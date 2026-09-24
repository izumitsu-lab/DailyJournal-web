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

// アプリの版（index.html の APP_HTML_VERSION・?v= と同じ値にする）
const APP_VERSION = '2026.09.24-6';
function applyAppVersionLabel() {
    const el = document.getElementById('appVersionLabel');
    if (!el) return;
    const htmlVer = window.APP_HTML_VERSION || '';
    if (htmlVer && htmlVer !== APP_VERSION) {
        el.textContent = `版 ${APP_VERSION}（画面は ${htmlVer}）― 古いファイルが残っています。アプリを閉じて開き直してください`;
        el.classList.add('mismatch');
    } else {
        el.textContent = `Daily Journal 版 ${APP_VERSION}`;
        el.classList.remove('mismatch');
    }
}

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

// 写真の保存サイズ（端末ごとの設定）。写真を追加したときに一度だけ縮小して保存する。保存済みの写真は変わらない
// size は実際の写真での1枚あたりの目安（高画質で約300KBだった実績と、縮小率ごとの計測から算出）
const PHOTO_QUALITY_PRESETS = {
    high:     { label: '高画質', maxDimension: 1400, quality: 0.85, size: '約300KB' },
    standard: { label: '標準',   maxDimension: 1200, quality: 0.80, size: '約200KB' },
    saver:    { label: '節約',   maxDimension: 1000, quality: 0.75, size: '約130KB' },
    minimum:  { label: '最小',   maxDimension: 800,  quality: 0.70, size: '約80KB' }
};
let photoQuality = PHOTO_QUALITY_PRESETS[localStorage.getItem('daily_journal_photo_quality')] ? localStorage.getItem('daily_journal_photo_quality') : 'standard';
function getPhotoQualityPreset() { return PHOTO_QUALITY_PRESETS[photoQuality] || PHOTO_QUALITY_PRESETS.standard; }
function applyPhotoQualitySetting() {
    const sel = document.getElementById('photoQualitySelect');
    if (sel) sel.value = photoQuality;
    const p = getPhotoQualityPreset();
    if (typeof updateModalPhotoQualityUI === 'function') { updateModalPhotoQualityUI('add'); updateModalPhotoQualityUI('edit'); }
    const info = document.getElementById('photoQualityLastInfo');
    if (info) {
        let last = null;
        try { last = JSON.parse(localStorage.getItem('daily_journal_last_photo') || 'null'); } catch (e) { last = null; }
        info.textContent = last && last.bytes
            ? `直前に追加した写真：${Math.round(last.bytes / 1024)}KB（${last.w}×${last.h}px・${(PHOTO_QUALITY_PRESETS[last.preset] || {}).label || ''}）`
            : 'まだこの端末で写真を追加していません';
    }
}
function changePhotoQuality(val) {
    photoQuality = PHOTO_QUALITY_PRESETS[val] ? val : 'standard';
    localStorage.setItem('daily_journal_photo_quality', photoQuality);
    // 投稿画面を開いていなければ、次に開いたときの既定もこの値にする
    if (typeof resetModalPhotoQuality === 'function') {
        if (!document.getElementById('addModal').classList.contains('active')) resetModalPhotoQuality('add');
        if (!document.getElementById('editModal').classList.contains('active')) resetModalPhotoQuality('edit');
    }
    applyPhotoQualitySetting();
}

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
let currentEditTarget = { dateStr: null, id: null };
let isProgrammaticScroll = false;
let programmaticScrollTimer = null;

// ==========================================
// IndexedDB Setup & Wrappers
// ==========================================
// v2: 画像を別ストア(images)に分離。appData 側の journalData / notebookData には
//     "idbimg:<sha256>" という参照だけを保存し、1件保存するたびに全画像を書き直さないようにする。
const DB_NAME = 'DailyJournalDB';
const DB_VERSION = 2;
const STORE_NAME = 'appData';
const IMG_STORE = 'images';
const IDB_IMG_PREFIX = 'idbimg:';
const DATA_URI_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
const DATA_URI_FULL_RE = /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/;
const IDB_REF_RE = /idbimg:([a-f0-9]{64})/g;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

let _dbPromise = null;
function initDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
            if (!db.objectStoreNames.contains(IMG_STORE)) db.createObjectStore(IMG_STORE);
        };
        req.onsuccess = () => {
            const db = req.result;
            // 別タブで新しいバージョンが開かれたら接続を手放す（ブロック防止）
            db.onversionchange = () => { db.close(); _dbPromise = null; };
            db.onclose = () => { _dbPromise = null; };
            resolve(db);
        };
        req.onerror = () => { _dbPromise = null; reject(req.error); };
    });
    return _dbPromise;
}

