// ==========================================
// supabase.js
// Daily Journal - Supabase Auth + 差分同期 + Storage
//
// 設計:
// - ローカル: IndexedDB / localStorage を従来どおり利用
// - クラウド: 1 Journal = 1 row / 1 Notebook = 1 row
// - 同期: 前回同期以降の変更行だけ SELECT / UPSERT
// - 画像: PostgreSQLには保存せず Storage にファイル単位で保存
// - ブラウザには Publishable/anon key のみ。service_role/secret は使用しない
// ==========================================

const SUPABASE_CONFIG_KEY = 'daily_journal_supabase_config_v1';
const SUPABASE_TABLE = 'daily_journal_entries';
const SUPABASE_NOTEBOOK_TABLE = 'daily_journal_notebooks';
const SUPABASE_SETTINGS_TABLE = 'daily_journal_settings';
const SUPABASE_BUCKET = 'daily-journal-images';
const SUPABASE_MARKER_PREFIX = 'supabase-storage://';
const SUPABASE_META_KEY = 'daily_journal_cloud_sync_meta_v2';
const SUPABASE_LINKED_USER_KEY = 'daily_journal_supabase_linked_user_v2';
const LEGACY_SUPABASE_TABLE = 'daily_journal_state';
const SYNC_SCHEMA_VERSION = 2;

let appSupabaseClient = null;
let cloudUser = null;
let cloudSession = null;
let cloudSyncInProgress = false;
let cloudSaveTimer = null;
let cloudRefreshTimer = null;
let cloudAuthSubscription = null;
let cloudSyncQueued = false;

function getSupabaseConfig() {
    try {
        const raw = localStorage.getItem(SUPABASE_CONFIG_KEY);
        if (!raw) return { url: '', key: '' };
        const parsed = JSON.parse(raw);
        return {
            url: String(parsed?.url || '').trim().replace(/\/$/, ''),
            key: normalizeSupabaseKey(parsed?.key || '')
        };
    } catch (e) {
        return { url: '', key: '' };
    }
}

function saveSupabaseConfig(url, key) {
    const config = { url: String(url || '').trim().replace(/\/$/, ''), key: normalizeSupabaseKey(key) };
    localStorage.setItem(SUPABASE_CONFIG_KEY, JSON.stringify(config));
    return config;
}

function clearSupabaseConfig() {
    localStorage.removeItem(SUPABASE_CONFIG_KEY);
}

function isValidSupabaseUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    } catch (e) {
        return false;
    }
}

function getAuthRedirectUrl() {
    try {
        const u = new URL(window.location.href);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return u.href.split('#')[0];
    } catch (e) {
        return null;
    }
}

