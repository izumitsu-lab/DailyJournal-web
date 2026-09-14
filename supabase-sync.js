// ==========================================
// supabase-sync.js (Supabase 連携・超軽量ハッシュ同期・ローカル完全保護版)
// ==========================================

let supabaseClient = null;
let supabaseUser = null;
let isPulling = false; 

let journalPushTimer = null;
let notebookPushTimer = null;
let settingsPushTimer = null;

// 送信待ちデータを保持（アプリを閉じる瞬間に即時送信するため）
let pendingJournalPush = null;
let pendingNotebookPush = null;

let lastSyncedJournals = {};
let lastSyncedNotebooks = {};

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
        
        pullFromSupabase(true); // 初期ロード時は強制Pull
    } else {
        supabaseUser = null;
        statusEl.textContent = "未ログイン (本体保存のみ)";
        statusEl.style.color = "var(--text-secondary)";
        logoutBtn.style.display = "none";
    }
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
    alert("ログアウトしました。これ以降は本体のみに保存されます。");
    checkSupabaseAuth();
}

// ==========================================
// 3. UI フィードバック機能 (トースト＆アイコンアニメーション)
// ==========================================

function showGlobalToast(message, type = 'info') {
    const toast = document.getElementById('globalToast');
    if (!toast) return;
    
    toast.innerHTML = message;
    toast.className = 'global-toast show ' + (type === 'success' ? 'sync-success' : type === 'error' ? 'sync-error' : '');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 2500);
}

function toggleSyncIcon(isSyncing) {
    const icon = document.getElementById('btnSyncPullIcon');
    if (!icon) return;
    if (isSyncing) {
        icon.classList.add('icon-spin', 'sync-active');
    } else {
        icon.classList.remove('icon-spin', 'sync-active');
    }
}

// ==========================================
// 4. 画像のハッシュ化・無駄ゼロ通信モジュール
// ==========================================

async function getHash(str) {
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function uploadImageToSupabase(base64Str) {
    if (!base64Str || !base64Str.startsWith('data:image')) return base64Str;
    try {
        const hash = await getHash(base64Str);
        const ext = base64Str.substring(base64Str.indexOf('/') + 1, base64Str.indexOf(';')) || 'jpeg';
        const fileName = `img_${hash}.${ext}`;
        const filePath = `${supabaseUser.id}/${fileName}`;

        const { data: publicUrlData } = supabaseClient.storage.from('images').getPublicUrl(filePath);

        const res = await fetch(base64Str);
        const blob = await res.blob();
        const { error } = await supabaseClient.storage.from('images').upload(filePath, blob, { upsert: false });
        
        if (error && !error.message.includes('already exists') && !error.message.includes('Duplicate')) {
            throw error;
        }

        return publicUrlData.publicUrl;
    } catch (err) {
        console.error("画像アップロード失敗:", err);
        return base64Str; 
    }
}

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
// 5. ブラウザ・ストレージの直接監視 (フック) と 即時フラッシュ
// ==========================================

const _originalSetItem = localStorage.setItem;
const _originalSetDBData = window.setDBData;

function hookCoreStorage() {
    localStorage.setItem = function(key, value) {
        _originalSetItem.call(this, key, value); 

        if (['daily_journal_categories', 'daily_journal_types', 'daily_journal_type_slack', 'daily_journal_type_notebook'].includes(key)) {
            clearTimeout(settingsPushTimer);
            settingsPushTimer = setTimeout(() => {
                if (supabaseClient && supabaseUser && !isPulling) pushSettingsToSupabase();
            }, 1000);
        }
    };

    if (_originalSetDBData) {
        window.setDBData = function(key, value) {
            const promise = _originalSetDBData(key, value); 
            
            if (supabaseClient && supabaseUser && !isPulling) {
                if (key === 'journalData') {
                    clearTimeout(journalPushTimer);
                    pendingJournalPush = JSON.parse(JSON.stringify(value));
                    journalPushTimer = setTimeout(() => {
                        pushJournalsToSupabase(pendingJournalPush);
                        journalPushTimer = null;
                        pendingJournalPush = null;
                    }, 800);
                } else if (key === 'notebookData') {
                    clearTimeout(notebookPushTimer);
                    pendingNotebookPush = JSON.parse(JSON.stringify(value));
                    notebookPushTimer = setTimeout(() => {
                        pushNotebooksToSupabase(pendingNotebookPush);
                        notebookPushTimer = null;
                        pendingNotebookPush = null;
                    }, 800);
                }
            }
            return promise;
        };
    }
}

// アプリがバックグラウンドに回った時、または閉じられる時に送信待ちがあれば即時送信(Push)
async function flushPendingPushes() {
    if (!supabaseClient || !supabaseUser) return;
    
    let promises = [];
    if (journalPushTimer && pendingJournalPush) {
        clearTimeout(journalPushTimer);
        promises.push(pushJournalsToSupabase(pendingJournalPush));
        journalPushTimer = null;
        pendingJournalPush = null;
    }
    if (notebookPushTimer && pendingNotebookPush) {
        clearTimeout(notebookPushTimer);
        promises.push(pushNotebooksToSupabase(pendingNotebookPush));
        notebookPushTimer = null;
        pendingNotebookPush = null;
    }
    if (settingsPushTimer) {
        clearTimeout(settingsPushTimer);
        promises.push(pushSettingsToSupabase());
        settingsPushTimer = null;
    }

    if (promises.length > 0) {
        await Promise.all(promises);
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        flushPendingPushes();
    }
});

