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

// RLS（本人の行だけ・許可リストの人だけ）で書き込みが拒否されたか
function _isPermissionError(e) {
    const s = ((e && (e.code || '')) + ' ' + (e && (e.message || e.error || '')) + ' ' + (e && e.statusCode || '')).toString();
    return /42501|row-level security|violates row level|Unauthorized|\b403\b/i.test(s);
}

function _reportSyncError(e) {
    console.warn('同期に失敗しました（未送信分は保持され、自動で再試行します）', e);
    _lastSyncError = e;
    updateSyncStatusUI();
}

// ==========================================
// 1. 同期状態の表示
// ==========================================
// 同期に問題があるときだけ、下のメニューの設定アイコンに点を付ける（オレンジ：要注意、赤：エラー）
// ※点はバックアップのお知らせ（ui.js）と共用なので、同期の状態を覚えておき、表示は updateSettingsAlertDot にまとめる
function _setSyncAlertDot(level, text) {
    window._syncAlertState = { level: level || null, text: text || '' };
    if (typeof updateSettingsAlertDot === 'function') { updateSettingsAlertDot(); return; }
    const dot = document.getElementById('syncAlertDot');
    if (dot) { dot.classList.toggle('warn', level === 'warn'); dot.classList.toggle('error', level === 'error'); }
    const btn = document.getElementById('btnSettings');
    if (btn) btn.title = level ? `設定（同期：${text}）` : '設定';
}

function updateSyncStatusUI() {
    const icon = document.getElementById('btnSyncPullIcon');
    const statusEl = document.getElementById('supabaseSyncStatus');

    const configured = !!getSupabaseConfig();
    if (!configured) { _setSyncAlertDot(null); return; }

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
    } else if (_lastSyncError && _isPermissionError(_lastSyncError)) {
        text = `このアカウントにはクラウドへの保存が許可されていません（許可リストへの登録が必要です）。未送信 ${pending} 件は本体に保存されています。`;
        iconChar = "⚠️"; color = "#e74c3c";
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
    // 点を付けるのは、放っておくと困る状態だけ（未ログイン・同期中・一時的な送信待ちでは付けない）
    let level = null;
    if (supabaseUser && (_schemaState === 'outdated' || _lastSyncError)) level = 'error';
    else if (supabaseUser && !isOnline && pending > 0) level = 'warn';
    _setSyncAlertDot(level, text);
}

// ==========================================
// 2. 初期化と設定管理
// ==========================================
// 既定の接続先（このアプリ専用の Supabase）。
// URL と Anon Key（Publishable Key）は公開前提の値で、ここに書いても安全です。
// データを守っているのはサーバー側の RLS（本人の行だけ・許可リストの人だけ）です。
// ※ service_role key（秘密鍵）は絶対にここへ書かないこと。
const DEFAULT_SUPABASE_URL = 'https://jgqnirudwghgexiinybz.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_ArYcXh6SegZ5XyVvZCuYIA_QrQ7c6w-';

// 接続先：設定画面で別の接続先を保存していればそれを、なければ既定値を使う
function getSupabaseConfig() {
    const savedUrl = localStorage.getItem('daily_journal_supabase_url') || '';
    const savedKey = localStorage.getItem('daily_journal_supabase_key') || '';
    if (savedUrl && savedKey) {
        const custom = savedUrl !== DEFAULT_SUPABASE_URL || savedKey !== DEFAULT_SUPABASE_ANON_KEY;
        return { url: savedUrl, key: savedKey, custom };
    }
    if (DEFAULT_SUPABASE_URL && DEFAULT_SUPABASE_ANON_KEY) {
        return { url: DEFAULT_SUPABASE_URL, key: DEFAULT_SUPABASE_ANON_KEY, custom: false };
    }
    return null;
}
function hasBuiltInSupabaseConfig() { return !!(DEFAULT_SUPABASE_URL && DEFAULT_SUPABASE_ANON_KEY); }

