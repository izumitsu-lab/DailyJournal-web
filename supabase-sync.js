// ==========================================
// supabase-sync.js (Supabase 連携・オフライン耐性・リアルタイム反映版)
// ==========================================
//
// このファイルで解決している問題:
// 1. オフライン時に保存した内容が「送信済み」扱いになり、二度と再送されなくなるバグを修正
//    （送信は「成功が確認できるまでは未送信のまま」を徹底し、失敗時は必ず再送キューに残す）
// 2. 未送信キューを localStorage に永続化し、オンライン復帰時・アプリ復帰時・定期的に自動で再送する
// 3. 他デバイスの更新が「いつ届くか分からない」問題を解消するため、
//    Supabase Realtime（即時通知）＋ 画面復帰時の差分取得の二段構えで反映タイミングを明確にする
// 4. 通信量を抑えるため、通常時は「前回同期以降に更新された行だけ」を取得する（全件取得は初回ログイン時のみ）
// 5. 同期状態（未送信件数・オフライン・同期済み時刻）を画面に明示し、手動で「今すぐ同期」できる手段を用意する

let supabaseClient = null;
let supabaseUser = null;
let isPulling = false;
let isOnline = navigator.onLine;
let realtimeChannel = null;
let _listenersBound = false;

let journalPushTimer = null;
let notebookPushTimer = null;
let settingsPushTimer = null;
let retryLoopTimer = null;

// 直近でクラウドと一致していることが確認できた内容（自分の書き込みのエコーを無視するために使う）
let lastSyncedJournals = {};
let lastSyncedNotebooks = {};

// ==========================================
// 0. 未送信キュー（オフライン等で送れなかったデータを覚えておく）
// ==========================================

function _safeParseArray(key) {
    try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return []; }
}

let pendingJournalDates = new Set(_safeParseArray('daily_journal_pending_journals'));
let pendingNotebookIds = new Set(_safeParseArray('daily_journal_pending_notebooks'));
let pendingSettingsDirty = localStorage.getItem('daily_journal_pending_settings') === '1';

function _persistPending() {
    localStorage.setItem('daily_journal_pending_journals', JSON.stringify([...pendingJournalDates]));
    localStorage.setItem('daily_journal_pending_notebooks', JSON.stringify([...pendingNotebookIds]));
    localStorage.setItem('daily_journal_pending_settings', pendingSettingsDirty ? '1' : '0');
}

function getPendingCount() {
    return pendingJournalDates.size + pendingNotebookIds.size + (pendingSettingsDirty ? 1 : 0);
}

// 画面上の同期状態表示（バーの更新ボタン・設定画面のステータス行）を更新
function updateSyncStatusUI() {
    const icon = document.getElementById('btnSyncPullIcon');
    const statusEl = document.getElementById('supabaseSyncStatus');
    if (!icon && !statusEl) return;

    let text, iconChar, color;
    const configured = !!localStorage.getItem('daily_journal_supabase_url');

    if (!configured) {
        return;
    } else if (!supabaseUser) {
        text = "未ログイン（本体保存のみ）"; iconChar = "☁️"; color = "var(--text-secondary)";
    } else if (!isOnline) {
        text = getPendingCount() > 0 ? `オフライン（未送信 ${getPendingCount()} 件・復帰後に自動送信）` : "オフライン（本体には保存済み）";
        iconChar = "📴"; color = "#e67e22";
    } else if (getPendingCount() > 0) {
        text = `同期中… (未送信 ${getPendingCount()} 件)`;
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
// 1. 初期化と設定管理
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
    const savedUrl = localStorage.getItem('daily_journal_supabase_url');
    const savedKey = localStorage.getItem('daily_journal_supabase_key');

    const urlInput = document.getElementById('supabaseUrlInput');
    const keyInput = document.getElementById('supabaseKeyInput');

    if (urlInput && savedUrl) urlInput.value = savedUrl;
    if (keyInput && savedKey) keyInput.value = savedKey;

    if (savedUrl && savedKey) {
        initSupabase(savedUrl, savedKey);
    }
});