function _txDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
}

async function getDBData(key) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function setDBData(key, value) {
    const db = await initDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    await _txDone(tx);
}

async function deleteDBData(key) {
    const db = await initDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    await _txDone(tx);
}

// ==========================================
// 画像ストア（ハッシュ ⇔ Base64）
// ==========================================
// v3: ジャーナルの画像は起動時にメモリへ読み込まない。
//     メモリ上の記録は "idbimg:<hash>" 参照のまま持ち、画面に表示されるときだけ画像ストアから読む（LRUキャッシュ付き）。
//     ※ノート本文の画像は編集機能の都合上、従来どおり読み込んだ状態で保持する。
const _hashByData = new Map();   // dataURL -> sha256（ノート本文の画像と、保存前の新しい画像だけを保持）
const _storedImageHashes = new Set();  // images ストアに保存済みのハッシュ
const _sessionStoredHashes = new Set(); // この起動中に保存した画像（掃除処理で消さないため）

function isDataImage(s) { return typeof s === 'string' && s.startsWith('data:image/'); }
function isValidDataImage(s) { return typeof s === 'string' && DATA_URI_FULL_RE.test(s); }
function idbRefHash(s) { return (typeof s === 'string' && s.startsWith(IDB_IMG_PREFIX)) ? s.slice(IDB_IMG_PREFIX.length) : null; }

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 画像キャッシュ（ハッシュ -> dataURL、合計サイズで上限を設けるLRU）
// iPhone などはページで使えるメモリが少ないので、画像キャッシュを小さくする
const IMG_CACHE_BUDGET = (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ? 16 : 48) * 1024 * 1024; // 文字数（≒バイト数）
const _imgCache = new Map();
let _imgCacheSize = 0;
function _cachePut(h, d) {
    if (_imgCache.has(h)) { _imgCacheSize -= _imgCache.get(h).length; _imgCache.delete(h); }
    _imgCache.set(h, d); _imgCacheSize += d.length;
    while (_imgCacheSize > IMG_CACHE_BUDGET && _imgCache.size > 1) {
        const [k, v] = _imgCache.entries().next().value;
        _imgCache.delete(k); _imgCacheSize -= v.length;
    }
}
function _cacheGet(h) {
    const d = _imgCache.get(h);
    if (d !== undefined) { _imgCache.delete(h); _imgCache.set(h, d); }
    return d;
}

// ノート本文の画像など、メモリ上で dataURL のまま扱う画像のハッシュを登録
function registerImage(hash, dataUrl) {
    _hashByData.set(dataUrl, hash);
    _cachePut(hash, dataUrl);
}
function hasStoredImage(hash) { return _storedImageHashes.has(hash); }