// 設定画面の表示を、使っている接続先に合わせる
function updateSupabaseConfigUI() {
    const cfg = getSupabaseConfig();
    const builtIn = hasBuiltInSupabaseConfig();
    const custom = !!(cfg && cfg.custom);
    const info = document.getElementById('supabaseConfigInfo');
    if (info) {
        if (!builtIn) info.textContent = '接続先が組み込まれていません。下の「詳細設定」で URL と Anon Key を入力してください。';
        else if (custom) info.textContent = '別の接続先を使っています（詳細設定で保存したもの）。';
        else info.textContent = '接続先はアプリに組み込まれています。ログインするだけで同期できます。';
    }
    const details = document.getElementById('supabaseAdvanced');
    if (details && (!builtIn || custom)) details.open = true;
    const resetBtn = document.getElementById('supabaseResetConfigBtn');
    if (resetBtn) resetBtn.style.display = (builtIn && custom) ? '' : 'none';
    // 新規登録は、自分で用意した Supabase を使うときだけ出す（組み込みの接続先では新規登録を受け付けない）
    const signUpBtn = document.getElementById('supabaseSignUpBtn');
    if (signUpBtn) signUpBtn.style.display = (!builtIn || custom) ? '' : 'none';
    const signUpNote = document.getElementById('supabaseSignUpNote');
    if (signUpNote) signUpNote.style.display = (!builtIn || custom) ? 'none' : '';
}

document.addEventListener('DOMContentLoaded', () => {
    const cfg = getSupabaseConfig();
    const custom = !!(cfg && cfg.custom);

    // 入力欄には、別の接続先を保存しているときだけ値を入れる（既定値は画面に出さない）
    const urlInput = document.getElementById('supabaseUrlInput');
    const keyInput = document.getElementById('supabaseKeyInput');
    if (urlInput && custom) urlInput.value = cfg.url;
    if (keyInput && custom) keyInput.value = cfg.key;
    updateSupabaseConfigUI();

    if (cfg) initSupabase(cfg.url, cfg.key);
});

function initSupabase(url, key) {
    if (!window.supabase) return;
    try {
        supabaseClient = window.supabase.createClient(url, key);
        _schemaState = 'unknown';
        document.getElementById('supabaseAuthBox').style.display = 'block';
        document.getElementById('supabaseSetupBox').style.display = 'block';
        updateMigrateBoxVisibility(); // 「軽量化」はクラウドに画像が直接残っているときだけ表示
        const cleanupBox = document.getElementById('supabaseCleanupBox');
        if (cleanupBox) cleanupBox.style.display = 'block';
        setupNetworkAndLifecycleListeners();
        checkSupabaseAuth();
    } catch (err) {
        console.error("Supabase初期化エラー:", err);
    }
}

async function saveSupabaseConfig() {
    await _commitPendingInput();
    const url = document.getElementById('supabaseUrlInput').value.trim();
    const key = document.getElementById('supabaseKeyInput').value.trim();
    if (!url || !key) return alert("URLとAnon Keyを入力してください。");

    if (!/^https:\/\/[^\s/]+/.test(url)) return alert("URLは https:// から始まる Project URL を入力してください。");

    const prev = getSupabaseConfig();
    localStorage.setItem('daily_journal_supabase_url', url);
    localStorage.setItem('daily_journal_supabase_key', key);
    updateSupabaseConfigUI();
    if (prev && (prev.url !== url || prev.key !== key)) {
        // 接続先を変えたときは、古い接続を残さないよう読み込み直す
        alert("接続設定を保存しました。アプリを読み込み直します。");
        location.reload();
        return;
    }
    alert("接続設定を保存しました。");
    initSupabase(url, key);
}