function initSupabase(url, key) {
    if (!window.supabase) return;
    try {
        supabaseClient = window.supabase.createClient(url, key);
        document.getElementById('supabaseAuthBox').style.display = 'block';
        document.getElementById('supabaseSetupBox').style.display = 'block';
        checkSupabaseAuth();
        hookCoreStorage();
        setupNetworkAndLifecycleListeners();
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

// 通信状態・アプリ復帰イベントを監視し、然るべきタイミングで自動的に再同期する
function setupNetworkAndLifecycleListeners() {
    if (_listenersBound) return;
    _listenersBound = true;

    window.addEventListener('online', () => {
        isOnline = true;
        updateSyncStatusUI();
        // オンラインに戻った瞬間に、溜まっていた未送信データを送る
        flushPendingPush();
    });
    window.addEventListener('offline', () => {
        isOnline = false;
        updateSyncStatusUI();
    });

    // スマホでアプリを閉じて→開き直した時など、Realtime接続が切れている間の更新を確実に拾う
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && supabaseClient && supabaseUser && navigator.onLine) {
            flushPendingPush();
            pullFromSupabase(false); // 差分のみ（通信量節約）
            ensureRealtimeSubscribed();
        }
    });

    // 一定間隔で「送れていないデータ」がないか確認し、あれば再送を試みる（保険）
    clearInterval(retryLoopTimer);
    retryLoopTimer = setInterval(() => {
        if (navigator.onLine && supabaseClient && supabaseUser && getPendingCount() > 0) {
            flushPendingPush();
        }
    }, 20000);
}

// 手動同期（設定画面・更新ボタンから呼ばれる）：確実性を優先し、未送信分の送信＋全件チェックを行う
async function forceSyncNow() {
    if (!supabaseClient || !supabaseUser) {
        alert("先にSupabaseへログインしてください。");
        return;
    }
    updateSyncStatusUI();
    await flushPendingPush();
    await pullFromSupabase(true);
    updateSyncStatusUI();
}

// ==========================================
// 2. 認証 (Auth) 処理
// ==========================================

async function checkSupabaseAuth() {
    if (!supabaseClient) return;
    const { data: { session } } = await supabaseClient.auth.getSession();
    const statusEl = document.getElementById('supabaseAuthStatus');
    const logoutBtn = document.getElementById('supabaseLogoutBtn');

    if (session && session.user) {
        supabaseUser = session.user;
        statusEl.textContent = `ログイン中: ${supabaseUser.email}`;
        statusEl.style.color = "var(--notebook-color)";
        logoutBtn.style.display = "inline-flex";

        await pullFromSupabase(true); // 初回は全件同期
        ensureRealtimeSubscribed();
        if (getPendingCount() > 0) flushPendingPush(); // 前回オフラインで送れなかった分があれば送る
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

    const { error } = await supabaseClient.auth.signUp({ email, password });
    if (error) alert("登録エラー: " + error.message);
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

    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) alert("ログインエラー: " + error.message);
    else {
        alert("ログインしました。クラウドのデータと同期します。");
        checkSupabaseAuth();
    }
}

async function signOutSupabase() {
    if (!supabaseClient) return;
    await supabaseClient.auth.signOut();
    unsubscribeRealtime();
    alert("ログアウトしました。これ以降は本体のみに保存されます。");
    checkSupabaseAuth();
}

// ==========================================
// 3. 画像のハッシュ化・無駄ゼロ通信モジュール
// ==========================================