const _imgLoading = new Map();
async function getImageData(hash) {
    const c = _cacheGet(hash);
    if (c !== undefined) return c;
    if (_imgLoading.has(hash)) return _imgLoading.get(hash);
    const p = (async () => {
        const db = await initDB();
        const d = await new Promise((res, rej) => { const r = db.transaction(IMG_STORE, 'readonly').objectStore(IMG_STORE).get(hash); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        if (typeof d === 'string') _cachePut(hash, d);
        return typeof d === 'string' ? d : null;
    })();
    _imgLoading.set(hash, p);
    try { return await p; } finally { _imgLoading.delete(hash); }
}

// 一括処理用：画像ストアから読むが、表示用キャッシュには入れない（大量に読んでも表示中の画像を追い出さない）
async function readStoredImage(hash) {
    const c = _imgCache.get(hash);
    if (c !== undefined) return c;
    const db = await initDB();
    const d = await new Promise((res, rej) => { const r = db.transaction(IMG_STORE, 'readonly').objectStore(IMG_STORE).get(hash); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return typeof d === 'string' ? d : null;
}

async function storeImage(hash, dataUrl) {
    if (!_storedImageHashes.has(hash)) {
        const db = await initDB();
        const tx = db.transaction(IMG_STORE, 'readwrite');
        tx.objectStore(IMG_STORE).put(dataUrl, hash);
        await _txDone(tx);
        _storedImageHashes.add(hash);
    }
    _sessionStoredHashes.add(hash);
    _cachePut(hash, dataUrl);
}

// "idbimg:" 参照 / dataURL → dataURL（書き出し・アップロード用）
async function resolveImageRef(ref) {
    const h = idbRefHash(ref);
    if (h) return await getImageData(h);
    return ref;
}

async function hashImage(dataUrl) {
    let h = _hashByData.get(dataUrl);
    if (!h) { h = await sha256Hex(dataUrl); _hashByData.set(dataUrl, h); }
    return h;
}
async function ensureImageHashes(list) {
    for (const s of list) if (isDataImage(s) && !_hashByData.has(s)) await hashImage(s);
}

// 変更検知用の軽量な画像キー（全画像をハッシュし直さずに済むよう、長さ＋数か所のサンプルで判定）
// ※ハッシュの有無で結果が変わらないよう、常に同じ方式で算出する（変わると「変更あり」と誤検知する）
function _imageFpKey(s) {
    if (!isDataImage(s)) return s;
    const n = s.length;
    return '~' + n + ':' + s.substr(Math.floor(n / 3), 32) + s.substr(Math.floor(n * 2 / 3), 32) + s.slice(-32);
}

function _logImages(log) {
    const arr = Array.isArray(log.images) ? log.images.slice() : [];
    if (log.image) arr.push(log.image);
    return arr;
}

// ==========================================
// ID・データ検証（同期やインポートで外から入ってくる値は必ずここを通す）
// ==========================================
function generateId(prefix) {
    const rnd = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
    return prefix + Date.now().toString(36) + rnd.slice(0, 12);
}
function isSafeId(id) { return typeof id === 'string' && SAFE_ID_RE.test(id); }

function _fnv1a(str) {
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ str.length;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 16777619);
        h2 = Math.imul(h2 ^ c, 2246822519);
    }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
// ID を持たない旧データの記録には、内容から決まる同じIDを全端末で振る（重複を防ぐため）
function legacyLogId(dateStr, log, counter) {
    const base = 'lg_' + _fnv1a(`${dateStr}|${log.time || ''}|${log.text || ''}|${log.category || ''}`);
    const n = counter.get(base) || 0;
    counter.set(base, n + 1);
    return n ? `${base}_${n}` : base;
}

const _IMG_REF_OK_RE = /^(SBIMG:[A-Za-z0-9_\/.-]+|idbimg:[a-f0-9]{64}|https:\/\/[^"'<>\s]+)$/;
function sanitizeImageValue(s) {
    if (typeof s !== 'string') return null;
    if (isDataImage(s)) return isValidDataImage(s) ? s : null;
    return _IMG_REF_OK_RE.test(s) ? s : null;
}

function sanitizeLog(dateStr, raw, counter) {
    if (!raw || typeof raw !== 'object') return null;
    const log = {};
    log.time = typeof raw.time === 'string' && /^\d{1,2}:\d{2}$/.test(raw.time) ? raw.time : '00:00';
    log.text = typeof raw.text === 'string' ? raw.text : '';
    log.category = typeof raw.category === 'string' && raw.category ? raw.category : 'ライフログ';
    log.slackType = (raw.slackType === 'incoming' || raw.slackType === 'outgoing') ? raw.slackType : null;
    if (raw.isSlack && !log.slackType) log.slackType = 'incoming';
    log.images = _logImages(raw).map(sanitizeImageValue).filter(Boolean);
    log.id = isSafeId(raw.id) ? raw.id : legacyLogId(dateStr, log, counter);
    if (typeof raw.updatedAt === 'string' && !isNaN(Date.parse(raw.updatedAt))) log.updatedAt = raw.updatedAt;
    // 実際に書いた日時（変更不可）と「後日記入」の印（一度付いたら外れない）
    if (typeof raw.writtenAt === 'string' && !isNaN(Date.parse(raw.writtenAt))) log.writtenAt = new Date(Date.parse(raw.writtenAt)).toISOString();
    if (raw.backdated === true) log.backdated = true;
    if (raw.pinned === true) log.pinned = true; // しおり
    return log;
}

function sanitizeDayLogs(dateStr, arr) {
    if (!Array.isArray(arr)) return [];
    const counter = new Map();
    const seen = new Set();
    const out = [];
    for (const raw of arr) {
        const log = sanitizeLog(dateStr, raw, counter);
        if (!log || seen.has(log.id)) continue;
        seen.add(log.id);
        out.push(log);
    }
    return out;
}

function sanitizeJournalData(data) {
    const out = {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
    for (const d of Object.keys(data)) {
        if (!DATE_KEY_RE.test(d)) continue;
        const logs = sanitizeDayLogs(d, data[d]);
        if (logs.length) out[d] = logs;
    }
    return out;
}

function sanitizeTombstoneMap(m) {
    const out = {};
    if (!m || typeof m !== 'object') return out;
    for (const k of Object.keys(m)) {
        if (isSafeId(k) && typeof m[k] === 'string' && !isNaN(Date.parse(m[k]))) out[k] = m[k];
    }
    return out;
}

function sanitizeNote(raw) {
    if (!raw || typeof raw !== 'object' || !isSafeId(raw.id)) return null;
    const iso = (v) => (typeof v === 'string' && !isNaN(Date.parse(v))) ? new Date(Date.parse(v)).toISOString() : null;
    const status = ['active', 'permanent', 'archive', 'trash'].includes(raw.status) ? raw.status : 'archive';
    let content = typeof raw.content === 'string' ? raw.content : '';
    if (typeof sanitizeNoteHtml === 'function') content = sanitizeNoteHtml(content);
    return {
        id: raw.id,
        title: typeof raw.title === 'string' ? raw.title : '',
        content,
        category: typeof raw.category === 'string' && raw.category ? raw.category : 'ライフログ',
        status,
        linkedNoteIds: Array.isArray(raw.linkedNoteIds) ? raw.linkedNoteIds.filter(isSafeId) : [],
        createdAt: iso(raw.createdAt) || iso(raw.updatedAt) || new Date().toISOString(),
        updatedAt: iso(raw.updatedAt) || iso(raw.createdAt) || new Date().toISOString()
    };
}

// ==========================================
// 変更検知（どの記録が追加・変更・削除されたかを保存時に判定する）
// ==========================================
// journalTombstones: { "YYYY-MM-DD": { logId: 削除時刻ISO } }  削除を他端末へ伝えるための印
// notebookTombstones: { noteId: 削除時刻ISO }
let journalTombstones = {};
let notebookTombstones = {};
const _journalFp = new Map();  // logId -> "date|内容の指紋"
const _notebookFp = new Map(); // noteId -> 内容の指紋
let _localChangeListener = null;
function setLocalChangeListener(fn) { _localChangeListener = fn; }
function _notifyLocalChange(kind, keys) {
    if (_localChangeListener && keys && keys.size) {
        try { _localChangeListener(kind, keys); } catch (e) { console.error(e); }
    }
}

function journalLogFp(dateStr, log) {
    const o = {};
    for (const k of Object.keys(log).sort()) {
        if (k === 'updatedAt') continue;
        let v = log[k];
        if (k === 'images' && Array.isArray(v)) v = v.map(_imageFpKey);
        else if (k === 'image') v = _imageFpKey(v);
        o[k] = v;
    }
    return dateStr + '|' + JSON.stringify(o);
}

// 本文の指紋はノートごとにキャッシュ（同じ本文文字列なら正規表現をかけ直さない）
let _nbFpContentCache = new Map();
function _contentFpKey(content) {
    if (!content || content.indexOf('data:image') === -1) return content || '';
    let v = _nbFpContentCache.get(content);
    if (v === undefined) { v = content.replace(DATA_URI_RE, _imageFpKey); _nbFpContentCache.set(content, v); }
    return v;
}
function _pruneFpContentCache() {
    const live = new Set(notebookData.map(n => n.content));
    for (const k of [..._nbFpContentCache.keys()]) if (!live.has(k)) _nbFpContentCache.delete(k);
}
function notebookFp(n) {
    const o = {};
    for (const k of Object.keys(n).sort()) {
        if (k === 'updatedAt') continue;
        o[k] = (k === 'content') ? _contentFpKey(n[k]) : n[k];
    }
    return JSON.stringify(o);
}

// 現在の内容を「同期済み／保存済みの基準」として記録（変更扱いにしない）
function rebaselineJournal(dates = null) {
    if (dates === null) {
        _journalFp.clear();
        for (const d of Object.keys(journalData)) for (const log of journalData[d]) _journalFp.set(log.id, journalLogFp(d, log));
        return;
    }
    const ds = new Set(dates);
    for (const [id, fp] of _journalFp) if (ds.has(fp.slice(0, 10))) _journalFp.delete(id);
    for (const d of ds) for (const log of (journalData[d] || [])) _journalFp.set(log.id, journalLogFp(d, log));
}
function rebaselineNotebooks(ids = null) {
    if (ids === null) {
        _notebookFp.clear();
        for (const n of notebookData) _notebookFp.set(n.id, notebookFp(n));
        return;
    }
    for (const id of ids) {
        const n = notebookData.find(x => x.id === id);
        if (n) _notebookFp.set(id, notebookFp(n)); else _notebookFp.delete(id);
    }
}

function _trackJournalChanges() {
    const now = new Date().toISOString();
    const changed = new Set();
    const seen = new Set();
    for (const d of Object.keys(journalData)) {
        const logs = journalData[d];
        if (!Array.isArray(logs) || logs.length === 0) { delete journalData[d]; continue; }
        for (const log of logs) {
            if (!isSafeId(log.id) || seen.has(log.id)) log.id = generateId('lg_');
            seen.add(log.id);
            const fp = journalLogFp(d, log);
            const prev = _journalFp.get(log.id);
            if (prev !== fp) {
                log.updatedAt = now;
                changed.add(d);
                if (prev && prev.slice(0, 10) !== d) {
                    const from = prev.slice(0, 10);
                    changed.add(from);
                    (journalTombstones[from] = journalTombstones[from] || {})[log.id] = now;
                }
                _journalFp.set(log.id, fp);
                if (journalTombstones[d] && journalTombstones[d][log.id]) delete journalTombstones[d][log.id];
            }
        }
    }
    for (const [id, fp] of _journalFp) {
        if (seen.has(id)) continue;
        const d = fp.slice(0, 10);
        (journalTombstones[d] = journalTombstones[d] || {})[id] = now;
        changed.add(d);
        _journalFp.delete(id);
    }
    return changed;
}

function _trackNotebookChanges() {
    const now = new Date().toISOString();
    const changed = new Set();
    const seen = new Set();
    for (const n of notebookData) {
        if (!isSafeId(n.id) || seen.has(n.id)) n.id = generateId('nb_');
        seen.add(n.id);
        const fp = notebookFp(n);
        if (_notebookFp.get(n.id) !== fp) {
            n.updatedAt = now;
            changed.add(n.id);
            _notebookFp.set(n.id, fp);
            delete notebookTombstones[n.id];
        }
    }
    for (const id of [..._notebookFp.keys()]) {
        if (seen.has(id)) continue;
        notebookTombstones[id] = now;
        changed.add(id);
        _notebookFp.delete(id);
    }
    return changed;
}

// ==========================================
// 永続化（画像は別ストアへ、本体データは参照のみ）
// ==========================================
function _toIdbRef(s, newImgs) {
    if (!isDataImage(s)) return s;
    const h = _hashByData.get(s);
    if (!h) return s; // 念のため（通常は事前に ensureImageHashes 済み）
    if (!_storedImageHashes.has(h)) newImgs.set(h, s);
    return IDB_IMG_PREFIX + h;
}

async function persistJournal() {
    if (_tabInactive) return;
    const fresh = [];
    for (const d of Object.keys(journalData)) for (const log of journalData[d]) for (const img of _logImages(log)) if (isDataImage(img)) fresh.push(img);
    await ensureImageHashes(fresh);

    // ここから同期的に処理：新しい画像を参照に置き換え、メモリ上からも Base64 を手放す
    const newImgs = new Map();
    const converted = [];
    const stored = {};
    for (const d of Object.keys(journalData)) {
        for (const log of journalData[d]) {
            if (log.image) { log.images = _logImages(log); delete log.image; }
            if (!Array.isArray(log.images)) log.images = [];
            if (log.images.some(isDataImage)) {
                // 画像の表現が変わるだけなので、ほかに未検知の変更がなければ「変更なし」の基準も更新する
                const baselineOk = _journalFp.get(log.id) === journalLogFp(d, log);
                log.images = log.images.map(s => {
                    if (!isDataImage(s)) return s;
                    const h = _hashByData.get(s);
                    if (!h) return s;
                    if (!_storedImageHashes.has(h)) newImgs.set(h, s);
                    converted.push(s);
                    return IDB_IMG_PREFIX + h;
                });
                if (baselineOk) _journalFp.set(log.id, journalLogFp(d, log));
            }
        }
        stored[d] = journalData[d].map(log => Object.assign({}, log, { images: log.images.slice() }));
    }
    const db = await initDB();
    const tx = db.transaction([STORE_NAME, IMG_STORE], 'readwrite');
    const imgStore = tx.objectStore(IMG_STORE);
    for (const [h, data] of newImgs) imgStore.put(data, h);
    tx.objectStore(STORE_NAME).put(stored, 'journalData');
    tx.objectStore(STORE_NAME).put(journalTombstones, 'journalTombstones');
    await _txDone(tx);
    for (const [h, data] of newImgs) { _storedImageHashes.add(h); _sessionStoredHashes.add(h); _cachePut(h, data); }
    for (const s of converted) _hashByData.delete(s);
}

let _nbPersistCache = new Map();
let _previewPruneTimer = null;
async function persistNotebooks() {
    if (_tabInactive) return;
    const nextCache = new Map();
    const newImgs = new Map();
    const stored = [];
    for (const n of notebookData) {
        const c = Object.assign({}, n);
        const content = n.content || '';
        if (content.indexOf('data:image') !== -1) {
            let entry = _nbPersistCache.get(content);
            if (!entry) {
                const uris = content.match(DATA_URI_RE) || [];
                await ensureImageHashes(uris);
                entry = { uris };
            }
            nextCache.set(content, entry);
            c.content = content.replace(DATA_URI_RE, m => _toIdbRef(m, newImgs));
        }
        stored.push(c);
    }
    _nbPersistCache = nextCache;
    _pruneFpContentCache();
    // 一覧プレビュー用の画像参照の掃除は、保存のたびではなく少し後にまとめて行う
    if (typeof prunePreviewImageRefs === 'function' && !_previewPruneTimer) {
        _previewPruneTimer = setTimeout(() => { _previewPruneTimer = null; try { prunePreviewImageRefs(); } catch (e) {} }, 15000);
    }

    const db = await initDB();
    const tx = db.transaction([STORE_NAME, IMG_STORE], 'readwrite');
    const imgStore = tx.objectStore(IMG_STORE);
    for (const [h, data] of newImgs) imgStore.put(data, h);
    tx.objectStore(STORE_NAME).put(stored, 'notebookData');
    tx.objectStore(STORE_NAME).put(notebookTombstones, 'notebookTombstones');
    await _txDone(tx);
    for (const h of newImgs.keys()) { _storedImageHashes.add(h); _sessionStoredHashes.add(h); }
}

// アプリ側（ui.js / notebooks.js）から呼ばれる保存関数。
// 変更点を検知して、更新時刻・削除の印を付けたうえで保存し、同期モジュールへ通知する。
async function saveJournalData() {
    if (_tabInactive) return;
    const changed = _trackJournalChanges();
    await persistJournal();
    _notifyLocalChange('journal', changed);
}
async function saveNotebookData() {
    if (_tabInactive) return;
    const changed = _trackNotebookChanges();
    await persistNotebooks();
    _notifyLocalChange('notebook', changed);
}

// 起動時の読み込み：images ストアは「どの画像があるか」だけ読む（画像本体は表示時に読む）
async function loadImageStore() {
    const db = await initDB();
    const keys = await new Promise((res, rej) => { const r = db.transaction(IMG_STORE, 'readonly').objectStore(IMG_STORE).getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    keys.forEach(h => _storedImageHashes.add(h));
}

// ノート本文中の "idbimg:" 参照を dataURL に戻す（ノートは編集の都合上、画像を読み込んだ状態で持つ）
async function hydrateNotes(notes) {
    const hashes = new Set();
    for (const n of notes) { if (n.content && n.content.indexOf(IDB_IMG_PREFIX) !== -1) { let m; const re = new RegExp(IDB_REF_RE.source, 'g'); while ((m = re.exec(n.content))) hashes.add(m[1]); } }
    const map = new Map();
    for (const h of hashes) { const d = await getImageData(h); if (d) { map.set(h, d); _hashByData.set(d, h); } }
    for (const n of notes) {
        if (n.content && n.content.indexOf(IDB_IMG_PREFIX) !== -1) n.content = n.content.replace(IDB_REF_RE, (m, h) => map.get(h) || m);
    }
}

// 旧形式（ジャーナルに Base64 が直接入っている）データ用：画像はそのまま持ち、次の保存で画像ストアへ移す
function normalizeJournalImages(data) {
    for (const d of Object.keys(data)) for (const log of data[d]) { log.images = _logImages(log); delete log.image; }
    return data;
}

// 書き出し用：画像を dataURL に戻したジャーナルのコピー
async function resolveLogsForExport(logs) {
    const out = [];
    for (const log of (logs || [])) {
        const images = [];
        for (const img of _logImages(log)) { const d = await resolveImageRef(img); if (d) images.push(d); }
        out.push(Object.assign({}, log, { images }));
    }
    return out;
}
async function getJournalDataForExport() {
    const out = {};
    for (const d of Object.keys(journalData).sort()) out[d] = await resolveLogsForExport(journalData[d]);
    return out;
}
async function getNotebookDataForExport() { return notebookData; }

// どこからも参照されなくなった画像を images ストアから掃除する（保存済みレコードを基準に同一トランザクション内で判定）
async function garbageCollectImages() {
    if (_tabInactive) return;
    try {
        const db = await initDB();
        const tx = db.transaction([STORE_NAME, IMG_STORE], 'readwrite');
        const app = tx.objectStore(STORE_NAME);
        const imgs = tx.objectStore(IMG_STORE);
        const get = (store, key) => new Promise((res, rej) => { const r = store.get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        const [j, n, keys] = await Promise.all([
            get(app, 'journalData'), get(app, 'notebookData'),
            new Promise((res, rej) => { const r = imgs.getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); })
        ]);
        // 保存済みレコード＋メモリ上のデータ＋この起動中に保存した画像は消さない（保存途中の画像を守る）
        const text = JSON.stringify(j || {}) + JSON.stringify(n || []) + JSON.stringify(journalData) + JSON.stringify(notebookTombstones);
        const used = new Set(_sessionStoredHashes);
        let m; const re = new RegExp(IDB_REF_RE.source, 'g');
        while ((m = re.exec(text))) used.add(m[1]);
        for (const h of keys) if (!used.has(h)) { imgs.delete(h); _storedImageHashes.delete(h); }
        await _txDone(tx);
    } catch (e) { console.warn('画像ストアの掃除に失敗しました', e); }
}

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
// 設定（タイプ・カテゴリ等）の変更時刻。ユーザー操作による変更のときだけ更新し、同期時の新旧判定に使う
const SETTINGS_EDITED_AT_KEY = 'daily_journal_settings_edited_at';
let _suppressSettingsDirty = false;
function markSettingsEdited() {
    if (_suppressSettingsDirty || _tabInactive) return;
    localStorage.setItem(SETTINGS_EDITED_AT_KEY, new Date().toISOString());
    _notifyLocalChange('settings', new Set(['settings']));
}
function getSettingsEditedAt() { return localStorage.getItem(SETTINGS_EDITED_AT_KEY) || ''; }

function saveAppTypes() {
    if (_tabInactive) return;
    localStorage.setItem('daily_journal_types', JSON.stringify(appTypes));
    markSettingsEdited();
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
    // 起動時・同期時の自動補正は「ユーザーの編集」ではないので、同期上の変更時刻は進めない
    _suppressSettingsDirty = true;
    try { await _syncAndMigrateCategoriesInner(); } finally { _suppressSettingsDirty = false; }
}

async function _syncAndMigrateCategoriesInner() {
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

    // ※以前は「ログ」「研究管理」を毎回強制的に追加していたため、削除しても起動のたびに復活していた。
    //   既定タイプはタイプが1つもない（初回起動）ときだけ入れる。

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
                if (!appTypes.includes("一般")) { appTypes.push("一般"); typesUpdated = true; }
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

function saveCategories() { if (_tabInactive) return; localStorage.setItem('daily_journal_categories', JSON.stringify(categories)); markSettingsEdited(); }
function saveTypeSlackSettings() { if (_tabInactive) return; localStorage.setItem('daily_journal_type_slack', JSON.stringify(typeSlackSettings)); markSettingsEdited(); }
function saveTypeNotebookSettings() { if (_tabInactive) return; localStorage.setItem('daily_journal_type_notebook', JSON.stringify(typeNotebookSettings)); markSettingsEdited(); }
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

// "YYYY-MM-DD" と "HH:MM"（端末の時刻）→ ISO 文字列
function slotToIso(dateStr, time) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const [hh, mm] = (time || '00:00').split(':').map(Number);
    return new Date(y, m - 1, d, hh || 0, mm || 0).toISOString();
}
function nowTimeStr() { const n = new Date(); return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`; }

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
// 複数タブ対策：最後に開いた（または「このタブで使う」を押した）タブだけが保存・同期する
// ==========================================
// 同じ端末の複数タブがそれぞれ全データを保存すると、後から保存したタブの古い内容で上書きされてしまうため。
const TAB_ID = generateId('tab_');
let _tabInactive = false;
const _tabChannel = ('BroadcastChannel' in window) ? new BroadcastChannel('daily-journal-tabs') : null;
function isTabActive() { return !_tabInactive; }

async function _deactivateTab() {
    if (_tabInactive) return;
    // 編集中のノートがあれば、手放す前に保存しておく
    try {
        if (typeof currentActiveEditorNotebookId !== 'undefined' && currentActiveEditorNotebookId && typeof saveNotebookContentDirect === 'function') {
            await saveNotebookContentDirect(currentActiveEditorNotebookId);
        }
    } catch (e) { console.warn(e); }
    _tabInactive = true;
    if (typeof onTabDeactivated === 'function') { try { onTabDeactivated(); } catch (e) {} }
    let ov = document.getElementById('tabInactiveOverlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'tabInactiveOverlay';
        ov.className = 'tab-inactive-overlay';
        ov.innerHTML = `<div class="tab-inactive-card"><div style="font-size: 30px;">🗂️</div><div class="tab-inactive-title">別のタブで開かれています</div><div class="tab-inactive-desc">データの上書きを防ぐため、このタブでは保存と同期を停止しました。</div><button type="button" class="modal-btn submit" onclick="location.reload()">このタブで使う</button></div>`;
        document.body.appendChild(ov);
    }
}
if (_tabChannel) {
    _tabChannel.onmessage = (e) => {
        if (e.data && e.data.type === 'claim' && e.data.id !== TAB_ID) _deactivateTab();
    };
}

// ==========================================
// 起動処理
// ==========================================
// 同期モジュールは、ローカルデータの読み込みが終わるまで待ってから動き出す
let _resolveAppDataReady;
const appDataReady = new Promise(r => { _resolveAppDataReady = r; });

// ※以前は window.onload（画像・外部ファイルをすべて読み終えるまで待つ）で起動していたため、
//   通信が遅いと起動やログイン後の同期開始が遅れていた。DOMの準備ができた時点で起動する。
async function startApp() {
    applyTheme(); 
    applyHideEmptyCardsSetting();
    applyGalleryColumnsSetting();
    applyPhotoQualitySetting();
    applyAppVersionLabel();
    applyDeviceModeSetting();

    // 他のタブに「このタブが使う」と知らせ、そちらの保存が終わるのを少し待ってから読み込む
    if (_tabChannel) {
        _tabChannel.postMessage({ type: 'claim', id: TAB_ID });
        await new Promise(r => setTimeout(r, 300));
        if (typeof reloadPendingQueue === 'function') reloadPendingQueue();
    }

    await purgeTodoFromStorage();

    try { await loadImageStore(); } catch (e) { console.warn('画像ストアの読み込みに失敗しました', e); }

    let loadedJournal = await getDBData('journalData');
    let loadedNotebook = await getDBData('notebookData');

    let needsMigration = false;
    if (!loadedJournal) {
        try { loadedJournal = JSON.parse(localStorage.getItem('daily_journal_data')) || {}; } catch (e) { loadedJournal = {}; }
        needsMigration = true;
    }
    if (!loadedNotebook) {
        try { loadedNotebook = JSON.parse(localStorage.getItem('daily_journal_notebook')) || []; } catch (e) { loadedNotebook = []; }
        needsMigration = true;
    }

    // 旧形式（画像をBase64のまま丸ごと保存）なら、画像ストア分離のために一度保存し直す
    const hadInlineImages = JSON.stringify(loadedJournal).indexOf('"data:image') !== -1
        || (Array.isArray(loadedNotebook) && loadedNotebook.some(n => n && typeof n.content === 'string' && n.content.indexOf('data:image') !== -1));
    // 旧形式（記録IDなし）なら、ID付与後に保存し直す
    const hadLogsWithoutId = Object.values(loadedJournal || {}).some(arr => Array.isArray(arr) && arr.some(l => l && !l.id));

    journalData = normalizeJournalImages(sanitizeJournalData(loadedJournal));
    notebookData = (Array.isArray(loadedNotebook) ? loadedNotebook : []).map(sanitizeNote).filter(Boolean);
    await hydrateNotes(notebookData);

    const jt = await getDBData('journalTombstones');
    journalTombstones = {};
    if (jt && typeof jt === 'object') for (const d of Object.keys(jt)) if (DATE_KEY_RE.test(d)) journalTombstones[d] = sanitizeTombstoneMap(jt[d]);
    notebookTombstones = sanitizeTombstoneMap(await getDBData('notebookTombstones'));

    // 読み込んだ内容を「未変更」の基準にする（ここより後の保存で差分が検知される）
    rebaselineJournal(null);
    rebaselineNotebooks(null);

    if (needsMigration || hadInlineImages || hadLogsWithoutId) {
        await persistJournal();
        await persistNotebooks();
        if (needsMigration) {
            localStorage.removeItem('daily_journal_data');
            localStorage.removeItem('daily_journal_notebook');
        }
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
    _resolveAppDataReady();
    setTimeout(garbageCollectImages, 8000);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { startApp().catch(_startupFailed); });
else startApp().catch(_startupFailed);

// 起動処理で予期しないエラーが起きた場合：画面は表示し、エラーを知らせる。
// ※端末内データを読み込めていない可能性があるので、同期は開始しない（空のデータでクラウドや端末内を上書きしないため）
function _startupFailed(e) {
    console.error('起動処理でエラーが発生しました', e);
    document.body.classList.add('ready');
    if (typeof showToast === 'function') showToast('起動中にエラーが発生しました。表示に問題がある場合は再読み込みしてください。（' + ((e && e.message) || e) + '）', 12000);
}