function normalizeSupabaseKey(value) {
    return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function getFriendlySupabaseError(error) {
    if (!error) return '不明なエラー';
    const message = String(error.message || error.error_description || error.msg || error);
    const code = error.code ? `\ncode: ${error.code}` : '';
    const status = error.status ? `\nHTTP: ${error.status}` : '';
    return `${message}${code}${status}`;
}

function cloudIsConfigured() {
    const config = getSupabaseConfig();
    return !!(config.url && config.key && isValidSupabaseUrl(config.url));
}

function cloudIsSignedIn() {
    return !!(appSupabaseClient && cloudUser && cloudSession);
}

function getCloudUserLabel() {
    return cloudUser?.email || cloudUser?.id || '未ログイン';
}

function updateCloudSettingsUI(message = null) {
    const config = getSupabaseConfig();
    const urlInput = document.getElementById('supabaseUrlInput');
    const keyInput = document.getElementById('supabasePublishableKeyInput');
    if (urlInput && document.activeElement !== urlInput) urlInput.value = config.url;
    if (keyInput && document.activeElement !== keyInput) keyInput.value = config.key;

    const status = document.getElementById('supabaseConnectionStatus');
    const user = document.getElementById('supabaseUserLabel');
    const saveBtn = document.getElementById('supabaseSaveConfigBtn');
    const syncButtons = document.querySelectorAll('[data-cloud-action]');
    const loginSection = document.getElementById('supabaseLoginSection');
    const logoutSection = document.getElementById('supabaseLogoutSection');

    if (status) {
        let text = message || '未設定';
        let cls = 'cloud-status-neutral';
        if (cloudIsSignedIn()) {
            text = message || '接続済み';
            cls = 'cloud-status-ok';
        } else if (cloudIsConfigured()) {
            text = message || '接続設定済み・未ログイン';
            cls = 'cloud-status-warn';
        }
        status.textContent = text;
        status.className = `cloud-status ${cls}`;
    }

    if (user) user.textContent = cloudIsSignedIn() ? getCloudUserLabel() : '未ログイン';
    if (saveBtn) saveBtn.disabled = !config.url || !config.key;
    if (loginSection) loginSection.style.display = cloudIsSignedIn() ? 'none' : '';
    if (logoutSection) logoutSection.style.display = cloudIsSignedIn() ? '' : 'none';
    syncButtons.forEach(btn => {
        btn.disabled = !cloudIsSignedIn() || cloudSyncInProgress;
    });

    const meta = getCloudSyncMeta();
    const syncInfo = document.getElementById('supabaseSyncInfo');
    if (syncInfo) {
        if (!cloudIsSignedIn()) {
            syncInfo.textContent = 'ローカル保存のみ';
        } else if (meta.lastSyncAt) {
            const count = Number(meta.lastSyncChangedCount || 0);
            const bytes = Number(meta.lastSyncUploadedBytes || 0);
            syncInfo.textContent = `差分同期 / 最終同期 ${formatSyncDate(meta.lastSyncAt)} / ${count}件・${formatBytes(bytes)}`;
        } else {
            syncInfo.textContent = '初回同期が必要です';
        }
    }
}

function formatSyncDate(iso) {
    try {
        return new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
    } catch (e) {
        return iso || '-';
    }
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function getCloudSyncMeta() {
    try {
        const raw = localStorage.getItem(SUPABASE_META_KEY);
        if (!raw) return {
            version: SYNC_SCHEMA_VERSION,
            userId: null,
            lastSyncAt: null,
            journal: {},
            notebooks: {},
            settingsHash: null,
            settingsCloudUpdatedAt: null,
            lastSyncChangedCount: 0,
            lastSyncUploadedBytes: 0,
            migratedLegacy: false
        };
        const parsed = JSON.parse(raw);
        return {
            version: SYNC_SCHEMA_VERSION,
            userId: parsed.userId || null,
            lastSyncAt: parsed.lastSyncAt || null,
            journal: parsed.journal || {},
            notebooks: parsed.notebooks || {},
            settingsHash: parsed.settingsHash || null,
            settingsCloudUpdatedAt: parsed.settingsCloudUpdatedAt || null,
            lastSyncChangedCount: Number(parsed.lastSyncChangedCount || 0),
            lastSyncUploadedBytes: Number(parsed.lastSyncUploadedBytes || 0),
            migratedLegacy: parsed.migratedLegacy === true
        };
    } catch (e) {
        return { version: SYNC_SCHEMA_VERSION, userId: null, lastSyncAt: null, journal: {}, notebooks: {}, settingsHash: null, settingsCloudUpdatedAt: null, lastSyncChangedCount: 0, lastSyncUploadedBytes: 0, migratedLegacy: false };
    }
}

function saveCloudSyncMeta(meta) {
    localStorage.setItem(SUPABASE_META_KEY, JSON.stringify(meta));
}

function resetCloudSyncMetaForUser(userId) {
    const meta = getCloudSyncMeta();
    if (meta.userId !== userId) {
        return {
            version: SYNC_SCHEMA_VERSION,
            userId,
            lastSyncAt: null,
            journal: {},
            notebooks: {},
            settingsHash: null,
            settingsCloudUpdatedAt: null,
            lastSyncChangedCount: 0,
            lastSyncUploadedBytes: 0,
            migratedLegacy: false
        };
    }
    return meta;
}

async function createConfiguredSupabaseClient() {
    if (!window.supabase?.createClient) {
        updateCloudSettingsUI('Supabase JSの読み込みに失敗しました');
        return null;
    }

    const config = getSupabaseConfig();
    if (!config.url || !config.key || !isValidSupabaseUrl(config.url)) {
        appSupabaseClient = null;
        cloudUser = null;
        cloudSession = null;
        updateCloudSettingsUI();
        return null;
    }

    try {
        appSupabaseClient = window.supabase.createClient(config.url, config.key, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
        });

        if (cloudAuthSubscription) {
            cloudAuthSubscription.unsubscribe();
            cloudAuthSubscription = null;
        }

        const result = await appSupabaseClient.auth.getSession();
        cloudSession = result?.data?.session || null;
        cloudUser = cloudSession?.user || null;

        const authResult = appSupabaseClient.auth.onAuthStateChange((_event, session) => {
            cloudSession = session || null;
            cloudUser = session?.user || null;
            updateCloudSettingsUI();
            startCloudRefreshPolling();
        });
        cloudAuthSubscription = authResult?.data?.subscription || null;
        updateCloudSettingsUI();
        startCloudRefreshPolling();
        return appSupabaseClient;
    } catch (e) {
        console.error('Supabase client initialization failed', e);
        appSupabaseClient = null;
        cloudUser = null;
        cloudSession = null;
        updateCloudSettingsUI('Supabase接続設定エラー');
        return null;
    }
}

async function initCloudSync() {
    return await createConfiguredSupabaseClient();
}

async function saveSupabaseSettingsFromUI() {
    const url = document.getElementById('supabaseUrlInput')?.value.trim() || '';
    const key = document.getElementById('supabasePublishableKeyInput')?.value.trim() || '';

    if (!url || !isValidSupabaseUrl(url)) {
        alert('Supabase Project URL が正しくありません。');
        return false;
    }
    if (!key) {
        alert('Publishable key（旧 anon key）を入力してください。');
        return false;
    }

    saveSupabaseConfig(url, key);
    const client = await createConfiguredSupabaseClient();
    if (!client) {
        updateCloudSettingsUI('Supabase JS / URL / key を確認してください');
        alert('Supabaseクライアントを初期化できませんでした。\n\nProject URL / Publishable key / 通信環境を確認してください。');
        return false;
    }
    updateCloudSettingsUI('接続設定を保存しました');
    return true;
}

async function testSupabaseConnection() {
    try {
        if (!cloudIsConfigured()) {
            const ok = await saveSupabaseSettingsFromUI();
            if (!ok) return;
        } else if (!appSupabaseClient) {
            await createConfiguredSupabaseClient();
        }
        if (!appSupabaseClient) throw new Error('Supabase client が作成できませんでした');

        const { data, error } = await appSupabaseClient.auth.getSession();
        if (error) throw error;
        if (!data?.session) {
            updateCloudSettingsUI('接続OK・未ログイン');
            alert('Supabase Auth APIへ接続できています。まだログインしていません。');
            return;
        }

        const { error: dbError } = await appSupabaseClient
            .from(SUPABASE_SETTINGS_TABLE)
            .select('user_id')
            .eq('user_id', data.session.user.id)
            .maybeSingle();
        if (dbError && !isMissingTableError(dbError)) throw dbError;
        updateCloudSettingsUI(isMissingTableError(dbError) ? 'Auth OK / DB未セットアップ' : 'Supabase接続OK');
        alert(isMissingTableError(dbError)
            ? 'Authは正常です。ただし差分同期用テーブルがまだありません。セットアップSQLを1回実行してください。'
            : 'Supabase Auth / DBへの接続を確認できました。');
    } catch (e) {
        updateCloudSettingsUI('未接続');
        alert(`接続確認に失敗しました。\n\n${getFriendlySupabaseError(e)}`);
    }
}

function isMissingTableError(error) {
    const msg = String(error?.message || '');
    return /relation .* does not exist|Could not find the table|schema cache|PGRST205/i.test(msg);
}

async function signUpWithSupabase() {
    if (!appSupabaseClient) await createConfiguredSupabaseClient();
    if (!appSupabaseClient) {
        alert('先にSupabase Project URLとPublishable keyを保存してください。');
        return false;
    }

    const email = document.getElementById('supabaseAuthEmail')?.value.trim() || '';
    const password = document.getElementById('supabaseAuthPassword')?.value || '';
    if (!email || !password) {
        alert('メールアドレスとパスワードを入力してください。');
        return false;
    }
    if (password.length < 6) {
        alert('パスワードは6文字以上にしてください。');
        return false;
    }

    try {
        updateCloudSettingsUI('アカウント作成中…');
        const options = {};
        const redirect = getAuthRedirectUrl();
        if (redirect) options.emailRedirectTo = redirect;
        const { data, error } = await appSupabaseClient.auth.signUp({ email, password, options });
        if (error) throw error;

        cloudSession = data?.session || null;
        cloudUser = data?.user || null;
        updateCloudSettingsUI();

        if (cloudSession) {
            await finishAuthenticatedLogin({ allowInitialSync: true });
        } else {
            alert('アカウントを作成しました。\n\nメール確認が有効な場合は、確認メールのリンクを開いてからログインしてください。');
        }
        return true;
    } catch (e) {
        updateCloudSettingsUI('アカウント作成に失敗');
        alert(`アカウント作成に失敗しました。\n\n${getFriendlySupabaseError(e)}`);
        return false;
    }
}

async function signInWithSupabase() {
    if (!appSupabaseClient) await createConfiguredSupabaseClient();
    if (!appSupabaseClient) {
        alert('先にSupabase Project URLとPublishable keyを保存してください。');
        return false;
    }

    const email = document.getElementById('supabaseAuthEmail')?.value.trim() || '';
    const password = document.getElementById('supabaseAuthPassword')?.value || '';
    if (!email || !password) {
        alert('メールアドレスとパスワードを入力してください。');
        return false;
    }

    try {
        updateCloudSettingsUI('ログイン中…');
        const { data, error } = await appSupabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        cloudSession = data?.session || null;
        cloudUser = data?.user || null;
        if (!cloudSession || !cloudUser) throw new Error('ログイン後のセッション取得に失敗しました。');

        updateCloudSettingsUI('ログインしました');
        // 認証成功と同期を分離。ただし初回同期は必ず実行する。
        try {
            await finishAuthenticatedLogin({ allowInitialSync: true });
        } catch (syncError) {
            console.error('post-login sync failed', syncError);
            updateCloudSettingsUI('ログイン済み・同期未完了');
            alert(`ログインには成功しましたが、データ同期だけ完了していません。\n\n${getFriendlySupabaseError(syncError)}\n\n認証情報は保持されています。`);
        }
        return true;
    } catch (e) {
        cloudSession = null;
        cloudUser = null;
        updateCloudSettingsUI('ログインに失敗');
        const msg = getFriendlySupabaseError(e);
        let hint = '';
        if (/Invalid login credentials/i.test(msg)) hint = '\n\nメールアドレスまたはパスワードが違うか、メール確認が未完了の可能性があります。';
        else if (/Email not confirmed/i.test(msg)) hint = '\n\n確認メールのリンクを先に開いてください。';
        else if (/Failed to fetch|NetworkError|Load failed|CORS/i.test(msg)) hint = '\n\nProject URL / key / HTTPS配信を確認してください。';
        alert(`ログインに失敗しました。\n\n${msg}${hint}`);
        return false;
    }
}

async function finishAuthenticatedLogin({ allowInitialSync = true } = {}) {
    if (!cloudIsSignedIn()) return false;
    const meta = resetCloudSyncMetaForUser(cloudUser.id);
    saveCloudSyncMeta(meta);

    if (!allowInitialSync) return true;

    const settingsRow = await fetchCloudSettings();
    const initialCloudHasData = await cloudHasAnyRows();
    const localHasData = stateHasMeaningfulData();

    // 旧バージョンの巨大JSONテーブルが存在し、差分テーブルが空なら一度だけ移行対象にする。
    if (!initialCloudHasData && !meta.migratedLegacy) {
        const legacy = await fetchLegacySnapshot();
        if (legacy) {
            const legacyHasData = hasMeaningfulLegacyData(legacy);
            if (legacyHasData && !localHasData) {
                await importLegacySnapshotToLocal(legacy);
                await syncCloudDiff({ silent: true, reason: 'legacy-import' });
                markMetaMigratedLegacy();
                return true;
            }
            if (legacyHasData && localHasData) {
                const choice = window.prompt('このアカウントには旧版のクラウドデータがあります。\n\n「cloud」= 旧クラウド→この端末\n「local」= この端末→新しい差分同期へ移行\n「cancel」= 何もしない', 'cloud');
                if (choice === 'cloud') {
                    await importLegacySnapshotToLocal(legacy);
                    await syncCloudDiff({ silent: true, reason: 'legacy-import' });
                    markMetaMigratedLegacy();
                    return true;
                }
                if (choice === 'local') {
                    await syncCloudDiff({ silent: true, reason: 'legacy-migrate-local' });
                    markMetaMigratedLegacy();
                    return true;
                }
            }
        }
    }

    if (!initialCloudHasData && localHasData) {
        const ok = confirm('ログインできました。\n\nこの端末の既存データをクラウドへ初回移行しますか？\n\n初回だけ、既存データと画像の全量をアップロードします。以後は変更分だけです。');
        if (ok) {
            await syncCloudDiff({ silent: false, reason: 'initial-local-to-cloud' });
        }
        return true;
    }

    if (initialCloudHasData && !localHasData) {
        await syncCloudDiff({ silent: false, reason: 'initial-cloud-to-local' });
        return true;
    }

    if (initialCloudHasData && localHasData && !meta.lastSyncAt) {
        const choice = window.prompt('クラウドとこの端末の両方にデータがあります。\n\n「cloud」= クラウドをこの端末へ\n「local」= この端末をクラウドへ（既存クラウドと差分統合）\n「cancel」= 何もしない', 'cloud');
        if (choice === 'cloud') await syncCloudDiff({ silent: false, reason: 'initial-both-cloud' });
        else if (choice === 'local') await syncCloudDiff({ silent: false, reason: 'initial-both-local' });
        return true;
    }

    await syncCloudDiff({ silent: true, reason: 'login' });
    return true;
}

async function diagnoseSupabaseAuth() {
    const config = getSupabaseConfig();
    const lines = [];
    lines.push(`ページ: ${window.location.protocol}//${window.location.host || '(local)'}`);
    lines.push(`Supabase SDK: ${window.supabase?.createClient ? '読み込みOK' : '読み込み失敗'}`);
    lines.push(`Project URL: ${config.url ? '設定済み' : '未設定'}`);
    lines.push(`Publishable/anon key: ${config.key ? '設定済み' : '未設定'}`);
    if (window.location.protocol === 'file:') lines.push('注意: file:// で開いています。メール確認リダイレクトや認証フローはHTTPS配信を推奨します。');
    if (!appSupabaseClient) await createConfiguredSupabaseClient();
    if (!appSupabaseClient) {
        alert(`Supabase診断結果\n\n${lines.join('\n')}\n\nクライアントを作成できません。`);
        return;
    }
    try {
        const { data, error } = await appSupabaseClient.auth.getSession();
        if (error) throw error;
        lines.push('Auth API: 接続OK');
        lines.push(`現在のセッション: ${data?.session ? 'あり' : 'なし'}`);
        if (data?.session?.user?.email) lines.push(`ログイン中: ${data.session.user.email}`);
        if (data?.session) {
            const { error: dbError } = await appSupabaseClient.from(SUPABASE_SETTINGS_TABLE).select('user_id').eq('user_id', data.session.user.id).maybeSingle();
            lines.push(`差分同期テーブル: ${isMissingTableError(dbError) ? '未作成' : (dbError ? 'エラー' : '確認OK')}`);
            if (dbError && !isMissingTableError(dbError)) lines.push(`DBエラー: ${getFriendlySupabaseError(dbError)}`);
        }
        alert(`Supabase診断結果\n\n${lines.join('\n')}`);
    } catch (e) {
        lines.push(`Auth API: 接続失敗`);
        lines.push(`エラー: ${getFriendlySupabaseError(e)}`);
        alert(`Supabase診断結果\n\n${lines.join('\n')}`);
    }
}

async function signOutFromSupabase() {
    if (!appSupabaseClient) return;
    try {
        await appSupabaseClient.auth.signOut();
        cloudUser = null;
        cloudSession = null;
        localStorage.removeItem(SUPABASE_LINKED_USER_KEY);
        updateCloudSettingsUI('ログアウトしました');
        stopCloudRefreshPolling();
    } catch (e) {
        alert(`ログアウトに失敗しました。\n\n${getFriendlySupabaseError(e)}`);
    }
}

async function sendSupabasePasswordReset() {
    if (!appSupabaseClient) await createConfiguredSupabaseClient();
    if (!appSupabaseClient) {
        alert('先にSupabase設定を保存してください。');
        return false;
    }
    const email = document.getElementById('supabaseAuthEmail')?.value.trim() || '';
    if (!email) {
        alert('パスワード再設定用のメールアドレスを入力してください。');
        return false;
    }
    try {
        const redirect = getAuthRedirectUrl();
        const options = redirect ? { redirectTo: redirect } : {};
        const { error } = await appSupabaseClient.auth.resetPasswordForEmail(email, options);
        if (error) throw error;
        alert('パスワード再設定用メールを送信しました。');
        return true;
    } catch (e) {
        alert(`メール送信に失敗しました。\n\n${getFriendlySupabaseError(e)}`);
        return false;
    }
}

// ---------- ローカル状態 ----------
function stateHasMeaningfulData() {
    const journalCount = Object.values(journalData || {}).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
    return journalCount > 0 || (Array.isArray(notebookData) && notebookData.length > 0);
}

function saveAppTypesLocalOnly() { localStorage.setItem('daily_journal_types', JSON.stringify(appTypes)); }
function saveCategoriesLocalOnly() { localStorage.setItem('daily_journal_categories', JSON.stringify(categories)); }
function saveTypeSlackSettingsLocalOnly() { localStorage.setItem('daily_journal_type_slack', JSON.stringify(typeSlackSettings)); }
function saveTypeNotebookSettingsLocalOnly() { localStorage.setItem('daily_journal_type_notebook', JSON.stringify(typeNotebookSettings)); }

function cloneForCloud(value) {
    if (value === undefined) return value;
    return JSON.parse(JSON.stringify(value));
}

function makeLocalId(prefix) {
    if (window.window.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function ensureLocalStableIds() {
    let changed = false;
    const now = new Date().toISOString();
    Object.keys(journalData || {}).forEach(dateKey => {
        const list = journalData[dateKey];
        if (!Array.isArray(list)) return;
        list.forEach(log => {
            if (!log || typeof log !== 'object') return;
            if (!log.id) { log.id = makeLocalId('jl'); changed = true; }
            if (!log.updatedAt) { log.updatedAt = now; changed = true; }
            if (!log.createdAt) { log.createdAt = log.updatedAt || now; changed = true; }
        });
    });
    (notebookData || []).forEach(note => {
        if (!note || typeof note !== 'object') return;
        if (!note.id) { note.id = makeLocalId('nb'); changed = true; }
        if (!note.updatedAt) { note.updatedAt = note.createdAt || now; changed = true; }
        if (!note.createdAt) { note.createdAt = note.updatedAt || now; changed = true; }
    });
    return changed;
}

function getLocalJournalEntries() {
    const rows = [];
    Object.keys(journalData || {}).forEach(dateKey => {
        const list = journalData[dateKey];
        if (!Array.isArray(list)) return;
        list.forEach(log => {
            if (!log || typeof log !== 'object' || !log.id) return;
            rows.push({ dateKey, log });
        });
    });
    return rows;
}

function getSettingsState() {
    return {
        appTypes: cloneForCloud(appTypes) || [],
        categories: cloneForCloud(categories) || [],
        typeSlackSettings: cloneForCloud(typeSlackSettings) || {},
        typeNotebookSettings: cloneForCloud(typeNotebookSettings) || {}
    };
}

function fingerprint(value) {
    const json = stableStringify(value);
    // fast non-cryptographic hash is enough for local change detection.
    let h1 = 2166136261, h2 = 16777619;
    for (let i = 0; i < json.length; i++) {
        const c = json.charCodeAt(i);
        h1 ^= c;
        h1 = Math.imul(h1, 16777619);
        h2 ^= c + ((i & 255) << 8);
        h2 = Math.imul(h2, 2246822519);
    }
    return `${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}-${json.length}`;
}

function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function lightweightImageSignature(src) {
    if (!src) return null;
    const s = String(src);
    if (s.startsWith('data:image/')) return { type: 'data', length: s.length, head: s.slice(0, 48), tail: s.slice(-48) };
    return { type: 'url', value: s };
}

function journalFingerprintPayload(log) {
    const copy = cloneForCloud(log) || {};
    delete copy.images;
    delete copy.image;
    copy._imageSignatures = (Array.isArray(log.images) ? log.images : (log.image ? [log.image] : [])).map(lightweightImageSignature);
    return copy;
}

function notebookFingerprintPayload(note) {
    return cloneForCloud(note) || {};
}

function getLocalJournalById(id) {
    const found = getLocalJournalEntries().find(x => x.log.id === id);
    return found ? found.log : null;
}

function removeLocalJournalById(id) {
    let changed = false;
    Object.keys(journalData || {}).forEach(dateKey => {
        const list = journalData[dateKey];
        if (!Array.isArray(list)) return;
        const next = list.filter(log => log?.id !== id);
        if (next.length !== list.length) {
            journalData[dateKey] = next;
            changed = true;
            if (!next.length) delete journalData[dateKey];
        }
    });
    return changed;
}

function localJournalRowFromLog(dateKey, log, storageInfo = null) {
    return {
        id: log.id,
        user_id: cloudUser.id,
        date_key: dateKey,
        time: log.time || null,
        text: log.text || '',
        category: log.category || null,
        slack_type: log.slackType || null,
        image_paths: storageInfo?.paths || (Array.isArray(log.imagePaths) ? log.imagePaths : []),
        external_images: storageInfo?.externalImages || (Array.isArray(log.externalImages) ? log.externalImages : []),
        created_client_at: log.createdAt || log.updatedAt || new Date().toISOString(),
        client_updated_at: log.updatedAt || new Date().toISOString(),
        deleted_at: null
    };
}

function localNotebookRowFromNote(note, content = null) {
    return {
        id: note.id,
        user_id: cloudUser.id,
        title: note.title || '',
        content: content !== null ? content : (note.content || ''),
        category: note.category || null,
        status: note.status || 'archive',
        linked_note_ids: Array.isArray(note.linkedNoteIds) ? note.linkedNoteIds : [],
        created_client_at: note.createdAt || note.updatedAt || new Date().toISOString(),
        client_updated_at: note.updatedAt || new Date().toISOString(),
        deleted_at: null
    };
}

// ---------- Storage ----------
function extractSupabaseStoragePath(src) {
    if (!src || typeof src !== 'string') return null;
    if (src.startsWith(SUPABASE_MARKER_PREFIX)) {
        const rest = src.slice(SUPABASE_MARKER_PREFIX.length);
        const slash = rest.indexOf('/');
        if (slash === -1) return null;
        const bucket = rest.slice(0, slash);
        const path = decodeURIComponent(rest.slice(slash + 1));
        return bucket === SUPABASE_BUCKET && path ? path : null;
    }
    try {
        const u = new URL(src);
        const markers = [
            `/storage/v1/object/sign/${SUPABASE_BUCKET}/`,
            `/storage/v1/object/public/${SUPABASE_BUCKET}/`,
            `/storage/v1/object/authenticated/${SUPABASE_BUCKET}/`
        ];
        for (const marker of markers) {
            if (u.pathname.includes(marker)) return decodeURIComponent(u.pathname.split(marker)[1] || '');
        }
    } catch (e) {}
    return null;
}

function makeStorageMarker(path) {
    return `${SUPABASE_MARKER_PREFIX}${SUPABASE_BUCKET}/${encodeURIComponent(path).replace(/%2F/g, '/')}`;
}

function dataUrlToBlob(dataUrl) {
    const m = String(dataUrl || '').match(/^data:([^;,]+)(?:;[^,]*)?,(.*)$/s);
    if (!m) return null;
    const mime = m[1] || 'application/octet-stream';
    const encoded = m[2] || '';
    try {
        const binary = atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    } catch (e) {
        return null;
    }
}

async function hashTextSha256(text) {
    if (window.crypto?.subtle) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `fnv-${(hash >>> 0).toString(16)}`;
}

function mimeToExt(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('png')) return 'png';
    if (m.includes('webp')) return 'webp';
    if (m.includes('gif')) return 'gif';
    if (m.includes('heic')) return 'heic';
    return 'jpg';
}

async function uploadDataUrlToStorage(dataUrl, scope = 'journal') {
    if (!cloudIsSignedIn()) throw new Error('Supabaseへログインしていません。');
    const blob = dataUrlToBlob(dataUrl);
    if (!blob) throw new Error('画像Data URLを変換できませんでした。');

    const hash = await hashTextSha256(dataUrl);
    const path = `${cloudUser.id}/${scope}/${hash}.${mimeToExt(blob.type)}`;
    const result = await appSupabaseClient.storage.from(SUPABASE_BUCKET).upload(path, blob, {
        cacheControl: '31536000',
        contentType: blob.type || 'image/jpeg',
        upsert: false
    });
    if (result.error && !/already exists|duplicate/i.test(result.error.message || '')) throw result.error;
    return { path, bytes: blob.size };
}

async function fetchStoragePathsAsDataUrls(paths) {
    const unique = [...new Set((paths || []).filter(Boolean))];
    if (!unique.length || !cloudIsSignedIn()) return {};

    const out = {};
    const { data: signedList, error } = await appSupabaseClient.storage
        .from(SUPABASE_BUCKET)
        .createSignedUrls(unique, 60 * 60);
    if (error) throw error;

    for (const item of (signedList || [])) {
        const path = item.path || '';
        const signedUrl = item.signedUrl;
        if (!path || !signedUrl) continue;
        try {
            const r = await fetch(signedUrl);
            if (!r.ok) continue;
            const blob = await r.blob();
            out[path] = await blobToDataUrl(blob);
        } catch (e) {
            console.warn('image hydrate skipped', path, e);
        }
    }
    return out;
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

async function prepareJournalStorage(log) {
    const paths = new Set(Array.isArray(log.imagePaths) ? log.imagePaths : []);
    const externalImages = [];
    const images = Array.isArray(log.images) ? log.images : (log.image ? [log.image] : []);
    let uploadedBytes = 0;
    for (const src of images) {
        const path = extractSupabaseStoragePath(src);
        if (path) {
            paths.add(path);
        } else if (typeof src === 'string' && src.startsWith('data:image/')) {
            const result = await uploadDataUrlToStorage(src, 'journal');
            paths.add(result.path);
            uploadedBytes += result.bytes;
        } else if (src) {
            externalImages.push(src);
        }
    }
    log.imagePaths = [...paths];
    if (externalImages.length) log.externalImages = externalImages;
    else delete log.externalImages;
    return { paths: [...paths], externalImages, uploadedBytes };
}

async function prepareNotebookContentForCloud(content) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = String(content || '');
    const imgs = Array.from(wrapper.querySelectorAll('img'));
    let uploadedBytes = 0;
    for (const img of imgs) {
        let path = img.getAttribute('data-sb-path') || extractSupabaseStoragePath(img.getAttribute('src') || '');
        const src = img.getAttribute('src') || '';
        if (!path && src.startsWith('data:image/')) {
            const result = await uploadDataUrlToStorage(src, 'notebook');
            path = result.path;
            uploadedBytes += result.bytes;
        }
        if (path) {
            img.setAttribute('data-sb-path', path);
            img.setAttribute('src', makeStorageMarker(path));
        }
    }
    return { content: wrapper.innerHTML, uploadedBytes };
}

async function hydrateNotebookContentForLocal(content, existingContent = '') {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = String(content || '');
    const existingWrapper = document.createElement('div');
    existingWrapper.innerHTML = String(existingContent || '');
    const existingImgs = Array.from(existingWrapper.querySelectorAll('img'));
    const existingByPath = new Map();
    existingImgs.forEach(img => {
        const p = img.getAttribute('data-sb-path') || extractSupabaseStoragePath(img.getAttribute('src') || '');
        if (p && img.getAttribute('src')?.startsWith('data:image/')) existingByPath.set(p, img.getAttribute('src'));
    });
    const paths = Array.from(wrapper.querySelectorAll('img'))
        .map(img => img.getAttribute('data-sb-path') || extractSupabaseStoragePath(img.getAttribute('src') || ''))
        .filter(Boolean);
    const missing = paths.filter(p => !existingByPath.has(p));
    const downloaded = missing.length ? await fetchStoragePathsAsDataUrls(missing) : {};
    let changed = false;
    wrapper.querySelectorAll('img').forEach(img => {
        const p = img.getAttribute('data-sb-path') || extractSupabaseStoragePath(img.getAttribute('src') || '');
        if (!p) return;
        const dataUrl = existingByPath.get(p) || downloaded[p];
        img.setAttribute('data-sb-path', p);
        if (dataUrl) { img.setAttribute('src', dataUrl); changed = true; }
    });
    return { content: wrapper.innerHTML, downloadedCount: missing.filter(p => !!downloaded[p]).length };
}

async function hydrateJournalEntryToLocal(remote, existingLog = null) {
    const imagePaths = Array.isArray(remote.image_paths) ? remote.image_paths : [];
    const existingImages = Array.isArray(existingLog?.images) ? existingLog.images : [];
    const existingByPath = new Map();
    imagePaths.forEach((path, i) => {
        const src = existingImages[i];
        if (src?.startsWith('data:image/')) existingByPath.set(path, src);
    });
    const missingPaths = imagePaths.filter(p => !existingByPath.has(p));
    const downloaded = missingPaths.length ? await fetchStoragePathsAsDataUrls(missingPaths) : {};
    const images = imagePaths.map(path => existingByPath.get(path) || downloaded[path]).filter(Boolean);

    return {
        id: remote.id,
        time: remote.time || '',
        text: remote.text || '',
        category: remote.category || '',
        slackType: remote.slack_type || null,
        imagePaths,
        externalImages: Array.isArray(remote.external_images) ? remote.external_images : [],
        images,
        createdAt: remote.created_client_at || remote.updated_at || new Date().toISOString(),
        updatedAt: remote.client_updated_at || remote.updated_at || new Date().toISOString()
    };
}

// ---------- DB row helpers ----------
async function fetchCloudSettings() {
    if (!cloudIsSignedIn()) return null;
    const { data, error } = await appSupabaseClient
        .from(SUPABASE_SETTINGS_TABLE)
        .select('*')
        .eq('user_id', cloudUser.id)
        .maybeSingle();
    if (error) {
        if (isMissingTableError(error)) return null;
        throw error;
    }
    return data || null;
}

async function fetchLegacySnapshot() {
    if (!cloudIsSignedIn()) return null;
    try {
        const { data, error } = await appSupabaseClient
            .from(LEGACY_SUPABASE_TABLE)
            .select('*')
            .eq('user_id', cloudUser.id)
            .maybeSingle();
        if (error) {
            if (isMissingTableError(error)) return null;
            throw error;
        }
        return data || null;
    } catch (e) {
        if (isMissingTableError(e)) return null;
        throw e;
    }
}

async function cloudHasAnyRows() {
    if (!cloudIsSignedIn()) return false;
    const [{ data: j, error: je }, { data: n, error: ne }, { data: s, error: se }] = await Promise.all([
        appSupabaseClient.from(SUPABASE_TABLE).select('id').eq('user_id', cloudUser.id).limit(1),
        appSupabaseClient.from(SUPABASE_NOTEBOOK_TABLE).select('id').eq('user_id', cloudUser.id).limit(1),
        appSupabaseClient.from(SUPABASE_SETTINGS_TABLE).select('user_id').eq('user_id', cloudUser.id).limit(1)
    ]);
    for (const e of [je, ne, se]) {
        if (e && !isMissingTableError(e)) throw e;
        if (isMissingTableError(e)) throw new Error('差分同期用テーブルが未作成です。セットアップSQLを1回実行してください。');
    }
    return !!((j || []).length || (n || []).length || (s || []).length);
}

async function fetchRemoteChangesSince(since) {
    const [journalResult, notebookResult, settingsResult] = await Promise.all([
        appSupabaseClient.from(SUPABASE_TABLE).select('*').eq('user_id', cloudUser.id).gte('updated_at', since || '1970-01-01T00:00:00Z').order('updated_at', { ascending: true }),
        appSupabaseClient.from(SUPABASE_NOTEBOOK_TABLE).select('*').eq('user_id', cloudUser.id).gte('updated_at', since || '1970-01-01T00:00:00Z').order('updated_at', { ascending: true }),
        appSupabaseClient.from(SUPABASE_SETTINGS_TABLE).select('*').eq('user_id', cloudUser.id).maybeSingle()
    ]);
    for (const r of [journalResult, notebookResult, settingsResult]) {
        if (r.error) throw r.error;
    }
    return {
        journal: journalResult.data || [],
        notebooks: notebookResult.data || [],
        settings: settingsResult.data || null
    };
}

async function fetchAllRemoteRows() {
    const [journalResult, notebookResult, settingsResult] = await Promise.all([
        appSupabaseClient.from(SUPABASE_TABLE).select('*').eq('user_id', cloudUser.id).order('updated_at', { ascending: true }),
        appSupabaseClient.from(SUPABASE_NOTEBOOK_TABLE).select('*').eq('user_id', cloudUser.id).order('updated_at', { ascending: true }),
        appSupabaseClient.from(SUPABASE_SETTINGS_TABLE).select('*').eq('user_id', cloudUser.id).maybeSingle()
    ]);
    for (const r of [journalResult, notebookResult, settingsResult]) {
        if (r.error) throw r.error;
    }
    return { journal: journalResult.data || [], notebooks: notebookResult.data || [], settings: settingsResult.data || null };
}

function hasMeaningfulLegacyData(row) {
    if (!row) return false;
    const journalCount = Object.values(row.journal_data || {}).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
    return journalCount > 0 || (Array.isArray(row.notebook_data) && row.notebook_data.length > 0);
}

async function importLegacySnapshotToLocal(row) {
    journalData = cloneForCloud(row.journal_data || {});
    notebookData = cloneForCloud(row.notebook_data || []);
    if (Array.isArray(row.app_types)) { appTypes = row.app_types; saveAppTypesLocalOnly(); }
    if (Array.isArray(row.categories)) { categories = row.categories; saveCategoriesLocalOnly(); }
    if (row.type_slack_settings) { typeSlackSettings = row.type_slack_settings; saveTypeSlackSettingsLocalOnly(); }
    if (row.type_notebook_settings) { typeNotebookSettings = row.type_notebook_settings; saveTypeNotebookSettingsLocalOnly(); }
    ensureLocalStableIds();
    await setDBData('journalData', journalData);
    await setDBData('notebookData', notebookData);
}

function markMetaMigratedLegacy() {
    const meta = getCloudSyncMeta();
    meta.migratedLegacy = true;
    saveCloudSyncMeta(meta);
}

async function applyRemoteSettings(row) {
    if (!row?.state) return false;
    const state = row.state;
    if (Array.isArray(state.appTypes)) { appTypes = state.appTypes; saveAppTypesLocalOnly(); }
    if (Array.isArray(state.categories)) { categories = state.categories; saveCategoriesLocalOnly(); }
    if (state.typeSlackSettings && typeof state.typeSlackSettings === 'object') { typeSlackSettings = state.typeSlackSettings; saveTypeSlackSettingsLocalOnly(); }
    if (state.typeNotebookSettings && typeof state.typeNotebookSettings === 'object') { typeNotebookSettings = state.typeNotebookSettings; saveTypeNotebookSettingsLocalOnly(); }
    return true;
}

function findRemoteChangeById(rows, id) { return rows.find(r => r.id === id) || null; }

function rebuildJournalDateListAndRender() {
    dateList = generateDateKeys();
    if (typeof renderRightCards === 'function') renderRightCards();
    if (typeof updateSidebars === 'function') updateSidebars();
    if (typeof renderMiniCalendar === 'function' && sidebarMode === 'cal' && calendarScope !== 'notebooks') renderMiniCalendar();
}

async function syncCloudDiff({ silent = true, reason = 'manual' } = {}) {
    if (!cloudIsSignedIn()) return false;
    if (cloudSyncInProgress) {
        cloudSyncQueued = true;
        return false;
    }

    cloudSyncInProgress = true;
    updateCloudSettingsUI(silent ? '差分同期中…' : 'クラウドと差分同期中…');

    try {
        const idChanged = ensureLocalStableIds();
        if (idChanged) {
            await setDBData('journalData', journalData);
            await setDBData('notebookData', notebookData);
        }

        let meta = resetCloudSyncMetaForUser(cloudUser.id);
        saveCloudSyncMeta(meta);

        const isInitial = !meta.lastSyncAt;
        const remote = isInitial ? await fetchAllRemoteRows() : await fetchRemoteChangesSince(meta.lastSyncAt);

        const localJournalEntries = getLocalJournalEntries();
        const localJournalMap = new Map(localJournalEntries.map(x => [x.log.id, x]));
        const localNotebookMap = new Map((notebookData || []).filter(Boolean).map(n => [n.id, n]));

        const changedJournal = [];
        const changedNotebooks = [];
        const deletedJournal = [];
        const deletedNotebooks = [];
        const now = new Date().toISOString();

        // 初回以外: 前回同期時点のマニフェストと比較してローカル差分を検出。
        if (!isInitial) {
            for (const [id, old] of Object.entries(meta.journal || {})) {
                if (old?.deleted) continue;
                const found = localJournalMap.get(id);
                if (!found) deletedJournal.push({ id, client_updated_at: now });
            }
            for (const [id, old] of Object.entries(meta.notebooks || {})) {
                if (old?.deleted) continue;
                const found = localNotebookMap.get(id);
                if (!found) deletedNotebooks.push({ id, client_updated_at: now });
            }
        }

        const localJournalChanges = [];
        for (const x of localJournalEntries) {
            const fp = fingerprint(journalFingerprintPayload(x.log));
            const prev = meta.journal?.[x.log.id];
            if (isInitial) {
                if (!remote.journal.some(r => r.id === x.log.id)) localJournalChanges.push(x);
            } else if (!prev || prev.hash !== fp) {
                x.log.updatedAt = x.log.updatedAt || now;
                localJournalChanges.push(x);
            }
        }

        const localNotebookChanges = [];
        for (const note of (notebookData || [])) {
            if (!note?.id) continue;
            const fp = fingerprint(notebookFingerprintPayload(note));
            const prev = meta.notebooks?.[note.id];
            if (isInitial) {
                if (!remote.notebooks.some(r => r.id === note.id)) localNotebookChanges.push(note);
            } else if (!prev || prev.hash !== fp) {
                note.updatedAt = note.updatedAt || now;
                localNotebookChanges.push(note);
            }
        }

        // リモート変更を適用。ローカルも変更済みなら client_updated_at の新しい方を採用。
        let localChangedByRemote = false;
        const activeRemoteJournalIds = new Set();
        for (const r of remote.journal) {
            activeRemoteJournalIds.add(r.id);
            const local = localJournalMap.get(r.id)?.log || null;
            const localChanged = localJournalChanges.some(x => x.log.id === r.id);
            const manifestRemote = meta.journal?.[r.id];
            // gte方式のカーソルで同じtimestampのrowを安全に再取得しても、
            // 既に同じサーバー版を取り込んでいれば処理しない。
            if (!isInitial && !localChanged && manifestRemote?.cloudUpdatedAt === r.updated_at && manifestRemote?.deleted === !!r.deleted_at) continue;
            const localTs = Date.parse(local?.updatedAt || '1970-01-01T00:00:00Z');
            const remoteTs = Date.parse(r.client_updated_at || r.updated_at || '1970-01-01T00:00:00Z');
            const remoteWins = !localChanged || remoteTs > localTs;
            if (!remoteWins) continue;

            if (r.deleted_at) {
                if (removeLocalJournalById(r.id)) localChangedByRemote = true;
                continue;
            }
            const hydrated = await hydrateJournalEntryToLocal(r, local);
            if (!journalData[r.date_key]) journalData[r.date_key] = [];
            removeLocalJournalById(r.id);
            journalData[r.date_key].push(hydrated);
            localChangedByRemote = true;
            // mark as already satisfied so it isn't immediately pushed again
            const fp = fingerprint(journalFingerprintPayload(hydrated));
            meta.journal[r.id] = { hash: fp, cloudUpdatedAt: r.updated_at, clientUpdatedAt: r.client_updated_at || r.updated_at, deleted: false };
        }

        // 初回にクラウド側に存在しないローカル行がある場合はアップロード。
        const journalUploads = [];
        let uploadedBytes = 0;
        for (const x of localJournalChanges) {
            const current = getLocalJournalById(x.log.id);
            if (!current) continue;
            const prev = meta.journal?.[current.id];
            const remoteRow = findRemoteChangeById(remote.journal, current.id);
            if (remoteRow) {
                const localTs = Date.parse(current.updatedAt || '1970-01-01T00:00:00Z');
                const remoteTs = Date.parse(remoteRow.client_updated_at || remoteRow.updated_at || '1970-01-01T00:00:00Z');
                if (remoteTs >= localTs) continue;
            }
            const storage = await prepareJournalStorage(current);
            uploadedBytes += storage.uploadedBytes;
            journalUploads.push(localJournalRowFromLog(x.dateKey, current, storage));
        }

        // リモート新規行のうち、ローカルにないものを追加（初回/差分双方）。
        if (isInitial) {
            for (const r of remote.journal) {
                if (r.deleted_at || localJournalMap.has(r.id)) continue;
                const hydrated = await hydrateJournalEntryToLocal(r, null);
                if (!journalData[r.date_key]) journalData[r.date_key] = [];
                journalData[r.date_key].push(hydrated);
                meta.journal[r.id] = {
                    hash: fingerprint(journalFingerprintPayload(hydrated)),
                    cloudUpdatedAt: r.updated_at,
                    clientUpdatedAt: r.client_updated_at || r.updated_at,
                    deleted: false
                };
                localChangedByRemote = true;
            }
        }

        if (journalUploads.length) {
            const { error } = await appSupabaseClient.from(SUPABASE_TABLE).upsert(journalUploads, { onConflict: 'id' });
            if (error) throw error;
        }

        const notebookUploads = [];
        for (const note of localNotebookChanges) {
            const current = localNotebookMap.get(note.id);
            if (!current) continue;
            const remoteRow = findRemoteChangeById(remote.notebooks, note.id);
            if (remoteRow) {
                const localTs = Date.parse(current.updatedAt || '1970-01-01T00:00:00Z');
                const remoteTs = Date.parse(remoteRow.client_updated_at || remoteRow.updated_at || '1970-01-01T00:00:00Z');
                if (remoteTs >= localTs) continue;
            }
            const prepared = await prepareNotebookContentForCloud(current.content || '');
            uploadedBytes += prepared.uploadedBytes;
            // Persist storage markers locally. This avoids uploading the same image again.
            if (prepared.content !== current.content) current.content = prepared.content;
            notebookUploads.push(localNotebookRowFromNote(current, prepared.content));
        }

        for (const r of remote.notebooks) {
            const local = localNotebookMap.get(r.id) || null;
            const localChanged = localNotebookChanges.some(n => n.id === r.id);
            const manifestRemote = meta.notebooks?.[r.id];
            if (!isInitial && !localChanged && manifestRemote?.cloudUpdatedAt === r.updated_at && manifestRemote?.deleted === !!r.deleted_at) continue;
            const localTs = Date.parse(local?.updatedAt || '1970-01-01T00:00:00Z');
            const remoteTs = Date.parse(r.client_updated_at || r.updated_at || '1970-01-01T00:00:00Z');
            if (localChanged && remoteTs <= localTs) continue;
            if (r.deleted_at) {
                const idx = notebookData.findIndex(n => n.id === r.id);
                if (idx !== -1) { notebookData.splice(idx, 1); localChangedByRemote = true; }
                continue;
            }
            const hydrated = await hydrateNotebookContentForLocal(r.content || '', local?.content || '');
            const note = {
                id: r.id,
                title: r.title || '',
                content: hydrated.content,
                category: r.category || '',
                status: r.status || 'archive',
                linkedNoteIds: Array.isArray(r.linked_note_ids) ? r.linked_note_ids : [],
                createdAt: r.created_client_at || r.updated_at || new Date().toISOString(),
                updatedAt: r.client_updated_at || r.updated_at || new Date().toISOString()
            };
            const idx = notebookData.findIndex(n => n.id === r.id);
            if (idx === -1) notebookData.push(note); else notebookData[idx] = note;
            meta.notebooks[r.id] = {
                hash: fingerprint(notebookFingerprintPayload(note)),
                cloudUpdatedAt: r.updated_at,
                clientUpdatedAt: r.client_updated_at || r.updated_at,
                deleted: false
            };
            localChangedByRemote = true;
        }

        if (notebookUploads.length) {
            const { error } = await appSupabaseClient.from(SUPABASE_NOTEBOOK_TABLE).upsert(notebookUploads, { onConflict: 'id' });
            if (error) throw error;
        }

        // 削除: tombstoneをDBに残す。これが他端末へ削除差分を伝える。
        const journalTombstones = deletedJournal.map(d => ({
            id: d.id,
            user_id: cloudUser.id,
            date_key: null,
            time: null,
            text: '',
            category: null,
            slack_type: null,
            image_paths: [],
            external_images: [],
            created_client_at: null,
            client_updated_at: d.client_updated_at,
            deleted_at: new Date().toISOString()
        }));
        const notebookTombstones = deletedNotebooks.map(d => ({
            id: d.id,
            user_id: cloudUser.id,
            title: '',
            content: '',
            category: null,
            status: 'trash',
            linked_note_ids: [],
            created_client_at: null,
            client_updated_at: d.client_updated_at,
            deleted_at: new Date().toISOString()
        }));
        if (journalTombstones.length) { const { error } = await appSupabaseClient.from(SUPABASE_TABLE).upsert(journalTombstones, { onConflict: 'id' }); if (error) throw error; }
        if (notebookTombstones.length) { const { error } = await appSupabaseClient.from(SUPABASE_NOTEBOOK_TABLE).upsert(notebookTombstones, { onConflict: 'id' }); if (error) throw error; }

        // 設定は小さい1行だけ同期。データ本体の100MBとは独立して軽量。
        let localSettings = getSettingsState();
        let localSettingsHash = fingerprint(localSettings);
        const preferRemoteSettings = reason === 'initial-cloud-to-local' || reason === 'initial-both-cloud';
        const preferLocalSettings = reason === 'initial-local-to-cloud' || reason === 'initial-both-local';
        const previousSettingsCloudTs = Date.parse(meta.settingsCloudUpdatedAt || '1970-01-01T00:00:00Z');
        const remoteSettingsClientTs = Date.parse(remote.settings?.client_updated_at || remote.settings?.updated_at || '1970-01-01T00:00:00Z');
        const localSettingsChanged = localSettingsHash !== meta.settingsHash;
        const remoteSettingsChanged = !!remote.settings && Date.parse(remote.settings.updated_at || '1970-01-01T00:00:00Z') > previousSettingsCloudTs;

        if (remote.settings && (preferRemoteSettings || (!localSettingsChanged && remoteSettingsChanged)) && remote.settings.state) {
            await applyRemoteSettings(remote.settings);
            localSettings = getSettingsState();
            localSettingsHash = fingerprint(localSettings);
        }

        // 双方が変更していた場合は client_updated_at の新しい方を採用。
        const refreshedLocalSettingsChanged = localSettingsHash !== meta.settingsHash;
        const localSettingsClientTs = refreshedLocalSettingsChanged
            ? Date.parse(new Date().toISOString())
            : Date.parse(meta.settingsCloudUpdatedAt || '1970-01-01T00:00:00Z');
        const remoteWins = !preferLocalSettings && remote.settings && remoteSettingsChanged && remoteSettingsClientTs > localSettingsClientTs;
        if (remoteWins && remote.settings.state) {
            await applyRemoteSettings(remote.settings);
        } else if (!remote.settings || refreshedLocalSettingsChanged) {
            const payload = {
                user_id: cloudUser.id,
                state: getSettingsState(),
                client_updated_at: new Date().toISOString()
            };
            const { error } = await appSupabaseClient.from(SUPABASE_SETTINGS_TABLE).upsert(payload, { onConflict: 'user_id' });
            if (error) throw error;
        }

        await setDBData('journalData', journalData);
        await setDBData('notebookData', notebookData);
        saveAppTypesLocalOnly();
        saveCategoriesLocalOnly();
        saveTypeSlackSettingsLocalOnly();
        saveTypeNotebookSettingsLocalOnly();

        // 全テーブルの最大updated_atをカーソルにする。settingsが更新されていなくても
        // Journal / Notebook の変更を次回から再取得しないようにする。
        const latestSettings = await appSupabaseClient.from(SUPABASE_SETTINGS_TABLE).select('updated_at').eq('user_id', cloudUser.id).maybeSingle();
        if (latestSettings.error && !isMissingTableError(latestSettings.error)) throw latestSettings.error;
        const maxUpdated = [
            ...(serverJ.data || []).map(r => r.updated_at),
            ...(serverN.data || []).map(r => r.updated_at),
            latestSettings.data?.updated_at
        ].filter(Boolean).map(v => Date.parse(v)).filter(Number.isFinite);
        const syncedAt = maxUpdated.length ? new Date(Math.max(...maxUpdated)).toISOString() : new Date().toISOString();

        // マニフェストを現在のローカル状態に合わせて再構築。
        const nextMeta = {
            version: SYNC_SCHEMA_VERSION,
            userId: cloudUser.id,
            lastSyncAt: syncedAt,
            journal: {},
            notebooks: {},
            settingsHash: fingerprint(getSettingsState()),
            settingsCloudUpdatedAt: latest.data?.updated_at || remote.settings?.updated_at || null,
            lastSyncChangedCount: journalUploads.length + notebookUploads.length + journalTombstones.length + notebookTombstones.length + (localChangedByRemote ? 1 : 0),
            lastSyncUploadedBytes: uploadedBytes,
            migratedLegacy: meta.migratedLegacy
        };

        // DB側のアクティブ状態を基準に、現在ローカルに存在する行を登録。
        const [serverJ, serverN] = await Promise.all([
            appSupabaseClient.from(SUPABASE_TABLE).select('id,updated_at,client_updated_at,deleted_at').eq('user_id', cloudUser.id),
            appSupabaseClient.from(SUPABASE_NOTEBOOK_TABLE).select('id,updated_at,client_updated_at,deleted_at').eq('user_id', cloudUser.id)
        ]);
        if (serverJ.error) throw serverJ.error;
        if (serverN.error) throw serverN.error;

        const serverJMap = new Map((serverJ.data || []).map(r => [r.id, r]));
        for (const x of getLocalJournalEntries()) {
            const r = serverJMap.get(x.log.id);
            nextMeta.journal[x.log.id] = {
                hash: fingerprint(journalFingerprintPayload(x.log)),
                cloudUpdatedAt: r?.updated_at || null,
                clientUpdatedAt: x.log.updatedAt || r?.client_updated_at || null,
                deleted: !!r?.deleted_at
            };
        }
        const serverNMap = new Map((serverN.data || []).map(r => [r.id, r]));
        for (const note of (notebookData || [])) {
            const r = serverNMap.get(note.id);
            nextMeta.notebooks[note.id] = {
                hash: fingerprint(notebookFingerprintPayload(note)),
                cloudUpdatedAt: r?.updated_at || null,
                clientUpdatedAt: note.updatedAt || r?.client_updated_at || null,
                deleted: !!r?.deleted_at
            };
        }
        for (const r of (serverJ.data || [])) {
            if (r.deleted_at) nextMeta.journal[r.id] = { hash: null, cloudUpdatedAt: r.updated_at, clientUpdatedAt: r.client_updated_at, deleted: true };
        }
        for (const r of (serverN.data || [])) {
            if (r.deleted_at) nextMeta.notebooks[r.id] = { hash: null, cloudUpdatedAt: r.updated_at, clientUpdatedAt: r.client_updated_at, deleted: true };
        }

        saveCloudSyncMeta(nextMeta);
        localStorage.setItem(SUPABASE_LINKED_USER_KEY, cloudUser.id);

        rebuildJournalDateListAndRender();
        updateCloudSettingsUI('差分同期済み');
        return true;
    } catch (e) {
        console.error('Supabase diff sync failed', e);
        updateCloudSettingsUI('同期に失敗');
        if (!silent) {
            let hint = '';
            if (isMissingTableError(e)) hint = '\n\nセットアップSQLをSupabase SQL Editorで1回実行してください。';
            alert(`差分同期に失敗しました。\n\n${getFriendlySupabaseError(e)}${hint}`);
        }
        return false;
    } finally {
        cloudSyncInProgress = false;
        updateCloudSettingsUI();
        if (cloudSyncQueued) {
            cloudSyncQueued = false;
            scheduleCloudSave(50);
        }
    }
}

function scheduleCloudSave(delay = 900) {
    if (!cloudIsSignedIn()) return;
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = setTimeout(() => {
        syncCloudDiff({ silent: true, reason: 'local-save' });
    }, delay);
}

async function saveCloudSnapshot() {
    return await syncCloudDiff({ silent: false, reason: 'manual-push' });
}

async function pushCurrentDeviceToCloud(showMessage = true) {
    if (!cloudIsSignedIn()) {
        alert('Supabaseにログインしていません。');
        return false;
    }
    const ok = await syncCloudDiff({ silent: !showMessage, reason: 'manual-push' });
    if (ok && showMessage) alert('この端末の未同期分をクラウドへ反映しました。\n\n既存の全データを毎回送信することはありません。');
    return ok;
}

async function loadCloudIntoCurrentDevice(showMessage = true) {
    if (!cloudIsSignedIn()) {
        alert('Supabaseにログインしていません。');
        return false;
    }
    try {
        cloudSyncInProgress = true;
        updateCloudSettingsUI('クラウドから全量読み込み中…');
        const remote = await fetchAllRemoteRows();
        await setDBData('localBackupBeforeSupabaseLoad', {
            journalData: cloneForCloud(journalData) || {},
            notebookData: cloneForCloud(notebookData) || [],
            appTypes: cloneForCloud(appTypes) || [],
            categories: cloneForCloud(categories) || [],
            typeSlackSettings: cloneForCloud(typeSlackSettings) || {},
            typeNotebookSettings: cloneForCloud(typeNotebookSettings) || {},
            savedAt: new Date().toISOString()
        });

        journalData = {};
        notebookData = [];
        for (const r of remote.journal) {
            if (r.deleted_at) continue;
            const hydrated = await hydrateJournalEntryToLocal(r, null);
            if (!journalData[r.date_key]) journalData[r.date_key] = [];
            journalData[r.date_key].push(hydrated);
        }
        for (const r of remote.notebooks) {
            if (r.deleted_at) continue;
            const hydrated = await hydrateNotebookContentForLocal(r.content || '', '');
            notebookData.push({
                id: r.id,
                title: r.title || '',
                content: hydrated.content,
                category: r.category || '',
                status: r.status || 'archive',
                linkedNoteIds: Array.isArray(r.linked_note_ids) ? r.linked_note_ids : [],
                createdAt: r.created_client_at || r.updated_at || new Date().toISOString(),
                updatedAt: r.client_updated_at || r.updated_at || new Date().toISOString()
            });
        }
        if (remote.settings) await applyRemoteSettings(remote.settings);
        ensureLocalStableIds();
        await setDBData('journalData', journalData);
        await setDBData('notebookData', notebookData);

        localStorage.removeItem(SUPABASE_LINKED_USER_KEY);
        // 直後に差分同期してmanifest/cursorを確定。
        cloudSyncInProgress = false;
        const synced = await syncCloudDiff({ silent: !showMessage, reason: 'full-download-normalize' });
        if (synced && showMessage) alert('クラウドデータをこの端末へ読み込みました。\n\n以後は差分同期になります。');
        return synced;
    } catch (e) {
        console.error('Supabase full load failed', e);
        alert(`クラウドデータの読み込みに失敗しました。\n\n${getFriendlySupabaseError(e)}`);
        return false;
    } finally {
        cloudSyncInProgress = false;
        updateCloudSettingsUI();
    }
}

async function recoverLocalBackupBeforeSupabaseLoad() {
    try {
        const backup = await getDBData('localBackupBeforeSupabaseLoad');
        if (!backup) { alert('復元用のローカルバックアップがありません。'); return; }
        const ok = confirm(`このバックアップを復元しますか？\n\n保存日時: ${backup.savedAt || '不明'}\n\n現在の端末上のデータは置き換えられます。`);
        if (!ok) return;
        journalData = backup.journalData || {};
        notebookData = backup.notebookData || [];
        appTypes = backup.appTypes || appTypes;
        categories = backup.categories || categories;
        typeSlackSettings = backup.typeSlackSettings || typeSlackSettings;
        typeNotebookSettings = backup.typeNotebookSettings || typeNotebookSettings;
        ensureLocalStableIds();
        await setDBData('journalData', journalData);
        await setDBData('notebookData', notebookData);
        saveAppTypesLocalOnly(); saveCategoriesLocalOnly(); saveTypeSlackSettingsLocalOnly(); saveTypeNotebookSettingsLocalOnly();
        localStorage.removeItem(SUPABASE_META_KEY);
        rebuildJournalDateListAndRender();
        alert('ローカルバックアップを復元しました。');
    } catch (e) {
        alert(`バックアップ復元に失敗しました。\n\n${getFriendlySupabaseError(e)}`);
    }
}

async function refreshCloudStateSilently() {
    if (!cloudIsSignedIn() || cloudSyncInProgress || document.hidden) return;
    await syncCloudDiff({ silent: true, reason: 'poll' });
}

function startCloudRefreshPolling() {
    stopCloudRefreshPolling();
    if (!cloudIsSignedIn()) return;
    cloudRefreshTimer = setInterval(refreshCloudStateSilently, 20000);
}

function stopCloudRefreshPolling() {
    if (cloudRefreshTimer) clearInterval(cloudRefreshTimer);
    cloudRefreshTimer = null;
}

function getSupabaseSetupSqlText() {
    return `-- Daily Journal 差分同期版 / 初回セットアップ SQL\n-- Supabase Dashboard > SQL Editor で1回だけ実行してください。\n-- ブラウザには Publishable/anon key のみ置き、service_role/secret key は絶対に公開しません。\n\ncreate table if not exists public.daily_journal_entries (\n  id text primary key,\n  user_id uuid not null references auth.users(id) on delete cascade,\n  date_key text,\n  time text,\n  text text not null default '',\n  category text,\n  slack_type text,\n  image_paths jsonb not null default '[]'::jsonb,\n  external_images jsonb not null default '[]'::jsonb,\n  created_client_at timestamptz,\n  client_updated_at timestamptz not null default now(),\n  deleted_at timestamptz,\n  updated_at timestamptz not null default now()\n);\n\ncreate table if not exists public.daily_journal_notebooks (\n  id text primary key,\n  user_id uuid not null references auth.users(id) on delete cascade,\n  title text not null default '',\n  content text not null default '',\n  category text,\n  status text not null default 'archive',\n  linked_note_ids jsonb not null default '[]'::jsonb,\n  created_client_at timestamptz,\n  client_updated_at timestamptz not null default now(),\n  deleted_at timestamptz,\n  updated_at timestamptz not null default now()\n);\n\ncreate table if not exists public.daily_journal_settings (\n  user_id uuid primary key references auth.users(id) on delete cascade,\n  state jsonb not null default '{}'::jsonb,\n  client_updated_at timestamptz not null default now(),\n  updated_at timestamptz not null default now()\n);\n\ncreate index if not exists daily_journal_entries_user_updated_idx on public.daily_journal_entries(user_id, updated_at);\ncreate index if not exists daily_journal_notebooks_user_updated_idx on public.daily_journal_notebooks(user_id, updated_at);\n\ncreate or replace function public.daily_journal_touch_updated_at()\nreturns trigger\nlanguage plpgsql\nsecurity invoker\nas $$\nbegin\n  new.updated_at = now();\n  return new;\nend;\n$$;\n\ndrop trigger if exists daily_journal_entries_touch_updated_at on public.daily_journal_entries;\ncreate trigger daily_journal_entries_touch_updated_at before update on public.daily_journal_entries for each row execute function public.daily_journal_touch_updated_at();\ndrop trigger if exists daily_journal_notebooks_touch_updated_at on public.daily_journal_notebooks;\ncreate trigger daily_journal_notebooks_touch_updated_at before update on public.daily_journal_notebooks for each row execute function public.daily_journal_touch_updated_at();\ndrop trigger if exists daily_journal_settings_touch_updated_at on public.daily_journal_settings;\ncreate trigger daily_journal_settings_touch_updated_at before update on public.daily_journal_settings for each row execute function public.daily_journal_touch_updated_at();\n\nalter table public.daily_journal_entries enable row level security;\nalter table public.daily_journal_notebooks enable row level security;\nalter table public.daily_journal_settings enable row level security;\n\nrevoke all on table public.daily_journal_entries, public.daily_journal_notebooks, public.daily_journal_settings from anon;\ngrant select, insert, update, delete on table public.daily_journal_entries, public.daily_journal_notebooks, public.daily_journal_settings to authenticated;\n\ndrop policy if exists "journal entries select own" on public.daily_journal_entries;\ncreate policy "journal entries select own" on public.daily_journal_entries for select to authenticated using ((select auth.uid()) = user_id);\ndrop policy if exists "journal entries insert own" on public.daily_journal_entries;\ncreate policy "journal entries insert own" on public.daily_journal_entries for insert to authenticated with check ((select auth.uid()) = user_id);\ndrop policy if exists "journal entries update own" on public.daily_journal_entries;\ncreate policy "journal entries update own" on public.daily_journal_entries for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);\ndrop policy if exists "journal entries delete own" on public.daily_journal_entries;\ncreate policy "journal entries delete own" on public.daily_journal_entries for delete to authenticated using ((select auth.uid()) = user_id);\n\ndrop policy if exists "notebooks select own" on public.daily_journal_notebooks;\ncreate policy "notebooks select own" on public.daily_journal_notebooks for select to authenticated using ((select auth.uid()) = user_id);\ndrop policy if exists "notebooks insert own" on public.daily_journal_notebooks;\ncreate policy "notebooks insert own" on public.daily_journal_notebooks for insert to authenticated with check ((select auth.uid()) = user_id);\ndrop policy if exists "notebooks update own" on public.daily_journal_notebooks;\ncreate policy "notebooks update own" on public.daily_journal_notebooks for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);\ndrop policy if exists "notebooks delete own" on public.daily_journal_notebooks;\ncreate policy "notebooks delete own" on public.daily_journal_notebooks for delete to authenticated using ((select auth.uid()) = user_id);\n\ndrop policy if exists "settings select own" on public.daily_journal_settings;\ncreate policy "settings select own" on public.daily_journal_settings for select to authenticated using ((select auth.uid()) = user_id);\ndrop policy if exists "settings insert own" on public.daily_journal_settings;\ncreate policy "settings insert own" on public.daily_journal_settings for insert to authenticated with check ((select auth.uid()) = user_id);\ndrop policy if exists "settings update own" on public.daily_journal_settings;\ncreate policy "settings update own" on public.daily_journal_settings for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);\ndrop policy if exists "settings delete own" on public.daily_journal_settings;\ncreate policy "settings delete own" on public.daily_journal_settings for delete to authenticated using ((select auth.uid()) = user_id);\n\ninsert into storage.buckets (id, name, public) values ('daily-journal-images', 'daily-journal-images', false) on conflict (id) do nothing;\n\ndrop policy if exists "daily journal images insert own" on storage.objects;\ncreate policy "daily journal images insert own" on storage.objects for insert to authenticated with check (bucket_id = 'daily-journal-images' and (storage.foldername(name))[1] = (select auth.uid()::text));\ndrop policy if exists "daily journal images select own" on storage.objects;\ncreate policy "daily journal images select own" on storage.objects for select to authenticated using (bucket_id = 'daily-journal-images' and (storage.foldername(name))[1] = (select auth.uid()::text));\ndrop policy if exists "daily journal images update own" on storage.objects;\ncreate policy "daily journal images update own" on storage.objects for update to authenticated using (bucket_id = 'daily-journal-images' and (storage.foldername(name))[1] = (select auth.uid()::text)) with check (bucket_id = 'daily-journal-images' and (storage.foldername(name))[1] = (select auth.uid()::text));\ndrop policy if exists "daily journal images delete own" on storage.objects;\ncreate policy "daily journal images delete own" on storage.objects for delete to authenticated using (bucket_id = 'daily-journal-images' and (storage.foldername(name))[1] = (select auth.uid()::text));\n\n-- 任意: 旧版の daily_journal_state は新しい差分同期が自動移行に利用します。\n`;
}

async function copySupabaseSetupSql() {
    const text = getSupabaseSetupSqlText();
    try {
        await navigator.clipboard.writeText(text);
        alert('差分同期用セットアップSQLをクリップボードへコピーしました。');
    } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        alert('差分同期用セットアップSQLをコピーしました。');
    }
}

function downloadSupabaseSetupSql() {
    const blob = new Blob([getSupabaseSetupSqlText()], { type: 'text/sql;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'supabase_setup_diff_sync.sql';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