// Base64から固有のハッシュ（ID）を生成する
async function getHash(str) {
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// アップロード（重複時は通信をスキップして即URLを返す）
async function uploadImageToSupabase(base64Str) {
    if (!base64Str || !base64Str.startsWith('data:image')) return base64Str;
    try {
        const hash = await getHash(base64Str);
        const ext = base64Str.substring(base64Str.indexOf('/') + 1, base64Str.indexOf(';')) || 'jpeg';
        const fileName = `img_${hash}.${ext}`;
        const filePath = `${supabaseUser.id}/${fileName}`;

        const { data: publicUrlData } = supabaseClient.storage.from('images').getPublicUrl(filePath);

        // 同一ファイル名（ハッシュ）でアップロードを試みる
        const res = await fetch(base64Str);
        const blob = await res.blob();
        const { error } = await supabaseClient.storage.from('images').upload(filePath, blob, { upsert: false });

        // エラーが出ても「既に存在する(Duplicate)」なら正常なのでそのままURLを返す
        if (error && !error.message.includes('already exists') && !error.message.includes('Duplicate')) {
            throw error;
        }

        return publicUrlData.publicUrl;
    } catch (err) {
        console.error("画像アップロード失敗:", err);
        throw err; // 呼び出し元（push処理）に失敗を伝え、確実に再送キューに残す
    }
}

// ダウンロード（本当にローカルに無い時だけ通信する）
async function downloadImageToBase64(url) {
    if (!url || !url.startsWith('http')) return url;
    try {
        const res = await fetch(url);
        const blob = await res.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        console.error("画像ダウンロード失敗:", e);
        return url;
    }
}

// ==========================================
// 4. ブラウザ・ストレージの直接監視 (フック)
// ==========================================

const _originalSetItem = localStorage.setItem;
const _originalSetDBData = window.setDBData;

function hookCoreStorage() {
    localStorage.setItem = function(key, value) {
        _originalSetItem.call(this, key, value);

        if (['daily_journal_categories', 'daily_journal_types', 'daily_journal_type_slack', 'daily_journal_type_notebook'].includes(key)) {
            pendingSettingsDirty = true;
            _persistPending();
            updateSyncStatusUI();
            clearTimeout(settingsPushTimer);
            settingsPushTimer = setTimeout(() => {
                if (supabaseClient && supabaseUser && !isPulling) pushSettingsToSupabase();
            }, 1000);
        }
    };

    if (_originalSetDBData) {
        window.setDBData = function(key, value) {
            // ★完全なBase64データをローカル本体に保存（これは通信状況に関係なく必ず成功する）
            const promise = _originalSetDBData(key, value);

            // クラウド送信処理へ（送信そのものが失敗しても本体保存には影響しない）
            if (supabaseClient && supabaseUser && !isPulling) {
                if (key === 'journalData') {
                    clearTimeout(journalPushTimer);
                    const payloadCopy = JSON.parse(JSON.stringify(value));
                    journalPushTimer = setTimeout(() => pushJournalsToSupabase(payloadCopy), 800);
                } else if (key === 'notebookData') {
                    clearTimeout(notebookPushTimer);
                    const payloadCopy = JSON.parse(JSON.stringify(value));
                    notebookPushTimer = setTimeout(() => pushNotebooksToSupabase(payloadCopy), 800);
                }
            }
            return promise;
        };
    }
}

// ==========================================
// 5. データ送信 (Push) 処理
// ==========================================
// 方針：「クラウドへの送信が確認できるまでは、常に未送信キューに残す」。
// これにより、オフライン時の入力や通信断は自動的に検知され、
// オンライン復帰時・アプリ復帰時・20秒毎のリトライのいずれかで必ず再送される。

async function pushSettingsToSupabase() {
    if (!supabaseClient || !supabaseUser) return;
    try {
        const payload = {
            user_id: supabaseUser.id,
            settings_data: {
                appTypes: typeof appTypes !== 'undefined' ? appTypes : [],
                categories: typeof categories !== 'undefined' ? categories : [],
                typeSlackSettings: typeof typeSlackSettings !== 'undefined' ? typeSlackSettings : {},
                typeNotebookSettings: typeof typeNotebookSettings !== 'undefined' ? typeNotebookSettings : {}
            },
            updated_at: new Date().toISOString()
        };
        const { error } = await supabaseClient.from('app_settings').upsert(payload);
        if (error) throw error;
        pendingSettingsDirty = false;
    } catch (e) {
        console.warn("設定の同期に失敗しました（オフライン等）。オンライン復帰後に再送します。", e);
        // pendingSettingsDirty はtrueのまま残す＝次回リトライ対象
    } finally {
        _persistPending();
        updateSyncStatusUI();
    }
}

// force=true の場合、差分比較をスキップして「渡された日付は必ず送信を試みる」
// （未送信キューからの再送時に使用。再送時にlastSyncedJournalsが信頼できるとは限らないため）
async function pushJournalsToSupabase(cloudJData, force = false) {
    if (!supabaseClient || !supabaseUser) return;
    const payload = [];

    for (const dateStr of Object.keys(cloudJData)) {
        // Base64の状態（本体と同じ状態）のJSONで比較する
        const currentJson = JSON.stringify(cloudJData[dateStr]);
        if (!force && currentJson === lastSyncedJournals[dateStr]) continue;

        // ここで「未送信」として即マーク。送信に成功するまではこの印を消さない。
        pendingJournalDates.add(dateStr);

        try {
            // 通信用のコピーの画像だけをURL化する
            for (const log of cloudJData[dateStr]) {
                if (log.images && log.images.length > 0) {
                    for (let i = 0; i < log.images.length; i++) {
                        if (log.images[i].startsWith('data:image')) {
                            log.images[i] = await uploadImageToSupabase(log.images[i]);
                        }
                    }
                }
                if (log.image && log.image.startsWith('data:image')) {
                    log.image = await uploadImageToSupabase(log.image);
                }
            }

            payload.push({
                date_str: dateStr,
                user_id: supabaseUser.id,
                log_data: cloudJData[dateStr],
                updated_at: new Date().toISOString()
            });
        } catch (imgErr) {
            // 画像アップロード自体がオフライン等で失敗。この日付は未送信のまま次回に回す。
            console.warn(`画像アップロード失敗のため ${dateStr} は未送信のままにします。`, imgErr);
        }
    }

    _persistPending();
    updateSyncStatusUI();

    if (payload.length === 0) return;

    try {
        const { error } = await supabaseClient.from('journals').upsert(payload);
        if (error) throw error;

        // ここまで来て初めて「送信済み」に確定する
        for (const p of payload) {
            lastSyncedJournals[p.date_str] = JSON.stringify(p.log_data);
            pendingJournalDates.delete(p.date_str);
        }
    } catch (e) {
        console.warn("Journal同期に失敗しました（オフライン等）。オンライン復帰後に自動で再送します。", e);
        // 失敗時は何もしない＝pendingJournalDatesに残ったままになる（重要：ここが従来のバグの修正点）
    } finally {
        _persistPending();
        updateSyncStatusUI();
    }
}

async function pushNotebooksToSupabase(cloudNData, force = false) {
    if (!supabaseClient || !supabaseUser) return;
    const payload = [];

    for (const cloudNote of cloudNData) {
        const currentJson = JSON.stringify(cloudNote);
        if (!force && currentJson === lastSyncedNotebooks[cloudNote.id]) continue;

        pendingNotebookIds.add(cloudNote.id);

        try {
            if (cloudNote.content && cloudNote.content.includes('data:image')) {
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = cloudNote.content;
                const imgs = tempDiv.querySelectorAll('img[src^="data:image"]');
                for (let img of imgs) {
                    const url = await uploadImageToSupabase(img.src);
                    if (url && url !== img.src) img.src = url;
                }
                cloudNote.content = tempDiv.innerHTML;
            }

            payload.push({
                id: cloudNote.id,
                user_id: supabaseUser.id,
                title: cloudNote.title || '',
                content: cloudNote.content || '',
                category: cloudNote.category || 'ライフログ',
                status: cloudNote.status || 'archive',
                linked_note_ids: cloudNote.linkedNoteIds || [],
                created_at: cloudNote.createdAt || new Date().toISOString(),
                updated_at: cloudNote.updatedAt || new Date().toISOString()
            });
        } catch (imgErr) {
            console.warn(`画像アップロード失敗のためノート ${cloudNote.id} は未送信のままにします。`, imgErr);
        }
    }

    _persistPending();
    updateSyncStatusUI();

    if (payload.length === 0) return;

    try {
        const { error } = await supabaseClient.from('notebooks').upsert(payload);
        if (error) throw error;

        for (const p of payload) {
            lastSyncedNotebooks[p.id] = JSON.stringify(cloudNData.find(n => n.id === p.id));
            pendingNotebookIds.delete(p.id);
        }
    } catch (e) {
        console.warn("Notebook同期に失敗しました（オフライン等）。オンライン復帰後に自動で再送します。", e);
    } finally {
        _persistPending();
        updateSyncStatusUI();
    }
}

// 未送信キューにあるものだけを対象に、最新のローカルデータから再送を試みる
// （オンライン復帰時・アプリ復帰時・定期リトライ・手動同期ボタンから呼ばれる）
async function flushPendingPush() {
    if (!supabaseClient || !supabaseUser || !navigator.onLine) return;

    if (pendingSettingsDirty) {
        await pushSettingsToSupabase();
    }

    if (pendingJournalDates.size > 0) {
        const jData = typeof journalData !== 'undefined' ? journalData : window.journalData;
        const subset = {};
        for (const d of pendingJournalDates) {
            if (jData && jData[d]) subset[d] = jData[d];
            else pendingJournalDates.delete(d); // 該当データがもう存在しない（削除済み等）
        }
        if (Object.keys(subset).length > 0) {
            await pushJournalsToSupabase(JSON.parse(JSON.stringify(subset)), true);
        }
    }

    if (pendingNotebookIds.size > 0) {
        const nData = typeof notebookData !== 'undefined' ? notebookData : window.notebookData;
        // 既にローカルから消えたノートのIDはキューから外す（削除済みなので送りようがない）
        for (const id of [...pendingNotebookIds]) {
            if (!nData.some(n => n.id === id)) pendingNotebookIds.delete(id);
        }
        const subset = (nData || []).filter(n => pendingNotebookIds.has(n.id));
        if (subset.length > 0) {
            await pushNotebooksToSupabase(JSON.parse(JSON.stringify(subset)), true);
        }
    }

    _persistPending();
    updateSyncStatusUI();
}

// ==========================================
// 6. クラウドからのデータ取得 (Pull) と 無駄ゼロ復元
// ==========================================

// ローカルに保存されている画像をハッシュ辞書としてまとめる（照合用）
async function extractLocalImagesDict() {
    const dict = {};
    const jData = typeof journalData !== 'undefined' ? journalData : window.journalData;
    const nData = typeof notebookData !== 'undefined' ? notebookData : window.notebookData;

    // ジャーナルの画像を抽出
    for (const d of Object.keys(jData)) {
        for (const log of jData[d]) {
            if (log.images) {
                for (const b64 of log.images) {
                    if (b64.startsWith('data:image')) {
                        const h = await getHash(b64);
                        dict[h] = b64;
                    }
                }
            }
            if (log.image && log.image.startsWith('data:image')) {
                const h = await getHash(log.image);
                dict[h] = log.image;
            }
        }
    }
    // ノートブックの画像を抽出
    for (const note of nData) {
        if (note.content && note.content.includes('data:image')) {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = note.content;
            const imgs = tempDiv.querySelectorAll('img[src^="data:image"]');
            for (let img of imgs) {
                const h = await getHash(img.src);
                dict[h] = img.src;
            }
        }
    }
    return dict;
}

function applySettingsData(s) {
    if (s.appTypes && typeof appTypes !== 'undefined') {
        appTypes.splice(0, appTypes.length, ...s.appTypes);
        _originalSetItem.call(localStorage, 'daily_journal_types', JSON.stringify(appTypes));
    }
    if (s.categories && typeof categories !== 'undefined') {
        categories.splice(0, categories.length, ...s.categories);
        _originalSetItem.call(localStorage, 'daily_journal_categories', JSON.stringify(categories));
    }
    if (s.typeSlackSettings && typeof typeSlackSettings !== 'undefined') {
        Object.keys(typeSlackSettings).forEach(k => delete typeSlackSettings[k]);
        Object.assign(typeSlackSettings, s.typeSlackSettings);
        _originalSetItem.call(localStorage, 'daily_journal_type_slack', JSON.stringify(typeSlackSettings));
    }
    if (s.typeNotebookSettings && typeof typeNotebookSettings !== 'undefined') {
        Object.keys(typeNotebookSettings).forEach(k => delete typeNotebookSettings[k]);
        Object.assign(typeNotebookSettings, s.typeNotebookSettings);
        _originalSetItem.call(localStorage, 'daily_journal_type_notebook', JSON.stringify(typeNotebookSettings));
    }
}

// クラウドの1行分（1日分のjournal）をローカルへ反映。呼び出し元でrender/保存を行う。
async function mergeJournalRow(row, localImagesDict) {
    const jData = typeof journalData !== 'undefined' ? journalData : window.journalData;
    const downloadedLogs = row.log_data;

    for (const log of downloadedLogs) {
        if (log.images && log.images.length > 0) {
            for (let i = 0; i < log.images.length; i++) {
                if (log.images[i].startsWith('http')) {
                    const match = log.images[i].match(/img_([a-f0-9]+)\./);
                    if (match && match[1] && localImagesDict[match[1]]) {
                        log.images[i] = localImagesDict[match[1]]; // 通信回避！ローカルデータで復元
                    } else {
                        log.images[i] = await downloadImageToBase64(log.images[i]); // 新規画像のみダウンロード
                    }
                }
            }
        }
        if (log.image && log.image.startsWith('http')) {
            const match = log.image.match(/img_([a-f0-9]+)\./);
            if (match && match[1] && localImagesDict[match[1]]) {
                log.image = localImagesDict[match[1]];
            } else {
                log.image = await downloadImageToBase64(log.image);
            }
        }
    }

    jData[row.date_str] = downloadedLogs;
    lastSyncedJournals[row.date_str] = JSON.stringify(downloadedLogs);
    if (typeof dateList !== 'undefined' && !dateList.includes(row.date_str)) dateList.push(row.date_str);
}

// クラウドの1行分（1ノート）をローカルへ反映。反映した場合はtrueを返す。
async function mergeNotebookRow(row, localImagesDict) {
    const nData = typeof notebookData !== 'undefined' ? notebookData : window.notebookData;
    const idx = nData.findIndex(n => n.id === row.id);
    if (idx !== -1 && new Date(nData[idx].updatedAt) >= new Date(row.updated_at)) return false;

    let content = row.content;
    if (content && content.includes('http')) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = content;
        const imgs = tempDiv.querySelectorAll('img[src^="http"]');
        for (let img of imgs) {
            const match = img.src.match(/img_([a-f0-9]+)\./);
            if (match && match[1] && localImagesDict[match[1]]) {
                img.src = localImagesDict[match[1]]; // 通信回避！ローカルデータで復元
            } else if (img.src.includes('/storage/v1/object/public/images/')) {
                const b64 = await downloadImageToBase64(img.src); // 新規画像のみダウンロード
                if (b64) img.src = b64;
            }
        }
        content = tempDiv.innerHTML;
    }

    const noteObj = {
        id: row.id, title: row.title, content: content, category: row.category,
        status: row.status, linkedNoteIds: row.linked_note_ids || [],
        createdAt: row.created_at, updatedAt: row.updated_at
    };

    if (idx !== -1) nData[idx] = noteObj;
    else nData.push(noteObj);

    lastSyncedNotebooks[row.id] = JSON.stringify(noteObj);
    return true;
}