window.addEventListener('beforeunload', () => {
    flushPendingPushes();
});

// ==========================================
// 6. データ送信 (Push) 処理
// ==========================================

async function pushSettingsToSupabase() {
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
        await supabaseClient.from('app_settings').upsert(payload);
    } catch (e) {}
}

async function pushJournalsToSupabase(cloudJData) {
    try {
        const payload = [];

        for (const dateStr of Object.keys(cloudJData)) {
            const currentJson = JSON.stringify(cloudJData[dateStr]);
            if (currentJson !== lastSyncedJournals[dateStr]) {
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
                lastSyncedJournals[dateStr] = currentJson;
            }
        }

        if (payload.length > 0) {
            const { error } = await supabaseClient.from('journals').upsert(payload);
            if (error) payload.forEach(p => delete lastSyncedJournals[p.date_str]); 
        }
    } catch (e) {}
}

async function pushNotebooksToSupabase(cloudNData) {
    try {
        const payload = [];

        for (const cloudNote of cloudNData) {
            const currentJson = JSON.stringify(cloudNote);
            if (currentJson !== lastSyncedNotebooks[cloudNote.id]) {
                
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
                lastSyncedNotebooks[cloudNote.id] = currentJson; 
            }
        }

        if (payload.length > 0) {
            const { error } = await supabaseClient.from('notebooks').upsert(payload);
            if (error) payload.forEach(p => delete lastSyncedNotebooks[p.id]); 
        }
    } catch (e) {}
}

// ==========================================
// 7. クラウドからのデータ取得 (Pull) と 強制更新処理
// ==========================================

