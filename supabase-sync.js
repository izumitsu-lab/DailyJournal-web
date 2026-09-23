// ==========================================
// supabase-sync.js (Supabase 連携・オフライン耐性・リアルタイム反映)
// ==========================================
//
// 同期の考え方（v2）
// 1. 「上書き」ではなく「記録単位のマージ」
//    - ジャーナルは1日＝1行だが、行の中の記録（ログ）ごとに id と updatedAt を持ち、
//      ローカルとクラウドを id 単位で突き合わせて新しい方を採用する。
//      → 2台で同じ日に書いても、両方の記録が残る。
//    - ノートは1冊＝1行。edited_at（編集時刻）が新しい方を採用する。
// 2. 削除は「削除の印（トゥームストーン）」として同期する
//    - journals.tombstones = { 記録id: 削除時刻 }、notebooks.deleted = true
//    - これがないと、他の端末の古いデータから削除したものが復活してしまう。
// 3. 送信前に必ずクラウドの最新行を読み、マージしてから書き込む（read-merge-write）
//    - オフラインで書いた内容が、復帰時にクラウドの古い版で消されることはない。
// 4. 差分取得のカーソルはサーバー時刻（トリガーで付与される updated_at）で管理する
//    - 端末の時計がずれていても、他端末の更新を取りこぼさない。
// 5. 同期処理（送信・取得・リアルタイム反映）は1本の列に並べて順番に実行する
//    - 取得中に届いた変更や編集を捨てない。
//
// ※ サーバー側に v2 用の列とトリガーが必要です（設定 > クラウド の SQL を実行）。

let supabaseClient = null;
let supabaseUser = null;
let isOnline = navigator.onLine;
let realtimeChannel = null;
let _listenersBound = false;
let _schemaState = 'unknown'; // 'unknown' | 'ok' | 'outdated'
let _lastSyncError = null;
let _isSyncing = false;

let _pushTimer = null;
let retryLoopTimer = null;

const SB_IMG_PREFIX = 'SBIMG:';
const PULL_OVERLAP_MS = 30000; // 取りこぼし防止のため、前回カーソルより少し前から取得する（マージは冪等なので重複は無害）

// ==========================================
// 0. 未送信キュー（送信に成功するまで消さない）
// ==========================================

function _safeParseArray(key) {
    try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}

let pendingJournalDates = new Set(_safeParseArray('daily_journal_pending_journals').filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)));
let pendingNotebookIds = new Set(_safeParseArray('daily_journal_pending_notebooks'));
let pendingSettingsDirty = localStorage.getItem('daily_journal_pending_settings') === '1';

// 送信中に同じキーが再編集されたかを判定するための版数（送信成功時、版数が変わっていなければキューから外す）
const _journalDirtyVer = new Map();
const _notebookDirtyVer = new Map();
let _settingsDirtyVer = 0;

function _persistPending() {
    if (typeof isTabActive === 'function' && !isTabActive()) return;
    localStorage.setItem('daily_journal_pending_journals', JSON.stringify([...pendingJournalDates]));
    localStorage.setItem('daily_journal_pending_notebooks', JSON.stringify([...pendingNotebookIds]));
    localStorage.setItem('daily_journal_pending_settings', pendingSettingsDirty ? '1' : '0');
}

// 別タブが直前まで書き込んでいた未送信キューを取り込み直す（タブを引き継いだとき）
function reloadPendingQueue() {
    _safeParseArray('daily_journal_pending_journals').filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).forEach(d => pendingJournalDates.add(d));
    _safeParseArray('daily_journal_pending_notebooks').forEach(id => pendingNotebookIds.add(id));
    if (localStorage.getItem('daily_journal_pending_settings') === '1') pendingSettingsDirty = true;
}

// このタブが使われなくなったら、同期を止める
function onTabDeactivated() {
    clearTimeout(_pushTimer);
    clearInterval(retryLoopTimer);
    unsubscribeRealtime();
}

function getPendingCount() {
    return pendingJournalDates.size + pendingNotebookIds.size + (pendingSettingsDirty ? 1 : 0);
}

// main.js の保存処理から「何が変わったか」を受け取る
setLocalChangeListener((kind, keys) => {
    if (kind === 'journal') {
        keys.forEach(d => { pendingJournalDates.add(d); _journalDirtyVer.set(d, (_journalDirtyVer.get(d) || 0) + 1); });
    } else if (kind === 'notebook') {
        keys.forEach(id => { pendingNotebookIds.add(id); _notebookDirtyVer.set(id, (_notebookDirtyVer.get(id) || 0) + 1); });
    } else if (kind === 'settings') {
        pendingSettingsDirty = true;
        _settingsDirtyVer++;
    }
    _persistPending();
    updateSyncStatusUI();
    schedulePush();
});

// ==========================================
// 0.5 同期処理の直列化
// ==========================================
let _syncChain = Promise.resolve();
function runExclusive(fn) {
    const p = _syncChain.then(fn, fn);
    _syncChain = p.catch(() => {});
    return p;
}

function _canSync() {
    return !!(supabaseClient && supabaseUser && navigator.onLine && _schemaState !== 'outdated' && isTabActive());
}

function schedulePush(delay = 800) {
    clearTimeout(_pushTimer);
    _pushTimer = setTimeout(() => {
        if (!_canSync()) return;
        runExclusive(async () => {
            if (!(await _ensureSchema())) return;
            await _pushAll();
        }).catch(e => _reportSyncError(e));
    }, delay);
}

function _reportSyncError(e) {
    console.warn('同期に失敗しました（未送信分は保持され、自動で再試行します）', e);
    _lastSyncError = e;
    updateSyncStatusUI();
}

// ==========================================
// 1. 同期状態の表示
// ==========================================
function updateSyncStatusUI() {
    const icon = document.getElementById('btnSyncPullIcon');
    const statusEl = document.getElementById('supabaseSyncStatus');
    if (!icon && !statusEl) return;

    const configured = !!localStorage.getItem('daily_journal_supabase_url');
    if (!configured) return;

    let text, iconChar, color;
    const pending = getPendingCount();

    if (!supabaseUser) {
        text = "未ログイン（本体保存のみ）"; iconChar = "☁️"; color = "var(--text-secondary)";
    } else if (_schemaState === 'outdated') {
        text = "サーバー側の更新が必要です（設定 > クラウド のSQLを実行してください）。入力は本体に保存されています。";
        iconChar = "⚠️"; color = "#e67e22";
    } else if (!isOnline) {
        text = pending > 0 ? `オフライン（未送信 ${pending} 件・復帰後に自動送信）` : "オフライン（本体には保存済み）";
        iconChar = "📴"; color = "#e67e22";
    } else if (_isSyncing) {
        text = pending > 0 ? `同期中… (未送信 ${pending} 件)` : "同期中…";
        iconChar = "🔄"; color = "#e67e22";
    } else if (_lastSyncError) {
        text = `同期エラー（未送信 ${pending} 件は保持・自動で再試行します）`;
        iconChar = "⚠️"; color = "#e74c3c";
    } else if (pending > 0) {
        text = `送信待ち (未送信 ${pending} 件)`;
        iconChar = "🔄"; color = "#e67e22";
    } else {
        const t = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
        text = `同期済み（${t} 時点）`;
        iconChar = "✅"; color = "var(--notebook-color)";
    }

    if (icon) icon.textContent = iconChar;
    if (statusEl) { statusEl.textContent = text; statusEl.style.color = color; }
}

