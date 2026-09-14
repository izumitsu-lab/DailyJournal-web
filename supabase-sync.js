// ==========================================
// supabase-sync.js (Supabase 連携・クラウド差分同期)
// ==========================================

let supabaseClient = null;
let supabaseUser = null;
let isSyncing = false;

// 差分同期用のキャッシュ（前回同期した状態を記憶）
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
    } catch (err) {
        console.error("Supabase クライアントの初期化に失敗しました:", err);
        alert("SupabaseのURLかKeyが正しくありません。");
    }
}

function saveSupabaseConfig() {
    const url = document.getElementById('supabaseUrlInput').value.trim();
    const key = document.getElementById('supabaseKeyInput').value.trim();

    if (!url || !key) {
        alert("URLとAnon Keyを入力してください。");
        return;
    }

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

    const { data: { session }, error } = await supabaseClient.auth.getSession();
    const statusEl = document.getElementById('supabaseAuthStatus');
    const logoutBtn = document.getElementById('supabaseLogoutBtn');

    if (session && session.user) {
        supabaseUser = session.user;
        statusEl.textContent = `ログイン中: ${supabaseUser.email} (クラウド同期有効)`;
        statusEl.style.color = "var(--notebook-color)";
        logoutBtn.style.display = "inline-flex";
        
        pullFromSupabase();
    } else {
        supabaseUser = null;
        statusEl.textContent = "未ログイン (クラウド同期無効)";
        statusEl.style.color = "var(--text-secondary)";
        logoutBtn.style.display = "none";
    }
}

async function signUpSupabase() {
    if (!supabaseClient) return alert("接続設定を先に行ってください。");
    
    const email = document.getElementById('supabaseEmail').value.trim();
    const password = document.getElementById('supabasePassword').value;

    if (!email || !password) return alert("メールアドレスとパスワードを入力してください。");

    const { data, error } = await supabaseClient.auth.signUp({ email, password });
    if (error) {
        alert("登録エラー: " + error.message);
    } else {
        alert("登録完了！クラウド同期を開始します。");
        document.getElementById('supabaseEmail').value = "";
        document.getElementById('supabasePassword').value = "";
        checkSupabaseAuth();
    }
}

async function signInSupabase() {
    if (!supabaseClient) return alert("接続設定を先に行ってください。");

    const email = document.getElementById('supabaseEmail').value.trim();
    const password = document.getElementById('supabasePassword').value;

    if (!email || !password) return alert("メールアドレスとパスワードを入力してください。");

    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
        alert("ログインエラー: " + error.message);
    } else {
        alert("ログインしました。クラウドからデータを同期します。");
        document.getElementById('supabaseEmail').value = "";
        document.getElementById('supabasePassword').value = "";
        checkSupabaseAuth();
    }
}

async function signOutSupabase() {
    if (!supabaseClient) return;
    await supabaseClient.auth.signOut();
    alert("ログアウトしました。ローカルデータは保持されます。");
    checkSupabaseAuth();
}

// ==========================================
// 3. Storageへの画像アップロード処理
// ==========================================