// 詳細設定で保存した接続先を消して、組み込みの接続先に戻す
function resetSupabaseConfig() {
    if (!hasBuiltInSupabaseConfig()) return;
    if (!confirm("詳細設定で保存した接続先を消して、アプリに組み込まれた接続先に戻しますか？\n（端末内の記録は消えません。戻したあとは、もう一度ログインが必要になることがあります）")) return;
    localStorage.removeItem('daily_journal_supabase_url');
    localStorage.removeItem('daily_journal_supabase_key');
    location.reload();
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
    // アプリに戻ってきたとき：
    // ・まだ未ログインの表示なら、ログイン状態を確認し直す（元の版にあった動作。iPhoneでログイン直後に反映されない場合の救済）
    // ・ログイン済みなら、未送信分の送信 → 差分取得
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || !supabaseClient) return;
        if (!supabaseUser) { checkSupabaseAuth(); return; }
        if (navigator.onLine) {
            syncNow(false);
            ensureRealtimeSubscribed();
        }
    });
    window.addEventListener('pageshow', (e) => { if (e.persisted && supabaseClient && !supabaseUser) checkSupabaseAuth(); });

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
        _setLoginFormVisible(false);

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
        _setLoginFormVisible(true);
        unsubscribeRealtime();
    }
    updateMigrateBoxVisibility();
    updateSyncStatusUI();
}

async function signUpSupabase() {
    if (!supabaseClient) return alert("接続設定を先に行ってください。");
    await _commitPendingInput();
    const email = document.getElementById('supabaseEmail').value.trim();
    const password = document.getElementById('supabasePassword').value;
    if (!email || !password) return alert("メールアドレスとパスワードを入力してください。");

    let error = null;
    try { ({ error } = await supabaseClient.auth.signUp({ email, password })); } catch (e) { error = e; }
    if (!error) _clearPasswordInput();
    if (error) {
        const msg = error.message || String(error);
        const hint = /signups? not allowed|signup.*disabled/i.test(msg) ? '\n\n新規登録は受け付けていません。アカウントは管理者が Supabase の管理画面で作成します。' : '';
        alert("登録エラー: " + msg + hint);
    }
    else {
        alert("登録完了！データの同期を開始します。");
        checkSupabaseAuth();
    }
}

// ログイン中はログイン欄を隠し、パスワードを画面（入力欄）に残さない。
// ※以前はログイン後もパスワードが入力欄に残っていたため、ページが読み込み直されると
//   iPhone が「パスワードを保存しますか？」と聞いてきた（入力欄にパスワードを残すこと自体も安全ではない）。
function _clearPasswordInput() {
    const pw = document.getElementById('supabasePassword');
    if (pw) pw.value = '';
}
function _setLoginFormVisible(show) {
    const f = document.getElementById('supabaseLoginForm');
    if (f) f.style.display = show ? '' : 'none';
    if (!show) _clearPasswordInput();
}

// iPhoneでは、自動入力や日本語入力の値が「入力欄から離れるまで」確定しないことがある。
// 送信前に入力欄のフォーカスを外し、少し待ってから値を読む。
async function _commitPendingInput() {
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.blur();
    await new Promise(r => setTimeout(r, 120));
}

