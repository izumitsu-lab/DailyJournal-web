// ==========================================
// main.js (初期化・全体設定・データ管理・IndexedDB)
// ==========================================

function updateAppHeight() {
    document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`);
}
window.addEventListener('resize', () => {
    updateAppHeight();
    applyDeviceModeSetting();
});
window.addEventListener('orientationchange', () => { 
    setTimeout(() => {
        updateAppHeight();
        applyDeviceModeSetting();
    }, 150); 
});
updateAppHeight();

// デフォルトのタイプ順序（「ログ」が前、「研究管理」が後）
const DEFAULT_TYPES = ["ログ", "研究管理", "一般"];

// デフォルトカテゴリ設定
const DEFAULT_CATEGORIES = [
    { name: "ライフログ", type: "ログ" },
    { name: "植物", type: "ログ" },
    { name: "学生１", type: "研究管理" },
    { name: "学生２", type: "研究管理" }
];
const DEFAULT_TYPE_SLACK = { "all": false, "研究管理": true, "ログ": false, "一般": false };
const DEFAULT_TYPE_NOTEBOOK = { "all": true, "研究管理": true, "ログ": true, "一般": true };

let appTypes = JSON.parse(localStorage.getItem('daily_journal_types')) || DEFAULT_TYPES;
let categories = JSON.parse(localStorage.getItem('daily_journal_categories')) || DEFAULT_CATEGORIES;
let typeSlackSettings = JSON.parse(localStorage.getItem('daily_journal_type_slack')) || DEFAULT_TYPE_SLACK;
let typeNotebookSettings = JSON.parse(localStorage.getItem('daily_journal_type_notebook')) || DEFAULT_TYPE_NOTEBOOK;

// デフォルトで明るいテーマ（ライトテーマ）を有効化
let lightThemeEnabled = localStorage.getItem('daily_journal_theme') !== null 
    ? localStorage.getItem('daily_journal_theme') === 'true' 
    : true;

let hideEmptyCards = localStorage.getItem('daily_journal_hide_empty') === 'true';

// 表示モード設定 ('auto', 'mobile', 'desktop')
let deviceDisplayMode = localStorage.getItem('daily_journal_device_mode') || 'auto';

// Gallery View 列数設定 ('auto', '3', '4', '5')
let galleryColumns = localStorage.getItem('daily_journal_gallery_cols') || 'auto';

let calendarScope = 'day';
let previousCalendarScope = 'day';
let lastJournalScope = 'day';
let lastJournalDateKey = null;
let lastPhotoPanelKey = null;

let currentNotebookIndex = 0;
let currentNotebookCategory = "ライフログ";
let notebookViewMode = 'grid';

let journalData = {};
let notebookData = [];
let dateList = [];
let activeDateKey = null;

let miniCalYear = new Date().getFullYear();
let miniCalMonth = new Date().getMonth();
let sidebarMode = 'cal';
let currentFilter = { mode: 'all', value: '' };

let selectedAddCategory = "ライフログ";
let selectedEditCategory = "ライフログ";
let currentAddMsgType = 'normal';
let currentEditMsgType = 'normal';
let currentAddPhotos = [];
let currentEditPhotos = [];
let currentEditTarget = { dateStr: null, index: null };
let isProgrammaticScroll = false;
let programmaticScrollTimer = null;

// ==========================================
// IndexedDB Setup & Wrappers
// ==========================================
const DB_NAME = 'DailyJournalDB';
const STORE_NAME = 'appData';

function initDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function getDBData(key) {
    return new Promise(async (resolve, reject) => {
        try {
            const db = await initDB();
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        } catch (e) { reject(e); }
    });
}

function setDBData(key, value) {
    return new Promise(async (resolve, reject) => {
        try {
            const db = await initDB();
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.put(value, key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        } catch (e) { reject(e); }
    });
}

function deleteDBData(key) {
    return new Promise(async (resolve, reject) => {
        try {
            const db = await initDB();
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.delete(key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        } catch (e) { reject(e); }
    });
}

async function saveNotebookData() { await setDBData('notebookData', notebookData); }
async function saveJournalData() { await setDBData('journalData', journalData); }

async function purgeTodoFromStorage() {
    try {
        await deleteDBData('todoData');
        await deleteDBData('projectData');
    } catch (e) {}
    localStorage.removeItem('daily_journal_todo');
    localStorage.removeItem('daily_journal_projects');
    localStorage.removeItem('daily_journal_type_todo');
}

// ==========================================
// タイプ管理関数 (追加・リネーム・削除・順序保持)
// ==========================================
function saveAppTypes() {
    localStorage.setItem('daily_journal_types', JSON.stringify(appTypes));
}

function addNewType(name) {
    name = (name || '').trim();
    if (!name) { alert("タイプ名を入力してください。"); return false; }
    if (appTypes.includes(name)) { alert("同名のタイプが既に存在します。"); return false; }

    appTypes.push(name);
    if (typeSlackSettings[name] === undefined) typeSlackSettings[name] = false;
    if (typeNotebookSettings[name] === undefined) typeNotebookSettings[name] = true;

    saveAppTypes();
    saveTypeSlackSettings();
    saveTypeNotebookSettings();
    return true;
}

function renameType(oldName, newName) {
    newName = (newName || '').trim();
    if (!newName) { alert("新しいタイプ名を入力してください。"); return false; }
    if (oldName === newName) return true;
    if (appTypes.includes(newName)) { alert("既に同名のタイプが存在します。"); return false; }

    const idx = appTypes.indexOf(oldName);
    if (idx !== -1) {
        appTypes[idx] = newName;
    }

    categories.forEach(c => {
        if (c.type === oldName) c.type = newName;
    });

    if (typeSlackSettings[oldName] !== undefined) {
        typeSlackSettings[newName] = typeSlackSettings[oldName];
        delete typeSlackSettings[oldName];
    } else {
        typeSlackSettings[newName] = false;
    }

    if (typeNotebookSettings[oldName] !== undefined) {
        typeNotebookSettings[newName] = typeNotebookSettings[oldName];
        delete typeNotebookSettings[oldName];
    } else {
        typeNotebookSettings[newName] = true;
    }

    if (currentFilter.mode === 'type' && currentFilter.value === oldName) {
        currentFilter.value = newName;
    }

    saveAppTypes();
    saveCategories();
    saveTypeSlackSettings();
    saveTypeNotebookSettings();
    return true;
}

function deleteType(typeName) {
    if (appTypes.length <= 1) {
        alert("タイプをすべて削除することはできません。（最低1つのタイプが必要です）");
        return false;
    }

    const catCount = categories.filter(c => c.type === typeName).length;
    const fallbackType = appTypes.find(t => t !== typeName) || "一般";

    const confirmMsg = catCount > 0
        ? `タイプ「${typeName}」を削除しますか？\n所属している ${catCount} 個のカテゴリは「${fallbackType}」に変更されます。`
        : `タイプ「${typeName}」を削除しますか？`;

    if (!confirm(confirmMsg)) return false;

    appTypes = appTypes.filter(t => t !== typeName);

    categories.forEach(c => {
        if (c.type === typeName) c.type = fallbackType;
    });

    delete typeSlackSettings[typeName];
    delete typeNotebookSettings[typeName];

    if (currentFilter.mode === 'type' && currentFilter.value === typeName) {
        currentFilter = { mode: 'all', value: '' };
    }

    saveAppTypes();
    saveCategories();
    saveTypeSlackSettings();
    saveTypeNotebookSettings();
    return true;
}

// ==========================================
// カテゴリ管理関数 (リネーム対応)
// ==========================================
async function renameCategory(oldName, newName) {
    newName = (newName || '').trim();
    if (!newName) { alert("カテゴリ名を入力してください。"); return false; }
    if (oldName === newName) return true;
    if (categories.some(c => c.name === newName)) { alert("同名のカテゴリが既に存在します。"); return false; }

    const cat = categories.find(c => c.name === oldName);
    if (cat) {
        cat.name = newName;
    }

    let journalUpdated = false;
    Object.keys(journalData).forEach(dateStr => {
        if (Array.isArray(journalData[dateStr])) {
            journalData[dateStr].forEach(log => {
                if (log.category === oldName) {
                    log.category = newName;
                    journalUpdated = true;
                }
            });
        }
    });

    let notebookUpdated = false;
    notebookData.forEach(n => {
        if (n.category === oldName) {
            n.category = newName;
            notebookUpdated = true;
        }
    });

    if (currentFilter.mode === 'category' && currentFilter.value === oldName) {
        currentFilter.value = newName;
    }
    if (selectedAddCategory === oldName) selectedAddCategory = newName;
    if (selectedEditCategory === oldName) selectedEditCategory = newName;
    if (currentNotebookCategory === oldName) currentNotebookCategory = newName;

    saveCategories();
    if (journalUpdated) await saveJournalData();
    if (notebookUpdated) await saveNotebookData();
    return true;
}

// ==========================================
// Migrations & Helpers
// ==========================================
async function syncAndMigrateCategories() {
    let typesUpdated = false;

    if (!Array.isArray(appTypes) || appTypes.length === 0) {
        appTypes = [...DEFAULT_TYPES];
        typesUpdated = true;
    }

    const oldStudentIdx = appTypes.indexOf("学生管理");
    if (oldStudentIdx !== -1) {
        appTypes[oldStudentIdx] = "研究管理";
        typesUpdated = true;
    }

    if (!appTypes.includes("ログ")) {
        appTypes.unshift("ログ");
        typesUpdated = true;
    }
    if (!appTypes.includes("研究管理")) {
        const logIdx = appTypes.indexOf("ログ");
        appTypes.splice(logIdx + 1, 0, "研究管理");
        typesUpdated = true;
    }

    let catUpdated = false;
    categories.forEach(c => {
        if (c.type === "学生管理") { 
            c.type = "研究管理"; 
            catUpdated = true; 
        }
        if (!c.type || !appTypes.includes(c.type)) {
            if (c.type && !appTypes.includes(c.type)) {
                appTypes.push(c.type);
                typesUpdated = true;
            } else {
                c.type = "一般";
                catUpdated = true;
            }
        }
    });

    if (!categories || categories.length === 0) {
        categories = [...DEFAULT_CATEGORIES];
        catUpdated = true;
    }

    if (typesUpdated) saveAppTypes();
    if (catUpdated) saveCategories();

    let settingsUpdated = false;
    if (typeSlackSettings["all"] === undefined) { typeSlackSettings["all"] = false; settingsUpdated = true; }
    if (typeSlackSettings["学生管理"] !== undefined) { typeSlackSettings["研究管理"] = typeSlackSettings["学生管理"]; delete typeSlackSettings["学生管理"]; settingsUpdated = true; }
    if (typeNotebookSettings["学生管理"] !== undefined) { typeNotebookSettings["研究管理"] = typeNotebookSettings["学生管理"]; delete typeNotebookSettings["学生管理"]; settingsUpdated = true; }

    appTypes.forEach(t => {
        if (typeSlackSettings[t] === undefined) { typeSlackSettings[t] = false; settingsUpdated = true; }
        if (typeNotebookSettings[t] === undefined) { typeNotebookSettings[t] = true; settingsUpdated = true; }
    });

    if (settingsUpdated) { saveTypeSlackSettings(); saveTypeNotebookSettings(); }

    let dataUpdated = false;
    Object.keys(journalData).forEach(dateStr => {
        if (Array.isArray(journalData[dateStr])) {
            journalData[dateStr].forEach(log => {
                if (!log.category) { log.category = "ライフログ"; dataUpdated = true; }
            });
        }
    });
    if (dataUpdated) await saveJournalData();
    
    let notebookUpdated = false;
    notebookData.forEach(n => {
        if (!Array.isArray(n.linkedNoteIds)) {
            n.linkedNoteIds = [];
            notebookUpdated = true;
        }
        if (!n.status) {
            n.status = 'archive';
            notebookUpdated = true;
        }
    });
    if (notebookUpdated) await saveNotebookData();
}

function saveCategories() { localStorage.setItem('daily_journal_categories', JSON.stringify(categories)); }
function saveTypeSlackSettings() { localStorage.setItem('daily_journal_type_slack', JSON.stringify(typeSlackSettings)); }
function saveTypeNotebookSettings() { localStorage.setItem('daily_journal_type_notebook', JSON.stringify(typeNotebookSettings)); }
function isSlackEnabledForType(type) { return typeSlackSettings[type] !== undefined ? !!typeSlackSettings[type] : false; }

function applyGalleryColumnsSetting() {
    const sel = document.getElementById('galleryColumnsSelect');
    if (sel) sel.value = galleryColumns;
}

function changeGalleryColumns(val) {
    galleryColumns = val || 'auto';
    localStorage.setItem('daily_journal_gallery_cols', galleryColumns);
    if (calendarScope === 'notebooks' && notebookViewMode === 'grid') {
        renderRightCards();
    }
}

// ==========================================
// 表示モード（スマホ / PC / オート）の適用・切り替え
// ==========================================
function applyDeviceModeSetting() {
    const sel = document.getElementById('deviceModeSelect');
    if (sel) sel.value = deviceDisplayMode;

    document.body.classList.remove('is-mobile-mode', 'is-desktop-mode');

    if (deviceDisplayMode === 'mobile') {
        document.body.classList.add('is-mobile-mode');
        sidebarMode = 'none';
        const calSidebar = document.getElementById('calendarSidebar');
        if (calSidebar) calSidebar.classList.remove('active');
    } else if (deviceDisplayMode === 'desktop') {
        document.body.classList.add('is-desktop-mode');
    } else {
        // auto
        const isMobile = window.innerWidth <= 768 || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
        if (isMobile) {
            document.body.classList.add('is-mobile-mode');
            sidebarMode = 'none';
            const calSidebar = document.getElementById('calendarSidebar');
            if (calSidebar) calSidebar.classList.remove('active');
        } else {
            document.body.classList.add('is-desktop-mode');
        }
    }
}

function changeDeviceMode(mode) {
    deviceDisplayMode = mode || 'auto';
    localStorage.setItem('daily_journal_device_mode', deviceDisplayMode);
    applyDeviceModeSetting();
    updateSidebars();
    renderRightCards();
}

function getTodayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function generateDateKeys() {
    const dates = [];
    for (let i = 29; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    Object.keys(journalData).forEach(dKey => { if (!dates.includes(dKey)) dates.push(dKey); });
    dates.sort();
    return dates;
}

function applyTheme() {
    const s = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    const t = document.querySelector('meta[name="theme-color"]');
    if (lightThemeEnabled) {
        document.body.classList.add('light-theme');
        if (s) s.setAttribute('content', 'default');
        if (t) t.setAttribute('content', '#f2f2f7');
        const tgl = document.getElementById('themeToggle'); if (tgl) tgl.checked = true;
    } else {
        document.body.classList.remove('light-theme');
        if (s) s.setAttribute('content', 'black-translucent');
        if (t) t.setAttribute('content', '#08080a');
        const tgl = document.getElementById('themeToggle'); if (tgl) tgl.checked = false;
    }
}
function toggleTheme() {
    lightThemeEnabled = document.getElementById('themeToggle').checked;
    localStorage.setItem('daily_journal_theme', lightThemeEnabled);
    applyTheme();
    if (calendarScope === 'notebooks') renderRightCards(); 
}

// ==========================================
// 起動処理
// ==========================================
window.onload = async () => {
    applyTheme(); 
    applyHideEmptyCardsSetting();
    applyGalleryColumnsSetting();
    applyDeviceModeSetting();

    await purgeTodoFromStorage();

    const loadedJournal = await getDBData('journalData');
    const loadedNotebook = await getDBData('notebookData');

    let needsMigration = false;
    
    if (loadedJournal) { journalData = loadedJournal; } 
    else { journalData = JSON.parse(localStorage.getItem('daily_journal_data')) || {}; needsMigration = true; }
    
    if (loadedNotebook) { notebookData = loadedNotebook; } 
    else { notebookData = JSON.parse(localStorage.getItem('daily_journal_notebook')) || []; needsMigration = true; }

    if (needsMigration) {
        await saveJournalData();
        await saveNotebookData();
        localStorage.removeItem('daily_journal_data');
        localStorage.removeItem('daily_journal_notebook');
    }

    await syncAndMigrateCategories();
    dateList = generateDateKeys();
    
    calendarScope = 'day';
    previousCalendarScope = 'day';
    lastJournalScope = 'day';
    const todayStr = getTodayKey();
    if (hideEmptyCards) {
        const w = dateList.filter(d => getFilteredDayLogs(d).length > 0);
        if (w.length > 0) {
            activeDateKey = w.includes(todayStr) ? todayStr : w[w.length - 1];
            const p = activeDateKey.split('-'); miniCalYear = parseInt(p[0], 10); miniCalMonth = parseInt(p[1], 10) - 1;
        } else activeDateKey = todayStr;
    } else activeDateKey = todayStr;
    lastJournalDateKey = activeDateKey;

    updateCategoryButtonUI(); 
    updateScopeButtonsUI(); 
    updateJumpButtonLabel(); 
    updateSidebars();
    renderRightCards(); 
    setupMiniCalSwipe(); 
    document.body.classList.add('ready');
};