function refreshUIAfterSync() {
    if (typeof updateCategoryButtonUI === 'function') updateCategoryButtonUI();
    if (typeof renderSettingsTypeList === 'function') renderSettingsTypeList();
    if (typeof renderSettingsCategoryList === 'function') renderSettingsCategoryList();
    if (typeof renderRightCards === 'function') renderRightCards();
    if (typeof renderNotebookSidebar === 'function' && typeof calendarScope !== 'undefined' && calendarScope === 'notebooks') renderNotebookSidebar();
    if (typeof renderMiniCalendar === 'function' && typeof sidebarMode !== 'undefined' && sidebarMode === 'cal' && typeof calendarScope !== 'undefined' && calendarScope !== 'notebooks') renderMiniCalendar();
}

// fullSync=true: 全件取得（初回ログイン・手動同期時のみ。通信量は増えるが確実）
// fullSync=false: 前回同期以降に更新された行だけを取得（自動再同期はこちら。通信量を節約）
async function pullFromSupabase(fullSync = true) {
    if (!supabaseClient || !supabaseUser) return;
    if (isPulling) return; // 二重実行防止
    isPulling = true;
    updateSyncStatusUI();

    const requestedAt = new Date().toISOString();
    const cursor = fullSync ? null : localStorage.getItem('daily_journal_last_pull_at');

    try {
        console.log(fullSync ? "クラウドと全件を照合中..." : "クラウドの更新分のみ照合中...(通信量節約)");

        // 本体にある画像リストの目次（ハッシュ辞典）を作成
        const localImagesDict = await extractLocalImagesDict();

        // --- 1. 設定の取得 ---
        const { data: sDb } = await supabaseClient.from('app_settings').select('*').eq('user_id', supabaseUser.id).maybeSingle();
        if (sDb && sDb.settings_data) {
            applySettingsData(sDb.settings_data);
        } else if (fullSync) {
            pushSettingsToSupabase();
        }

        // --- 2. Journals の取得（差分取得: 前回同期以降に更新された分のみ） ---
        let jQuery = supabaseClient.from('journals').select('*');
        if (cursor) jQuery = jQuery.gte('updated_at', cursor);
        const { data: jDb } = await jQuery;

        if (jDb && jDb.length > 0) {
            for (const row of jDb) {
                // 自分がこの内容を送信済みなら（エコー）、無駄なダウンロード・再描画を避けてスキップ
                if (JSON.stringify(row.log_data) === lastSyncedJournals[row.date_str]) continue;
                await mergeJournalRow(row, localImagesDict);
            }
            if (typeof dateList !== 'undefined') dateList.sort();
            const jData = typeof journalData !== 'undefined' ? journalData : window.journalData;
            await _originalSetDBData('journalData', jData);
        }

        // --- 3. Notebooks の取得（差分取得） ---
        let nQuery = supabaseClient.from('notebooks').select('*');
        if (cursor) nQuery = nQuery.gte('updated_at', cursor);
        const { data: nDb } = await nQuery;

        if (nDb && nDb.length > 0) {
            let updated = false;
            for (const row of nDb) {
                const changed = await mergeNotebookRow(row, localImagesDict);
                if (changed) updated = true;
            }
            if (updated) {
                const nData = typeof notebookData !== 'undefined' ? notebookData : window.notebookData;
                await _originalSetDBData('notebookData', nData);
            }
        }

        // --- 4. 画面の再描画 ---
        refreshUIAfterSync();

        // 次回の差分取得用カーソルを更新（時計のズレに備えて少し余裕を持たせる）
        localStorage.setItem('daily_journal_last_pull_at', new Date(new Date(requestedAt).getTime() - 10000).toISOString());

        console.log("クラウド同期が完了しました。");
    } catch (e) {
        console.error("Pull同期エラー:", e);
    } finally {
        isPulling = false;
        updateSyncStatusUI();
    }
}