async function signInSupabase() {
    if (!supabaseClient) return;
    await _commitPendingInput();
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
        const msg = error.message || String(error);
        let hint = '';
        if (/Invalid login credentials/i.test(msg)) {
            hint = '\n\nメールアドレスまたはパスワードが一致しません。次を確認してください：'
                + '\n・パスワード欄に、iPhoneの自動入力で別の値（Anon Keyなど）が入っていないか'
                + '\n・メールアドレスの大文字/小文字や前後の空白'
                + '\n・接続設定の Project URL が、ログインできている端末と同じか';
        } else if (/signups? not allowed|signup.*disabled/i.test(msg)) {
            hint = '\n\n新規登録は受け付けていません。アカウントは管理者が Supabase の管理画面で作成します。';
        } else if (/Email not confirmed/i.test(msg)) {
            hint = '\n\n登録確認メールのリンクをまだ開いていません。メールを確認してください。';
        }
        alert("ログインエラー: " + msg + hint);
        checkSupabaseAuth();
    } else {
        _clearPasswordInput();
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
    const rowHasInline = _journalRowHasInline(row);
    _noteInlineImages('j', d, rowHasInline);
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
    // 画像が行に直接入っている（以前のバージョンの不具合）なら、内容が同じでも送り直して Storage 参照に置き換える
    if (!unresolved && !rowHasInline && _daySig(result, tomb) === _daySig(remoteLogs, remoteTomb)) pendingJournalDates.delete(d);
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
    const rowHasInline = !row.deleted && typeof row.content === 'string' && row.content.indexOf('data:image') !== -1;
    _noteInlineImages('n', row.id, rowHasInline);
    // 画像が行に直接入っているノートは、内容が同じでも送り直して Storage 参照に置き換える
    const settle = () => { if (rowHasInline) pendingNotebookIds.add(row.id); else pendingNotebookIds.delete(row.id); };
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
        if (localDeleted === !!row.deleted) settle();
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
    settle();
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
    // ホームに出さないタイプ（false のものだけを持つ）。以前の版の端末が送った設定にはこの項目がない
    if (s.typeHomeSettings && typeof s.typeHomeSettings === 'object') {
        const h = boolMap(s.typeHomeSettings);
        out.typeHomeSettings = {};
        for (const k of Object.keys(h)) if (h[k] === false) out.typeHomeSettings[k] = false;
    }
    // タグの登録簿。以前の版の端末が送った設定にはこの項目がない
    if (Array.isArray(s.tagDefs)) out.tagDefs = sanitizeTagDefs(s.tagDefs);
    // 定型文。以前の版の端末が送った設定にはこの項目がない
    if (Array.isArray(s.templateDefs)) out.templateDefs = sanitizeTemplateDefs(s.templateDefs);
    out._editedAt = typeof s._editedAt === 'string' ? s._editedAt : '';
    return out;
}

// ------------------------------------------
// 設定の3方向マージ
// ------------------------------------------
// 以前は設定（タイプ・カテゴリ等）を「丸ごと1つ」として、編集時刻が新しい方で上書きしていた。
// そのため、別の端末の変更をまだ受け取っていない端末で何か1つ編集すると、
// その端末の古い一覧がクラウドを丸ごと上書きし、他の端末で追加したカテゴリやタイプが消えていた
// （端末の時計がずれていると、逆に後からした編集の方が消えることもあった）。
// → 「最後にクラウドと一致していた設定（基準）」を端末ごとに覚えておき、
//    基準からの自分の変更だけをクラウドの最新版に重ねる（項目単位のマージ）。
function _settingsBaseKey() { return 'daily_journal_settings_base_' + (supabaseUser ? supabaseUser.id : ''); }
function _loadSettingsBase() {
    try { const v = JSON.parse(localStorage.getItem(_settingsBaseKey()) || 'null'); return v ? sanitizeSettingsData(v) : null; } catch (e) { return null; }
}
function _saveSettingsBase(s) {
    if (typeof isTabActive === 'function' && !isTabActive()) return;
    if (!supabaseUser || !s) return;
    localStorage.setItem(_settingsBaseKey(), JSON.stringify({
        appTypes: s.appTypes || [], categories: s.categories || [],
        typeSlackSettings: s.typeSlackSettings || {}, typeNotebookSettings: s.typeNotebookSettings || {},
        typeHomeSettings: s.typeHomeSettings || {},
        tagDefs: s.tagDefs || [],
        templateDefs: s.templateDefs || [],
        _editedAt: s._editedAt || ''
    }));
}
function _currentSettings() {
    return sanitizeSettingsData({ appTypes, categories, typeSlackSettings, typeNotebookSettings, typeHomeSettings, tagDefs, templateDefs, _editedAt: getSettingsEditedAt() });
}

