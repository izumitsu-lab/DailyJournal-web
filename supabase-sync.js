// ==========================================
// supabase-sync.js (Supabase 連携・クラウド差分同期・究極安全版)
// ==========================================

let supabaseClient = null;
let supabaseUser = null;
let isSyncing = false;
let settingsSyncTimer = null;

// 差分同期用のキャッシュ
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
        console.error("Supabase SDKが読み込まれていません");
        return;
    }
    
    try {
        supabaseClient = window.supabase.createClient(url, key);
        document.getElementById('supabaseAuthBox').style.display = 'block';
        document.getElementById('supabaseSetupBox').style.display = 'block';
        checkSupabaseAuth();
        hookIntoAppSave(); 
        hookIntoSettingsSave();
    } catch (err) {
        console.error("Supabase クライアントの初期化に失敗しました:", err);
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
        statusEl.textContent = "未ログイン (ローカル保存のみ)";
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
        alert("登録完了！同期を開始します。");
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
        alert("ログインしました。データを同期します。");
        checkSupabaseAuth();
    }
}

async function signOutSupabase() {
    if (!supabaseClient) return;
    await supabaseClient.auth.signOut();
    alert("ログアウトしました。データは本体にのみ保存されます。");
    checkSupabaseAuth();
}

// ==========================================
// 3. Storageへの画像アップロード（確実なFetch方式）
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

// ==========================================
// 4. 設定の同期 (Push)
// ==========================================

function triggerSettingsSync() {
    if (!supabaseClient || !supabaseUser || isSyncing) return;
    clearTimeout(settingsSyncTimer);
    settingsSyncTimer = setTimeout(async () => {
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
        } catch(e) {}
    }, 1000);
}

function hookIntoSettingsSave() {
    const hooks = ['saveAppTypes', 'saveCategories', 'saveTypeSlackSettings', 'saveTypeNotebookSettings'];
    hooks.forEach(name => {
        if (typeof window[name] === 'function' && !window[`_original_${name}`]) {
            window[`_original_${name}`] = window[name];
            window[name] = function() {
                window[`_original_${name}`](); 
                triggerSettingsSync(); 
            };
        }
    });
}

// ==========================================
// 5. データ保存のフック（ローカル最優先・差分Push）
// ==========================================

function hookIntoAppSave() {
    // ---------------- Jourals ----------------
    if (typeof saveJournalData === 'function' && !window._originalSaveJournalData) {
        window._originalSaveJournalData = saveJournalData;
        
        saveJournalData = async function() {
            // ★超重要: まず何があっても必ずローカル（本体）に保存する
            await window._originalSaveJournalData();

            if (supabaseClient && supabaseUser && !isSyncing) {
                isSyncing = true;
                try {
                    const jData = typeof journalData !== 'undefined' ? journalData : window.journalData;
                    const payload = [];
                    let localNeedsResave = false;

                    for (const dateStr of Object.keys(jData)) {
                        let isModified = false;
                        for (const log of jData[dateStr]) {
                            if (log.images && log.images.length > 0) {
                                for (let i = 0; i < log.images.length; i++) {
                                    if (log.images[i].startsWith('data:image')) {
                                        log.images[i] = await uploadImageToSupabase(log.images[i]);
                                        isModified = true;
                                    }
                                }
                            }
                            if (log.image && log.image.startsWith('data:image')) {
                                log.image = await uploadImageToSupabase(log.image);
                                isModified = true;
                            }
                        }

                        if (isModified) localNeedsResave = true;

                        const currentJson = JSON.stringify(jData[dateStr]);
                        if (currentJson !== lastSyncedJournals[dateStr]) {
                            payload.push({
                                date_str: dateStr,
                                user_id: supabaseUser.id,
                                log_data: jData[dateStr],
                                updated_at: new Date().toISOString()
                            });
                        }
                    }

                    // 画像がURL化された場合はもう一度ローカルに保存
                    if (localNeedsResave) await window._originalSaveJournalData();

                    if (payload.length > 0) {
                        const { error } = await supabaseClient.from('journals').upsert(payload);
                        if (!error) {
                            payload.forEach(p => lastSyncedJournals[p.date_str] = JSON.stringify(p.log_data));
                        }
                    }
                } catch (e) {
                    console.error("クラウド保存中にエラー:", e);
                } finally {
                    isSyncing = false;
                }
            }
        };
    }

    // ---------------- Notebooks ----------------
    if (typeof saveNotebookData === 'function' && !window._originalSaveNotebookData) {
        window._originalSaveNotebookData = saveNotebookData;
        
        saveNotebookData = async function() {
            // ★超重要: まず何があっても必ずローカル（本体）に保存する
            await window._originalSaveNotebookData();

            if (supabaseClient && supabaseUser && !isSyncing) {
                isSyncing = true;
                try {
                    const nData = typeof notebookData !== 'undefined' ? notebookData : window.notebookData;
                    const payload = [];
                    let localNeedsResave = false;

                    for (const note of nData) {
                        if (note.content && note.content.includes('data:image')) {
                            const tempDiv = document.createElement('div');
                            tempDiv.innerHTML = note.content;
                            const imgs = tempDiv.querySelectorAll('img[src^="data:image"]');
                            
                            for (let img of imgs) {
                                const url = await uploadImageToSupabase(img.src);
                                if (url && url !== img.src) {
                                    img.src = url;
                                    isModified = true;
                                }
                            }
                            if (isModified) {
                                note.content = tempDiv.innerHTML;
                                localNeedsResave = true;
                            }
                        }

                        const currentJson = JSON.stringify(note);
                        if (currentJson !== lastSyncedNotebooks[note.id]) {
                            payload.push({
                                id: note.id,
                                user_id: supabaseUser.id,
                                title: note.title || '',
                                content: note.content || '',
                                category: note.category || 'ライフログ',
                                status: note.status || 'archive',
                                linked_note_ids: note.linkedNoteIds || [],
                                created_at: note.createdAt,
                                updated_at: note.updatedAt || new Date().toISOString()
                            });
                        }
                    }

                    if (localNeedsResave) await window._originalSaveNotebookData();

                    if (payload.length > 0) {
                        const { error } = await supabaseClient.from('notebooks').upsert(payload);
                        if (!error) {
                            payload.forEach(p => lastSyncedNotebooks[p.id] = JSON.stringify(p));
                        }
                    }
                } catch (e) {
                    console.error("クラウド保存中にエラー:", e);
                } finally {
                    isSyncing = false;
                }
            }
        };
    }
}