async function extractLocalImagesDict() {
    const dict = {};
    const jData = typeof journalData !== 'undefined' ? journalData : window.journalData;
    const nData = typeof notebookData !== 'undefined' ? notebookData : window.notebookData;

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

// ★ 引数に force=false を追加。true ならキャッシュを無視して強制取得＋UI表示
async function pullFromSupabase(force = false) {
    if (!supabaseClient || !supabaseUser) return;
    if (isPulling) return; 

    isPulling = true; 

    if (force) {
        toggleSyncIcon(true);
        showGlobalToast('⏳ クラウドと同期中...', 'info');
        // キャッシュを破棄してクラウド側を正とする
        lastSyncedJournals = {};
        lastSyncedNotebooks = {};
    }

    try {
        console.log("クラウドからデータを照合中...");
        
        const localImagesDict = await extractLocalImagesDict();

        // --- 1. 設定の取得 ---
        const { data: sDb } = await supabaseClient.from('app_settings').select('*').eq('user_id', supabaseUser.id).single();
        if (sDb && sDb.settings_data) {
            const s = sDb.settings_data;
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
        } else {
            pushSettingsToSupabase();
        }

        // --- 2. Journals の取得 ---
        const { data: jDb } = await supabaseClient.from('journals').select('*');
        if (jDb && jDb.length > 0) {
            const jData = typeof journalData !== 'undefined' ? journalData : window.journalData;
            let updated = false;

            for (const row of jDb) {
                const downloadedLogs = row.log_data;
                
                for (const log of downloadedLogs) {
                    if (log.images && log.images.length > 0) {
                        for (let i = 0; i < log.images.length; i++) {
                            if (log.images[i].startsWith('http')) {
                                const match = log.images[i].match(/img_([a-f0-9]+)\./);
                                if (match && match[1] && localImagesDict[match[1]]) {
                                    log.images[i] = localImagesDict[match[1]];
                                } else {
                                    log.images[i] = await downloadImageToBase64(log.images[i]); 
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

                // Force フラグがある、または手元のキャッシュと異なる場合は上書き
                if (force || JSON.stringify(jData[row.date_str]) !== JSON.stringify(downloadedLogs)) {
                    jData[row.date_str] = downloadedLogs;
                    lastSyncedJournals[row.date_str] = JSON.stringify(downloadedLogs); 
                    if (typeof dateList !== 'undefined' && !dateList.includes(row.date_str)) dateList.push(row.date_str);
                    updated = true;
                }
            }
            if (updated) {
                if (typeof dateList !== 'undefined') dateList.sort();
                await _originalSetDBData('journalData', jData);
            }
        }

        // --- 3. Notebooks の取得 ---
        const { data: nDb } = await supabaseClient.from('notebooks').select('*');
        if (nDb && nDb.length > 0) {
            const nData = typeof notebookData !== 'undefined' ? notebookData : window.notebookData;
            let updated = false;

            for (const row of nDb) {
                const idx = nData.findIndex(n => n.id === row.id);
                // forceフラグが無く、かつローカルの方が新しい場合はスキップ（ローカル保護）
                if (!force && idx !== -1 && new Date(nData[idx].updatedAt) > new Date(row.updated_at)) {
                    continue;
                }

                let content = row.content;
                if (content && content.includes('http')) {
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = content;
                    const imgs = tempDiv.querySelectorAll('img[src^="http"]');
                    for (let img of imgs) {
                        const match = img.src.match(/img_([a-f0-9]+)\./);
                        if (match && match[1] && localImagesDict[match[1]]) {
                            img.src = localImagesDict[match[1]];
                        } else if (img.src.includes('/storage/v1/object/public/images/')) {
                            const b64 = await downloadImageToBase64(img.src); 
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

                // 更新があるかチェック
                if (idx === -1 || JSON.stringify(nData[idx]) !== JSON.stringify(noteObj)) {
                    if (idx !== -1) nData[idx] = noteObj;
                    else nData.push(noteObj);

                    lastSyncedNotebooks[row.id] = JSON.stringify(noteObj);
                    updated = true;
                }
            }
            if (updated) {
                await _originalSetDBData('notebookData', nData);
            }
        }

        // --- 4. 画面の再描画 ---
        if (typeof updateCategoryButtonUI === 'function') updateCategoryButtonUI();
        if (typeof renderSettingsTypeList === 'function') renderSettingsTypeList();
        if (typeof renderSettingsCategoryList === 'function') renderSettingsCategoryList();
        if (typeof renderRightCards === 'function') renderRightCards();
        if (typeof renderNotebookSidebar === 'function' && typeof calendarScope !== 'undefined' && calendarScope === 'notebooks') renderNotebookSidebar();
        if (typeof renderMiniCalendar === 'function' && typeof sidebarMode !== 'undefined' && sidebarMode === 'cal' && typeof calendarScope !== 'undefined' && calendarScope !== 'notebooks') renderMiniCalendar();

        console.log("クラウド同期が完了しました。");
        
        if (force) {
            showGlobalToast('✅ 最新の状態です', 'success');
        }

    } catch (e) {
        console.error("Pull同期エラー:", e);
        if (force) {
            showGlobalToast('❌ 同期に失敗しました', 'error');
        }
    } finally {
        isPulling = false;
        if (force) {
            toggleSyncIcon(false);
        }
    }
}