// 並び順付きの一覧（タイプ名 / カテゴリ）のマージ。keyOf で同一項目を判定し、pick で中身を選ぶ
function _mergeOrderedList(base, local, remote, keyOf, pick) {
    base = base || null; local = local || []; remote = remote || [];
    const bMap = new Map((base || []).map(x => [keyOf(x), x]));
    const lMap = new Map(local.map(x => [keyOf(x), x]));
    const rMap = new Map(remote.map(x => [keyOf(x), x]));
    const keep = new Map();
    for (const [k, r] of rMap) {
        if (base && bMap.has(k) && !lMap.has(k)) continue;          // この端末で削除した
        keep.set(k, pick(bMap.get(k), lMap.get(k), r));
    }
    for (const [k, l] of lMap) {
        if (rMap.has(k)) continue;
        // 基準にあってクラウドにない ＝ 他の端末で削除された。この端末で手を加えていなければ削除を受け入れる
        if (base && bMap.has(k) && _sameItem(bMap.get(k), l)) continue;
        keep.set(k, l);                                              // この端末で追加した（または削除と編集が競合→残す）
    }

    // 並び順：この端末で並べ替えていればこの端末の順、そうでなければクラウドの順（新規分はこの端末での位置の近くへ）
    const common = (arr) => arr.map(keyOf).filter(k => bMap.has(k) && lMap.has(k));
    const localReordered = !!base && JSON.stringify(common(local)) !== JSON.stringify(common(base).filter(k => lMap.has(k)));
    const order = [];
    const seen = new Set();
    const push = k => { if (keep.has(k) && !seen.has(k)) { seen.add(k); order.push(k); } };
    if (localReordered) { local.forEach(x => push(keyOf(x))); remote.forEach(x => push(keyOf(x))); }
    else {
        // クラウドの順に並べ、この端末で追加した項目は、直前の項目の後ろに差し込む
        const remoteKeys = remote.map(keyOf);
        const afterMap = new Map();
        let prev = null;
        for (const x of local) {
            const k = keyOf(x);
            if (!rMap.has(k)) { const arr = afterMap.get(prev) || []; arr.push(k); afterMap.set(prev, arr); }
            else prev = k;
        }
        (afterMap.get(null) || []).forEach(push);
        for (const k of remoteKeys) { push(k); (afterMap.get(k) || []).forEach(push); }
        local.forEach(x => push(keyOf(x)));
    }
    return order.map(k => keep.get(k));
}
function _sameItem(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// { キー: 真偽 } のマージ（キー単位で、この端末が変えたものだけ優先）
function _mergeBoolMap(base, local, remote) {
    base = base || null; local = local || {}; remote = remote || {};
    const out = {};
    const keys = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base || {})]);
    for (const k of keys) {
        const inB = !!base && k in base, inL = k in local, inR = k in remote;
        if (inB && !inL) continue;                                  // この端末で削除
        if (inL && (!inB || local[k] !== base[k])) { out[k] = local[k]; continue; } // この端末で追加・変更
        if (inR) { out[k] = remote[k]; continue; }                  // クラウドの値（他端末の変更を含む）
        if (inL && !inB) out[k] = local[k];
        // inB && inL && !inR（他端末で削除・この端末は未変更）→ 削除を受け入れる
    }
    return out;
}

function _mergeSettings(base, local, remote) {
    const typePick = (b, l, r) => r;
    const catPick = (b, l, r) => {
        if (l && (!b || l.type !== b.type)) return l;   // この端末で追加・所属タイプ変更
        return r || l;
    };
    return {
        appTypes: _mergeOrderedList(base && base.appTypes, local.appTypes, remote.appTypes, x => x, typePick),
        categories: _mergeOrderedList(base && base.categories, local.categories, remote.categories, x => x.name, catPick),
        typeSlackSettings: _mergeBoolMap(base && base.typeSlackSettings, local.typeSlackSettings, remote.typeSlackSettings),
        typeNotebookSettings: _mergeBoolMap(base && base.typeNotebookSettings, local.typeNotebookSettings, remote.typeNotebookSettings),
        // クラウドにこの項目がない（以前の版の端末が送った）場合は、この端末の設定を残す
        typeHomeSettings: remote.typeHomeSettings
            ? _mergeBoolMap(base && base.typeHomeSettings, local.typeHomeSettings, remote.typeHomeSettings)
            : Object.assign({}, local.typeHomeSettings || {}),
        // タグ：名前ごとに、この端末で変えたもの（追加・お気に入り・タイプの付け替え）を優先
        tagDefs: remote.tagDefs
            ? _mergeOrderedList(base && base.tagDefs, local.tagDefs || [], remote.tagDefs, x => x.name, (b, l, r) => (l && (!b || !_sameItem(l, b))) ? l : (r || l))
            : (local.tagDefs || []).slice(),
        // 定型文：ID ごとに、この端末で変えたもの（追加・編集・並べ替え）を優先
        templateDefs: remote.templateDefs
            ? _mergeOrderedList(base && base.templateDefs, local.templateDefs || [], remote.templateDefs, x => x.id, (b, l, r) => (l && (!b || !_sameItem(l, b))) ? l : (r || l))
            : (local.templateDefs || []).slice(),
        _editedAt: remote._editedAt
    };
}