async function uploadImageToSupabase(base64Str) {
    if (!base64Str || !base64Str.startsWith('data:image')) return base64Str;

    try {
        const res = await fetch(base64Str);
        const blob = await res.blob();
        const ext = blob.type.split('/')[1] || 'jpeg';
        const fileName = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.${ext}`;
        const filePath = `${supabaseUser.id}/${fileName}`;

        const { data, error } = await supabaseClient.storage
            .from('images')
            .upload(filePath, blob);

        if (error) throw error;

        const { data: publicUrlData } = supabaseClient.storage
            .from('images')
            .getPublicUrl(filePath);

        return publicUrlData.publicUrl;
    } catch (err) {
        console.error("画像のアップロードに失敗しました:", err);
        return base64Str; 
    }
}

// ==========================================
// 4. アプリケーションの保存処理のフック (差分 Push同期)
// ==========================================

function hookIntoAppSave() {
    if (window.saveJournalData && !window._originalSaveJournalData) {
        window._originalSaveJournalData = window.saveJournalData;
        
        window.saveJournalData = async function() {
            if (supabaseClient && supabaseUser && !isSyncing) {
                isSyncing = true;
                try {
                    const payload = [];

                    for (const dateStr of Object.keys(window.journalData)) {
                        let isModified = false;

                        // 画像のURL化処理
                        for (const log of window.journalData[dateStr]) {
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

                        // 差分チェック (文字の変更や画像の変換があったか)
                        const currentJson = JSON.stringify(window.journalData[dateStr]);
                        if (currentJson !== lastSyncedJournals[dateStr]) {
                            payload.push({
                                date_str: dateStr,
                                user_id: supabaseUser.id,
                                log_data: window.journalData[dateStr],
                                updated_at: new Date().toISOString()
                            });
                            // キャッシュを更新
                            lastSyncedJournals[dateStr] = currentJson;
                        }
                    }

                    await window._originalSaveJournalData();

                    // 変更があった日付のデータだけを送信
                    if (payload.length > 0) {
                        const { error } = await supabaseClient.from('journals').upsert(payload);
                        if (error) console.error("Journals同期エラー:", error);
                    }
                } catch (e) {
                    console.error("クラウドへのJournal保存中にエラーが発生:", e);
                } finally {
                    isSyncing = false;
                }
            } else {
                await window._originalSaveJournalData();
            }
        };
    }

    if (window.saveNotebookData && !window._originalSaveNotebookData) {
        window._originalSaveNotebookData = window.saveNotebookData;
        
        window.saveNotebookData = async function() {
            if (supabaseClient && supabaseUser && !isSyncing) {
                isSyncing = true;
                try {
                    const payload = [];

                    for (const note of window.notebookData) {
                        // Notebook内のBase64画像をStorageへ
                        if (note.content && note.content.includes('data:image')) {
                            const tempDiv = document.createElement('div');
                            tempDiv.innerHTML = note.content;
                            const imgs = tempDiv.querySelectorAll('img[src^="data:image"]');
                            
                            for (let img of imgs) {
                                const url = await uploadImageToSupabase(img.src);
                                if (url) img.src = url;
                            }
                            note.content = tempDiv.innerHTML;
                        }

                        // 差分チェック
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
                            // キャッシュを更新
                            lastSyncedNotebooks[note.id] = currentJson;
                        }
                    }

                    await window._originalSaveNotebookData();

                    // 変更があったノートだけを送信
                    if (payload.length > 0) {
                        const { error } = await supabaseClient.from('notebooks').upsert(payload);
                        if (error) console.error("Notebooks同期エラー:", error);
                    }
                } catch (e) {
                    console.error("クラウドへのNotebook保存中にエラーが発生:", e);
                } finally {
                    isSyncing = false;
                }
            } else {
                await window._originalSaveNotebookData();
            }
        };
    }
}

// ==========================================
// 5. クラウドからのデータ取得 (Pull同期)
// ==========================================

async function pullFromSupabase() {
    if (!supabaseClient || !supabaseUser) return;
    isSyncing = true;

    try {
        console.log("クラウドからデータを同期中...");

        // 1. Journals の取得とキャッシュ更新
        const { data: journalsDb, error: jError } = await supabaseClient
            .from('journals')
            .select('*');
            
        if (!jError && journalsDb && journalsDb.length > 0) {
            journalsDb.forEach(row => {
                window.journalData[row.date_str] = row.log_data;
                lastSyncedJournals[row.date_str] = JSON.stringify(row.log_data); // キャッシュ保存
                
                if (!window.dateList.includes(row.date_str)) {
                    window.dateList.push(row.date_str);
                }
            });
            window.dateList.sort();
            await window._originalSaveJournalData();
        }

        // 2. Notebooks の取得とキャッシュ更新
        const { data: notebooksDb, error: nError } = await supabaseClient
            .from('notebooks')
            .select('*');

        if (!nError && notebooksDb && notebooksDb.length > 0) {
            window.notebookData = notebooksDb.map(row => {
                const noteObj = {
                    id: row.id,
                    title: row.title,
                    content: row.content,
                    category: row.category,
                    status: row.status,
                    linkedNoteIds: row.linked_note_ids || [],
                    createdAt: row.created_at,
                    updatedAt: row.updated_at
                };
                lastSyncedNotebooks[row.id] = JSON.stringify(noteObj); // キャッシュ保存
                return noteObj;
            });
            await window._originalSaveNotebookData();
        }

        // 3. UIの再描画
        if (typeof window.renderRightCards === 'function') {
            window.renderRightCards();
        }
        if (typeof window.renderMiniCalendar === 'function' && window.sidebarMode === 'cal' && window.calendarScope !== 'notebooks') {
            window.renderMiniCalendar();
        }

        console.log("クラウド同期が完了しました。");
        
    } catch (e) {
        console.error("Pull同期中にエラーが発生しました:", e);
    } finally {
        isSyncing = false;
    }
}