// ==========================================
// 6. クラウドからのデータ取得 (Pull同期・上書き防止)
// ==========================================

async function pullFromSupabase() {
    if (!supabaseClient || !supabaseUser) return;
    isSyncing = true;

    try {
        console.log("クラウドからデータを同期中...");

        // --- 1. 設定の取得 ---
        const { data: settingsDb } = await supabaseClient.from('app_settings').select('*').eq('user_id', supabaseUser.id).single();
        if (settingsDb && settingsDb.settings_data) {
            const s = settingsDb.settings_data;
            if (s.appTypes && typeof appTypes !== 'undefined') { appTypes = s.appTypes; localStorage.setItem('daily_journal_types', JSON.stringify(appTypes)); }
            if (s.categories && typeof categories !== 'undefined') { categories = s.categories; localStorage.setItem('daily_journal_categories', JSON.stringify(categories)); }
            if (s.typeSlackSettings && typeof typeSlackSettings !== 'undefined') { typeSlackSettings = s.typeSlackSettings; localStorage.setItem('daily_journal_type_slack', JSON.stringify(typeSlackSettings)); }
            if (s.typeNotebookSettings && typeof typeNotebookSettings !== 'undefined') { typeNotebookSettings = s.typeNotebookSettings; localStorage.setItem('daily_journal_type_notebook', JSON.stringify(typeNotebookSettings)); }
        }

        // --- 2. Journals の取得 ---
        const { data: journalsDb } = await supabaseClient.from('journals').select('*');
        if (journalsDb && journalsDb.length > 0) {
            const jData = typeof journalData !== 'undefined' ? journalData : window.journalData;
            let needLocalSave = false;

            journalsDb.forEach(row => {
                const localLogs = jData[row.date_str] || [];
                // ★防波堤: ローカル(本体)の方が件数が多い場合は、クラウドの古いデータで上書きしない！
                if (localLogs.length > row.log_data.length) {
                    console.warn(`[Sync] ${row.date_str}は本体のデータが最新のため上書きをスキップします`);
                    return; 
                }
                
                jData[row.date_str] = row.log_data;
                lastSyncedJournals[row.date_str] = JSON.stringify(row.log_data);
                if (typeof dateList !== 'undefined' && !dateList.includes(row.date_str)) dateList.push(row.date_str);
                needLocalSave = true;
            });
            if (typeof dateList !== 'undefined') dateList.sort();
            if (needLocalSave && typeof window._originalSaveJournalData === 'function') await window._originalSaveJournalData();
        }

        // --- 3. Notebooks の取得 ---
        const { data: notebooksDb } = await supabaseClient.from('notebooks').select('*');
        if (notebooksDb && notebooksDb.length > 0) {
            const nData = typeof notebookData !== 'undefined' ? notebookData : window.notebookData;
            let needLocalSave = false;

            notebooksDb.forEach(row => {
                const existingIndex = nData.findIndex(n => n.id === row.id);
                // ★防波堤: 本体の方が更新日時が新しい場合は上書きしない！
                if (existingIndex !== -1 && new Date(nData[existingIndex].updatedAt) > new Date(row.updated_at)) {
                    console.warn(`[Sync] ノート ${row.id} は本体のデータが最新のため上書きをスキップします`);
                    return;
                }

                const noteObj = {
                    id: row.id, title: row.title, content: row.content, category: row.category,
                    status: row.status, linkedNoteIds: row.linked_note_ids || [],
                    createdAt: row.created_at, updatedAt: row.updated_at
                };

                if (existingIndex !== -1) nData[existingIndex] = noteObj;
                else nData.push(noteObj);

                lastSyncedNotebooks[row.id] = JSON.stringify(noteObj);
                needLocalSave = true;
            });
            if (needLocalSave && typeof window._originalSaveNotebookData === 'function') await window._originalSaveNotebookData();
        }

        // --- 4. 画面の再描画 ---
        if (typeof updateCategoryButtonUI === 'function') updateCategoryButtonUI();
        if (typeof renderSettingsTypeList === 'function') renderSettingsTypeList();
        if (typeof renderSettingsCategoryList === 'function') renderSettingsCategoryList();
        if (typeof renderRightCards === 'function') renderRightCards();
        if (typeof renderMiniCalendar === 'function' && typeof sidebarMode !== 'undefined' && sidebarMode === 'cal' && typeof calendarScope !== 'undefined' && calendarScope !== 'notebooks') {
            renderMiniCalendar();
        }

    } catch (e) {
        console.error("Pull同期エラー:", e);
    } finally {
        isSyncing = false;
    }
}