async function _applySettingsData(s, editedAt = s._editedAt) {
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
    if (Array.isArray(s.templateDefs)) {
        templateDefs.splice(0, templateDefs.length, ...s.templateDefs.map(d => Object.assign({}, d, { tags: (d.tags || []).slice() })));
        localStorage.setItem('daily_journal_templates', JSON.stringify(templateDefs));
    }
    if (Array.isArray(s.tagDefs)) {
        tagDefs.splice(0, tagDefs.length, ...s.tagDefs.map(d => Object.assign({}, d)));
        localStorage.setItem('daily_journal_tags', JSON.stringify(tagDefs));
    }
    if (s.typeHomeSettings) {
        Object.keys(typeHomeSettings).forEach(k => delete typeHomeSettings[k]);
        Object.assign(typeHomeSettings, s.typeHomeSettings);
        localStorage.setItem('daily_journal_type_home', JSON.stringify(typeHomeSettings));
    }
    localStorage.setItem(SETTINGS_EDITED_AT_KEY, editedAt || '');
    if (typeof syncAndMigrateCategories === 'function') await syncAndMigrateCategories();
}

// 以前のバージョンから使っている端末では、設定（タイプ・カテゴリ）はあっても「編集時刻」の記録がなく、
// 「未送信の変更なし」と扱われていた。そのため、
//   ・クラウドに設定がなければ、いつまでも送信されない（記録は届くのに、設定だけ他の端末に届かない）
//   ・クラウドに設定があれば、その内容でこの端末の設定が上書きされて消える
// という不具合があった。
// → このアカウントとまだ一度も設定を同期していない端末（基準がない端末）は、
//    手元の設定を「未送信の変更」として扱い、クラウドの設定と合わせてから送る（どちらの項目も消さない）。
//    ただし、既定値のまま一度も触っていない端末（新しく入れたiPhoneなど）は、何も送らずクラウドの設定を受け取る。
function _isUntouchedDefaultSettings() {
    if (typeof DEFAULT_TYPES === 'undefined' || typeof DEFAULT_CATEGORIES === 'undefined') return false;
    const norm = cs => JSON.stringify((cs || []).map(c => [c.name, c.type]));
    return JSON.stringify(appTypes) === JSON.stringify(DEFAULT_TYPES) && norm(categories) === norm(DEFAULT_CATEGORIES);
}
function _claimUnsyncedLocalSettings() {
    if (!supabaseUser || pendingSettingsDirty || _loadSettingsBase()) return;
    if (typeof isTabActive === 'function' && !isTabActive()) return;
    if (_isUntouchedDefaultSettings()) return;
    pendingSettingsDirty = true;
    _settingsDirtyVer++;
    if (!getSettingsEditedAt()) localStorage.setItem(SETTINGS_EDITED_AT_KEY, new Date().toISOString());
    _persistPending();
}

