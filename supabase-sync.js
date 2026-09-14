// ==========================================
// supabase-sync.js (Supabase 連携・ローカルBase64完全保護版)
// ==========================================

let supabaseClient = null;
let supabaseUser = null;
let isPulling = false; 

let journalPushTimer = null;
let notebookPushTimer = null;
let settingsPushTimer = null;

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
    if (!window.supabase) {
        console.error("Supabase SDKが見つかりません。");
        return;
    }
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
        pullFromSupabase();
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
// 3. Storage画像アップロード＆ダウンロード
// ==========================================

async function uploadImageToSupabase(base64Str) {
    if (!base64Str || !base64Str.startsWith('data:image')) return base64Str;
    try {
        const res = await fetch(base64Str);
        const blob = await res.blob();
        const ext = blob.type.split('/')[1] || 'jpeg';
        const fileName = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.${ext}`;
        const filePath = `${supabaseUser.id}/${fileName}`;

        const { error } = await supabaseClient.storage.from('images').upload(filePath, blob);
        if (error) throw error;

        const { data: publicUrlData } = supabaseClient.storage.from('images').getPublicUrl(filePath);
        return publicUrlData.publicUrl;
    } catch (err) {
        console.error("画像のアップロード失敗:", err);
        return base64Str; 
    }
}

// 追加：クラウドのURL画像をローカル用にBase64（実データ）に変換する
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
        console.error("画像のダウンロード・変換失敗:", e);
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
            clearTimeout(settingsPushTimer);
            settingsPushTimer = setTimeout(() => {
                if (supabaseClient && supabaseUser && !isPulling) pushSettingsToSupabase();
            }, 1000);
        }
    };

    if (_originalSetDBData) {
        window.setDBData = function(key, value) {
            // ★ローカルのデータ（Base64の画像を含む）をそのまま本体に保存
            const promise = _originalSetDBData(key, value); 
            
            if (supabaseClient && supabaseUser && !isPulling) {
                if (key === 'journalData') {
                    clearTimeout(journalPushTimer);
                    journalPushTimer = setTimeout(() => pushJournalsToSupabase(value), 800);
                } else if (key === 'notebookData') {
                    clearTimeout(notebookPushTimer);
                    notebookPushTimer = setTimeout(() => pushNotebooksToSupabase(value), 800);
                }
            }
            return promise;
        };
    }
}

// ==========================================
// 5. データ送信 (Push) 処理
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
    } catch (e) {
        console.error("設定送信エラー:", e);
    }
}

async function pushJournalsToSupabase(jData) {
    try {
        const payload = [];

        for (const dateStr of Object.keys(jData)) {
            const currentJson = JSON.stringify(jData[dateStr]);
            if (currentJson !== lastSyncedJournals[dateStr]) {
                // ★本体のデータは守るため、クラウド送信用のコピーを作る
                const cloudLogData = JSON.parse(currentJson);
                
                // コピー側だけをURLに変換する
                for (const log of cloudLogData) {
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
                    log_data: cloudLogData,
                    updated_at: new Date().toISOString()
                });
                
                // キャッシュには「本体のBase64の状態」を記録しておく
                lastSyncedJournals[dateStr] = currentJson;
            }
        }

        if (payload.length > 0) {
            const { error } = await supabaseClient.from('journals').upsert(payload);
            if (error) {
                console.error("Journals送信エラー:", error);
                payload.forEach(p => delete lastSyncedJournals[p.date_str]); 
            }
        }
    } catch (e) {
        console.error("Journals同期中にエラー:", e);
    }
}

async function pushNotebooksToSupabase(nData) {
    try {
        const payload = [];

        for (const note of nData) {
            const currentJson = JSON.stringify(note);
            if (currentJson !== lastSyncedNotebooks[note.id]) {
                // ★本体のデータは守るため、クラウド送信用のコピーを作る
                const cloudNote = JSON.parse(currentJson);
                
                if (cloudNote.content && cloudNote.content.includes('data:image')) {
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = cloudNote.content;
                    const imgs = tempDiv.querySelectorAll('img[src^="data:image"]');
                    for (let img of imgs) {
                        const url = await uploadImageToSupabase(img.src);
                        if (url && url !== img.src) {
                            img.src = url;
                        }
                    }
                    cloudNote.content = tempDiv.innerHTML;
                }

                const safeCreatedAt = cloudNote.createdAt || new Date().toISOString();
                const safeUpdatedAt = cloudNote.updatedAt || new Date().toISOString();

                payload.push({
                    id: cloudNote.id,
                    user_id: supabaseUser.id,
                    title: cloudNote.title || '',
                    content: cloudNote.content || '',
                    category: cloudNote.category || 'ライフログ',
                    status: cloudNote.status || 'archive',
                    linked_note_ids: cloudNote.linkedNoteIds || [],
                    created_at: safeCreatedAt,
                    updated_at: safeUpdatedAt
                });
                lastSyncedNotebooks[note.id] = currentJson; 
            }
        }

        if (payload.length > 0) {
            const { error } = await supabaseClient.from('notebooks').upsert(payload);
            if (error) {
                console.error("Notebooks送信エラー:", error);
                payload.forEach(p => delete lastSyncedNotebooks[p.id]); 
            }
        }
    } catch (e) {
        console.error("Notebooks同期中にエラー:", e);
    }
}

// ==========================================
// 6. クラウドからのデータ取得 (Pull)
// ==========================================

async function pullFromSupabase() {
    if (!supabaseClient || !supabaseUser) return;
    isPulling = true; 

    try {
        console.log("クラウドからデータをダウンロード中...");

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
            let updated = false;
            for (const row of jDb) {
                const localLogs = journalData[row.date_str] || [];
                if (localLogs.length > row.log_data.length) continue; 
                
                const downloadedLogs = row.log_data;
                // ★クラウドから来たURL画像を、すべて実データ（Base64）にダウンロードしてから本体にしまう
                for (const log of downloadedLogs) {
                    if (log.images && log.images.length > 0) {
                        for (let i = 0; i < log.images.length; i++) {
                            if (log.images[i].startsWith('http')) {
                                log.images[i] = await downloadImageToBase64(log.images[i]);
                            }
                        }
                    }
                    if (log.image && log.image.startsWith('http')) {
                        log.image = await downloadImageToBase64(log.image);
                    }
                }

                journalData[row.date_str] = downloadedLogs;
                lastSyncedJournals[row.date_str] = JSON.stringify(downloadedLogs); 
                if (typeof dateList !== 'undefined' && !dateList.includes(row.date_str)) dateList.push(row.date_str);
                updated = true;
            }
            if (updated) {
                if (typeof dateList !== 'undefined') dateList.sort();
                await _originalSetDBData('journalData', journalData);
            }
        }

        // --- 3. Notebooks の取得 ---
        const { data: nDb } = await supabaseClient.from('notebooks').select('*');
        if (nDb && nDb.length > 0) {
            let updated = false;
            for (const row of nDb) {
                const idx = notebookData.findIndex(n => n.id === row.id);
                if (idx !== -1 && new Date(notebookData[idx].updatedAt) >= new Date(row.updated_at)) continue;

                let content = row.content;
                // ★クラウドから来たURL画像を、すべて実データ（Base64）にダウンロードしてから本体にしまう
                if (content && content.includes('http')) {
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = content;
                    const imgs = tempDiv.querySelectorAll('img[src^="http"]');
                    for (let img of imgs) {
                        const b64 = await downloadImageToBase64(img.src);
                        if (b64 && b64 !== img.src) {
                            img.src = b64;
                        }
                    }
                    content = tempDiv.innerHTML;
                }

                const noteObj = {
                    id: row.id, title: row.title, content: content, category: row.category,
                    status: row.status, linkedNoteIds: row.linked_note_ids || [],
                    createdAt: row.created_at, updatedAt: row.updated_at
                };

                if (idx !== -1) notebookData[idx] = noteObj;
                else notebookData.push(noteObj);

                lastSyncedNotebooks[row.id] = JSON.stringify(noteObj);
                updated = true;
            }
            if (updated) {
                await _originalSetDBData('notebookData', notebookData);
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
    } catch (e) {
        console.error("Pull同期エラー:", e);
    } finally {
        isPulling = false;
    }
}