// ==========================================
// 2. 初期化と設定管理
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    const savedUrl = localStorage.getItem('daily_journal_supabase_url');
    const savedKey = localStorage.getItem('daily_journal_supabase_key');

    const urlInput = document.getElementById('supabaseUrlInput');
    const keyInput = document.getElementById('supabaseKeyInput');
    if (urlInput && savedUrl) urlInput.value = savedUrl;
    if (keyInput && savedKey) keyInput.value = savedKey;

    if (savedUrl && savedKey) initSupabase(savedUrl, savedKey);
});

function initSupabase(url, key) {
    if (!window.supabase) return;
    try {
        supabaseClient = window.supabase.createClient(url, key);
        _schemaState = 'unknown';
        document.getElementById('supabaseAuthBox').style.display = 'block';
        document.getElementById('supabaseSetupBox').style.display = 'block';
        const migrateBox = document.getElementById('supabaseMigrateBox');
        if (migrateBox) migrateBox.style.display = 'block';
        const cleanupBox = document.getElementById('supabaseCleanupBox');
        if (cleanupBox) cleanupBox.style.display = 'block';
        setupNetworkAndLifecycleListeners();
        checkSupabaseAuth();
    } catch (err) {
        console.error("Supabase初期化エラー:", err);
    }
}

function saveSupabaseConfig() {
    const url = document.getElementById('supabaseUrlInput').value.trim();
    const key = document.getElementById('supabaseKeyInput').value.trim();
    if (!url || !key) return alert("URLとAnon Keyを入力してください。");

    localStorage.setItem('daily_journal_supabase_url', url);
    localStorage.setItem('daily_journal_supabase_key', key);
    alert("接続設定を保存しました。");
    initSupabase(url, key);
}

function setupNetworkAndLifecycleListeners() {
    if (_listenersBound) return;
    _listenersBound = true;

    window.addEventListener('online', () => {
        isOnline = true;
        updateSyncStatusUI();
        syncNow(false);
        ensureRealtimeSubscribed();
    });
    window.addEventListener('offline', () => {
        isOnline = false;
        updateSyncStatusUI();
    });

    // アプリ復帰時：未送信分を送ってから、差分を取得する
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && supabaseClient && supabaseUser && navigator.onLine) {
            syncNow(false);
            ensureRealtimeSubscribed();
        }
    });

    // 保険：送れていないデータがあれば定期的に再送
    clearInterval(retryLoopTimer);
    retryLoopTimer = setInterval(() => {
        if (_canSync() && getPendingCount() > 0) schedulePush(0);
    }, 20000);
}

// 手動同期（設定画面・更新ボタン）：未送信分の送信＋全件照合
async function forceSyncNow() {
    if (!supabaseClient || !supabaseUser) {
        alert("先にSupabaseへログインしてください。");
        return;
    }
    await syncNow(true);
    if (_schemaState === 'outdated') {
        alert("サーバー側のデータベース更新が必要です。\n設定 > クラウド の「データベースセットアップ」のSQLを Supabase の SQL Editor で実行してください。");
    }
}

// ==========================================
// 3. 認証 (Auth)
// ==========================================
async function checkSupabaseAuth() {
    if (!supabaseClient) return;
    const statusEl = document.getElementById('supabaseAuthStatus');
    const logoutBtn = document.getElementById('supabaseLogoutBtn');

    let session = null;
    try {
        const { data, error } = await supabaseClient.auth.getSession();
        if (error) throw error;
        session = data && data.session;
    } catch (e) {
        console.error('ログイン状態の確認に失敗しました', e);
        statusEl.textContent = 'ログイン状態を確認できませんでした: ' + ((e && e.message) || e);
        statusEl.style.color = '#e74c3c';
        return;
    }

    if (session && session.user) {
        // ログイン状態の表示は、端末内データの読み込みを待たずにすぐ更新する
        statusEl.textContent = `ログイン中: ${session.user.email}`;
        statusEl.style.color = "var(--notebook-color)";
        logoutBtn.style.display = "inline-flex";

        // 同期は、端末内データの読み込み完了を待ってから始める（読み込み前にマージしない）
        await appDataReady;
        const switched = !supabaseUser || supabaseUser.id !== session.user.id;
        supabaseUser = session.user;

        ensureRealtimeSubscribed();
        // カーソルがなければ全件照合、あれば差分のみ
        if (switched) await syncNow(!_getCursor().j);
    } else {
        supabaseUser = null;
        statusEl.textContent = "未ログイン (本体保存のみ)";
        statusEl.style.color = "var(--text-secondary)";
        logoutBtn.style.display = "none";
        unsubscribeRealtime();
    }
    updateSyncStatusUI();
}

async function signUpSupabase() {
    if (!supabaseClient) return alert("接続設定を先に行ってください。");
    const email = document.getElementById('supabaseEmail').value.trim();
    const password = document.getElementById('supabasePassword').value;
    if (!email || !password) return alert("メールアドレスとパスワードを入力してください。");

    let error = null;
    try { ({ error } = await supabaseClient.auth.signUp({ email, password })); } catch (e) { error = e; }
    if (error) alert("登録エラー: " + (error.message || error));
    else {
        alert("登録完了！データの同期を開始します。");
        checkSupabaseAuth();
    }
}

async function signInSupabase() {
    if (!supabaseClient) return;
    const email = document.getElementById('supabaseEmail').value.trim();
    const password = document.getElementById('supabasePassword').value;
    if (!email || !password) return;

    const statusEl = document.getElementById('supabaseAuthStatus');
    if (statusEl) { statusEl.textContent = 'ログイン処理中…'; statusEl.style.color = 'var(--text-secondary)'; }
    let error = null;
    try {
        ({ error } = await supabaseClient.auth.signInWithPassword({ email, password }));
    } catch (e) { error = e; } // 通信エラー等で例外になった場合も必ず知らせる
    if (error) {
        alert("ログインエラー: " + (error.message || error));
        checkSupabaseAuth();
    } else {
        alert("ログインしました。クラウドのデータと同期します。");
        checkSupabaseAuth();
    }
}