// 戻り値: ローカル設定（画面に出る内容）が変わったら true
async function mergeRemoteSettingsRow(row) {
    const s = sanitizeSettingsData(row && row.settings_data);
    if (!s) return false;
    _claimUnsyncedLocalSettings();
    const localEdited = getSettingsEditedAt();

    if (!pendingSettingsDirty) {
        // この端末に未送信の変更はない → クラウドの設定をそのまま採用
        if (localEdited && localEdited === s._editedAt) { _saveSettingsBase(s); return false; } // 同一
        const before = JSON.stringify(_currentSettings());
        await _applySettingsData(s);
        _saveSettingsBase(s);
        _persistPending();
        return JSON.stringify(_currentSettings()) !== before;
    }

    // この端末に未送信の変更がある → 基準からの自分の変更だけをクラウドの最新版に重ねる（時刻の新旧では決めない）
    const local = _currentSettings();
    const merged = _mergeSettings(_loadSettingsBase(), local, s);
    const before = JSON.stringify(local);
    // マージ結果は送信するので未送信のまま。送信する版には新しい編集時刻を付け、他端末が確実に取り込むようにする
    await _applySettingsData(merged, new Date().toISOString());
    _saveSettingsBase(s); // 自分の変更は「クラウドの s からの差分」になった
    _persistPending();
    return JSON.stringify(_currentSettings()) !== before;
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
        _claimUnsyncedLocalSettings();
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
    // ※以前はここでクラウド側を採用したら送信せずに終えていたが、マージ後の自分の変更も送る必要がある
    if (remote && await mergeRemoteSettingsRow(remote)) refreshUIAfterSync();
    if (!pendingSettingsDirty) return;

    if (!getSettingsEditedAt()) localStorage.setItem(SETTINGS_EDITED_AT_KEY, new Date().toISOString());
    const data = JSON.parse(JSON.stringify({
        appTypes, categories, typeSlackSettings, typeNotebookSettings, typeHomeSettings, tagDefs, templateDefs,
        _editedAt: getSettingsEditedAt()
    }));
    const payload = { user_id: supabaseUser.id, settings_data: data, updated_at: new Date().toISOString() };
    const { error } = await supabaseClient.from('app_settings').upsert(payload);
    if (error) throw error;
    _saveSettingsBase(sanitizeSettingsData(data));
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
            _noteInlineImages('j', p.date_str, false); // 送信する行の画像は必ず Storage 参照になっている
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
            _noteInlineImages('n', p.id, false);
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
        else { _claimUnsyncedLocalSettings(); if (fullSync && getSettingsEditedAt() && !_isUntouchedDefaultSettings()) pendingSettingsDirty = true; }

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
        if (!_loadInlineState().scanned) { try { await _scanInlineImagesOnce(); } catch (e) { console.warn('画像の埋め込み確認に失敗しました（次回やり直します）', e); } }
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
    // クラウドにだけ残っている行も対象にする（送信前にクラウドの行を読み込んでマージするので、画像も Storage に移る）
    const inl = _loadInlineState();
    inl.j.forEach(d => { if (DATE_KEY_RE.test(d)) pendingJournalDates.add(d); });
    inl.n.forEach(id => { if (isSafeId(id)) pendingNotebookIds.add(id); });
    _persistPending();
    await syncNow(false);
    if (_lastSyncError || _schemaState === 'outdated') alert("移行を完了できませんでした。通信状態とサーバー設定を確認し、時間をおいて再度お試しください。");
    else alert("移行が完了しました。Supabaseダッシュボードの Storage と Table Editor でサイズをご確認ください。");
    updateMigrateBoxVisibility();
}