// ==========================================
// 7. Supabase Realtime（他デバイスの更新を即座に受け取る）
// ==========================================
// 前提: Supabase管理画面の Database > Replication で
// journals / notebooks / app_settings テーブルの Realtime を有効化しておく必要があります。
// これを行わない場合でも、画面復帰時の差分取得（上記6番）により、多少遅れて反映されます。

function ensureRealtimeSubscribed() {
    if (!realtimeChannel) subscribeRealtime();
}

function subscribeRealtime() {
    if (!supabaseClient || !supabaseUser) return;
    unsubscribeRealtime();

    try {
        realtimeChannel = supabaseClient
            .channel('daily-journal-sync-' + supabaseUser.id)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'journals', filter: `user_id=eq.${supabaseUser.id}` }, payload => {
                if (payload.new && payload.new.date_str) handleRemoteJournalRow(payload.new);
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'notebooks', filter: `user_id=eq.${supabaseUser.id}` }, payload => {
                if (payload.new && payload.new.id) handleRemoteNotebookRow(payload.new);
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings', filter: `user_id=eq.${supabaseUser.id}` }, payload => {
                if (payload.new && payload.new.settings_data) handleRemoteSettingsRow(payload.new);
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

async function handleRemoteJournalRow(row) {
    if (isPulling) return;
    if (JSON.stringify(row.log_data) === lastSyncedJournals[row.date_str]) return; // 自分のエコーは無視

    isPulling = true;
    try {
        const localImagesDict = await extractLocalImagesDict();
        await mergeJournalRow(row, localImagesDict);
        if (typeof dateList !== 'undefined') dateList.sort();
        const jData = typeof journalData !== 'undefined' ? journalData : window.journalData;
        await _originalSetDBData('journalData', jData);
        refreshUIAfterSync();
    } catch (e) {
        console.error("Realtime反映エラー(journals):", e);
    } finally {
        isPulling = false;
    }
}

async function handleRemoteNotebookRow(row) {
    if (isPulling) return;
    isPulling = true;
    try {
        const localImagesDict = await extractLocalImagesDict();
        const changed = await mergeNotebookRow(row, localImagesDict);
        if (changed) {
            const nData = typeof notebookData !== 'undefined' ? notebookData : window.notebookData;
            await _originalSetDBData('notebookData', nData);
            refreshUIAfterSync();
        }
    } catch (e) {
        console.error("Realtime反映エラー(notebooks):", e);
    } finally {
        isPulling = false;
    }
}

async function handleRemoteSettingsRow(row) {
    if (isPulling) return;
    isPulling = true;
    try {
        applySettingsData(row.settings_data);
        refreshUIAfterSync();
    } catch (e) {
        console.error("Realtime反映エラー(app_settings):", e);
    } finally {
        isPulling = false;
    }
}