async function signOutSupabase() {
    if (!supabaseClient) return;
    await supabaseClient.auth.signOut();
    unsubscribeRealtime();
    supabaseUser = null;
    alert("ログアウトしました。これ以降は本体のみに保存されます。");
    checkSupabaseAuth();
}

// ==========================================
// 4. サーバー側スキーマ（v2）の確認
// ==========================================
async function _ensureSchema() {
    if (_schemaState === 'ok') return true;
    const a = await supabaseClient.from('journals').select('date_str,tombstones').limit(1);
    const b = await supabaseClient.from('notebooks').select('id,deleted,edited_at').limit(1);
    const err = a.error || b.error;
    if (err) {
        const msg = (err.message || '') + ' ' + (err.code || '');
        if (/42703|column|does not exist|schema cache/i.test(msg)) {
            _schemaState = 'outdated';
            updateSyncStatusUI();
            return false;
        }
        throw err; // 通信エラー等
    }
    _schemaState = 'ok';
    return true;
}

// ==========================================
// 5. 画像（Storage）
// ==========================================
// アップロード済み画像の一覧（ハッシュ -> Storage内パス）。ユーザーごとに保持
function _uploadedKey() { return 'daily_journal_uploaded_paths_' + (supabaseUser ? supabaseUser.id : ''); }
let _uploadedCache = { key: null, map: {} };
function _uploadedMap() {
    const k = _uploadedKey();
    if (_uploadedCache.key !== k) {
        let m = {};
        try { m = JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch (e) { m = {}; }
        _uploadedCache = { key: k, map: m };
    }
    return _uploadedCache.map;
}
// 他の端末が「不要画像の掃除」をした場合、この端末の「アップロード済み」記録は信用できないので捨てる
function _validFromKey() { return 'daily_journal_uploaded_valid_from_' + (supabaseUser ? supabaseUser.id : ''); }
function _applyImagesCleanedAt(cleanedAt) {
    const t = _normIso(cleanedAt);
    if (!t) return;
    const validFrom = localStorage.getItem(_validFromKey()) || '';
    if (t > validFrom) {
        _uploadedCache = { key: _uploadedKey(), map: {} };
        localStorage.setItem(_uploadedKey(), '{}');
        localStorage.setItem(_validFromKey(), t);
    }
}
async function _checkImagesCleanedAt() {
    const { data, error } = await supabaseClient.from('app_settings').select('images_cleaned_at').eq('user_id', supabaseUser.id).maybeSingle();
    if (error) return; // 列がない（SQL未更新）場合は何もしない
    if (data && data.images_cleaned_at) _applyImagesCleanedAt(data.images_cleaned_at);
}

function _markUploaded(hash, path) {
    const m = _uploadedMap();
    if (m[hash] === path) return;
    m[hash] = path;
    localStorage.setItem(_uploadedKey(), JSON.stringify(m));
}

// 画像（dataURL または "idbimg:" 参照）→ Storage にアップロードして "SBIMG:<uid>/img_<hash>.<ext>" を返す
// アップロード済みなら通信せず、画像本体の読み込みもしない
async function _toCloudImage(img) {
    let hash = idbRefHash(img);
    if (hash) {
        const known = _uploadedMap()[hash];
        if (known) return SB_IMG_PREFIX + known;
        img = await getImageData(hash);
        if (!img) throw new Error('画像が端末内に見つかりません: ' + hash);
    }
    if (!isDataImage(img)) return img;
    if (!hash) hash = await hashImage(img);
    const known = _uploadedMap()[hash];
    if (known) return SB_IMG_PREFIX + known;

    const ext = (img.substring(img.indexOf('/') + 1, img.indexOf(';')) || 'jpeg').replace(/[^a-z0-9]/gi, '') || 'jpeg';
    const filePath = `${supabaseUser.id}/img_${hash}.${ext}`;
    const blob = await (await fetch(img)).blob();
    const { error } = await supabaseClient.storage.from('images').upload(filePath, blob, { upsert: false, contentType: blob.type || `image/${ext}` });
    if (error) {
        const m = `${error.message || ''} ${error.statusCode || ''} ${error.error || ''}`;
        if (!/already exists|Duplicate|409/i.test(m)) throw error;
    }
    _markUploaded(hash, filePath);
    return SB_IMG_PREFIX + filePath;
}

async function _blobToDataUrl(blob) {
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function _isNotFoundError(e) {
    const m = `${(e && e.message) || ''} ${(e && e.statusCode) || ''} ${(e && e.error) || ''}`;
    return /not found|404|does not exist/i.test(m);
}

async function _downloadCloudImage(ref) {
    let blob;
    if (ref.startsWith(SB_IMG_PREFIX)) {
        const path = ref.slice(SB_IMG_PREFIX.length);
        const { data, error } = await supabaseClient.storage.from('images').createSignedUrl(path, 600);
        if (error || !data || !data.signedUrl) throw error || new Error('署名付きURLを取得できませんでした');
        const res = await fetch(data.signedUrl);
        if (!res.ok) throw new Error(res.status === 404 ? 'Object not found' : 'image download failed: ' + res.status);
        blob = await res.blob();
    } else if (/^https:\/\/[^"'<>\s]+\/storage\/v1\/object\/public\/images\//.test(ref)) {
        const res = await fetch(ref); // 旧・公開バケット形式の互換
        if (!res.ok) throw new Error('image download failed: ' + res.status);
        blob = await res.blob();
    } else {
        throw new Error('unsupported image ref');
    }
    const dataUrl = await _blobToDataUrl(blob);
    if (!isValidDataImage(dataUrl)) throw new Error('downloaded file is not an image');
    return dataUrl;
}

// クラウド側の画像値 → 端末の画像ストアに保存して "idbimg:<hash>" を返す（ジャーナル用）
// 手元に同じ画像があれば通信しない。失敗時は例外（その行は次回やり直す）
async function _resolveCloudImageToRef(ref) {
    if (typeof ref !== 'string') throw new Error('invalid image');
    const own = idbRefHash(ref);
    if (own) { if (hasStoredImage(own)) return ref; throw new Error('missing local image'); }
    if (isDataImage(ref)) {
        if (!isValidDataImage(ref)) throw new Error('invalid data URI');
        const h = await hashImage(ref);
        await storeImage(h, ref);
        return IDB_IMG_PREFIX + h;
    }
    const m = ref.match(/img_([a-f0-9]{64})\./);
    if (m && ref.startsWith(SB_IMG_PREFIX)) _markUploaded(m[1], ref.slice(SB_IMG_PREFIX.length));
    if (m && hasStoredImage(m[1])) return IDB_IMG_PREFIX + m[1];
    let dataUrl;
    try { dataUrl = await _downloadCloudImage(ref); }
    catch (e) {
        // クラウドに画像が存在しない場合は「欠けた画像」として参照のまま残す（同期全体は止めない）
        if (_isNotFoundError(e)) { console.warn('クラウドに画像が見つかりません（欠けた画像として扱います）:', ref); return ref; }
        throw e;
    }
    const h = m ? m[1] : await sha256Hex(dataUrl);
    await storeImage(h, dataUrl);
    return IDB_IMG_PREFIX + h;
}

// クラウド側の画像値 → dataURL（ノート本文用。ノートは画像を読み込んだ状態で持つ）
async function _resolveCloudImageToData(ref) {
    if (typeof ref !== 'string') throw new Error('invalid image');
    const own = idbRefHash(ref);
    if (own) { const d = await getImageData(own); if (d) return d; throw new Error('missing local image'); }
    if (isDataImage(ref)) {
        if (!isValidDataImage(ref)) throw new Error('invalid data URI');
        await hashImage(ref);
        return ref;
    }
    const m = ref.match(/img_([a-f0-9]{64})\./);
    if (m && ref.startsWith(SB_IMG_PREFIX)) _markUploaded(m[1], ref.slice(SB_IMG_PREFIX.length));
    if (m && hasStoredImage(m[1])) { const d = await getImageData(m[1]); if (d) { registerImage(m[1], d); return d; } }
    let dataUrl;
    try { dataUrl = await _downloadCloudImage(ref); }
    catch (e) {
        if (_isNotFoundError(e)) { console.warn('クラウドに画像が見つかりません（欠けた画像として扱います）:', ref); return ref; }
        throw e;
    }
    if (m) registerImage(m[1], dataUrl); else await hashImage(dataUrl);
    return dataUrl;
}

// ==========================================
// 6. マージ（クラウドの1行 → ローカル）
// ==========================================
function _mergeTombs(a, b) {
    const out = Object.assign({}, a);
    for (const k of Object.keys(b)) if (!out[k] || b[k] > out[k]) out[k] = b[k];
    return out;
}
function _isBuried(log, tomb) { return !!(tomb[log.id] && tomb[log.id] >= (log.updatedAt || '')); }
function _daySig(logs, tomb) {
    return JSON.stringify([
        logs.filter(l => !_isBuried(l, tomb)).map(l => l.id + '@' + (l.updatedAt || '')).sort(),
        Object.keys(tomb).map(k => k + '@' + tomb[k]).sort()
    ]);
}

// 戻り値: ローカルのデータが変わったら true（呼び出し側で保存・再描画）
async function mergeRemoteJournalRow(row) {
    const d = row && row.date_str;
    if (!DATE_KEY_RE.test(d || '')) return false;
    const remoteLogs = sanitizeDayLogs(d, row.log_data);
    const remoteTomb = sanitizeTombstoneMap(row.tombstones);

    // 採用される可能性のあるクラウド側の記録だけ、画像を解決しておく
    const resolved = new Map();
    for (let attempt = 0; attempt < 3; attempt++) {
        const localById = new Map((journalData[d] || []).map(l => [l.id, l]));
        const need = remoteLogs.filter(r => {
            if (resolved.has(r.id)) return false;
            const c = localById.get(r.id);
            return !c || (r.updatedAt || '') > (c.updatedAt || '');
        });
        if (!need.length) break;
        for (const r of need) {
            const imgs = [];
            for (const ref of r.images) imgs.push(await _resolveCloudImageToRef(ref));
            resolved.set(r.id, Object.assign({}, r, { images: imgs }));
        }
    }

    // ここから先は同期的に（途中でユーザー編集が割り込まない）現在のローカルとマージ
    const cur = journalData[d] || [];
    const tomb = _mergeTombs(journalTombstones[d] || {}, remoteTomb);
    const map = new Map(cur.map(l => [l.id, l]));
    const order = cur.map(l => l.id);
    let changed = false;
    let unresolved = false;
    for (const r of remoteLogs) {
        const c = map.get(r.id);
        if (c && (r.updatedAt || '') <= (c.updatedAt || '')) continue;
        const rr = resolved.get(r.id);
        if (!rr) { unresolved = true; continue; }
        if (!c) order.push(r.id);
        map.set(r.id, rr);
        changed = true;
    }
    const result = order.map(id => map.get(id)).filter(l => !_isBuried(l, tomb));
    if (result.length !== order.length) changed = true;
    const tombChanged = JSON.stringify(tomb) !== JSON.stringify(journalTombstones[d] || {});

    if (changed) {
        if (result.length) journalData[d] = result; else delete journalData[d];
        if (typeof dateList !== 'undefined' && result.length && !dateList.includes(d)) { dateList.push(d); dateList.sort(); }
    }
    if (Object.keys(tomb).length) journalTombstones[d] = tomb; else delete journalTombstones[d];
    rebaselineJournal([d]);

    // クラウドの行とマージ結果が一致していれば送信不要、違えば送信対象
    if (!unresolved && _daySig(result, tomb) === _daySig(remoteLogs, remoteTomb)) pendingJournalDates.delete(d);
    else pendingJournalDates.add(d);

    return changed || tombChanged;
}

const _LEGACY_PUBLIC_IMG_RE = /https:\/\/[^"'<>\s]+\/storage\/v1\/object\/public\/images\/[^"'<>\s]+/g;
const _SBIMG_IN_HTML_RE = /SBIMG:[A-Za-z0-9_\/.-]+/g;

async function _resolveNoteContent(html) {
    let content = sanitizeNoteHtml(html || '');
    const refs = new Set([...(content.match(_SBIMG_IN_HTML_RE) || []), ...(content.match(_LEGACY_PUBLIC_IMG_RE) || [])]);
    const map = new Map();
    for (const ref of refs) map.set(ref, await _resolveCloudImageToData(ref));
    if (map.size) content = content.replace(_SBIMG_IN_HTML_RE, m => map.get(m) || m).replace(_LEGACY_PUBLIC_IMG_RE, m => map.get(m) || m);
    const inline = content.match(DATA_URI_RE) || [];
    await ensureImageHashes(inline);
    return content;
}

async function mergeRemoteNotebookRow(row) {
    if (!row || !isSafeId(row.id)) return false;
    const id = row.id;
    // Postgres の timestamptz は "…+00:00" 形式で返るため、アプリ側の "…Z" 形式に揃えてから比較する
    const remoteTime = _normIso(row.edited_at || row.updated_at);
    const localTime = () => {
        const n = notebookData.find(x => x.id === id);
        return n ? (n.updatedAt || '') : (notebookTombstones[id] || '');
    };

    // このノートを編集中に、他の端末での更新が届いた場合（自分の送信のエコーは除く）
    // → 画面の編集内容は上書きせず、相手の版を失わないよう別途保全する（notebooks.js 側で処理）
    if (typeof getEditingNotebookBase === 'function') {
        const base = getEditingNotebookBase(id);
        const own = (_pushedEditedAt.get(id) || new Set()).has(remoteTime);
        if (base !== null && !own && remoteTime > base) {
            if (row.deleted) {
                await handleRemoteEditConflict(id, { deleted: true, editedAt: remoteTime });
            } else {
                const content = await _resolveNoteContent(row.content);
                const remoteNote = sanitizeNote({ id, title: row.title, content: '', category: row.category, status: row.status, linkedNoteIds: row.linked_note_ids, createdAt: row.created_at, updatedAt: remoteTime });
                if (remoteNote) { remoteNote.content = content; await handleRemoteEditConflict(id, remoteNote); }
            }
            pendingNotebookIds.add(id);
            return false;
        }
    }

    if (remoteTime < localTime()) { pendingNotebookIds.add(id); return false; }
    if (remoteTime === localTime()) {
        const n = notebookData.find(x => x.id === id);
        const localDeleted = !n;
        if (localDeleted === !!row.deleted) pendingNotebookIds.delete(id);
        return false;
    }

    // クラウド側が新しい
    if (row.deleted) {
        const idx = notebookData.findIndex(x => x.id === id);
        if (idx !== -1) notebookData.splice(idx, 1);
        notebookData.forEach(o => { if (Array.isArray(o.linkedNoteIds) && o.linkedNoteIds.includes(id)) o.linkedNoteIds = o.linkedNoteIds.filter(x => x !== id); });
        notebookTombstones[id] = remoteTime;
        rebaselineNotebooks([id]);
        pendingNotebookIds.delete(id);
        return true;
    }

    const content = await _resolveNoteContent(row.content);
    if (remoteTime <= localTime()) { pendingNotebookIds.add(id); return false; } // 画像取得中にローカルで編集された

    const note = sanitizeNote({
        id, title: row.title, content: '', category: row.category, status: row.status,
        linkedNoteIds: row.linked_note_ids, createdAt: row.created_at, updatedAt: remoteTime
    });
    if (!note) return false;
    note.content = content;

    const idx = notebookData.findIndex(x => x.id === id);
    if (idx !== -1) notebookData[idx] = note; else notebookData.push(note);
    delete notebookTombstones[id];
    rebaselineNotebooks([id]);
    pendingNotebookIds.delete(id);
    return true;
}

function sanitizeSettingsData(s) {
    if (!s || typeof s !== 'object') return null;
    const str = v => typeof v === 'string' && v.trim() !== '' && v.length <= 60;
    const boolMap = (m) => {
        const o = {};
        if (m && typeof m === 'object') for (const k of Object.keys(m)) if (str(k)) o[k] = !!m[k];
        return o;
    };
    const out = {};
    if (Array.isArray(s.appTypes)) out.appTypes = [...new Set(s.appTypes.filter(str))];
    if (Array.isArray(s.categories)) {
        const seen = new Set();
        out.categories = s.categories
            .filter(c => c && str(c.name) && !seen.has(c.name) && seen.add(c.name))
            .map(c => ({ name: c.name, type: str(c.type) ? c.type : '一般' }));
    }
    if (s.typeSlackSettings) out.typeSlackSettings = boolMap(s.typeSlackSettings);
    if (s.typeNotebookSettings) out.typeNotebookSettings = boolMap(s.typeNotebookSettings);
    out._editedAt = typeof s._editedAt === 'string' ? s._editedAt : '';
    return out;
}

async function _applySettingsData(s) {
    if (s.appTypes && s.appTypes.length) {
        appTypes.splice(0, appTypes.length, ...s.appTypes);
        localStorage.setItem('daily_journal_types', JSON.stringify(appTypes));
    }
    if (s.categories && s.categories.length) {
        categories.splice(0, categories.length, ...s.categories);
        localStorage.setItem('daily_journal_categories', JSON.stringify(categories));
    }
    if (s.typeSlackSettings) {
        Object.keys(typeSlackSettings).forEach(k => delete typeSlackSettings[k]);
        Object.assign(typeSlackSettings, s.typeSlackSettings);
        localStorage.setItem('daily_journal_type_slack', JSON.stringify(typeSlackSettings));
    }
    if (s.typeNotebookSettings) {
        Object.keys(typeNotebookSettings).forEach(k => delete typeNotebookSettings[k]);
        Object.assign(typeNotebookSettings, s.typeNotebookSettings);
        localStorage.setItem('daily_journal_type_notebook', JSON.stringify(typeNotebookSettings));
    }
    localStorage.setItem(SETTINGS_EDITED_AT_KEY, s._editedAt || '');
    if (typeof syncAndMigrateCategories === 'function') await syncAndMigrateCategories();
}

// 戻り値: ローカル設定が変わったら true
async function mergeRemoteSettingsRow(row) {
    const s = sanitizeSettingsData(row && row.settings_data);
    if (!s) return false;
    const localEdited = getSettingsEditedAt();
    if (pendingSettingsDirty && localEdited > s._editedAt) return false; // ローカルの未送信変更の方が新しい → 送信で反映
    if (!pendingSettingsDirty && localEdited && localEdited === s._editedAt) return false; // 同一
    await _applySettingsData(s);
    pendingSettingsDirty = false;
    _persistPending();
    return true;
}

// 自分が送信したノートの edited_at（リアルタイムで戻ってくるエコーを「他端末の更新」と誤認しないため）
const _pushedEditedAt = new Map();
function _rememberPushed(id, editedAt) {
    let set = _pushedEditedAt.get(id);
    if (!set) { set = new Set(); _pushedEditedAt.set(id, set); }
    set.add(editedAt);
    if (set.size > 50) set.delete(set.values().next().value);
}

// ==========================================
// 7. 送信（read-merge-write）
// ==========================================
function _normIso(v) {
    if (!v) return '';
    const t = Date.parse(v);
    return isNaN(t) ? '' : new Date(t).toISOString();
}

function _chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

async function _pushAll() {
    if (!_canSync()) return;
    _isSyncing = true; updateSyncStatusUI();
    try {
        if (pendingJournalDates.size || pendingNotebookIds.size) await _checkImagesCleanedAt();
        if (pendingSettingsDirty) await _pushSettings();
        if (pendingJournalDates.size) await _pushJournals([...pendingJournalDates]);
        if (pendingNotebookIds.size) await _pushNotebooks([...pendingNotebookIds]);
        _lastSyncError = null;
    } finally {
        _isSyncing = false;
        _persistPending();
        updateSyncStatusUI();
    }
}

async function _pushSettings() {
    const ver = _settingsDirtyVer;
    const { data: remote, error: rErr } = await supabaseClient.from('app_settings').select('*').eq('user_id', supabaseUser.id).maybeSingle();
    if (rErr) throw rErr;
    if (remote && await mergeRemoteSettingsRow(remote)) { refreshUIAfterSync(); return; }
    if (!pendingSettingsDirty) return;

    const payload = {
        user_id: supabaseUser.id,
        settings_data: {
            appTypes, categories, typeSlackSettings, typeNotebookSettings,
            _editedAt: getSettingsEditedAt() || new Date().toISOString()
        },
        updated_at: new Date().toISOString()
    };
    const { error } = await supabaseClient.from('app_settings').upsert(payload);
    if (error) throw error;
    if (ver === _settingsDirtyVer) pendingSettingsDirty = false;
}

async function _pushJournals(dates) {
    for (const chunk of _chunk(dates.sort(), 20)) {
        // 1) クラウドの最新行を読み、先にマージする
        const { data: rows, error: rErr } = await supabaseClient.from('journals').select('*').in('date_str', chunk);
        if (rErr) throw rErr;
        let changedLocal = false;
        for (const row of rows || []) if (await mergeRemoteJournalRow(row)) changedLocal = true;
        if (changedLocal) { await persistJournal(); refreshUIAfterSync(); }

        // 2) まだクラウドと食い違っている日だけを書き込む
        const payload = [];
        const vers = new Map();
        for (const d of chunk) {
            if (!pendingJournalDates.has(d)) continue;
            vers.set(d, _journalDirtyVer.get(d) || 0);
            const cloudLogs = [];
            for (const log of (journalData[d] || [])) {
                const images = [];
                for (const img of (log.images || [])) images.push(await _toCloudImage(img));
                cloudLogs.push(Object.assign({}, log, { images }));
            }
            payload.push({
                date_str: d,
                user_id: supabaseUser.id,
                log_data: cloudLogs,
                tombstones: journalTombstones[d] || {},
                updated_at: new Date().toISOString() // サーバーのトリガーがサーバー時刻で上書きする
            });
        }
        if (!payload.length) continue;
        const { error } = await supabaseClient.from('journals').upsert(payload);
        if (error) throw error;
        for (const p of payload) {
            if ((_journalDirtyVer.get(p.date_str) || 0) === vers.get(p.date_str)) pendingJournalDates.delete(p.date_str);
        }
        _persistPending();
    }
}

async function _noteContentForCloud(content) {
    if (!content || content.indexOf('data:image') === -1) return content || '';
    const uris = [...new Set(content.match(DATA_URI_RE) || [])];
    const map = new Map();
    for (const u of uris) map.set(u, await _toCloudImage(u));
    return content.replace(DATA_URI_RE, m => map.get(m) || m);
}

async function _pushNotebooks(ids) {
    for (const chunk of _chunk(ids, 20)) {
        const { data: rows, error: rErr } = await supabaseClient.from('notebooks').select('*').in('id', chunk);
        if (rErr) throw rErr;
        let changedLocal = false;
        for (const row of rows || []) if (await mergeRemoteNotebookRow(row)) changedLocal = true;
        if (changedLocal) { await persistNotebooks(); refreshUIAfterSync(); }

        const payload = [];
        const vers = new Map();
        for (const id of chunk) {
            if (!pendingNotebookIds.has(id)) continue;
            const n = notebookData.find(x => x.id === id);
            vers.set(id, _notebookDirtyVer.get(id) || 0);
            if (n) {
                payload.push({
                    id, user_id: supabaseUser.id,
                    title: n.title || '',
                    content: await _noteContentForCloud(n.content),
                    category: n.category || 'ライフログ',
                    status: n.status || 'archive',
                    linked_note_ids: n.linkedNoteIds || [],
                    created_at: n.createdAt || new Date().toISOString(),
                    edited_at: n.updatedAt || new Date().toISOString(),
                    deleted: false,
                    updated_at: new Date().toISOString()
                });
            } else if (notebookTombstones[id]) {
                // 削除の印だけを送る（本文は残さない）
                payload.push({
                    id, user_id: supabaseUser.id,
                    title: '', content: '', category: 'ライフログ', status: 'trash',
                    linked_note_ids: [],
                    edited_at: notebookTombstones[id],
                    deleted: true,
                    updated_at: new Date().toISOString()
                });
            } else {
                pendingNotebookIds.delete(id); // 送るものがない
            }
        }
        if (!payload.length) continue;
        payload.forEach(p => _rememberPushed(p.id, p.edited_at));
        const { error } = await supabaseClient.from('notebooks').upsert(payload);
        if (error) throw error;
        for (const p of payload) {
            if ((_notebookDirtyVer.get(p.id) || 0) === vers.get(p.id)) pendingNotebookIds.delete(p.id);
        }
        _persistPending();
    }
}

// ==========================================
// 8. 取得（Pull）
// ==========================================
function _cursorKey() { return 'daily_journal_pull_cursor_v2_' + (supabaseUser ? supabaseUser.id : ''); }
function _getCursor() {
    try { return JSON.parse(localStorage.getItem(_cursorKey()) || '{}') || {}; } catch (e) { return {}; }
}
function _setCursor(c) { localStorage.setItem(_cursorKey(), JSON.stringify(c)); }
function _maxIso(a, b) { return (!a || (b && Date.parse(b) > Date.parse(a))) ? b : a; }

async function _selectSince(table, since) {
    const out = [];
    const size = 500;
    for (let from = 0; ; from += size) {
        let q = supabaseClient.from(table).select('*').order('updated_at', { ascending: true }).range(from, from + size - 1);
        if (since) q = q.gte('updated_at', new Date(Date.parse(since) - PULL_OVERLAP_MS).toISOString());
        const { data, error } = await q;
        if (error) throw error;
        out.push(...(data || []));
        if (!data || data.length < size) break;
    }
    return out;
}

async function _pull(fullSync) {
    if (!_canSync()) return;
    _isSyncing = true; updateSyncStatusUI();
    try {
        const cursor = fullSync ? {} : _getCursor();
        const next = Object.assign({}, _getCursor());
        let uiChanged = false;

        // 設定
        const { data: sRow, error: sErr } = await supabaseClient.from('app_settings').select('*').eq('user_id', supabaseUser.id).maybeSingle();
        if (sErr) throw sErr;
        if (sRow && sRow.images_cleaned_at) _applyImagesCleanedAt(sRow.images_cleaned_at);
        if (sRow) { if (await mergeRemoteSettingsRow(sRow)) uiChanged = true; }
        else if (fullSync && getSettingsEditedAt()) { pendingSettingsDirty = true; }

        // ジャーナル
        const jRows = await _selectSince('journals', cursor.j);
        let jChanged = false;
        for (const row of jRows) {
            if (await mergeRemoteJournalRow(row)) jChanged = true;
            next.j = _maxIso(next.j, row.updated_at);
        }
        if (fullSync) {
            // クラウドに行がない日の記録は、未送信として送る
            const remoteDates = new Set(jRows.map(r => r.date_str));
            for (const d of Object.keys(journalData)) if (!remoteDates.has(d)) pendingJournalDates.add(d);
            for (const d of Object.keys(journalTombstones)) if (!remoteDates.has(d) && Object.keys(journalTombstones[d]).length) pendingJournalDates.add(d);
        }
        if (jChanged) { await persistJournal(); uiChanged = true; }

        // ノート
        const nRows = await _selectSince('notebooks', cursor.n);
        let nChanged = false;
        for (const row of nRows) {
            if (await mergeRemoteNotebookRow(row)) nChanged = true;
            next.n = _maxIso(next.n, row.updated_at);
        }
        if (fullSync) {
            const remoteIds = new Set(nRows.map(r => r.id));
            for (const n of notebookData) if (!remoteIds.has(n.id)) pendingNotebookIds.add(n.id);
            for (const id of Object.keys(notebookTombstones)) if (!remoteIds.has(id)) pendingNotebookIds.add(id);
        }
        if (nChanged) { await persistNotebooks(); uiChanged = true; }

        // 取得に成功した後にだけカーソルを進める（途中で失敗したら次回同じ範囲をやり直す）
        _setCursor(next);
        _persistPending();
        if (uiChanged) refreshUIAfterSync();
        _lastSyncError = null;
    } finally {
        _isSyncing = false;
        updateSyncStatusUI();
    }
}

// 送信 → 取得 → （マージで差分が出たら）再送信、の順で行う
function syncNow(fullSync = false) {
    if (!supabaseClient || !supabaseUser || !navigator.onLine || !isTabActive()) { updateSyncStatusUI(); return Promise.resolve(); }
    return runExclusive(async () => {
        if (!(await _ensureSchema())) return;
        await _pushAll();
        await _pull(fullSync);
        if (getPendingCount() > 0) await _pushAll();
    }).catch(e => _reportSyncError(e));
}

// 互換用（旧コードから呼ばれていた名前）
function pullFromSupabase(fullSync = true) { return syncNow(fullSync); }
function flushPendingPush() { return syncNow(false); }

// 旧バージョンでDBに直接入ってしまった画像を、Storage参照に置き換えるために全件を送り直す
async function migrateEmbeddedImagesToStorage() {
    if (!supabaseClient || !supabaseUser) { alert("先にSupabaseへログインしてください。"); return; }
    if (!confirm("ローカルに保存されている全データを元に、画像をクラウドStorageへ再アップロードし、データベースを軽量化します。データ量によっては数分かかることがあります。続行しますか？")) return;

    Object.keys(journalData).forEach(d => pendingJournalDates.add(d));
    notebookData.forEach(n => pendingNotebookIds.add(n.id));
    _persistPending();
    await syncNow(false);
    if (_lastSyncError || _schemaState === 'outdated') alert("移行を完了できませんでした。通信状態とサーバー設定を確認し、時間をおいて再度お試しください。");
    else alert("移行が完了しました。Supabaseダッシュボードの Storage と Table Editor でサイズをご確認ください。");
}

// ==========================================
// 8.5 クラウドの不要な画像の掃除（手動）
// ==========================================
// どの記録・ノートからも参照されていない画像を Storage から削除する。
// ・参照の判定は「サーバー上の全行」で行う（他端末の未取得分も含めて安全に判定）
// ・直近にアップロードされた画像は、行の書き込み前の可能性があるので消さない（猶予期間）
// ・掃除した時刻を app_settings に記録し、他の端末の「アップロード済み」記録を無効化させる
const IMAGE_CLEANUP_GRACE_DAYS = 7;

function _refsInText(text, out) {
    if (!text) return;
    const s = typeof text === 'string' ? text : JSON.stringify(text);
    let m;
    const re1 = /SBIMG:([A-Za-z0-9_\/.-]+)/g;
    while ((m = re1.exec(s))) out.add(m[1]);
    const re2 = /\/storage\/v1\/object\/public\/images\/([^"'<>\s\\]+)/g;
    while ((m = re2.exec(s))) out.add(decodeURIComponent(m[1]));
}

async function _selectAllColumns(table, cols) {
    const out = [];
    const size = 500;
    for (let from = 0; ; from += size) {
        const { data, error } = await supabaseClient.from(table).select(cols).order(table === 'journals' ? 'date_str' : 'id', { ascending: true }).range(from, from + size - 1);
        if (error) throw error;
        out.push(...(data || []));
        if (!data || data.length < size) break;
    }
    return out;
}

async function _listAllImages(folder) {
    const out = [];
    const size = 1000;
    for (let offset = 0; ; offset += size) {
        const { data, error } = await supabaseClient.storage.from('images').list(folder, { limit: size, offset, sortBy: { column: 'name', order: 'asc' } });
        if (error) throw error;
        out.push(...(data || []).filter(o => o && o.id !== null && o.name)); // フォルダ行を除外
        if (!data || data.length < size) break;
    }
    return out;
}

async function cleanupUnusedCloudImages() {
    if (!supabaseClient || !supabaseUser) { alert("先にSupabaseへログインしてください。"); return; }
    if (!navigator.onLine) { alert("オフラインのため実行できません。"); return; }
    if (!confirm(`クラウドの画像のうち、どの記録・ノートからも使われていないものを削除します。\n（${IMAGE_CLEANUP_GRACE_DAYS}日以内にアップロードされた画像は対象外です）\n\n先に未送信の変更を送信してから確認します。続行しますか？`)) return;

    let result = null;
    await runExclusive(async () => {
        if (!(await _ensureSchema())) { result = { error: 'schema' }; return; }
        const probe = await supabaseClient.from('app_settings').select('images_cleaned_at').limit(1);
        if (probe.error) { result = { error: 'schema' }; return; }

        await _pushAll();
        if (getPendingCount() > 0) { result = { error: 'pending' }; return; }

        const used = new Set();
        for (const r of await _selectAllColumns('journals', 'date_str,log_data')) _refsInText(r.log_data, used);
        for (const r of await _selectAllColumns('notebooks', 'id,content')) _refsInText(r.content, used);

        const uid = supabaseUser.id;
        const cutoff = Date.now() - IMAGE_CLEANUP_GRACE_DAYS * 86400000;
        const objects = await _listAllImages(uid);
        const targets = objects.filter(o => {
            const path = `${uid}/${o.name}`;
            if (used.has(path)) return false;
            const t = Date.parse(o.created_at || o.updated_at || '');
            return !isNaN(t) && t < cutoff;
        });
        const bytes = targets.reduce((a, o) => a + ((o.metadata && o.metadata.size) || 0), 0);
        result = { total: objects.length, used: used.size, targets, bytes };
    }).catch(e => { result = { error: e }; });

    if (!result || result.error) {
        if (result && result.error === 'schema') alert("この機能にはサーバー側の更新が必要です。\n設定 > クラウド のSQLをもう一度実行してください。");
        else if (result && result.error === 'pending') alert("未送信の変更を送信できなかったため中止しました。通信状態を確認してから再度お試しください。");
        else alert("確認中にエラーが発生しました: " + ((result && result.error && result.error.message) || result && result.error));
        return;
    }
    if (!result.targets.length) { alert(`削除できる不要な画像はありません。（クラウドの画像 ${result.total} 件）`); return; }
    const mb = (result.bytes / 1024 / 1024).toFixed(1);
    if (!confirm(`不要な画像が ${result.targets.length} 件（約 ${mb} MB）見つかりました。\nクラウドから削除しますか？（端末内の画像には影響しません）`)) return;

    let removed = 0;
    await runExclusive(async () => {
        const uid = supabaseUser.id;
        const paths = result.targets.map(o => `${uid}/${o.name}`);
        for (const chunk of _chunk(paths, 100)) {
            const { error } = await supabaseClient.storage.from('images').remove(chunk);
            if (error) throw error;
            removed += chunk.length;
            const map = _uploadedMap();
            for (const p of chunk) { const m = p.match(/img_([a-f0-9]{64})\./); if (m) delete map[m[1]]; }
            localStorage.setItem(_uploadedKey(), JSON.stringify(map));
        }
        // 他の端末に「掃除した」ことを知らせる
        const now = new Date().toISOString();
        const { data: row } = await supabaseClient.from('app_settings').select('user_id').eq('user_id', uid).maybeSingle();
        if (row) {
            const { error } = await supabaseClient.from('app_settings').update({ images_cleaned_at: now }).eq('user_id', uid);
            if (error) throw error;
        } else {
            const { error } = await supabaseClient.from('app_settings').upsert({
                user_id: uid, images_cleaned_at: now,
                settings_data: { appTypes, categories, typeSlackSettings, typeNotebookSettings, _editedAt: getSettingsEditedAt() }
            });
            if (error) throw error;
        }
        localStorage.setItem(_validFromKey(), now);
    }).catch(e => { alert(`削除の途中でエラーが発生しました（${removed} 件は削除済み）: ` + (e && e.message ? e.message : e)); removed = -1; });
    if (removed >= 0) alert(`${removed} 件の不要な画像をクラウドから削除しました。`);
}

function refreshUIAfterSync() {
    if (typeof updateCategoryButtonUI === 'function') updateCategoryButtonUI();
    const settingsOpen = document.getElementById('settingsModal') && document.getElementById('settingsModal').classList.contains('active');
    if (settingsOpen) {
        if (typeof renderSettingsTypeList === 'function') renderSettingsTypeList();
        if (typeof renderSettingsCategoryList === 'function') renderSettingsCategoryList();
    }
    // ノートを編集中は、カードを描き直すと入力中の内容が消えるので描画を控える（編集終了時に描画される）
    const editingNote = typeof currentActiveEditorNotebookId !== 'undefined' && currentActiveEditorNotebookId;
    if (!editingNote && typeof renderRightCards === 'function') renderRightCards();
    if (typeof renderNotebookSidebar === 'function' && calendarScope === 'notebooks') renderNotebookSidebar();
    if (typeof renderMiniCalendar === 'function' && sidebarMode === 'cal' && calendarScope !== 'notebooks') renderMiniCalendar();
}

// ==========================================
// 9. Supabase Realtime（他デバイスの更新を即座に受け取る）
// ==========================================
// 前提: Supabase管理画面の Database > Replication で journals / notebooks / app_settings の Realtime を有効化。
// 有効化していない場合も、アプリ復帰時・オンライン復帰時の差分取得で反映されます。

function ensureRealtimeSubscribed() {
    if (!isTabActive()) return;
    if (!realtimeChannel) subscribeRealtime();
}

function subscribeRealtime() {
    if (!supabaseClient || !supabaseUser) return;
    unsubscribeRealtime();
    try {
        realtimeChannel = supabaseClient
            .channel('daily-journal-sync-' + supabaseUser.id)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'journals', filter: `user_id=eq.${supabaseUser.id}` }, payload => {
                if (payload.new && payload.new.date_str) _enqueueRemote('journal', payload.new);
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'notebooks', filter: `user_id=eq.${supabaseUser.id}` }, payload => {
                if (payload.new && payload.new.id) _enqueueRemote('notebook', payload.new);
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings', filter: `user_id=eq.${supabaseUser.id}` }, payload => {
                if (payload.new && payload.new.settings_data) _enqueueRemote('settings', payload.new);
            })
            .subscribe();
    } catch (e) {
        console.warn("Realtime購読に失敗しました。画面復帰時の差分取得のみで同期します。", e);
    }
}

function unsubscribeRealtime() {
    if (realtimeChannel && supabaseClient) {
        try { supabaseClient.removeChannel(realtimeChannel); } catch (e) {}
    }
    realtimeChannel = null;
}

// 受け取った変更は捨てずに同期の列に並べる（取得中でも失われない）
function _enqueueRemote(kind, row) {
    runExclusive(async () => {
        if (_schemaState === 'outdated' || !isTabActive()) return;
        let changed = false;
        if (kind === 'journal') { changed = await mergeRemoteJournalRow(row); if (changed) await persistJournal(); }
        else if (kind === 'notebook') { changed = await mergeRemoteNotebookRow(row); if (changed) await persistNotebooks(); }
        else if (kind === 'settings') { changed = await mergeRemoteSettingsRow(row); }
        _persistPending();
        if (changed) refreshUIAfterSync();
        if (getPendingCount() > 0) schedulePush();
        updateSyncStatusUI();
    }).catch(e => _reportSyncError(e));
}