// ==========================================
// 8.4 「データベース軽量化」ボタンの表示判定
// ==========================================
// 以前のバージョンの不具合で、画像が Storage ではなくデータベースの行に直接入ってしまっている場合だけ
// 「軽量化（画像の再アップロード）」を表示する。
// どの行に画像が直接入っているかは、取得（マージ）・送信のたびに記録する。
// 以前から使っている端末は、差分取得では古い行を見直さないので、最初の1回だけ全行を確認する。
function _inlineStateKey() { return 'daily_journal_cloud_inline_' + (supabaseUser ? supabaseUser.id : ''); }
let _inlineStateCache = { key: null, st: null };
function _loadInlineState() {
    const k = _inlineStateKey();
    if (_inlineStateCache.key !== k) {
        let st = null;
        try { st = JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { st = null; }
        if (!st || typeof st !== 'object') st = {};
        _inlineStateCache = { key: k, st: { j: Array.isArray(st.j) ? st.j : [], n: Array.isArray(st.n) ? st.n : [], scanned: !!st.scanned } };
    }
    return _inlineStateCache.st;
}
function _saveInlineState() {
    if (!supabaseUser || (typeof isTabActive === 'function' && !isTabActive())) return;
    localStorage.setItem(_inlineStateKey(), JSON.stringify(_loadInlineState()));
}
function _journalRowHasInline(row) {
    const logs = Array.isArray(row && row.log_data) ? row.log_data : [];
    return logs.some(l => l && [].concat(Array.isArray(l.images) ? l.images : [], l.image ? [l.image] : [])
        .some(s => typeof s === 'string' && s.startsWith('data:image')));
}
function _noteInlineImages(kind, key, has) {
    if (!supabaseUser) return;
    const st = _loadInlineState();
    const arr = st[kind];
    const i = arr.indexOf(key);
    if (has && i === -1) arr.push(key);
    else if (!has && i !== -1) arr.splice(i, 1);
    else return;
    _saveInlineState();
    updateMigrateBoxVisibility();
}
function hasCloudInlineImages() {
    if (!supabaseUser) return false;
    const st = _loadInlineState();
    return st.j.length > 0 || st.n.length > 0;
}
function updateMigrateBoxVisibility() {
    const box = document.getElementById('supabaseMigrateBox');
    if (box) box.style.display = (supabaseClient && hasCloudInlineImages()) ? 'block' : 'none';
}
async function _scanInlineImagesOnce() {
    const st = _loadInlineState();
    const j = await _selectAllColumns('journals', 'date_str,log_data');
    const n = await _selectAllColumns('notebooks', 'id,content,deleted');
    st.j = j.filter(_journalRowHasInline).map(r => r.date_str);
    st.n = n.filter(r => !r.deleted && typeof r.content === 'string' && r.content.indexOf('data:image') !== -1).map(r => r.id);
    st.scanned = true;
    _saveInlineState();
    updateMigrateBoxVisibility();
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
                settings_data: { appTypes, categories, typeSlackSettings, typeNotebookSettings, typeHomeSettings, tagDefs, templateDefs, _editedAt: getSettingsEditedAt() }
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
        if (typeof renderSettingsTagList === 'function') renderSettingsTagList();
    }
    if (typeof refreshOpenTagUIs === 'function') refreshOpenTagUIs();
    if (typeof refreshOpenTemplateUIs === 'function') refreshOpenTemplateUIs();
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

// ==========================================
// 10. クラウドの画像の使用量（設定 > データ の容量メーター用）
// ==========================================
// Storage の自分のフォルダの一覧から、枚数・合計サイズ・最近の増え方を数える（画像そのものはダウンロードしない）
async function measureCloudImages() {
    if (!supabaseClient || !supabaseUser) return null;
    const objects = await _listAllImages(supabaseUser.id);
    const now = Date.now();
    let bytes = 0, recent = 0, oldest = now;
    for (const o of objects) {
        const size = (o.metadata && o.metadata.size) || 0;
        bytes += size;
        const t = Date.parse(o.created_at || o.updated_at || '');
        if (!isNaN(t)) {
            if (t < oldest) oldest = t;
            if (now - t <= 30 * 86400000) recent += size;
        }
    }
    // 1日あたりの増え方：直近30日の分から。使い始めて30日未満なら、使い始めからの平均（7日未満は出さない）
    const spanDays = (now - oldest) / 86400000;
    let perDay = null;
    if (spanDays >= 30) perDay = recent / 30;
    else if (spanDays >= 7) perDay = bytes / spanDays;
    return { count: objects.length, bytes, perDay, checkedAt: new Date().toISOString(), userId: supabaseUser.id };
}
function isCloudLoggedIn() { return !!(supabaseClient && supabaseUser); }
