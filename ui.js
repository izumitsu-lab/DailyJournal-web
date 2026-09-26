// ==========================================
// ui.js (モーダル開閉・タブ切り替え・カード描画・設定管理・Sortable並び替え)
// ==========================================

let cardScrollPositions = {};
let selectedBatchExportOption = 'both';
let typeSortableInstance = null;
let categorySortableInstance = null;

// 横断スポットライト検索用ステート
let globalSearchTab = 'all'; // 'all' | 'journals' | 'notebooks'
let globalSearchOperator = 'AND'; // 'AND' | 'OR'

// スマホモード判定ヘルパー
function isCurrentMobileMode() {
    if (deviceDisplayMode === 'mobile') return true;
    if (deviceDisplayMode === 'desktop') return false;
    // autoの場合は画面幅またはユーザーエージェントで自動判定
    const isSmallScreen = window.innerWidth <= 768;
    const isIPhoneOrMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    return isSmallScreen || isIPhoneOrMobile;
}

function saveCurrentScrollPositions() {
    const container = document.getElementById('journalCarouselContainer');
    if (!container) return;
    
    if (container.classList.contains('grid-mode-active')) {
        cardScrollPositions['notebook_grid'] = container.scrollTop;
    }
    
    const panels = container.querySelectorAll('.card-carousel-panel');
    panels.forEach(p => {
        const sw = p.querySelector('.logs-container-wrapper');
        if (sw && p.dataset.key) {
            cardScrollPositions[p.dataset.key] = sw.scrollTop;
        }
    });
}

window.addEventListener('scroll', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('logs-container-wrapper')) {
        const panel = e.target.closest('.card-carousel-panel');
        if (panel && panel.dataset.key) {
            cardScrollPositions[panel.dataset.key] = e.target.scrollTop;
        }
    } else if (e.target && e.target.id === 'journalCarouselContainer') {
        if (e.target.classList.contains('grid-mode-active')) {
            cardScrollPositions['notebook_grid'] = e.target.scrollTop;
        }
    }
}, true);

function applyHideEmptyCardsSetting() { const t = document.getElementById('hideEmptyCardsToggle'); if (t) t.checked = hideEmptyCards; }
function toggleHideEmptyCards() {
    hideEmptyCards = document.getElementById('hideEmptyCardsToggle').checked;
    localStorage.setItem('daily_journal_hide_empty', hideEmptyCards);
    if (hideEmptyCards && calendarScope !== 'notebooks') adjustActiveDateToLatestLog();
    triggerSmoothViewSwitch(() => { renderRightCards(); if (sidebarMode === 'cal' && calendarScope !== 'notebooks') renderMiniCalendar(); });
}

// 表示の切り替え。
// ※以前は切り替えのたびに80ms後の描き直しを予約し、素早く連打すると予約が溜まって全カードの描き直しが連続で走っていた。
//   iPhone ではその間に古い画面の画像が解放されないままメモリが跳ね上がり、アプリ（ページ）が落ちる原因になっていた。
//   → 連打中は予約をまとめ、状態の変更だけを順に反映して、描き直しは最後に1回だけ行う。
let _viewSwitchQueue = [];
let _viewSwitchTimer = null;
let _deferRender = false;
let _renderDirty = false;
function triggerSmoothViewSwitch(updateCallback) {
    if (!_viewSwitchQueue.length) saveCurrentScrollPositions();
    _viewSwitchQueue.push(updateCallback);
    const container = document.getElementById('journalCarouselContainer');
    isProgrammaticScroll = true;
    container.classList.add('is-transitioning');
    clearTimeout(_viewSwitchTimer);
    _viewSwitchTimer = setTimeout(() => {
        const queue = _viewSwitchQueue;
        _viewSwitchQueue = [];
        _deferRender = true; _renderDirty = false;
        try {
            for (const cb of queue) { try { cb(); } catch (e) { console.error(e); } }
        } finally { _deferRender = false; }
        if (_renderDirty) { _renderDirty = false; renderRightCards(); }
        container.classList.remove('is-transitioning');
        clearTimeout(programmaticScrollTimer);
        programmaticScrollTimer = setTimeout(() => { isProgrammaticScroll = false; }, 350);
    }, 80);
}

function smoothScrollToKey(key) {
    const container = document.getElementById('journalCarouselContainer');
    const panel = container.querySelector(`[data-key="${key}"]`);
    if (panel) {
        isProgrammaticScroll = true;
        container.scrollTo({ left: panel.offsetLeft - container.offsetLeft, behavior: 'smooth' });
        clearTimeout(programmaticScrollTimer);
        programmaticScrollTimer = setTimeout(() => { isProgrammaticScroll = false; }, 500);
        return true;
    }
    return false;
}

function smoothScrollToPhotoDate(dateKey, instant = false) {
    const container = document.getElementById('journalCarouselContainer');
    let t = container.querySelector(`[data-date="${dateKey}"]`);
    if (!t) {
        const panels = Array.from(container.querySelectorAll('.card-carousel-panel[data-date]'));
        t = panels.find(p => p.dataset.date >= dateKey) || panels[panels.length - 1];
    }
    if (t) {
        isProgrammaticScroll = true;
        if (t.dataset.key) lastPhotoPanelKey = t.dataset.key;
        if (instant) container.scrollLeft = t.offsetLeft - container.offsetLeft;
        else container.scrollTo({ left: t.offsetLeft - container.offsetLeft, behavior: 'smooth' });
        clearTimeout(programmaticScrollTimer);
        programmaticScrollTimer = setTimeout(() => { isProgrammaticScroll = false; }, instant ? 120 : 500);
        return true;
    }
    return false;
}

function instantScrollToKey(key) {
    const c = document.getElementById('journalCarouselContainer');
    const p = c.querySelector(`[data-key="${key}"]`);
    if (p) {
        isProgrammaticScroll = true;
        c.scrollLeft = p.offsetLeft - c.offsetLeft;
        clearTimeout(programmaticScrollTimer);
        programmaticScrollTimer = setTimeout(() => { isProgrammaticScroll = false; }, 120);
    }
}

function getActiveCarouselPanel() { const c = document.getElementById('journalCarouselContainer'); const w = c.clientWidth; if (!w) return null; return c.querySelectorAll('.card-carousel-panel')[Math.round(c.scrollLeft / w)] || null; }

function scrollToTimelineDateInPanel(p, tD, s = true) {
    if (!p) return; const sw = p.querySelector('.logs-container-wrapper'); if (!sw) return;
    let t = p.querySelector(`.timeline-date-divider[data-date="${tD}"]`);
    if (!t) { const d = Array.from(p.querySelectorAll('.timeline-date-divider[data-date]')); if (d.length > 0) { t = d.find(x => x.dataset.date >= tD) || d[0]; } }
    if (t) {
        const wR = sw.getBoundingClientRect(); const tR = t.getBoundingClientRect();
        const tS = Math.max(0, tR.top - wR.top + sw.scrollTop - 10);
        if (!((tR.top >= wR.top - 10 && tR.top <= wR.top + 70) || Math.abs(sw.scrollTop - tS) < 18)) sw.scrollTo({ top: tS, behavior: s ? 'smooth' : 'auto' });
        t.classList.remove('highlight-target'); void t.offsetWidth; t.classList.add('highlight-target');
    } else if (sw.scrollTop > 30) sw.scrollTo({ top: 0, behavior: s ? 'smooth' : 'auto' });
}

function parseLinksAndText(text) {
    if (!text) return "";
    return escapeHtml(text).replace(/(https?:\/\/[^\s]+)/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer" class="journal-link" onclick="event.stopPropagation()">🔗 ${url}</a>`);
}

function escapeHtml(str) { return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }

// 写真を追加するときの縮小。大きさ・画質は「写真の保存サイズ」のプリセットに従う（既定は設定画面の値）
function resizeImageFile(file, maxDimension, quality, presetKey = photoQuality) {
    const preset = PHOTO_QUALITY_PRESETS[presetKey] || getPhotoQualityPreset();
    if (!maxDimension) maxDimension = preset.maxDimension;
    if (!quality) quality = preset.quality;
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                let w = img.width, h = img.height;
                if (w > maxDimension || h > maxDimension) {
                    if (w > h) { h = Math.round((h * maxDimension) / w); w = maxDimension; }
                    else { w = Math.round((w * maxDimension) / h); h = maxDimension; }
                }
                const cvs = document.createElement('canvas'); cvs.width = w; cvs.height = h;
                cvs.getContext('2d').drawImage(img, 0, 0, w, h);
                const out = cvs.toDataURL('image/jpeg', quality);
                cvs.width = 0; cvs.height = 0;
                try {
                    localStorage.setItem('daily_journal_last_photo', JSON.stringify({ bytes: dataUrlBytes(out), w, h, preset: presetKey }));
                    applyPhotoQualitySetting();
                } catch (e) {}
                resolve(out);
            };
            img.onerror = reject; img.src = e.target.result;
        };
        reader.onerror = reject; reader.readAsDataURL(file);
    });
}
function dataUrlBytes(d) { return (typeof d === 'string' && d.startsWith('data:')) ? Math.round((d.length - d.indexOf(',') - 1) * 3 / 4) : 0; }
function formatKB(bytes) { return bytes >= 1024 * 1024 ? (bytes / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(bytes / 1024)) + 'KB'; }

// ------------------------------------------
// 投稿画面（追記・編集）での画質の選択
// ------------------------------------------
// 設定画面の値は「既定」。投稿画面ではその投稿に追加する写真だけ画質を変えられる（画面を開き直すと既定に戻る）。
// 写真を選んだ後に画質を変えても反映できるよう、投稿が終わるまで元の写真ファイルを覚えておき、作り直す。
// ※元のファイルは端末上のファイルへの参照なので、覚えておいてもメモリはほとんど使わない。保存済みの写真は対象外。
const _modalPhotoQuality = { add: photoQuality, edit: photoQuality }; // 投稿画面の画質（開くたびに設定の既定へ戻す）
const _photoSourceFiles = { add: new Map(), edit: new Map() }; // 縮小後の dataURL -> 元のファイル
const _photoJobs = { add: Promise.resolve(), edit: Promise.resolve() };
const _photoBusy = { add: 0, edit: 0 };
function _photoList(m) { return m === 'add' ? currentAddPhotos : currentEditPhotos; }
function _runPhotoJob(m, fn) {
    _photoBusy[m]++; updateModalPhotoQualityUI(m);
    const job = _photoJobs[m].then(fn).catch(e => console.warn('写真の処理に失敗しました', e))
        .finally(() => { _photoBusy[m]--; updateModalPhotoQualityUI(m); });
    _photoJobs[m] = job;
    return job;
}
function waitPhotoJobs(m) { return _photoJobs[m]; }
function resetModalPhotoQuality(m) {
    _modalPhotoQuality[m] = photoQuality;
    _photoSourceFiles[m].clear();
    updateModalPhotoQualityUI(m);
}
function updateModalPhotoQualityUI(m) {
    const sel = document.getElementById(m === 'add' ? 'addPhotoQualitySelect' : 'editPhotoQualitySelect');
    if (!sel) return;
    sel.value = _modalPhotoQuality[m];
    sel.disabled = _photoBusy[m] > 0;
    sel.classList.toggle('is-busy', _photoBusy[m] > 0);
    sel.classList.toggle('is-changed', _modalPhotoQuality[m] !== photoQuality);
}
function changeModalPhotoQuality(m, val) {
    if (!PHOTO_QUALITY_PRESETS[val] || val === _modalPhotoQuality[m]) { updateModalPhotoQualityUI(m); return; }
    _modalPhotoQuality[m] = val;
    // すでに選んである写真（この画面で追加したもの）を、新しい画質で作り直す
    return _runPhotoJob(m, async () => {
        const list = _photoList(m);
        const srcMap = _photoSourceFiles[m];
        for (let i = 0; i < list.length; i++) {
            const file = srcMap.get(list[i]);
            if (!file) continue; // 保存済みの写真は変えない
            const preset = _modalPhotoQuality[m];
            const d = await resizeImageFile(file, 0, 0, preset);
            const cur = _photoList(m);
            const idx = cur.indexOf(list[i]);
            if (idx === -1) continue; // 処理中に削除された
            srcMap.delete(list[i]);
            cur[idx] = d; srcMap.set(d, file);
        }
        renderPhotoPreviews(m);
    });
}
function triggerPhotoSelect(m) { document.getElementById(m === 'add' ? 'addPhotoInput' : 'editPhotoInput').click(); }
function handlePhotosSelected(e, m) {
    const files = Array.from(e.target.files); e.target.value = "";
    if (!files.length) return Promise.resolve();
    return _runPhotoJob(m, async () => {
        for (const f of files) {
            try {
                const d = await resizeImageFile(f, 0, 0, _modalPhotoQuality[m]);
                _photoList(m).push(d);
                _photoSourceFiles[m].set(d, f);
            } catch (err) {}
        }
        renderPhotoPreviews(m);
    });
}
function renderPhotoPreviews(m) {
    const c = document.getElementById(m === 'add' ? 'addPhotoPreviewsContainer' : 'editPhotoPreviewsContainer');
    const p = _photoList(m);
    c.innerHTML = "";
    if (!p.length) { c.classList.remove('has-photos'); return; }
    c.classList.add('has-photos');
    p.forEach((d, i) => {
        const div = document.createElement('div'); div.className = 'photo-preview-item';
        const bytes = dataUrlBytes(d);
        const cap = bytes ? formatKB(bytes) : '保存済み';
        div.innerHTML = `<img ${imgSrcAttrs(d, 240)}><span class="photo-preview-size${bytes ? '' : ' saved'}">${cap}</span><button class="photo-preview-del-btn" onclick="removePhotoAtIndex('${m}', ${i})">✕</button>`;
        c.appendChild(div);
    });
}
function removePhotoAtIndex(m, i) {
    const list = _photoList(m);
    const [d] = list.splice(i, 1);
    if (d) _photoSourceFiles[m].delete(d);
    renderPhotoPreviews(m);
}
// 画面下部に一時的なお知らせを出す（alert と違い、作業を止めない）
function showToast(message, ms = 7000) {
    let box = document.getElementById('appToastBox');
    if (!box) { box = document.createElement('div'); box.id = 'appToastBox'; box.className = 'app-toast-box'; document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'app-toast';
    t.setAttribute('role', 'status');
    t.textContent = message;
    t.onclick = () => t.remove();
    box.appendChild(t);
    setTimeout(() => t.remove(), ms);
}

function openLightbox(s) { document.getElementById('lightboxImg').src = s; document.getElementById('lightboxModal').classList.add('active'); }

// ==========================================
// ジャーナル画像の遅延読み込み
// ==========================================
// 記録の画像はメモリ上では "idbimg:<hash>" 参照。描画時は透明画像を置き、画面に近づいたら画像ストアから読み込む。
const IMG_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
// thumbSize を指定すると、小さく縮小した画像を表示する（一覧の小さな枠に原寸の写真を展開しないため）
function imgSrcAttrs(ref, thumbSize = 0) {
    const h = idbRefHash(ref);
    const t = thumbSize ? ` data-thumb="${thumbSize}"` : '';
    if (h) return `src="${IMG_PLACEHOLDER}" data-idbimg="${h}"${t}`;
    if (isDataImage(ref)) return `src="${ref}"`;
    return `src="${IMG_PLACEHOLDER}" data-missing="1"`; // クラウドから取得できなかった画像
}
async function openLightboxFromImg(img) {
    if (!img) return;
    const h = img.dataset ? img.dataset.idbimg : null;
    const nk = img.dataset ? img.dataset.nbthumb : null;
    const src = h ? await getImageData(h) : (nk ? _nbThumbSrc.get(nk) : img.src);
    if (src) openLightbox(src);
}

// ------------------------------------------
// 縮小画像（一覧・プレビュー用）
// ------------------------------------------
// iPhone は1ページで使えるメモリが少なく、1400px の写真は1枚展開するだけで約6MBを使う。
// 以前は Gallery View で全ノートの画像を原寸のまま一度に展開していたため、画像が多いと数百MBになり、
// 素早い切り替えと重なるとページが強制終了していた。
const THUMB_CACHE_MAX = 300;
const _thumbCache = new Map();   // "キー@サイズ" -> 縮小画像の dataURL（LRU）
const _nbThumbSrc = new Map();   // ノート本文の画像キー -> 元の dataURL
let _thumbQueue = Promise.resolve();
function _thumbCacheGet(k) { const v = _thumbCache.get(k); if (v !== undefined) { _thumbCache.delete(k); _thumbCache.set(k, v); } return v; }
function _thumbCachePut(k, v) { _thumbCache.set(k, v); while (_thumbCache.size > THUMB_CACHE_MAX) _thumbCache.delete(_thumbCache.keys().next().value); }
// 縮小は1枚ずつ順番に行う（同時に何枚も原寸で展開しない）
function _makeThumb(dataUrl, max) {
    const job = _thumbQueue.then(() => new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            try {
                const w = img.naturalWidth, h = img.naturalHeight;
                const s = Math.min(1, max / Math.max(w, h));
                if (s >= 1) { resolve(dataUrl); return; }
                const c = document.createElement('canvas');
                c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                const out = c.toDataURL('image/jpeg', 0.82);
                c.width = 0; c.height = 0; img.src = IMG_PLACEHOLDER;
                resolve(out);
            } catch (e) { resolve(dataUrl); }
        };
        img.onerror = () => resolve(null);
        img.src = dataUrl;
    }));
    _thumbQueue = job.catch(() => {});
    return job;
}
async function getThumbnail(key, size, getSource) {
    const k = key + '@' + size;
    const c = _thumbCacheGet(k);
    if (c !== undefined) return c;
    const src = await getSource();
    if (!src) return null;
    const t = await _makeThumb(src, size);
    if (t) _thumbCachePut(k, t);
    return t;
}
function _nbThumbKey(dataUrl) { return 'n' + _fnv1a(_imageFpKey(dataUrl)); }

// ------------------------------------------
// 画像の遅延読み込み・画面外の画像の解放
// ------------------------------------------
// 記録の画像（data-idbimg）とノートのプレビュー画像（data-nbthumb）は、画面に近づいたら読み込み、
// 画面から大きく離れたら透明画像に戻してメモリを手放す（以前は一度読み込むと手放さなかった）。
const LAZY_IMG_SELECTOR = 'img[data-idbimg], img[data-nbthumb]';
function _lazyKey(img) { return img.dataset.idbimg || img.dataset.nbthumb || ''; }
async function _loadLazyImage(img) {
    const key = _lazyKey(img);
    if (!key || img.dataset.lazyLoaded === key) return;
    img.dataset.lazyLoaded = key;
    const h = img.dataset.idbimg;
    const getSource = () => h ? getImageData(h) : Promise.resolve(_nbThumbSrc.get(key) || null);
    const size = parseInt(img.dataset.thumb || '0', 10);
    let d = null;
    try { d = size ? await getThumbnail(h ? 'i' + h : key, size, getSource) : await getSource(); } catch (e) { d = null; }
    if (img.dataset.lazyLoaded !== key || !img.isConnected) return; // 待っている間に画面外へ出た・消えた
    if (d) img.src = d; else img.classList.add('img-missing');
}
function _unloadLazyImage(img) {
    if (!img.dataset.lazyLoaded) return;
    delete img.dataset.lazyLoaded;
    img.src = IMG_PLACEHOLDER;
}
const _lazyImgObserver = ('IntersectionObserver' in window)
    ? new IntersectionObserver(entries => {
        entries.forEach(e => { if (e.isIntersecting) _loadLazyImage(e.target); else _unloadLazyImage(e.target); });
    }, { rootMargin: '600px' })
    : null;
function _lazyImagesIn(root) {
    if (!root || !root.querySelectorAll) return [];
    const list = root.matches && root.matches(LAZY_IMG_SELECTOR) ? [root] : [];
    root.querySelectorAll(LAZY_IMG_SELECTOR).forEach(i => list.push(i));
    return list;
}
function watchIdbImages(root) {
    _lazyImagesIn(root).forEach(img => {
        const key = _lazyKey(img);
        if (img.dataset.lazyWatched === key) return;
        img.dataset.lazyWatched = key;
        if (_lazyImgObserver) _lazyImgObserver.observe(img); else _loadLazyImage(img);
    });
}
// 画面から取り除かれた画像は監視をやめてすぐ手放す（描き直しのたびに古い画面の画像が残らないように）
function _releaseRemovedImages(root) {
    _lazyImagesIn(root).forEach(img => {
        if (img.isConnected) return; // 移動しただけ
        if (_lazyImgObserver) _lazyImgObserver.unobserve(img);
        delete img.dataset.lazyWatched;
        _unloadLazyImage(img);
    });
}
new MutationObserver(muts => {
    for (const m of muts) {
        for (const n of m.removedNodes) if (n.nodeType === 1) _releaseRemovedImages(n);
        for (const n of m.addedNodes) if (n.nodeType === 1) watchIdbImages(n);
    }
}).observe(document.documentElement, { childList: true, subtree: true });
function closeLightbox() { document.getElementById('lightboxModal').classList.remove('active'); document.getElementById('lightboxImg').src = ""; }

function getLogCategoryType(catName) { const f = categories.find(c => c.name === catName); return f ? (f.type || "一般") : "一般"; }
function getTypeIcon(t) { 
    if (t === 'ログ') return '🌿';
    if (t === '研究管理') return '🎓';
    if (t === '一般') return '📁';
    return '🏷️';
}
function getCategoryTypeClass(catName) { const f = categories.find(c => c.name === catName); if (!f) return ""; return f.type === "研究管理" ? "type-student" : f.type === "ログ" ? "type-log" : ""; }

function matchesCurrentFilter(item) {
    const isSlackMsg = !!(item.slackType || item.isSlack);
    
    // 「ホーム」（all）と「すべて表示」（everything）は、Slack の表示を「すべて表示時の連携設定」に従う
    if (currentFilter.mode === 'all' || currentFilter.mode === 'everything') {
        if (isSlackMsg && typeSlackSettings['all'] === false) {
            return false;
        }
        // ホームでは、ホームに出さないタイプを除く
        if (currentFilter.mode === 'all' && !isTypeShownOnHome(getLogCategoryType(item.category || "ライフログ"))) return false;
        // ホームでは、アーカイブしたカテゴリも除く（「すべて表示」やカテゴリを選べば見られる）
        if (currentFilter.mode === 'all' && isCategoryArchived(item.category || "ライフログ")) return false;
        return true;
    }
    
    const cat = item.category || "ライフログ";
    const catType = getLogCategoryType(cat);
    
    if (isSlackMsg && !isSlackEnabledForType(catType)) {
        return false;
    }

    // カテゴリの表示では、本文で「@カテゴリ名」と呼ばれた記録も一緒に並べる（mentions.js）
    if (currentFilter.mode === 'category') return cat === currentFilter.value || (typeof logMentions === 'function' && logMentions(item).includes(currentFilter.value));
    if (currentFilter.mode === 'type') return catType === currentFilter.value;
    return true;
}

function updateMsgTypeVisibility(mode, catName) {
    const catType = getLogCategoryType(catName);
    const enabled = isSlackEnabledForType(catType);
    const s = document.getElementById(mode === 'add' ? 'addMsgTypeSegmented' : 'editMsgTypeSegmented');
    if (!s) return;
    if (enabled) {
        s.style.display = 'inline-flex';
    } else {
        s.style.display = 'none';
        setMessageType(mode, 'normal');
    }
}

function setMessageType(mode, type) {
    if (mode === 'add') currentAddMsgType = type; else currentEditMsgType = type;
    const p = mode === 'add' ? 'addMsgType_' : 'editMsgType_';
    ['normal', 'incoming', 'outgoing'].forEach(t => {
        const b = document.getElementById(p + t); if (b) b.classList.toggle('active', t === type);
    });
    const ta = document.getElementById(mode === 'add' ? 'journalInputText' : 'editInputText');
    if (type === 'incoming') ta.placeholder = "相手から届いたSlackメッセージ...";
    else if (type === 'outgoing') ta.placeholder = "相手へ送信したSlackメッセージ...";
    else ta.placeholder = mode === 'add' ? "いま起きたことや記録を入力..." : "記録内容を編集...";
}

// PCモードでサイドバーを閉じたとき、画面端に「再表示」タブを出す（閉じたまま戻せなくなる問題の対策）
function updateSidebarReopenButtons() {
    const left = document.getElementById('pcLeftSidebarReopen');
    const right = document.getElementById('pcRightSidebarReopen');
    const isPc = !isCurrentMobileMode() && !window.IS_READONLY_MODE;
    const inCardView = calendarScope === 'notebooks' && ['card', 'linked', 'single'].includes(notebookViewMode);
    if (left) left.classList.toggle('visible', isPc && sidebarMode !== 'cal');
    if (right) right.classList.toggle('visible', isPc && inCardView && typeof isRightSidebarOpen !== 'undefined' && !isRightSidebarOpen);
}

function updateSidebars() {
    const calSidebar = document.getElementById('calendarSidebar'); 
    calSidebar.classList.remove('active');
    updateSidebarReopenButtons();
    
    if (isCurrentMobileMode()) {
        // スマホモード時は常駐サイドバーを無効化
        return;
    }

    if (sidebarMode === 'cal') {
        calSidebar.classList.add('active'); 
        
        const sidebarHeaderEl = document.querySelector('#calendarSidebar .sidebar-header');
        if (calendarScope === 'notebooks') {
            document.getElementById('sidebarTitle').textContent = 'NOTEBOOKS';
            document.getElementById('sidebarTitle').style.color = 'var(--notebook-color)';
            document.getElementById('calSidebarContent').style.display = 'none';
            document.getElementById('notebookSidebarContent').style.display = 'flex';
            if (sidebarHeaderEl) sidebarHeaderEl.classList.add('notebook-header-accent');
            renderNotebookSidebar();
        } else {
            document.getElementById('sidebarTitle').textContent = 'JOURNALS';
            document.getElementById('sidebarTitle').style.color = 'var(--accent-color)';
            document.getElementById('calSidebarContent').style.display = 'flex';
            document.getElementById('notebookSidebarContent').style.display = 'none';
            if (sidebarHeaderEl) sidebarHeaderEl.classList.remove('notebook-header-accent');
            renderMiniCalendar(); 
        }
        
        updateScopeButtonsUI(); 
        updateJumpButtonLabel();
    }
}

function closeSidebar() { sidebarMode = 'none'; updateSidebars(); }

function handleCalendarButtonClick() {
    if (calendarScope === 'notebooks' && (notebookViewMode === 'card' || notebookViewMode === 'linked')) {
        const leftSwitch = document.getElementById('toggleLeftSidebarSwitch');
        const rightSwitch = document.getElementById('toggleRightSidebarSwitch');
        if (leftSwitch) leftSwitch.checked = (sidebarMode === 'cal');
        if (rightSwitch) rightSwitch.checked = isRightSidebarOpen;
        openModal('sidebarToggleModal');
        return;
    }

    if (sidebarMode === 'cal') closeSidebar();
    else {
        sidebarMode = 'cal';
        const p = (activeDateKey || getTodayKey()).split('-');
        miniCalYear = parseInt(p[0], 10);
        miniCalMonth = parseInt(p[1], 10) - 1;
        updateSidebars();
    }
}

function toggleLeftSidebar(isOpen) {
    if (isOpen && typeof focusMode !== 'undefined' && focusMode) { focusMode = false; _focusPrev = null; document.body.classList.remove('focus-mode'); updateFocusButtonUI(); }
    if (isOpen) {
        sidebarMode = 'cal';
        const p = (activeDateKey || getTodayKey()).split('-');
        miniCalYear = parseInt(p[0], 10);
        miniCalMonth = parseInt(p[1], 10) - 1;
        updateSidebars();
    } else {
        closeSidebar();
    }
}

function toggleRightSidebar(isOpen) {
    if (isOpen && typeof focusMode !== 'undefined' && focusMode) { focusMode = false; _focusPrev = null; document.body.classList.remove('focus-mode'); updateFocusButtonUI(); }
    isRightSidebarOpen = isOpen;
    const viewContainer = document.querySelector('.connected-view-container');
    if (viewContainer) {
        viewContainer.classList.toggle('hide-right-sidebar', !isRightSidebarOpen);
    }
    const rightSwitch = document.getElementById('toggleRightSidebarSwitch');
    if (rightSwitch) rightSwitch.checked = isRightSidebarOpen;
    updateSidebarReopenButtons();
}

function handleCategoryButtonClick() { renderCategoryFilterModal(); openModal('categorySelectModal'); }

function selectFilter(mode, value = '') {
    saveCurrentScrollPositions();
    triggerSmoothViewSwitch(() => {
        currentFilter = { mode, value };
        
        if (calendarScope === 'notebooks' && !isNotebookEnabledForCurrentFilter()) {
            calendarScope = 'day';
        }
        
        if (hideEmptyCards && calendarScope !== 'notebooks') adjustActiveDateToLatestLog();
        updateCategoryButtonUI(); 
        updateScopeButtonsUI(); 
        renderRightCards(); 
        if (sidebarMode === 'cal') updateSidebars();
    });
    closeModal('categorySelectModal');
}

function renderCategoryFilterModal() {
    const c = document.getElementById('catFilterModalList'); c.innerHTML = "";
    
    // 一番上：ホーム（ホームに出さないタイプを除く）
    const hidden = getHomeHiddenTypes().filter(t => categories.some(ca => (ca.type || "一般") === t));
    const homeBtn = document.createElement('div');
    homeBtn.className = `cat-filter-all-btn ${currentFilter.mode === 'all' ? 'selected' : ''}`;
    homeBtn.innerHTML = `<div style="display: flex; align-items: center; gap: 9px; min-width: 0;"><span style="font-size: 18px;">🏠</span><div class="cat-filter-all-text"><span class="cat-filter-name">ホーム</span></div></div>`;
    homeBtn.onclick = () => selectFilter('all'); c.appendChild(homeBtn);

    const activeCats = getActiveCategories();
    const types = appTypes.filter(t => activeCats.some(ca => (ca.type || "一般") === t));
    types.forEach(t => {
        const card = document.createElement('div'); card.className = 'cat-filter-type-card';
        const isT = currentFilter.mode === 'type' && currentFilter.value === t;
        const row = document.createElement('button'); row.className = `cat-filter-type-row-btn ${isT ? 'selected' : ''}`;
        const homeMark = isTypeShownOnHome(t) ? '' : '<span class="cat-filter-home-hidden" title="ホームには表示しないタイプ">ホーム非表示</span>';
        row.innerHTML = `<div class="cat-filter-type-title-area"><span class="cat-filter-type-icon">${getTypeIcon(t)}</span><span class="cat-filter-type-title">${escapeHtml(t)}</span><span class="cat-filter-type-subtext">${isT ? '(全件選択中)' : '(タイプ全件)'}</span>${homeMark}</div>`;
        row.onclick = () => selectFilter('type', t); card.appendChild(row);

        const wrap = document.createElement('div'); wrap.className = 'cat-filter-chips-grid';
        activeCats.filter(ca => (ca.type || "一般") === t).forEach(cat => {
            const isC = currentFilter.mode === 'category' && currentFilter.value === cat.name;
            const b = document.createElement('button'); b.className = `cat-filter-subchip ${isC ? 'selected' : ''}`;
            b.innerHTML = `<span>${escapeHtml(cat.name)}</span>`;
            b.onclick = () => selectFilter('category', cat.name); wrap.appendChild(b);
        });
        card.appendChild(wrap); c.appendChild(card);
    });

    // 一番下：すべて表示（ホームに出さないタイプも含めて全部）
    const allBtn = document.createElement('div');
    allBtn.className = `cat-filter-all-btn cat-filter-everything-btn ${currentFilter.mode === 'everything' ? 'selected' : ''}`;
    allBtn.innerHTML = `<div style="display: flex; align-items: center; gap: 9px; min-width: 0;"><span style="font-size: 18px;">🌐</span><div class="cat-filter-all-text"><span class="cat-filter-name">すべて表示</span></div></div>`;
    allBtn.onclick = () => selectFilter('everything'); c.appendChild(allBtn);

    // さらに下：アーカイブしたカテゴリ（ふだんは畳んでおき、選んでいるときだけ開いておく）
    const archived = getArchivedCategories();
    if (archived.length) {
        const selArchived = currentFilter.mode === 'category' && isCategoryArchived(currentFilter.value);
        if (selArchived) _archiveFilterOpen = true;
        const box = document.createElement('div'); box.className = 'cat-filter-archive';
        const head = document.createElement('button'); head.type = 'button';
        head.className = `cat-filter-archive-head ${_archiveFilterOpen ? 'is-open' : ''}`;
        head.innerHTML = `<span>📦 アーカイブ（${archived.length}）</span><span class="cat-filter-archive-chev">▾</span>`;
        head.onclick = () => { _archiveFilterOpen = !_archiveFilterOpen; renderCategoryFilterModal(); };
        box.appendChild(head);
        if (_archiveFilterOpen) {
            const wrap = document.createElement('div'); wrap.className = 'cat-filter-chips-grid';
            archived.forEach(cat => {
                const isC = currentFilter.mode === 'category' && currentFilter.value === cat.name;
                const b = document.createElement('button'); b.className = `cat-filter-subchip is-archived ${isC ? 'selected' : ''}`;
                b.innerHTML = `<span>${escapeHtml(cat.name)}</span>`;
                b.onclick = () => selectFilter('category', cat.name); wrap.appendChild(b);
            });
            box.appendChild(wrap);
        }
        c.appendChild(box);
    }
}
let _archiveFilterOpen = false;

function updateCategoryButtonUI() {
    const b = document.getElementById('btnCategory'), l = document.getElementById('btnCategoryLabel');
    if (!b || !l) return;
    if (currentFilter.mode === 'all') { l.textContent = "カテゴリ"; b.classList.remove('active-filter'); }
    else if (currentFilter.mode === 'everything') { l.textContent = "すべて"; b.classList.add('active-filter'); }
    else { l.textContent = currentFilter.value; b.classList.add('active-filter'); }
}

function switchSettingsTab(t) {
    // ★ 'cloud' タブを配列に追加しました
    if (t === 'tags' && typeof renderSettingsTagList === 'function') renderSettingsTagList();
    if (t === 'data') renderStorageStatus();
    if (t === 'templates' && typeof renderSettingsTemplateList === 'function') renderSettingsTemplateList();
    ['general', 'types', 'categories', 'tags', 'templates', 'data', 'cloud', 'sync'].forEach(p => {
        const b = document.getElementById('tabBtn' + p.charAt(0).toUpperCase() + p.slice(1));
        const e = document.getElementById('settingsPage' + p.charAt(0).toUpperCase() + p.slice(1));
        if (b) b.classList.toggle('active', p === t); 
        if (e) e.classList.toggle('active', p === t);
    });
}

function openViewScopeModal() { updateViewScopeModalUI(); openModal('viewScopeModal'); }
function updateViewScopeModalUI() {
    ['day', 'week', 'month', 'photo'].forEach(s => {
        const i = document.getElementById(`scopeItem_${s}`);
        if (i) i.classList.toggle('selected', calendarScope === s && !showPinnedList && !showTagView);
    });
    const pinItem = document.getElementById('scopeItem_pins');
    if (pinItem) pinItem.classList.toggle('selected', showPinnedList && calendarScope !== 'notebooks');

    const activeNbMode = (notebookViewMode === 'linked' || notebookViewMode === 'single') ? 'card' : notebookViewMode;
    ['grid', 'card', 'graph'].forEach(m => {
        const c = document.getElementById(`scopeItem_notebooks_${m}`);
        if (c) c.classList.toggle('notebook-selected', calendarScope === 'notebooks' && activeNbMode === m);
    });

    const nbDivider = document.getElementById('modalNotebookDivider');
    const isNbEnabled = isNotebookEnabledForCurrentFilter();
    if (nbDivider) nbDivider.style.display = isNbEnabled ? 'block' : 'none';
    ['grid', 'card', 'graph'].forEach(m => {
        const c = document.getElementById(`scopeItem_notebooks_${m}`);
        if (c) c.style.display = isNbEnabled ? 'flex' : 'none';
    });
}
function selectScopeFromModal(s) { setCalendarScope(s); closeModal('viewScopeModal'); }

function setCalendarScope(scope) {
    showPinnedList = false; showTagView = null;
    saveCurrentScrollPositions();
    triggerSmoothViewSwitch(() => {
        if (['day', 'week', 'month', 'photo'].includes(calendarScope)) {
            lastJournalScope = calendarScope;
            lastJournalDateKey = activeDateKey;
            previousCalendarScope = calendarScope;
        }

        if (['day', 'week', 'month', 'photo'].includes(scope)) {
            if (lastJournalDateKey) {
                activeDateKey = lastJournalDateKey;
                const p = activeDateKey.split('-');
                miniCalYear = parseInt(p[0], 10);
                miniCalMonth = parseInt(p[1], 10) - 1;
            }
        }

        calendarScope = scope;
        
        if (hideEmptyCards && calendarScope !== 'notebooks') adjustActiveDateToLatestLog();
        updateScopeButtonsUI(); updateJumpButtonLabel(); 
        if (sidebarMode === 'cal') updateSidebars();
        renderRightCards();
    });
}

function updateScopeButtonsUI() {
    const bDay = document.getElementById('btnScopeDay');
    const bWeek = document.getElementById('btnScopeWeek');
    const bMonth = document.getElementById('btnScopeMonth');
    const bPhoto = document.getElementById('btnScopePhoto');
    const bPins = document.getElementById('btnScopePins');
    const pinOn = !!showPinnedList && calendarScope !== 'notebooks';
    const tagOn = !!showTagView && calendarScope !== 'notebooks';
    // サイドバーの一覧は「表示ビューの切り替え」と同じ見た目（選択中は selected）
    const plain = !pinOn && !tagOn;
    [[bDay, plain && calendarScope === 'day'], [bWeek, plain && calendarScope === 'week'], [bMonth, plain && calendarScope === 'month'], [bPhoto, plain && calendarScope === 'photo'], [bPins, pinOn]]
        .forEach(([el, on]) => { if (el) { el.classList.toggle('active', on); el.classList.toggle('selected', on); el.setAttribute('aria-current', on ? 'true' : 'false'); } });

    const isNbEnabled = isNotebookEnabledForCurrentFilter();
    const sbNb = document.getElementById('btnSidebarNotebook');
    if (sbNb) {
        sbNb.style.display = isNbEnabled ? 'flex' : 'none';
        sbNb.classList.toggle('active', calendarScope === 'notebooks');
    }

    const si = document.getElementById('btnViewScopeIcon'), sl = document.getElementById('btnViewScopeLabel'), v = document.getElementById('btnViewScope');
    if (v && si && sl) {
        v.className = 'bar-btn'; 
        if (showPinnedList && calendarScope !== 'notebooks') { si.textContent = '🔖'; sl.textContent = 'しおり'; v.classList.add('active-scope'); }
        else if (showTagView && calendarScope !== 'notebooks') { si.textContent = '🏷️'; sl.textContent = 'タグ'; v.classList.add('active-scope'); }
        else if (calendarScope === 'day') { si.textContent = '☀️'; sl.textContent = '日表示'; }
        else if (calendarScope === 'week') { si.textContent = '🗓️'; sl.textContent = '週表示'; v.classList.add('active-scope'); }
        else if (calendarScope === 'month') { si.textContent = '🌙'; sl.textContent = '月表示'; v.classList.add('active-scope'); }
        else if (calendarScope === 'photo') { si.textContent = '📸'; sl.textContent = '写真'; v.classList.add('active-scope'); }
        else if (calendarScope === 'notebooks') {
            const m = (notebookViewMode === 'linked' || notebookViewMode === 'single') ? 'card' : notebookViewMode;
            if (m === 'card') { si.textContent = '📖'; sl.textContent = 'カード'; }
            else if (m === 'graph') { si.textContent = '🎯'; sl.textContent = 'グラフ'; }
            else if (m === 'trash') { si.textContent = '🗑️'; sl.textContent = 'ゴミ箱'; }
            else { si.textContent = '🗂️'; sl.textContent = 'ノート'; }
            v.classList.add('notebook-active-scope');
        }
    }

    fitBarLabels();

    const mainIcon = document.getElementById('launcherMainIcon');
    const mainLabel = document.getElementById('launcherMainLabel');
    const mainBtn = document.getElementById('launcherMainBtn');

    if (mainIcon && mainLabel) {
        if (calendarScope === 'notebooks') {
            mainIcon.textContent = '+';
            mainLabel.textContent = 'ノート';
            if (mainBtn) mainBtn.classList.add('notebook-active');
        } else {
            mainIcon.textContent = '+';
            mainLabel.textContent = '追記';
            if (mainBtn) mainBtn.classList.remove('notebook-active');
        }
    }
}

function updateJumpButtonLabel() {
    const l = document.getElementById('calJumpCurrentLabel');
    if (l) {
        l.textContent = (calendarScope === 'notebooks') ? "一覧に戻る" : "今日に戻る";
    }

    const isNb = (calendarScope === 'notebooks');

    // 下部バー: 今日／一覧ボタン
    const tlLabel = document.getElementById('btnTodayListLabel');
    if (tlLabel) tlLabel.textContent = isNb ? "一覧" : "今日";

    // 下部バー: カレンダー／リンクボタン
    const clLabel = document.getElementById('btnCalendarLinkLabel');
    const clIcon = document.getElementById('btnCalendarLinkIcon');
    if (clLabel) clLabel.textContent = isNb ? "リンク" : "日付";
    fitBarLabels();
    if (clIcon) clIcon.textContent = isNb ? "🔗" : "📅";
}

// ==========================================
// カレンダー / リンク ボタンのハンドリング（スマホ時は全画面ポップアップ）
// ==========================================
function handleCalendarLinkButtonClick() {
    if (isCurrentMobileMode()) {
        if (calendarScope === 'notebooks') {
            openFullscreenLinkPopup();
        } else {
            openFullscreenCalendarPopup();
        }
    } else {
        // PCモード時：左サイドバー開閉
        handleCalendarButtonClick();
    }
}

function openFullscreenCalendarPopup() {
    renderFullscreenCalendar();
    openModal('fullscreenCalendarModal');
}

function openFullscreenLinkPopup() {
    renderFullscreenLinkedNotes();
    openModal('fullscreenLinkModal');
}

function renderFullscreenCalendar() {
    const titleEl = document.getElementById('fsMiniCalTitle');
    if (titleEl) titleEl.textContent = `${miniCalYear}年 ${miniCalMonth + 1}月`;
    const g = document.getElementById('fsMiniCalGrid');
    if (!g) return;
    g.innerHTML = "";

    const fDi = new Date(miniCalYear, miniCalMonth, 1).getDay();
    const lDd = new Date(miniCalYear, miniCalMonth + 1, 0).getDate();
    const todayStr = getTodayKey();

    for (let i = 0; i < fDi; i++) {
        const e = document.createElement('div');
        e.className = 'mini-cal-day empty';
        g.appendChild(e);
    }

    for (let d = 1; d <= lDd; d++) {
        const dk = `${miniCalYear}-${String(miniCalMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const b = document.createElement('button');
        let cls = ['mini-cal-day'];
        if (dk === todayStr) cls.push('today');
        if (hasVisibleLogsForDate(dk)) { cls.push('has-log'); if (calendarScope !== 'photo' && isLateOnlyDate(dk)) cls.push('late-only'); }
        
        if (calendarScope === 'day' || calendarScope === 'photo') { 
            if (dk === activeDateKey) cls.push('day-selected'); 
        } else if (calendarScope === 'week') { 
            if (isDateInWeek(dk, activeDateKey)) { 
                cls.push('week-selected'); 
                if (dk === activeDateKey) cls.push('day-focus'); 
            } 
        } else if (calendarScope === 'month') { 
            if (dk.substring(0, 7) === activeDateKey.substring(0, 7)) { 
                cls.push('month-selected'); 
                if (dk === activeDateKey) cls.push('day-focus'); 
            } 
        }

        b.className = cls.join(' ');
        b.textContent = d;
        b.onclick = () => jumpToDateFromPopup(dk);
        g.appendChild(b);
    }

    // 週・月の範囲の帯：行の中で途切れるところを丸める
    const cells = Array.from(g.children);
    const inBand = el => el && (el.classList.contains('week-selected') || el.classList.contains('month-selected'));
    cells.forEach((el, i) => {
        if (!inBand(el)) return;
        const col = i % 7;
        if (col === 0 || !inBand(cells[i - 1])) el.classList.add('band-start');
        if (col === 6 || !inBand(cells[i + 1])) el.classList.add('band-end');
    });

    // スコープボタン同期
    ['Day', 'Week', 'Month', 'Photo'].forEach(s => {
        const btn = document.getElementById(`fsBtnScope${s}`);
        if (btn) btn.classList.toggle('active', calendarScope.toLowerCase() === s.toLowerCase());
    });

    const fsInput = document.getElementById('fsJournalSearchInput');
    const fsClear = document.getElementById('fsJournalSearchClearBtn');
    if (fsInput) fsInput.value = journalSearchQuery;
    if (fsClear) fsClear.classList.toggle('active', !!journalSearchQuery);
}

function setCalendarScopeFromPopup(scope) {
    setCalendarScope(scope);
    renderFullscreenCalendar();
    closeModal('fullscreenCalendarModal');
}

function jumpToCurrentScopePeriodFromPopup() {
    const now = new Date(); miniCalYear = now.getFullYear(); miniCalMonth = now.getMonth();
    jumpToDateFromPopup(getTodayKey());
}

// カレンダーのポップアップから日付を選んだとき：カードを流すスクロールはせず、その日へそのまま切り替える
// ※以前は途中のカードを高速で流して移動していた（遠い日ほど長く流れる）。ポップアップを閉じ、軽くフェードして表示を差し替える。
function jumpToDateFromPopup(dk) {
    closeModal('fullscreenCalendarModal');
    jumpToDateInstant(dk);
}

// 日付へ「ぱっと」切り替える共通処理（左サイドバーのカレンダー・ポップアップのカレンダーの両方で使う）
// ※カードを横に流すスクロールや、タイムラインを縦に流すスクロールはしない。
//   指でのスワイプ・スクロールの動き（カルーセルの滑らかな動作）には影響しない。
function jumpToDateInstant(dk) {
    const c = document.getElementById('journalCarouselContainer');
    c.style.transition = 'none';
    c.style.opacity = '0';

    if (journalSearchQuery) { journalSearchQuery = ''; ['journalSearchInput', 'fsJournalSearchInput'].forEach(i => { const el = document.getElementById(i); if (el) el.value = ''; }); ['journalSearchClearBtn', 'fsJournalSearchClearBtn'].forEach(i => { const el = document.getElementById(i); if (el) el.classList.remove('active'); }); }
    const wasOverlay = showPinnedList || showTagView || !c.querySelector('.card-carousel-panel[data-key]');
    if (showPinnedList || showTagView) { showPinnedList = false; showTagView = null; updateScopeButtonsUI(); }
    activeDateKey = dk; lastJournalDateKey = dk;
    if (!dateList.includes(dk)) { dateList.push(dk); dateList.sort(); }

    if (wasOverlay) {
        if (calendarScope === 'photo') lastPhotoPanelKey = null;
        renderRightCards();
    }
    if (calendarScope === 'day') {
        if (c.querySelector(`[data-key="${dk}"]`)) instantScrollToKey(dk); else renderDayCarousel();
    } else if (calendarScope === 'photo') {
        smoothScrollToPhotoDate(dk, true);
    } else if (calendarScope === 'week') {
        const { monStr } = getWeekRangeFromDate(dk);
        const panel = c.querySelector(`[data-key="${monStr}"]`);
        if (panel) { instantScrollToKey(monStr); scrollToTimelineDateInPanel(panel, dk, false); } else renderWeekCarousel();
    } else if (calendarScope === 'month') {
        const pre = dk.substring(0, 7);
        const panel = c.querySelector(`[data-key="${pre}"]`);
        if (panel) { instantScrollToKey(pre); scrollToTimelineDateInPanel(panel, dk, false); } else renderMonthCarousel();
    }
    renderMiniCalendar();
    renderFullscreenCalendar();
    requestAnimationFrame(() => requestAnimationFrame(() => {
        c.style.transition = 'opacity 0.22s ease';
        c.style.opacity = '';
        setTimeout(() => { c.style.transition = ''; }, 260);
    }));
}

function handleFsJournalSearchInput(e) {
    journalSearchQuery = (e.target.value || '').trim();
    const clearBtn = document.getElementById('fsJournalSearchClearBtn');
    if (clearBtn) clearBtn.classList.toggle('active', !!journalSearchQuery);
    renderRightCards();
}

function clearFsJournalSearch() {
    journalSearchQuery = "";
    const input = document.getElementById('fsJournalSearchInput');
    const clearBtn = document.getElementById('fsJournalSearchClearBtn');
    if (input) input.value = "";
    if (clearBtn) clearBtn.classList.remove('active');
    renderRightCards();
}

function renderFullscreenLinkedNotes() {
    const container = document.getElementById('fsLinkedCardsContainer');
    const countBadge = document.getElementById('fsLinkedCountBadge');
    const sub = document.getElementById('fsLinkedSubtitle');
    if (!container) return;

    const filteredNotebooks = getFilteredNotebooks();
    const currentNote = filteredNotebooks[currentNotebookIndex] || filteredNotebooks[0];
    const addBtn = document.getElementById('fsLinkAddBtn');
    if (addBtn) addBtn.style.display = currentNote && !window.IS_READONLY_MODE ? '' : 'none';

    if (!currentNote) {
        if (sub) sub.textContent = '';
        if (countBadge) countBadge.textContent = '0';
        container.className = '';
        container.innerHTML = '<div class="ios-link-empty"><span class="big">📔</span><span class="ttl">ノートがありません</span></div>';
        return;
    }
    if (sub) sub.textContent = `「${currentNote.title || '無題のノート'}」とつながっているノート`; 

    const linkedNotes = [];
    (Array.isArray(currentNote.linkedNoteIds) ? currentNote.linkedNoteIds : []).forEach(lid => {
        const found = notebookData.find(n => n.id === lid && n.status !== 'trash');
        if (found) linkedNotes.push(found);
    });
    if (countBadge) countBadge.textContent = String(linkedNotes.length);

    if (linkedNotes.length === 0) {
        container.className = '';
        container.innerHTML = `<div class="ios-link-empty"><span class="big">🔗</span><span class="ttl">リンクされたノートはありません</span><span>右上の「＋ リンク」から、関連するノートをつなげられます</span></div>`;
        return;
    }

    let html = '';
    linkedNotes.forEach(ln => {
        const title = ln.title || '無題のノート';
        const preview = (ln.content && ln.content.trim()) ? buildNotebookPreviewHtml(ln.content) : '<span style="opacity:0.4;">(空のノート)</span>';
        const unlink = window.IS_READONLY_MODE ? '<span></span>' : `<button type="button" class="nb-unlink-btn ios-card-unlink" onclick="event.stopPropagation(); unlinkNotebook('${currentNote.id}', '${ln.id}', event)" title="このノートとのリンクを解除">✕ 解除</button>`;
        html += `
            <div class="notebook-grid-card ios-link-card" onclick="openNotebookLinkedFromPopup('${ln.id}')">
                <h3 class="notebook-grid-title">${escapeHtml(title)}</h3>
                <div class="notebook-grid-preview">${preview}</div>
                <div class="notebook-grid-meta">
                    ${unlink}
                    <div style="display: flex; gap: 4px; align-items: center;">${buildStatusBadgeHtml(ln.status || 'archive', ln.id)}${buildNotebookCategoryBadge(ln)}</div>
                </div>
            </div>`;
    });
    container.className = 'ios-link-cards';
    container.innerHTML = html;
}

function openNotebookLinkedFromPopup(id) {
    closeModal('fullscreenLinkModal');
    openNotebookLinked(id);
}

function openLinkNotebookModalFromPopup() {
    closeModal('fullscreenLinkModal');
    const filteredNotebooks = getFilteredNotebooks();
    const currentNote = filteredNotebooks[currentNotebookIndex] || filteredNotebooks[0];
    if (currentNote) openLinkNotebookModal(currentNote.id);
}

function shouldShowSlackFormatting(log) {
    if (currentFilter.mode === 'all' || currentFilter.mode === 'everything') {
        return typeSlackSettings['all'] === true;
    }
    const catType = getLogCategoryType(log.category || "ライフログ");
    return isSlackEnabledForType(catType);
}

function createLogItemHtml(log, dateStr, originalIndex) {
    const catName = log.category || "ライフログ"; const tCls = getCategoryTypeClass(catName);
    const showSlack = shouldShowSlackFormatting(log);
    const sType = showSlack ? (log.slackType || (log.isSlack ? 'incoming' : null)) : null;

    const showCat = (currentFilter.mode === 'all' || currentFilter.mode === 'everything' || currentFilter.mode === 'type');
    const catBadge = showCat ? `<span class="log-category-badge ${tCls}">${escapeHtml(catName)}</span>` : '';
    let sBadge = "";
    if (sType === 'incoming') sBadge = `<span class="slack-direction-badge incoming"><span>📥</span><span>相手から</span></span>`;
    else if (sType === 'outgoing') sBadge = `<span class="slack-direction-badge outgoing"><span>📤</span><span>自分から</span></span>`;

    const p = Array.isArray(log.images) ? log.images : (log.image ? [log.image] : []);
    const pHtml = p.length > 0 ? `<div class="log-photos-grid">` + p.map(img => `<div class="log-photo-thumb-wrap" onclick="event.stopPropagation(); openLightboxFromImg(this.querySelector('img'))"><img class="log-photo-thumb" ${imgSrcAttrs(img, 240)}></div>`).join('') + `</div>` : "";

    let cHtml = "";
    if (sType === 'incoming') cHtml = `<div class="chat-bubble-card incoming"><div class="chat-bubble-header"><span>💬</span><span>${escapeHtml(catName)}</span></div><div class="chat-bubble-text">${renderLogText(log.text)}</div></div>`;
    else if (sType === 'outgoing') cHtml = `<div class="chat-bubble-card outgoing"><div class="chat-bubble-header"><span>💬</span><span>あなた → ${escapeHtml(catName)}</span></div><div class="chat-bubble-text">${renderLogText(log.text)}</div></div>`;
    else cHtml = `<div class="log-content">${renderLogText(log.text)}</div>`;

    const viaHtml = typeof mentionViaHtml === 'function' ? mentionViaHtml(log) : '';
    return `<li class="log-item${log.backdated ? ' is-backdated' : ''}${log.pinned ? ' is-pinned' : ''}${viaHtml ? ' is-mentioned' : ''}" id="logItem_${dateStr}_${log.id}"><div class="log-header-row"><div class="log-meta-group"><span class="log-badge">${escapeHtml(log.time)}</span>${catBadge}${sBadge}${lateMarkHtml(log, dateStr)}</div><div class="log-actions">${pinButtonHtml(log, dateStr)}<button class="log-edit-btn" onclick="openEditModal('${dateStr}', '${log.id}')"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button></div></div>${cHtml}${pHtml}${logTagsHtml(log)}${viaHtml}</li>`;
}

function getFilteredDayLogs(dStr) {
    const raw = journalData[dStr] || []; const res = [];
    raw.forEach((l, i) => { if (matchesCurrentFilter(l)) res.push({ log: l, index: i }); });
    return res.sort((a, b) => a.log.time.localeCompare(b.log.time));
}

function getActiveFilterBadgeHtml() {
    if (currentFilter.mode === 'type') return `<span class="filter-status-badge type-badge"><span>${getTypeIcon(currentFilter.value)}</span><span>${escapeHtml(currentFilter.value)} (全件)</span></span>`;
    if (currentFilter.mode === 'category') return `<span class="filter-status-badge"><span>🏷️</span><span>${escapeHtml(currentFilter.value)}</span></span>`;
    if (currentFilter.mode === 'everything') return `<span class="filter-status-badge"><span>🌐</span><span>すべて</span></span>`;
    return '';
}

function getEmptyStateMessage() {
    if (currentFilter.mode === 'type') return `「${currentFilter.value}」タイプの記録はありません`;
    if (currentFilter.mode === 'category') return `「${currentFilter.value}」の記録はありません`;
    return 'まだ記録がありません';
}

function renderRightCards() {
    // 表示切り替えの処理中は描き直しを1回にまとめる（triggerSmoothViewSwitch 参照）
    if (_deferRender) { _renderDirty = true; return; }
    if (typeof updateTagBrowseButtons === 'function') updateTagBrowseButtons();
    saveCurrentScrollPositions();
    const container = document.getElementById('journalCarouselContainer');
    if (container) container.classList.remove('grid-mode-active');
    
    if (calendarScope !== 'notebooks' && showPinnedList) {
        renderPinnedListCard();
        updateSidebarReopenButtons();
        return;
    }
    if (calendarScope !== 'notebooks' && showTagView && typeof renderTagListCard === 'function') {
        renderTagListCard(showTagView);
        updateSidebarReopenButtons();
        return;
    }
    if (calendarScope !== 'notebooks' && typeof journalSearchQuery === 'string' && journalSearchQuery.trim() !== '') {
        renderJournalSearchResultsCard(journalSearchQuery.trim());
        return;
    }

    if (calendarScope === 'day') renderDayCarousel();
    else if (calendarScope === 'week') renderWeekCarousel();
    else if (calendarScope === 'month') renderMonthCarousel();
    else if (calendarScope === 'photo') renderPhotoJournalCarousel();
    else if (calendarScope === 'notebooks') {
        renderNotebookCarousel();
        if (notebookViewMode === 'grid' && cardScrollPositions['notebook_grid'] !== undefined) {
            requestAnimationFrame(() => {
                const c = document.getElementById('journalCarouselContainer');
                if (c) c.scrollTop = cardScrollPositions['notebook_grid'];
            });
        }
    }
    updateSidebarReopenButtons();
}

function renderJournalSearchResultsCard(query) {
    const container = document.getElementById('journalCarouselContainer');
    container.innerHTML = "";
    const filterBadgeHtml = getActiveFilterBadgeHtml();
    const q = query.toLowerCase();

    let matches = [];
    Object.keys(journalData).sort().reverse().forEach(dStr => {
        const logs = journalData[dStr] || [];
        logs.forEach((log, idx) => {
            if (!matchesCurrentFilter(log)) return;
            const sType = log.slackType || (log.isSlack ? 'incoming' : null);
            const textMatch = (log.text || '').toLowerCase().includes(q);
            const catMatch = (log.category || '').toLowerCase().includes(q);
            const typeMatch = getLogCategoryType(log.category || '').toLowerCase().includes(q);
            const slackMatch = (sType === 'incoming' && "受信slack相手".includes(q)) || (sType === 'outgoing' && "送信slack自分".includes(q));
            const tagMatch = (log.tags || []).some(t => ('#' + t).toLowerCase().includes(q));

            if (textMatch || catMatch || typeMatch || slackMatch || tagMatch) {
                matches.push({ dateStr: dStr, log: log, index: idx });
            }
        });
    });

    const panel = document.createElement('div');
    panel.className = 'card-carousel-panel';
    panel.style.width = '100%';

    let contentHtml = "";
    if (matches.length === 0) {
        contentHtml = `
            <div class="empty-state">
                <span style="font-size: 32px;">🔍</span>
                <span style="font-size: 15px; font-weight: 600; margin-top: 8px;">「${escapeHtml(query)}」に一致する記録はありません</span>
                <span style="font-size: 13px; opacity: 0.7;">別のキーワードを入力するか、検索窓の「✕」でクリアしてください</span>
            </div>
        `;
    } else {
        let curDate = null;
        contentHtml = `<ul class="log-list">`;
        matches.forEach(m => {
            if (m.dateStr !== curDate) {
                curDate = m.dateStr;
                contentHtml += `
                    <div class="timeline-date-divider" data-date="${curDate}" style="margin-top: 6px;">
                        <span class="timeline-date-label" onclick="jumpToDayFromTimeline('${curDate}')">📅 ${formatDateHeader(curDate)}</span>
                        <div class="timeline-date-line"></div>
                    </div>
                `;
            }
            contentHtml += createLogItemHtml(m.log, m.dateStr, m.index);
        });
        contentHtml += `</ul>`;
    }

    panel.innerHTML = `
        <div class="main-display">
            <div class="display-header compact-header">
                <div class="date-title-wrapper">
                    <span class="date-eyebrow">JOURNAL SEARCH RESULTS</span>
                    <h1 class="date-title">🔍 「${escapeHtml(query)}」</h1>
                </div>
                <div class="header-actions">
                    ${filterBadgeHtml}
                    <button type="button" class="data-action-btn" onclick="clearJournalSearch()" style="font-size: 11px; padding: 4px 9px;">検索解除</button>
                    <span class="header-badge">${matches.length} 件</span>
                </div>
            </div>
            <div class="logs-container-wrapper" style="padding: 4px 2px;">
                ${contentHtml}
            </div>
        </div>
    `;

    container.appendChild(panel);
}

function renderDayCarousel() {
    const container = document.getElementById('journalCarouselContainer'); container.innerHTML = "";
    const todayStr = getTodayKey(); const filterBadgeHtml = getActiveFilterBadgeHtml();
    let dToR = dateList;
    if (hideEmptyCards) {
        const w = dateList.filter(d => getFilteredDayLogs(d).length > 0);
        if (w.length > 0) { dToR = [...w]; if (!dToR.includes(activeDateKey)) { dToR.push(activeDateKey); dToR.sort(); } }
        else dToR = [todayStr];
    }
    dToR.forEach(dStr => {
        const f = getFilteredDayLogs(dStr); const p = document.createElement('div'); p.className = 'card-carousel-panel'; p.dataset.key = dStr;
        let h = "";
        if (!f.length) h = `<div class="empty-state"><span>📝 ${getEmptyStateMessage()}</span><span style="font-size: 13px; opacity: 0.7;">下部のボタンから今日に追記できます</span></div>`;
        else { h = `<ul class="log-list">`; f.forEach(i => h += createLogItemHtml(i.log, dStr, i.index)); h += `</ul>`; }
        p.innerHTML = `<div class="main-display"><div class="display-header"><div class="date-title-wrapper"><span class="date-eyebrow">DAILY JOURNAL</span><h1 class="date-title">${formatDateHeader(dStr)}</h1></div><div class="header-actions">${filterBadgeHtml}<span style="font-size: 11px; font-weight: 700; color: var(--text-secondary); opacity: 0.8; margin-right: 4px;">${dStr}</span>${dStr === todayStr ? '<span class="header-badge">今日</span>' : ''}</div></div><div class="logs-container-wrapper">${h}</div></div>`;
        container.appendChild(p);

        if (cardScrollPositions[dStr] !== undefined) {
            const sw = p.querySelector('.logs-container-wrapper');
            if (sw) sw.scrollTop = cardScrollPositions[dStr];
        }
    });
    const targetKey = dToR.includes(activeDateKey) ? activeDateKey : dToR[dToR.length - 1];
    instantScrollToKey(targetKey);
}

function renderPhotoJournalCarousel() {
    const container = document.getElementById('journalCarouselContainer'); container.innerHTML = ""; const filterBadgeHtml = getActiveFilterBadgeHtml();
    const pLogs = [];
    Object.keys(journalData).sort().forEach(dStr => {
        (journalData[dStr] || []).forEach((l, i) => {
            const p = Array.isArray(l.images) ? l.images : (l.image ? [l.image] : []);
            if (p.length > 0 && matchesCurrentFilter(l)) pLogs.push({ dateStr: dStr, log: l, index: i, photos: p });
        });
    });
    pLogs.sort((a, b) => { const c = a.dateStr.localeCompare(b.dateStr); return c !== 0 ? c : (a.log.time || "").localeCompare(b.log.time || ""); });
    
    if (!pLogs.length) {
        const ep = document.createElement('div'); ep.className = 'card-carousel-panel';
        ep.innerHTML = `<div class="main-display"><div class="display-header compact-header"><div class="date-title-wrapper"><span class="date-eyebrow">PHOTO JOURNAL</span><h1 class="date-title">Memories</h1></div><div class="header-actions">${filterBadgeHtml}<span class="header-badge">0件</span></div></div><div class="empty-state"><span style="font-size: 36px;">📸</span><span style="font-size: 15px; font-weight: 600;">写真付きの記録がまだありません</span></div></div>`;
        container.appendChild(ep); return;
    }

    pLogs.forEach((item, pIdx) => {
        const { dateStr, log, index, photos } = item; const cat = log.category || "ライフログ"; const tCls = getCategoryTypeClass(cat);
        const showSlack = shouldShowSlackFormatting(log);
        const sType = showSlack ? (log.slackType || (log.isSlack ? 'incoming' : null)) : null;

        let sb = ""; if (sType === 'incoming') sb = `<span class="slack-direction-badge incoming"><span>📥</span><span>相手から</span></span>`; else if (sType === 'outgoing') sb = `<span class="slack-direction-badge outgoing"><span>📤</span><span>自分から</span></span>`;
        let sHtml = ""; photos.forEach(u => sHtml += `<div class="photo-stage-slide"><img class="photo-stage-full-img" ${imgSrcAttrs(u)} onclick="openLightboxFromImg(this)"></div>`);
        const cp = photos.length > 1 ? `<div class="photo-count-pill">📷 1 / ${photos.length}</div>` : '';
        
        let mb = "";
        if (sType === 'incoming') mb = `<div class="chat-bubble-card incoming" style="margin-top: 2px;"><div class="chat-bubble-header"><span>💬</span><span>${escapeHtml(cat)}</span></div><div class="chat-bubble-text">${renderLogText(log.text)}</div></div>`;
        else if (sType === 'outgoing') mb = `<div class="chat-bubble-card outgoing" style="margin-top: 2px;"><div class="chat-bubble-header"><span>💬</span><span>あなた → ${escapeHtml(cat)}</span></div><div class="chat-bubble-text">${renderLogText(log.text)}</div></div>`;
        else mb = `<div class="journal-drawer-text">${renderLogText(log.text)}</div>`;

        const panelKey = `photo_${dateStr}_${log.id}`;
        const p = document.createElement('div'); p.className = 'card-carousel-panel'; p.dataset.key = panelKey; p.dataset.date = dateStr;
        p.innerHTML = `<div class="main-display journal-card-layout"><div class="display-header compact-header"><div class="date-title-wrapper"><span class="date-eyebrow">PHOTO JOURNAL</span><h1 class="date-title">${formatDateHeader(dateStr)}</h1></div><div class="header-actions">${filterBadgeHtml}<span style="font-size: 11px; font-weight: 700; color: var(--text-secondary); opacity: 0.8; margin-right: 4px;">${dateStr}</span><span class="header-badge">${pIdx + 1} / ${pLogs.length}</span></div></div><div class="photo-stage-viewport">${cp}<div class="photo-stage-scroller" onscroll="updateSlideCounter(this)">${sHtml}</div></div><div class="journal-bottom-drawer${log.pinned ? ' is-pinned' : ''}${typeof mentionViaHtml === 'function' && mentionViaHtml(log) ? ' is-mentioned' : ''}"><div class="journal-drawer-header"><div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;"><span class="log-badge">${escapeHtml(log.time)}</span><span class="log-category-badge ${tCls}">${escapeHtml(cat)}</span>${sb}${lateMarkHtml(log, dateStr)}</div><div class="log-actions">${pinButtonHtml(log, dateStr)}<button class="log-edit-btn" onclick="openEditModal('${dateStr}', '${log.id}')"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button></div></div>${mb}${logTagsHtml(log)}${typeof mentionViaHtml === 'function' ? mentionViaHtml(log) : ''}</div></div>`;
        container.appendChild(p);
    });

    let tP = null;
    if (lastPhotoPanelKey) {
        tP = container.querySelector(`[data-key="${lastPhotoPanelKey}"]`);
    }
    if (!tP) {
        tP = container.querySelector(`[data-date="${activeDateKey}"]`) || container.firstElementChild;
    }
    if (tP) {
        isProgrammaticScroll = true;
        container.scrollLeft = tP.offsetLeft - container.offsetLeft;
        if (tP.dataset.key) lastPhotoPanelKey = tP.dataset.key;
        clearTimeout(programmaticScrollTimer);
        programmaticScrollTimer = setTimeout(() => { isProgrammaticScroll = false; }, 120);
    }
}
function updateSlideCounter(s) { const p = s.parentElement.querySelector('.photo-count-pill'); if (!p) return; const w = s.clientWidth; if (!w) return; p.textContent = `📷 ${Math.round(s.scrollLeft / w) + 1} / ${s.querySelectorAll('.photo-stage-slide').length}`; }

function renderWeekCarousel() {
    const container = document.getElementById('journalCarouselContainer'); container.innerHTML = ""; const filterBadgeHtml = getActiveFilterBadgeHtml();
    const wL = []; const now = new Date();
    for (let i = 8; i >= 0; i--) {
        const t = new Date(); t.setDate(now.getDate() - (i * 7));
        const r = getWeekRangeFromDate(`${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`);
        if (!wL.some(w => w.monStr === r.monStr)) wL.push(r);
    }
    const aR = getWeekRangeFromDate(activeDateKey); if (!wL.some(w => w.monStr === aR.monStr)) { wL.push(aR); wL.sort((a, b) => a.monStr.localeCompare(b.monStr)); }
    
    const eW = [];
    wL.forEach(w => {
        const isC = isDateInWeek(getTodayKey(), w.monStr); const isF = isDateInWeek(activeDateKey, w.monStr);
        const wT = `${w.monDate.getMonth() + 1}/${w.monDate.getDate()}(${['日', '月', '火', '水', '木', '金', '土'][w.monDate.getDay()]}) - ${w.sunDate.getMonth() + 1}/${w.sunDate.getDate()}(${['日', '月', '火', '水', '木', '金', '土'][w.sunDate.getDay()]})`;
        let wLc = 0; let cH = "";
        for (let d = new Date(w.monDate); d <= w.sunDate; d.setDate(d.getDate() + 1)) {
            const dS = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const f = getFilteredDayLogs(dS);
            if (f.length > 0) {
                wLc += f.length; cH += `<div class="timeline-date-divider" data-date="${dS}"><span class="timeline-date-label" onclick="jumpToDayFromTimeline('${dS}')">${formatDateHeader(dS)}</span><div class="timeline-date-line"></div></div><ul class="log-list">`;
                f.forEach(i => cH += createLogItemHtml(i.log, dS, i.index)); cH += `</ul>`;
            }
        }
        if (!wLc) cH = `<div class="empty-state"><span>🗓️ この週の記録はありません</span></div>`;
        eW.push({ w, wT, cH, wLc, isC, isF });
    });

    let wToR = eW;
    if (hideEmptyCards) {
        const wL = eW.filter(ew => ew.wLc > 0);
        if (wL.length > 0) { wToR = [...wL]; const f = eW.find(ew => ew.isF); if (f && !wToR.some(ew => ew.w.monStr === f.w.monStr)) { wToR.push(f); wToR.sort((a, b) => a.w.monStr.localeCompare(b.w.monStr)); } }
        else { const fb = eW.find(ew => ew.isF) || eW[eW.length - 1]; wToR = [fb]; }
    }

    let aWk = null;
    wToR.forEach(ew => {
        if (ew.isF) aWk = ew.w.monStr;
        const p = document.createElement('div'); p.className = 'card-carousel-panel'; p.dataset.key = ew.w.monStr;
        p.innerHTML = `<div class="main-display"><div class="display-header"><div class="date-title-wrapper"><span class="date-eyebrow">WEEKLY JOURNAL</span><h1 class="date-title">${escapeHtml(ew.wT)}</h1></div><div class="header-actions">${filterBadgeHtml}${ew.isC ? '<span class="header-badge" style="background: var(--btn-secondary-bg); color: var(--text-primary);">今週</span>' : ''}</div></div><div class="logs-container-wrapper">${ew.cH}</div></div>`;
        container.appendChild(p);

        if (cardScrollPositions[ew.w.monStr] !== undefined) {
            const sw = p.querySelector('.logs-container-wrapper');
            if (sw) sw.scrollTop = cardScrollPositions[ew.w.monStr];
        }
    });
    const sT = aWk || (wToR.length > 0 ? wToR[wToR.length - 1].w.monStr : null);
    if (sT) {
        instantScrollToKey(sT);
        const aP = container.querySelector(`[data-key="${sT}"]`);
        if (aP) {
            if (cardScrollPositions[sT] === undefined) {
                scrollToTimelineDateInPanel(aP, activeDateKey, false);
            }
        }
    }
}

function renderMonthCarousel() {
    const container = document.getElementById('journalCarouselContainer'); container.innerHTML = ""; const filterBadgeHtml = getActiveFilterBadgeHtml();
    const mL = []; const now = new Date();
    for (let i = 11; i >= 0; i--) { const t = new Date(now.getFullYear(), now.getMonth() - i, 1); mL.push({ y: t.getFullYear(), m: t.getMonth() + 1, pre: `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}` }); }
    const aP = activeDateKey.substring(0, 7); if (!mL.some(m => m.pre === aP)) { const [y, m] = aP.split('-').map(v => parseInt(v, 10)); mL.push({ y, m, pre: aP }); mL.sort((a, b) => a.pre.localeCompare(b.pre)); }
    
    const eM = [];
    mL.forEach(mO => {
        const isC = (mO.pre === `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`); const isF = (mO.pre === aP);
        const mDs = Object.keys(journalData).filter(d => d.startsWith(mO.pre)).sort();
        let mLc = 0; let cH = "";
        mDs.forEach(dS => {
            const f = getFilteredDayLogs(dS);
            if (f.length > 0) {
                mLc += f.length; cH += `<div class="timeline-date-divider" data-date="${dS}"><span class="timeline-date-label" onclick="jumpToDayFromTimeline('${dS}')">${formatDateHeader(dS)}</span><div class="timeline-date-line"></div></div><ul class="log-list">`;
                f.forEach(i => cH += createLogItemHtml(i.log, dS, i.index)); cH += `</ul>`;
            }
        });
        if (!mLc) cH = `<div class="empty-state"><span>📅 この月の記録はありません</span></div>`;
        eM.push({ mO, isC, isF, mLc, cH });
    });

    let mToR = eM;
    if (hideEmptyCards) {
        const wL = eM.filter(em => em.mLc > 0);
        if (wL.length > 0) { mToR = [...wL]; const f = eM.find(em => em.isF); if (f && !mToR.some(em => em.mO.pre === f.mO.pre)) { mToR.push(f); mToR.sort((a, b) => a.mO.pre.localeCompare(b.mO.pre)); } }
        else { const fb = eM.find(em => em.isF) || eM[eM.length - 1]; mToR = [fb]; }
    }

    mToR.forEach(em => {
        const p = document.createElement('div'); p.className = 'card-carousel-panel'; p.dataset.key = em.mO.pre;
        p.innerHTML = `<div class="main-display"><div class="display-header"><div class="date-title-wrapper"><span class="date-eyebrow">MONTHLY JOURNAL</span><h1 class="date-title">${em.mO.y}年 ${em.mO.m}月</h1></div><div class="header-actions">${filterBadgeHtml}${em.isC ? '<span class="header-badge" style="background: var(--btn-secondary-bg); color: var(--text-primary);">今月</span>' : ''}</div></div><div class="logs-container-wrapper">${em.cH}</div></div>`;
        container.appendChild(p);

        if (cardScrollPositions[em.mO.pre] !== undefined) {
            const sw = p.querySelector('.logs-container-wrapper');
            if (sw) sw.scrollTop = cardScrollPositions[em.mO.pre];
        }
    });
    const sT = mToR.some(em => em.mO.pre === aP) ? aP : (mToR.length > 0 ? mToR[mToR.length - 1].mO.pre : null);
    if (sT) {
        instantScrollToKey(sT);
        const aPnl = container.querySelector(`[data-key="${sT}"]`);
        if (aPnl) {
            if (cardScrollPositions[sT] === undefined) {
                scrollToTimelineDateInPanel(aPnl, activeDateKey, false);
            }
        }
    }
}

function handleMainActionClick() {
    if (calendarScope === 'notebooks') openAddNotebookModal();
    else openAddModal();
}

function renderModalCategoryChips(mode, cSel) {
    const c = document.getElementById(mode === 'add' ? 'addCategoryChipsContainer' : 'editCategoryChipsContainer'); c.innerHTML = "";
    // アーカイブしたカテゴリは出さない。ただし編集中の記録のもとのカテゴリだけは「アーカイブ」の段に出す（外れたり勝手に変わったりしないように）
    let keepArchived = null;
    if (mode === 'edit' && currentEditTarget && currentEditTarget.id) {
        const log = findLogById(currentEditTarget.dateStr, currentEditTarget.id);
        if (log && isCategoryArchived(log.category)) keepArchived = log.category;
    }
    const pick = (cat) => {
        if (mode === 'add') { selectedAddCategory = cat.name; renderModalCategoryChips('add', selectedAddCategory); updateMsgTypeVisibility('add', cat.name); }
        else { selectedEditCategory = cat.name; renderModalCategoryChips('edit', selectedEditCategory); updateMsgTypeVisibility('edit', cat.name); }
    };
    const addRow = (label, icon, list, archived) => {
        const r = document.createElement('div'); r.className = 'category-type-row';
        r.innerHTML = `<div style="display: flex; align-items: center; gap: 5px;"><span style="font-size: 12px;">${icon}</span><span class="category-type-name">${escapeHtml(label)}</span></div>`;
        const w = document.createElement('div'); w.className = 'category-chips-wrap';
        list.forEach(cat => {
            const b = document.createElement('button'); b.type = 'button';
            b.className = `category-chip ${archived ? 'is-archived' : ''} ${cat.name === cSel ? 'selected' : ''}`; b.textContent = cat.name;
            b.onclick = () => pick(cat);
            w.appendChild(b);
        });
        r.appendChild(w); c.appendChild(r);
    };
    const active = getActiveCategories();
    appTypes.filter(t => active.some(ca => (ca.type || "一般") === t)).forEach(t => addRow(t, getTypeIcon(t), active.filter(ca => (ca.type || "一般") === t), false));
    if (keepArchived) addRow('アーカイブ', '📦', categories.filter(ca => ca.name === keepArchived), true);
    fitCategoryChips(c);
    if (typeof renderTagSection === 'function') renderTagSection(mode);
}

function openAddModal() {
    _addSlot = null; refreshAddSlotUI();
    document.getElementById('journalInputText').value = "";
    currentAddTags = []; const _ti = document.getElementById('addTagInput'); if (_ti) _ti.value = '';
    
    const _active = getActiveCategories();
    if (currentFilter.mode === 'category' && _active.some(c => c.name === currentFilter.value)) selectedAddCategory = currentFilter.value;
    else if (currentFilter.mode === 'type' || currentFilter.mode === 'category') {
        const ty = currentFilter.mode === 'type' ? currentFilter.value : getLogCategoryType(currentFilter.value);
        const f = _active.find(c => (c.type || "一般") === ty); selectedAddCategory = f ? f.name : "ライフログ";
    }
    else selectedAddCategory = "ライフログ";
    // 「ライフログ」もアーカイブ・削除されていたら、使えるカテゴリの先頭にする
    if (!_active.some(c => c.name === selectedAddCategory) && _active.length) selectedAddCategory = _active[0].name;
    
    renderModalCategoryChips('add', selectedAddCategory); 
    setMessageType('add', 'normal'); 
    updateMsgTypeVisibility('add', selectedAddCategory);
    currentAddPhotos = []; resetModalPhotoQuality('add'); renderPhotoPreviews('add'); openModal('addModal');
    setTimeout(() => document.getElementById('journalInputText').focus(), 200);
}

function findLogById(dStr, id) {
    return (journalData[dStr] || []).find(l => l.id === id) || null;
}

// 記録は配列の位置ではなくIDで特定する（編集中に同期で並びが変わっても別の記録を上書きしない）
function openEditModal(dStr, id) {
    const log = findLogById(dStr, id); if (!log) return;
    currentEditTarget = { dateStr: dStr, id: id };
    _editSlot = { date: dStr, time: log.time || '00:00' }; refreshEditSlotUI(); document.getElementById('editInputText').value = log.text || "";
    selectedEditCategory = log.category || "ライフログ"; 
    currentEditTags = Array.isArray(log.tags) ? [...log.tags] : []; const _ti = document.getElementById('editTagInput'); if (_ti) _ti.value = '';
    renderModalCategoryChips('edit', selectedEditCategory);
    const m = log.slackType || (log.isSlack ? 'incoming' : 'normal'); 
    setMessageType('edit', m); 
    updateMsgTypeVisibility('edit', selectedEditCategory);
    currentEditPhotos = Array.isArray(log.images) ? [...log.images] : (log.image ? [log.image] : []); resetModalPhotoQuality('edit'); renderPhotoPreviews('edit');
    openModal('editModal'); setTimeout(() => document.getElementById('editInputText').focus(), 200);
}

function openModal(id) { 
    if (id === 'settingsModal') { 
        switchSettingsTab('general'); 
        applyHideEmptyCardsSetting(); 
        applyDeviceModeSetting();
        renderSettingsTypeList();
        renderSettingsCategoryList(); 
    } 
    document.getElementById(id).classList.add('active'); 
}
function closeModal(id) { document.getElementById(id).classList.remove('active'); }
function outsideClose(e, id) { if (e.target.id === id) closeModal(id); }

async function saveNewLog() {
    await waitPhotoJobs('add'); // 写真の縮小・作り直しが終わるのを待つ
    const t = document.getElementById('journalInputText').value.trim();
    if (!t && !currentAddPhotos.length) { alert("内容または写真を添付してください。"); return; }
    if (!selectedAddCategory) { alert("カテゴリを選択してください。"); return; }
    // 通常は「いま」。追記画面で日時を変えた場合は後日記入として、その日時に入れる（実際に書いた日時も残す）
    let tStr = nowTimeStr(), dStr = getTodayKey(), late = false;
    if (_addSlot) {
        if (_slotIsFuture(_addSlot.date, _addSlot.time)) { alert("未来の日時には記録できません。"); return; }
        dStr = _addSlot.date; tStr = _addSlot.time; late = true;
    }
    if (!journalData[dStr]) journalData[dStr] = [];
    
    const sA = isSlackEnabledForType(getLogCategoryType(selectedAddCategory));
    commitPendingTagInput('add'); // タグ欄に打ちかけの文字があれば、タグとして付ける

    journalData[dStr].push({ 
        id: generateId('lg_'),
        time: tStr, 
        text: t, 
        category: selectedAddCategory, 
        slackType: (sA && currentAddMsgType !== 'normal') ? currentAddMsgType : null, 
        images: [...currentAddPhotos],
        writtenAt: new Date().toISOString(),
        ...(late ? { backdated: true } : {}),
        ...(currentAddTags.length ? { tags: [...currentAddTags] } : {})
    });
    currentAddTags = [];
    _addSlot = null;
    
    await saveJournalData();
    
    if (!dateList.includes(dStr)) { dateList.push(dStr); dateList.sort(); }
    clearDraft('add'); _setDraftBar('add', '');
    closeModal('addModal');
    triggerSmoothViewSwitch(() => {
        if (!['day', 'photo'].includes(calendarScope)) { calendarScope = 'day'; updateScopeButtonsUI(); updateJumpButtonLabel(); }
        activeDateKey = dStr;
        lastJournalDateKey = dStr;
        renderRightCards(); 
        if (sidebarMode === 'cal') updateSidebars();
    });
}

async function saveEditedLog() {
    await waitPhotoJobs('edit'); // 写真の縮小・作り直しが終わるのを待つ
    const { dateStr: d, id } = currentEditTarget; if (!d || !id) return;
    const target = findLogById(d, id);
    if (!target) { alert("この記録は他の端末で削除されたため、更新できませんでした。"); closeModal('editModal'); renderRightCards(); return; }
    const t = document.getElementById('editInputText').value.trim();
    if (!t && !currentEditPhotos.length) { alert("内容または写真を添付してください。"); return; }
    if (!selectedEditCategory) { alert("カテゴリを選択してください。"); return; }
    
    const sA = isSlackEnabledForType(getLogCategoryType(selectedEditCategory));

    target.text = t; 
    target.category = selectedEditCategory;
    target.slackType = (sA && currentEditMsgType !== 'normal') ? currentEditMsgType : null; 
    delete target.isSlack;
    target.images = [...currentEditPhotos]; 
    delete target.image;
    commitPendingTagInput('edit');
    if (currentEditTags.length) target.tags = [...currentEditTags]; else delete target.tags;

    // 日時の変更：後日記入の印を付け（外せない）、実際に書いた日時を残す
    let movedTo = null;
    if (_editSlot && (_editSlot.date !== d || _editSlot.time !== target.time)) {
        if (_slotIsFuture(_editSlot.date, _editSlot.time)) { alert("未来の日時には変更できません。"); return; }
        if (!target.writtenAt) target.writtenAt = slotToIso(d, target.time); // 以前の記録は、元の日時が書いた日時
        target.backdated = true;
        target.time = _editSlot.time;
        if (_editSlot.date !== d) {
            movedTo = _editSlot.date;
            journalData[d] = (journalData[d] || []).filter(l => l.id !== id);
            if (!journalData[d].length) delete journalData[d];
            (journalData[movedTo] = journalData[movedTo] || []).push(target);
            if (!dateList.includes(movedTo)) { dateList.push(movedTo); dateList.sort(); }
        }
    }
    
    await saveJournalData();
    
    clearDraft('edit', id); _setDraftBar('edit', '');
    closeModal('editModal');
    if (movedTo && calendarScope !== 'notebooks') {
        activeDateKey = movedTo; lastJournalDateKey = movedTo;
        const p = movedTo.split('-'); miniCalYear = parseInt(p[0], 10); miniCalMonth = parseInt(p[1], 10) - 1;
    }
    renderRightCards(); 
    if (sidebarMode === 'cal' && calendarScope !== 'notebooks') renderMiniCalendar();
}

async function deleteFromEditModal() {
    const { dateStr: d, id } = currentEditTarget; if (!d || !id) return;
    if (confirm("この記録を削除しますか？")) {
        const i = (journalData[d] || []).findIndex(l => l.id === id);
        // 取り消し用に、削除する記録をそのまま控えておく（画像は参照だけなので軽い）
        const removed = i !== -1 ? JSON.parse(JSON.stringify(journalData[d][i])) : null;
        if (i !== -1) journalData[d].splice(i, 1);
        if (journalData[d] && !journalData[d].length) delete journalData[d];

        await saveJournalData();
        if (removed) showUndoDeleteToast(d, removed, i);

        clearDraft('edit', id); _setDraftBar('edit', '');
        closeModal('editModal'); 
        triggerSmoothViewSwitch(() => { 
            renderRightCards(); 
            if (sidebarMode === 'cal' && calendarScope !== 'notebooks') renderMiniCalendar(); 
        });
    }
}

// ------------------------------------------
// 記録の削除の取り消し
// ------------------------------------------
// 削除した直後だけ、画面下に「元に戻す」を出す。押すと同じIDのまま元の日・元の位置に戻す。
// ※他の端末にはいったん削除が伝わるが、戻した記録の方が新しいので、他の端末でも元に戻る。
const UNDO_DELETE_MS = 10000;
function showUndoDeleteToast(dateStr, log, index) {
    // 取り消せる間は、この記録の画像を端末内の掃除の対象から外しておく
    for (const img of (log.images || [])) { const h = idbRefHash(img); if (h) _sessionStoredHashes.add(h); }
    let box = document.getElementById('appToastBox');
    if (!box) { box = document.createElement('div'); box.id = 'appToastBox'; box.className = 'app-toast-box'; document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'app-toast draft-toast undo-toast';
    t.setAttribute('role', 'status');
    const snippet = (log.text || '').replace(/\s+/g, ' ').trim().slice(0, 16) || (log.images && log.images.length ? '写真の記録' : '記録');
    t.innerHTML = `<span class="draft-toast-text"></span><span class="draft-toast-actions"><button type="button" class="draft-toast-btn">元に戻す</button></span><span class="undo-toast-bar" style="animation-duration:${UNDO_DELETE_MS}ms"></span>`;
    t.querySelector('.draft-toast-text').textContent = `削除しました：${snippet}`;
    t.onclick = null;
    const timer = setTimeout(() => t.remove(), UNDO_DELETE_MS);
    t.querySelector('button').onclick = async (e) => {
        e.stopPropagation();
        clearTimeout(timer);
        t.remove();
        await undoDeleteLog(dateStr, log, index);
    };
    box.appendChild(t);
}
async function undoDeleteLog(dateStr, log, index) {
    if (typeof isTabActive === 'function' && !isTabActive()) return;
    const list = journalData[dateStr] = journalData[dateStr] || [];
    if (!list.some(l => l.id === log.id)) {
        list.splice(Math.max(0, Math.min(index, list.length)), 0, log);
        if (!dateList.includes(dateStr)) { dateList.push(dateStr); dateList.sort(); }
        await saveJournalData();
    }
    renderRightCards();
    if (sidebarMode === 'cal' && calendarScope !== 'notebooks') renderMiniCalendar();
    showToast('記録を元に戻しました', 2500);
}

function renderSettingsTypeList() {
    const listEl = document.getElementById('settingsTypeList');
    if (!listEl) return;
    listEl.innerHTML = "";

    const nbAll = document.getElementById('typeNotebookAllSwitch');
    if (nbAll) nbAll.checked = (typeNotebookSettings['all'] !== false);
    const slAll = document.getElementById('typeSlackAllSwitch');
    if (slAll) slAll.checked = (typeSlackSettings['all'] === true);

    const countEl = document.getElementById('typeCountIndicator');
    if (countEl) countEl.textContent = `${appTypes.length}件`;

    appTypes.forEach((typeName, ti) => {
        const card = document.createElement('div');
        card.className = 'settings-type-card';
        card.id = `typeCard_${ti}`;
        card.dataset.id = typeName;

        const icon = getTypeIcon(typeName);
        const isSlack = isSlackEnabledForType(typeName);
        const isNb = (typeNotebookSettings[typeName] !== false);
        const catCount = categories.filter(c => c.type === typeName).length;

        card.innerHTML = `
            <div class="settings-type-header">
                <div class="settings-type-title-area" id="typeTitleArea_${ti}">
                    <span class="drag-handle" title="ドラッグして並び替え">⠿</span>
                    <span class="settings-type-icon">${icon}</span>
                    <span class="settings-type-name" title="${escapeHtml(typeName)}">${escapeHtml(typeName)}</span>
                    <span style="font-size: 11px; color: var(--text-secondary); font-weight: 600;">(${catCount})</span>
                </div>
                <div class="settings-type-actions" id="typeActions_${ti}">
                    <button type="button" class="settings-icon-btn edit-btn" onclick="startRenameType(${ti})">✏️ リネーム</button>
                    ${appTypes.length > 1 ? `<button type="button" class="settings-icon-btn del-btn" onclick="handleDeleteType(appTypes[${ti}])">🗑️</button>` : ''}
                </div>
            </div>
            <div class="settings-type-toggles-grid">
                <div class="settings-mini-toggle span-all" title="オフにすると、ホームにはこのタイプの記録・ノートを出しません（カテゴリの「すべて表示」や、このタイプを選べば見られます）">
                    <span>🏠 ホームに表示</span>
                    <label class="switch switch-sm">
                        <input type="checkbox" ${isTypeShownOnHome(typeName) ? 'checked' : ''} onchange="toggleTypeHomeSetting(appTypes[${ti}], this.checked)">
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="settings-mini-toggle">
                    <span>📔 Notebooks</span>
                    <label class="switch switch-sm">
                        <input type="checkbox" ${isNb ? 'checked' : ''} onchange="toggleTypeNotebookSetting(appTypes[${ti}], this.checked)">
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="settings-mini-toggle">
                    <span>💬 Slack機能</span>
                    <label class="switch switch-sm">
                        <input type="checkbox" ${isSlack ? 'checked' : ''} onchange="toggleTypeSlackSetting(appTypes[${ti}], this.checked)">
                        <span class="slider"></span>
                    </label>
                </div>
            </div>
        `;
        listEl.appendChild(card);
    });

    setupTypeSortable();
}

function setupTypeSortable() {
    const el = document.getElementById('settingsTypeList');
    if (!el || !window.Sortable) return;
    if (typeSortableInstance) typeSortableInstance.destroy();

    typeSortableInstance = new Sortable(el, {
        handle: '.drag-handle',
        animation: 180,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        onEnd: function(evt) {
            if (evt.oldIndex === evt.newIndex) return;
            const moved = appTypes.splice(evt.oldIndex, 1)[0];
            appTypes.splice(evt.newIndex, 0, moved);
            saveAppTypes();
            renderSettingsCategoryList();
            updateCategoryButtonUI();
            renderRightCards();
            if (sidebarMode === 'cal') updateSidebars();
        }
    });
}

function handleAddNewType() {
    const input = document.getElementById('newTypeName');
    if (!input) return;
    const name = input.value.trim();
    if (!name) { alert("タイプ名を入力してください。"); return; }
    if (addNewType(name)) {
        input.value = "";
        renderSettingsTypeList();
        renderSettingsCategoryList();
        if (calendarScope === 'notebooks') renderNotebookSidebar();
        renderRightCards();
        if (sidebarMode === 'cal') updateSidebars();
    }
}

// タイプ名は利用者が自由に付けられる文字列なので、インラインJSには埋め込まず「何番目か」で扱う
function startRenameType(ti) {
    const typeName = appTypes[ti];
    if (typeName === undefined) return;
    const titleArea = document.getElementById(`typeTitleArea_${ti}`);
    const actionsArea = document.getElementById(`typeActions_${ti}`);
    if (!titleArea || !actionsArea) return;

    titleArea.innerHTML = `
        <span class="drag-handle" style="opacity: 0.3; pointer-events: none;">⠿</span>
        <input type="text" class="settings-type-name-edit" id="renameInput_${ti}" value="${escapeHtml(typeName)}" onkeydown="if(event.key==='Enter'){ applyRenameType(${ti}); }">
    `;
    actionsArea.innerHTML = `
        <button type="button" class="settings-icon-btn edit-btn" onclick="applyRenameType(${ti})">✓ 保存</button>
        <button type="button" class="settings-icon-btn" onclick="renderSettingsTypeList()">✕</button>
    `;
    const editInput = document.getElementById(`renameInput_${ti}`);
    if (editInput) {
        editInput.focus();
        editInput.select();
    }
}

function applyRenameType(ti) {
    const oldName = appTypes[ti];
    const editInput = document.getElementById(`renameInput_${ti}`);
    if (!editInput) return;
    const newName = editInput.value.trim();
    if (!newName) { alert("タイプ名を入力してください。"); return; }
    if (renameType(oldName, newName)) {
        renderSettingsTypeList();
        renderSettingsCategoryList();
        updateCategoryButtonUI();
        renderRightCards();
        if (sidebarMode === 'cal') updateSidebars();
    }
}

function handleDeleteType(typeName) {
    if (deleteType(typeName)) {
        renderSettingsTypeList();
        renderSettingsCategoryList();
        updateCategoryButtonUI();
        renderRightCards();
        if (sidebarMode === 'cal') updateSidebars();
    }
}

function toggleTypeSlackSetting(t, chk) { 
    typeSlackSettings[t] = chk; 
    saveTypeSlackSettings();
    renderRightCards();
}

function toggleTypeHomeSetting(t, chk) {
    if (t === undefined) return;
    if (chk) delete typeHomeSettings[t]; else typeHomeSettings[t] = false;
    saveTypeHomeSettings();
    if (hideEmptyCards && calendarScope !== 'notebooks') adjustActiveDateToLatestLog();
    renderRightCards();
    if (sidebarMode === 'cal') updateSidebars();
}

function toggleTypeNotebookSetting(t, chk) {
    typeNotebookSettings[t] = chk; 
    saveTypeNotebookSettings();
    if (calendarScope === 'notebooks' && !isNotebookEnabledForCurrentFilter()) setCalendarScope('day');
    else { updateScopeButtonsUI(); updateViewScopeModalUI(); }
}

function renderSettingsCategoryList() {
    const c = document.getElementById('settingsCategoryList'); 
    if (!c) return;
    c.innerHTML = ""; 
    const indicator = document.getElementById('catCountIndicator');
    if (indicator) indicator.textContent = `${getActiveCategories().length}/30`; // アーカイブ済みは数えない

    const newCatTypeSelect = document.getElementById('newCatType');
    if (newCatTypeSelect) {
        const curVal = newCatTypeSelect.value;
        newCatTypeSelect.innerHTML = appTypes.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
        if (appTypes.includes(curVal)) newCatTypeSelect.value = curVal;
    }

    categories.forEach((cat, i) => {
        if (cat.archivedAt) return; // アーカイブ済みは下の段にまとめる
        const r = document.createElement('div'); 
        r.className = 'category-manage-item';
        r.id = `catManageItem_${i}`;
        r.dataset.id = cat.name;

        const typeOptionsHtml = appTypes.map(t => `<option value="${escapeHtml(t)}" ${cat.type === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');

        r.innerHTML = `
            <div class="category-manage-title-area" id="catTitleArea_${i}">
                <span class="drag-handle" title="ドラッグして並び替え">⠿</span>
                <span class="category-manage-name" title="${escapeHtml(cat.name)}">${escapeHtml(cat.name)}</span>
            </div>
            <div class="category-manage-actions" id="catActionsArea_${i}">
                <select class="category-item-type-select" onchange="updateCategoryType(${i}, this.value)">
                    ${typeOptionsHtml}
                </select>
                <button type="button" class="settings-icon-btn edit-btn" onclick="startRenameCategory(${i})" title="カテゴリ名を変更">✏️</button>
                ${getActiveCategories().length > 1 ? `<button type="button" class="settings-icon-btn archive-btn" onclick="archiveCategory(${i})" title="アーカイブ（新しく書くときとホームに出さない。あとで戻せます）">📦</button>` : ''}
                ${categories.length > 1 ? `<button type="button" class="settings-icon-btn del-btn" onclick="deleteCategory(${i})" title="削除">🗑️</button>` : ''}
            </div>
        `;
        c.appendChild(r);
    });

    // アーカイブ済み（戻す）
    const arcBox = document.getElementById('settingsArchivedCategoryList');
    if (arcBox) {
        const archived = categories.map((cat, i) => ({ cat, i })).filter(x => x.cat.archivedAt);
        arcBox.innerHTML = archived.length ? `<div class="tag-set-head">📦 アーカイブ済み（${archived.length}）</div>` + archived.map(({ cat, i }) => {
            const d = new Date(cat.archivedAt);
            return `<div class="category-manage-item is-archived"><div class="category-manage-title-area"><span class="category-manage-name" title="${escapeHtml(cat.name)}">${escapeHtml(cat.name)}</span><span class="archived-meta">${escapeHtml(cat.type || '一般')}・${d.getFullYear()}/${d.getMonth() + 1}〜</span></div><div class="category-manage-actions"><button type="button" class="data-action-btn" onclick="unarchiveCategory(${i})" style="padding: 4px 10px; font-size: 12px;">戻す</button></div></div>`;
        }).join('') : '';
        arcBox.style.display = archived.length ? '' : 'none';
    }
    const orphanBox = document.getElementById('settingsOrphanCategoryList');
    if (orphanBox) {
        const orphans = findOrphanCategories();
        orphanBox.innerHTML = orphans.length ? `<div class="tag-set-head">⚠️ カテゴリのない記録（以前に削除したカテゴリ）</div>` + orphans.map(o => {
            const parts = []; if (o.usage.logs) parts.push(`記録${o.usage.logs}`); if (o.usage.notes) parts.push(`ノート${o.usage.notes}`);
            return `<div class="category-manage-item is-archived is-orphan"><div class="category-manage-title-area"><span class="category-manage-name">${escapeHtml(o.name)}</span><span class="archived-meta">${parts.join('・')}件</span></div><div class="category-manage-actions"><button type="button" class="data-action-btn" data-orphan="${escapeHtml(o.name)}" style="padding: 4px 10px; font-size: 12px;">片付ける</button></div></div>`;
        }).join('') : '';
        orphanBox.style.display = orphans.length ? '' : 'none';
    }

    setupCategorySortable();
}

// ------------------------------------------
// カテゴリのアーカイブ・戻す
// ------------------------------------------
function _afterCategoryArchiveChange() {
    saveCategories();
    renderSettingsCategoryList();
    renderSettingsTypeList();
    updateCategoryButtonUI();
    if (hideEmptyCards && calendarScope !== 'notebooks') adjustActiveDateToLatestLog();
    renderRightCards();
    if (sidebarMode === 'cal') updateSidebars();
}
function archiveCategory(i) {
    const cat = categories[i];
    if (!cat || cat.archivedAt) return;
    if (getActiveCategories().length <= 1) { alert("すべてのカテゴリをアーカイブすることはできません。"); return; }
    const name = cat.name;
    cat.archivedAt = new Date().toISOString();
    _afterCategoryArchiveChange();
    showActionUndoToast(`${name} をアーカイブしました`, () => { const c = categories.find(x => x.name === name); if (c) { delete c.archivedAt; _afterCategoryArchiveChange(); } });
}
function unarchiveCategory(i) {
    const cat = categories[i];
    if (!cat || !cat.archivedAt) return;
    if (getActiveCategories().length >= 30) { alert("使っているカテゴリが30件あるため戻せません。ほかのカテゴリをアーカイブしてから戻してください。"); return; }
    delete cat.archivedAt;
    _afterCategoryArchiveChange();
    showToast(`${cat.name} を戻しました`, 2500);
}
// 「元に戻す」付きのお知らせ（10秒）
function showActionUndoToast(text, onUndo, ms = 10000) {
    let box = document.getElementById('appToastBox');
    if (!box) { box = document.createElement('div'); box.id = 'appToastBox'; box.className = 'app-toast-box'; document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'app-toast draft-toast undo-toast';
    t.setAttribute('role', 'status');
    t.innerHTML = `<span class="draft-toast-text"></span><span class="draft-toast-actions"><button type="button" class="draft-toast-btn">元に戻す</button></span><span class="undo-toast-bar" style="animation-duration:${ms}ms"></span>`;
    t.querySelector('.draft-toast-text').textContent = text;
    t.onclick = null;
    const timer = setTimeout(() => t.remove(), ms);
    t.querySelector('button').onclick = (e) => { e.stopPropagation(); clearTimeout(timer); t.remove(); onUndo(); };
    box.appendChild(t);
}

function setupCategorySortable() {
    const el = document.getElementById('settingsCategoryList');
    if (!el || !window.Sortable) return;
    if (categorySortableInstance) categorySortableInstance.destroy();

    categorySortableInstance = new Sortable(el, {
        handle: '.drag-handle',
        animation: 180,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        onEnd: function(evt) {
            if (evt.oldIndex === evt.newIndex) return;
            // アーカイブ済みは一覧に出ていないので、表示中の並びで使っている分だけを並べ替え、アーカイブ済みは元の位置に残す
            const order = Array.from(el.querySelectorAll('.category-manage-item')).map(r => r.dataset.id);
            const byName = new Map(categories.map(c => [c.name, c]));
            let k = 0;
            categories = categories.map(c => c.archivedAt ? c : (byName.get(order[k++]) || c));
            saveCategories();
            renderSettingsCategoryList();
            updateCategoryButtonUI();
            renderRightCards();
            if (sidebarMode === 'cal') updateSidebars();
        }
    });
}

function startRenameCategory(i) {
    const cat = categories[i];
    if (!cat) return;
    const titleArea = document.getElementById(`catTitleArea_${i}`);
    const actionsArea = document.getElementById(`catActionsArea_${i}`);
    if (!titleArea || !actionsArea) return;

    titleArea.innerHTML = `
        <span class="drag-handle" style="opacity: 0.3; pointer-events: none;">⠿</span>
        <input type="text" class="category-manage-name-edit" id="catRenameInput_${i}" value="${escapeHtml(cat.name)}" onkeydown="if(event.key==='Enter'){ applyRenameCategory(${i}); }">
    `;
    actionsArea.innerHTML = `
        <button type="button" class="settings-icon-btn edit-btn" onclick="applyRenameCategory(${i})">✓ 保存</button>
        <button type="button" class="settings-icon-btn" onclick="renderSettingsCategoryList()">✕</button>
    `;
    const editInput = document.getElementById(`catRenameInput_${i}`);
    if (editInput) {
        editInput.focus();
        editInput.select();
    }
}

async function applyRenameCategory(i) {
    const cat = categories[i];
    if (!cat) return;
    const editInput = document.getElementById(`catRenameInput_${i}`);
    if (!editInput) return;
    const newName = editInput.value.trim();
    if (!newName) { alert("カテゴリ名を入力してください。"); return; }
    
    if (await renameCategory(cat.name, newName)) {
        renderSettingsCategoryList();
        renderSettingsTypeList();
        updateCategoryButtonUI();
        renderRightCards();
        if (sidebarMode === 'cal') updateSidebars();
    }
}

function updateCategoryType(i, t) { 
    if (!categories[i]) return; 
    categories[i].type = t; 
    saveCategories(); 
    renderSettingsTypeList();
    renderSettingsCategoryList();
    renderRightCards(); 
    if (sidebarMode === 'cal') updateSidebars(); 
}

function addNewCategory() {
    if (getActiveCategories().length >= 30) { alert("使っているカテゴリは最大30件までです。使わなくなったカテゴリはアーカイブできます。"); return; }
    const n = document.getElementById('newCatName').value.trim(); 
    const selEl = document.getElementById('newCatType');
    const t = selEl ? selEl.value : (appTypes[0] || "一般");
    if (!n) { alert("カテゴリ名を入力してください。"); return; }
    if (categories.some(c => c.name === n)) { alert(isCategoryArchived(n) ? "同じ名前のカテゴリがアーカイブ済みにあります。そちらを「戻す」で使えます。" : "同名が存在します。"); return; }
    categories.push({ name: n, type: t }); 
    saveCategories(); 
    document.getElementById('newCatName').value = "";
    renderSettingsCategoryList(); 
    renderSettingsTypeList();
}

// ------------------------------------------
// カテゴリの削除（記録・ノートの行き先を選ぶ）
// ------------------------------------------
// ※以前は、記録が残ったままカテゴリだけが消え、その記録は下のメニューから選べなくなっていた（迷子）。
//   記録やノートがあるときは、「アーカイブ」か「別のカテゴリへ移してから削除」を選んでもらう。
function countCategoryUsage(name) {
    let logs = 0;
    for (const d of Object.keys(journalData)) for (const l of (journalData[d] || [])) if ((l.category || 'ライフログ') === name) logs++;
    const notes = notebookData.filter(n => (n.category || 'ライフログ') === name).length;
    return { logs, notes };
}
// 記録・ノート・定型文・タグの範囲・前回のカテゴリを from から to へ付け替える
async function moveCategoryRecords(from, to) {
    let jChanged = false, nChanged = false;
    for (const d of Object.keys(journalData)) for (const l of (journalData[d] || [])) if ((l.category || 'ライフログ') === from) { l.category = to; jChanged = true; }
    notebookData.forEach(n => { if ((n.category || 'ライフログ') === from) { n.category = to; nChanged = true; } });
    if (typeof replaceMentionsInLogs === 'function' && replaceMentionsInLogs(from, to)) jChanged = true;
    retargetTemplateScopes('cat:' + from, 'cat:' + to);
    if (tagDefs.some(d => d.scope === 'cat:' + from)) { tagDefs.forEach(d => { if (d.scope === 'cat:' + from) d.scope = 'cat:' + to; }); saveTagDefs(); }
    if (typeof renameTemplateLastCategory === 'function') renameTemplateLastCategory(from, to);
    if (currentFilter.mode === 'category' && currentFilter.value === from) { currentFilter = { mode: 'category', value: to }; updateCategoryButtonUI(); }
    if (jChanged) await saveJournalData();
    if (nChanged) await saveNotebookData();
}
function _removeCategoryAt(i) {
    const t = categories[i]; if (!t) return;
    categories.splice(i, 1); saveCategories();
    // そのカテゴリだけのタグ・定型文は、タイプ全体のものにする（タグ・定型文自体は消さない）
    retargetTemplateScopes('cat:' + t.name, t.type || '一般');
    if (tagDefs.some(d => d.scope === 'cat:' + t.name)) { tagDefs.forEach(d => { if (d.scope === 'cat:' + t.name) d.scope = t.type || '一般'; }); saveTagDefs(); }
    if (currentFilter.mode === 'category' && currentFilter.value === t.name) { currentFilter = { mode: 'all', value: '' }; updateCategoryButtonUI(); }
    else if (currentFilter.mode === 'type' && !categories.some(c => (c.type || "一般") === currentFilter.value)) { currentFilter = { mode: 'all', value: '' }; updateCategoryButtonUI(); }
}
function _refreshAfterCategoryChange() {
    renderSettingsCategoryList();
    renderSettingsTypeList();
    updateCategoryButtonUI();
    renderRightCards(); if (sidebarMode === 'cal') updateSidebars();
}
function deleteCategory(i) {
    const t = categories[i]; if (!t) return;
    const u = countCategoryUsage(t.name);
    if (!u.logs && !u.notes) {
        if (!confirm(`「${t.name}」を削除しますか？\n（このカテゴリの記録・ノートはありません）`)) return;
        _removeCategoryAt(i);
        _refreshAfterCategoryChange();
        return;
    }
    openCategoryFateModal('delete', t.name, u);
}

// 削除のときと、迷子の記録を片付けるときの共通の画面
// mode: 'delete'（カテゴリを削除する） / 'orphan'（すでに削除されたカテゴリ名が記録に残っている）
let _fateState = null;
function _fateModalEl() {
    let ov = document.getElementById('categoryFateModal');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.id = 'categoryFateModal';
    ov.style.zIndex = '2550';
    ov.onclick = e => { if (e.target === ov) closeModal('categoryFateModal'); };
    ov.innerHTML = `
        <div class="modal-content fate-content">
            <div class="modal-header"><span id="fateTitle"></span></div>
            <div class="fate-desc" id="fateDesc"></div>
            <div class="fate-options" id="fateOptions"></div>
            <div class="fate-dest" id="fateTypeBox">
                <label class="tpl-edit-label" for="fateType">戻すタイプ</label>
                <select class="settings-select" id="fateType"></select>
            </div>
            <div class="fate-dest" id="fateDestBox">
                <label class="tpl-edit-label" for="fateDest">移す先のカテゴリ</label>
                <select class="settings-select" id="fateDest"></select>
            </div>
            <div class="modal-actions">
                <button class="modal-btn cancel" onclick="closeModal('categoryFateModal')">キャンセル</button>
                <button class="modal-btn submit" id="fateRunBtn" onclick="runCategoryFate()">実行</button>
            </div>
        </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', e => {
        const opt = e.target.closest ? e.target.closest('[data-fate]') : null;
        if (opt) { _fateState.choice = opt.dataset.fate; _renderFateChoice(); }
    });
    return ov;
}
function openCategoryFateModal(mode, name, usage) {
    _fateModalEl();
    const others = getActiveCategories().filter(c => c.name !== name);
    _fateState = { mode, name, usage, choice: mode === 'delete' ? 'archive' : 'restore' };
    const parts = [];
    if (usage.logs) parts.push(`記録 ${usage.logs}件`);
    if (usage.notes) parts.push(`ノート ${usage.notes}件`);
    document.getElementById('fateTitle').textContent = mode === 'delete' ? `「${name}」を削除` : `カテゴリのない記録：「${name}」`;
    document.getElementById('fateDesc').textContent = mode === 'delete'
        ? `このカテゴリには ${parts.join('・')} があります。記録が迷子にならないよう、どうするか選んでください。`
        : `「${name}」はカテゴリ一覧にありませんが、${parts.join('・')} がこのカテゴリのまま残っています（以前に削除したカテゴリです）。`;
    const opts = mode === 'delete'
        ? [['archive', '📦 アーカイブする（おすすめ）', '記録・ノートはそのまま。新しく書くときとホームには出さず、あとで戻せます。'],
           ['move', '➡️ 別のカテゴリへ移してから削除', '記録・ノート（と、このカテゴリだけのタグ・定型文）を選んだカテゴリへ移し、このカテゴリを消します。']]
        : [['restore', '↩️ カテゴリとして戻す', 'この名前のカテゴリを作り直します（アーカイブした状態で戻すので、必要なら設定で「戻す」を押してください）。'],
           ['move', '➡️ 別のカテゴリへ移す', '記録・ノートを選んだカテゴリへ移します。']];
    document.getElementById('fateOptions').innerHTML = opts.map(([k, t, d]) => `<button type="button" class="fate-option" data-fate="${k}"><span class="fate-option-title">${t}</span><span class="fate-option-desc">${d}</span></button>`).join('');
    document.getElementById('fateType').innerHTML = appTypes.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    const sel = document.getElementById('fateDest');
    sel.innerHTML = appTypes.map(ty => { const cs = others.filter(c => (c.type || '一般') === ty); return cs.length ? `<optgroup label="${escapeHtml(ty)}">${cs.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('')}</optgroup>` : ''; }).join('');
    // 同じタイプのカテゴリを初期値にする
    const ty = categories.find(c => c.name === name);
    const same = others.find(c => ty && c.type === ty.type);
    if (same) sel.value = same.name;
    _renderFateChoice();
    openModal('categoryFateModal');
}
function _renderFateChoice() {
    const s = _fateState;
    document.querySelectorAll('#fateOptions .fate-option').forEach(b => b.classList.toggle('selected', b.dataset.fate === s.choice));
    const hasDest = !!document.getElementById('fateDest').options.length;
    document.getElementById('fateDestBox').style.display = s.choice === 'move' ? '' : 'none';
    document.getElementById('fateTypeBox').style.display = s.choice === 'restore' ? '' : 'none';
    const btn = document.getElementById('fateRunBtn');
    btn.textContent = s.choice === 'archive' ? 'アーカイブする' : s.choice === 'restore' ? '戻す' : (s.mode === 'delete' ? '移して削除' : '移す');
    btn.classList.toggle('danger-run', s.choice === 'move' && s.mode === 'delete');
    btn.disabled = s.choice === 'move' && !hasDest;
}
async function runCategoryFate() {
    const s = _fateState; if (!s) return;
    const i = categories.findIndex(c => c.name === s.name);
    if (s.choice === 'archive') {
        closeModal('categoryFateModal');
        if (i !== -1) archiveCategory(i);
        return;
    }
    if (s.choice === 'restore') {
        const type = document.getElementById('fateType').value || appTypes[0];
        if (!categories.some(c => c.name === s.name)) categories.push({ name: s.name, type, archivedAt: new Date().toISOString() });
        saveCategories();
        closeModal('categoryFateModal');
        _refreshAfterCategoryChange();
        showToast(`「${s.name}」をカテゴリとして戻しました（アーカイブ済みの一覧にあります）`, 5000);
        return;
    }
    const to = document.getElementById('fateDest').value;
    if (!to) return;
    const total = s.usage.logs + s.usage.notes;
    if (!confirm(`「${s.name}」の ${total}件を「${to}」へ移${s.mode === 'delete' ? 'し、「' + s.name + '」を削除' : ''}します。よろしいですか？`)) return;
    await moveCategoryRecords(s.name, to);
    if (s.mode === 'delete') { const j = categories.findIndex(c => c.name === s.name); if (j !== -1) _removeCategoryAt(j); }
    closeModal('categoryFateModal');
    _refreshAfterCategoryChange();
    showToast(`${total}件を「${to}」へ移しました${s.mode === 'delete' ? `。「${s.name}」は削除しました` : ''}`, 5000);
}

// 以前に削除したカテゴリ名のまま残っている記録・ノート（迷子）を探す
function findOrphanCategories() {
    const known = new Set(categories.map(c => c.name));
    const m = new Map();
    const add = (name, k) => { if (!name || known.has(name)) return; const u = m.get(name) || { logs: 0, notes: 0 }; u[k]++; m.set(name, u); };
    for (const d of Object.keys(journalData)) for (const l of (journalData[d] || [])) add(l.category || 'ライフログ', 'logs');
    notebookData.forEach(n => add(n.category || 'ライフログ', 'notes'));
    return [...m.entries()].map(([name, usage]) => ({ name, usage }));
}

function openSearchModal() {
    const input = document.getElementById('searchInput');
    if (input) input.value = "";
    const clearBtn = document.getElementById('searchClearBtn');
    if (clearBtn) clearBtn.classList.remove('active');
    
    globalSearchTab = 'all';
    globalSearchOperator = 'AND';
    resetSearchRefine();
    updateSearchFilterTabsUI();
    updateSearchOperatorUI();
    renderGlobalSearchResults("");

    openModal('searchModal');
    setTimeout(() => {
        if (input) input.focus();
    }, 200);
}

function setSearchFilterTab(tab) {
    globalSearchTab = tab;
    updateSearchFilterTabsUI();
    const input = document.getElementById('searchInput');
    renderGlobalSearchResults(input ? input.value : "");
}

function setSearchOperator(op) {
    globalSearchOperator = op;
    updateSearchOperatorUI();
    const input = document.getElementById('searchInput');
    renderGlobalSearchResults(input ? input.value : "");
}

function updateSearchOperatorUI() {
    const andBtn = document.getElementById('searchOpBtn_and');
    const orBtn = document.getElementById('searchOpBtn_or');
    if (andBtn) andBtn.classList.toggle('active', globalSearchOperator === 'AND');
    if (orBtn) orBtn.classList.toggle('active', globalSearchOperator === 'OR');
}

function updateSearchFilterTabsUI() {
    ['all', 'journals', 'notebooks'].forEach(t => {
        const btn = document.getElementById(`searchTab_${t}`);
        if (btn) btn.classList.toggle('active', globalSearchTab === t);
    });
}

function clearGlobalSearchInput() {
    const input = document.getElementById('searchInput');
    const clearBtn = document.getElementById('searchClearBtn');
    if (input) {
        input.value = "";
        input.focus();
    }
    if (clearBtn) clearBtn.classList.remove('active');
    renderGlobalSearchResults("");
}

function handleGlobalSearchInput() {
    const input = document.getElementById('searchInput');
    const clearBtn = document.getElementById('searchClearBtn');
    const query = input ? input.value : "";
    if (clearBtn) clearBtn.classList.toggle('active', !!query.trim());
    renderGlobalSearchResults(query);
}

function parseSearchQuery(query) {
    if (!query) return { tokens: [], operator: globalSearchOperator };

    let raw = query.trim();
    let op = globalSearchOperator;

    if (/\s+OR\s+/i.test(raw)) {
        op = 'OR';
        raw = raw.replace(/\s+OR\s+/gi, ' ');
    }

    const tokens = raw.split(/[\s ]+/).map(t => t.toLowerCase().trim()).filter(t => t.length > 0);
    return { tokens, operator: op };
}

function matchesSearchTokens(targetText, tokens, operator) {
    if (!tokens || tokens.length === 0) return true;
    const text = (targetText || '').toLowerCase();

    if (operator === 'OR') {
        return tokens.some(tok => text.includes(tok));
    } else {
        return tokens.every(tok => text.includes(tok));
    }
}

function renderGlobalSearchResults(query) {
    const container = document.getElementById('searchResultsContainer');
    const countTotalBadge = document.getElementById('searchTotalCountBadge');
    const countAllBadge = document.getElementById('searchTabCount_all');
    const countJournalsBadge = document.getElementById('searchTabCount_journals');
    const countNotebooksBadge = document.getElementById('searchTabCount_notebooks');

    if (!container) return;
    const { tokens, operator } = parseSearchQuery(query);

    const rf = _searchRefineState();
    if (tokens.length === 0 && !rf.any) {
        container.innerHTML = `
            <div style="text-align: center; color: var(--text-secondary); font-size: 13.5px; padding: 40px 10px;">
                キーワードを入力して検索を開始してください<br><span style="font-size: 12px; opacity: 0.8;">写真あり・しおり・期間だけで探すこともできます</span>
            </div>
        `;
        if (countTotalBadge) countTotalBadge.textContent = "0件";
        if (countAllBadge) countAllBadge.textContent = "0";
        if (countJournalsBadge) countJournalsBadge.textContent = "0";
        if (countNotebooksBadge) countNotebooksBadge.textContent = "0";
        return;
    }

    const journalMatches = [];
    Object.keys(journalData).sort().reverse().forEach(d => {
        if (!rf.dateOk(d)) return;
        (journalData[d] || []).forEach((l, idx) => {
            const nImg = Array.isArray(l.images) ? l.images.length : (l.image ? 1 : 0);
            if (rf.photo && !nImg) return;
            if (rf.pin && !l.pinned) return;
            const sT = l.slackType || (l.isSlack ? 'incoming' : null);
            const textContent = `${l.text || ''} ${l.category || ''} ${getLogCategoryType(l.category || '')} ${sT === 'incoming' ? '受信 slack 相手' : sT === 'outgoing' ? '送信 slack 自分' : ''} ${(l.tags || []).map(t => '#' + t).join(' ')}`;

            if (matchesSearchTokens(textContent, tokens, operator)) {
                journalMatches.push({
                    type: 'journal',
                    date: d,
                    time: l.time,
                    text: l.text,
                    category: l.category || 'ライフログ',
                    slackType: sT,
                    index: l.id,
                    photos: nImg,
                    pinned: !!l.pinned,
                    tags: l.tags || []
                });
            }
        });
    });

    const notebookMatches = [];
    notebookData.filter(n => n.status !== 'trash').forEach(n => {
        if (rf.pin) return; // しおりは記録だけの機能
        if (rf.photo && !/<img\b/i.test(n.content || '')) return;
        if (!rf.dateOk(String(n.updatedAt || n.createdAt || '').slice(0, 10))) return;
        const plainContent = stripHtml(n.content || '');
        const textContent = `${n.title || ''} ${plainContent} ${n.category || ''} ${n.status || ''}`;

        if (matchesSearchTokens(textContent, tokens, operator)) {
            notebookMatches.push({
                type: 'notebook',
                id: n.id,
                title: n.title || '無題のノート',
                content: plainContent,
                category: n.category || 'ライフログ',
                status: n.status || 'archive',
                updatedAt: n.updatedAt || n.createdAt || ''
            });
        }
    });

    const totalCount = journalMatches.length + notebookMatches.length;
    if (countTotalBadge) countTotalBadge.textContent = `${totalCount}件`;
    if (countAllBadge) countAllBadge.textContent = String(totalCount);
    if (countJournalsBadge) countJournalsBadge.textContent = String(journalMatches.length);
    if (countNotebooksBadge) countNotebooksBadge.textContent = String(notebookMatches.length);

    let displayedItems = [];
    if (globalSearchTab === 'all') {
        displayedItems = [...journalMatches, ...notebookMatches];
        displayedItems.sort((a, b) => {
            const dateA = a.type === 'journal' ? `${a.date} ${a.time || ''}` : (a.updatedAt || '');
            const dateB = b.type === 'journal' ? `${b.date} ${b.time || ''}` : (b.updatedAt || '');
            return dateB.localeCompare(dateA);
        });
    } else if (globalSearchTab === 'journals') {
        displayedItems = journalMatches;
    } else if (globalSearchTab === 'notebooks') {
        displayedItems = notebookMatches;
    }

    if (displayedItems.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="padding: 36px 10px;">
                <span style="font-size: 28px;">🔍</span>
                <span style="font-size: 14.5px; font-weight: 700; margin-top: 6px;">一致する結果は見つかりませんでした</span>
                <span style="font-size: 12px; color: var(--text-secondary);">${rf.any ? '絞り込み（' + rf.label + '）を外すと見つかるかもしれません' : `「${operator}」条件で検索しています。キーワードを変更するか、OR検索をお試しください`}</span>
            </div>
        `;
        return;
    }

    let html = "";
    const SEARCH_MAX = 300; // 一度に並べる件数の上限（大量の結果で重くならないように）
    const more = displayedItems.length - SEARCH_MAX;
    if (more > 0) displayedItems = displayedItems.slice(0, SEARCH_MAX);
    displayedItems.forEach(item => {
        if (item.type === 'journal') {
            const catClass = getCategoryTypeClass(item.category);
            let sBadge = "";
            if (item.slackType === 'incoming') sBadge = `<span class="slack-direction-badge incoming" style="font-size:10px;padding:1px 6px;">📥 相手</span>`;
            else if (item.slackType === 'outgoing') sBadge = `<span class="slack-direction-badge outgoing" style="font-size:10px;padding:1px 6px;">📤 自分</span>`;

            html += `
                <div class="search-result-item" onclick="jumpFromGlobalSearchToDay('${item.date}', '${item.index}')">
                    <div class="search-result-header">
                        <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                            <span class="search-type-pill journal">JOURNAL</span>
                            <span style="white-space:nowrap;">📅 ${item.date} (${item.time})</span>
                        </div>
                        <div style="display:flex; align-items:center; gap:4px; flex-wrap:wrap; justify-content:flex-end; min-width:0;">
                            ${item.pinned ? '<span class="search-mini-mark pin" title="しおり">🔖</span>' : ''}${item.photos ? `<span class="search-mini-mark" title="写真">📷${item.photos > 1 ? item.photos : ''}</span>` : ''}
                            ${sBadge}
                            <span class="log-category-badge ${catClass}" style="font-size:10px;padding:1px 6px;">${escapeHtml(item.category)}</span>
                        </div>
                    </div>
                    <div class="search-result-text">${escapeHtml(item.text)}</div>
                    ${item.tags && item.tags.length ? `<div class="search-result-tags">${item.tags.map(t => '#' + escapeHtml(t)).join('　')}</div>` : ''}
                </div>
            `;
        } else if (item.type === 'notebook') {
            const catClass = getCategoryTypeClass(item.category);
            const statusMap = {
                active: 'Active',
                permanent: 'Permanent',
                archive: 'Archive'
            };
            const statusLabel = statusMap[item.status] || 'Archive';

            html += `
                <div class="search-result-item notebook-res" onclick="jumpFromGlobalSearchToNotebook('${item.id}')">
                    <div class="search-result-header notebook-res">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <span class="search-type-pill notebook">NOTEBOOK</span>
                            <span class="nb-status-pill status-${item.status}" style="font-size:9.5px;padding:1px 6px;">${statusLabel}</span>
                        </div>
                        <span class="log-category-badge ${catClass}" style="font-size:10px;padding:1px 6px;">${escapeHtml(item.category)}</span>
                    </div>
                    <div class="search-result-title">📔 ${escapeHtml(item.title)}</div>
                    <div class="search-result-text">${escapeHtml(item.content ? item.content : '(本文なし)')}</div>
                </div>
            `;
        }
    });

    if (more > 0) html += `<div class="search-more-note">ほかに ${more} 件あります。キーワードや期間で絞り込んでください</div>`;
    container.innerHTML = html;
}

// ---- 検索の絞り込み（写真あり・しおり・期間） ----
let searchRefine = { photo: false, pin: false, period: 'all', from: '', to: '' };
function resetSearchRefine() {
    searchRefine = { photo: false, pin: false, period: 'all', from: '', to: '' };
    const sel = document.getElementById('searchRefinePeriod'); if (sel) sel.value = 'all';
    const f = document.getElementById('searchRangeFrom'), t = document.getElementById('searchRangeTo');
    if (f) f.value = ''; if (t) t.value = '';
    updateSearchRefineUI();
}
function _searchRefineState() {
    const r = searchRefine;
    let from = '', to = '', plabel = '';
    if (r.period === 'custom') { from = r.from || ''; to = r.to || ''; if (from && to && from > to) [from, to] = [to, from]; plabel = (from || to) ? `${from ? from.slice(5).replace('-', '/') : ''}〜${to ? to.slice(5).replace('-', '/') : ''}` : ''; }
    else if (r.period !== 'all') {
        const d = new Date(); d.setDate(d.getDate() - (parseInt(r.period, 10) - 1));
        from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        plabel = { '7': '1週間', '30': '1か月', '90': '3か月', '365': '1年' }[r.period] || '';
    }
    const parts = [];
    if (r.photo) parts.push('写真あり'); if (r.pin) parts.push('しおり'); if (plabel) parts.push(plabel);
    return {
        photo: r.photo, pin: r.pin, any: parts.length > 0, label: parts.join('・'),
        dateOk: (dk) => (!from || !dk || dk >= from) && (!to || !dk || dk <= to)
    };
}
function updateSearchRefineUI() {
    const r = searchRefine;
    const ph = document.getElementById('searchRefine_photo'), pn = document.getElementById('searchRefine_pin');
    if (ph) { ph.classList.toggle('active', r.photo); ph.setAttribute('aria-pressed', r.photo ? 'true' : 'false'); }
    if (pn) { pn.classList.toggle('active', r.pin); pn.setAttribute('aria-pressed', r.pin ? 'true' : 'false'); }
    const wrap = document.getElementById('searchRefine_periodWrap'), lab = document.getElementById('searchRefinePeriodLabel');
    const names = { all: '期間', '7': '1週間', '30': '1か月', '90': '3か月', '365': '1年', custom: '指定' };
    if (lab) lab.textContent = names[r.period] || '期間';
    if (wrap) wrap.classList.toggle('active', r.period !== 'all');
    const row = document.getElementById('searchRangeRow'); if (row) row.style.display = r.period === 'custom' ? '' : 'none';
}
function _rerenderSearch() { const i = document.getElementById('searchInput'); renderGlobalSearchResults(i ? i.value : ''); }
function toggleSearchRefine(k) { searchRefine[k] = !searchRefine[k]; updateSearchRefineUI(); _rerenderSearch(); }
function changeSearchPeriod(v) {
    searchRefine.period = v;
    if (v === 'custom' && !searchRefine.from && !searchRefine.to) {
        const t = document.getElementById('searchRangeTo'); if (t) { t.value = getTodayKey(); searchRefine.to = t.value; }
    }
    updateSearchRefineUI(); _rerenderSearch();
}
function changeSearchRange() {
    searchRefine.from = document.getElementById('searchRangeFrom').value || '';
    searchRefine.to = document.getElementById('searchRangeTo').value || '';
    _rerenderSearch();
}

function jumpFromGlobalSearchToDay(dateStr, targetLogIndex = null) {
    showPinnedList = false; showTagView = null;
    closeModal('searchModal');
    if (journalSearchQuery) clearJournalSearch();

    triggerSmoothViewSwitch(() => {
        if (calendarScope !== 'day' && calendarScope !== 'photo') calendarScope = 'day';
        activeDateKey = dateStr;
        lastJournalDateKey = dateStr;
        const p = dateStr.split('-');
        miniCalYear = parseInt(p[0], 10);
        miniCalMonth = parseInt(p[1], 10) - 1;

        if (!dateList.includes(dateStr)) {
            dateList.push(dateStr);
            dateList.sort();
        }

        updateScopeButtonsUI();
        updateJumpButtonLabel();
        if (sidebarMode === 'cal') updateSidebars();
        renderRightCards();

        if (targetLogIndex !== null && calendarScope === 'day') {
            setTimeout(() => {
                const targetEl = document.getElementById(`logItem_${dateStr}_${targetLogIndex}`);
                if (targetEl) {
                    const scrollWrapper = targetEl.closest('.logs-container-wrapper');
                    if (scrollWrapper) {
                        const wRect = scrollWrapper.getBoundingClientRect();
                        const tRect = targetEl.getBoundingClientRect();
                        const targetScroll = Math.max(0, tRect.top - wRect.top + scrollWrapper.scrollTop - 24);
                        scrollWrapper.scrollTo({ top: targetScroll, behavior: 'smooth' });
                    }
                    targetEl.classList.remove('highlight-target-pulse');
                    void targetEl.offsetWidth;
                    targetEl.classList.add('highlight-target-pulse');
                }
            }, 160);
        }
    });
}

function jumpFromGlobalSearchToNotebook(noteId) {
    closeModal('searchModal');
    if (journalSearchQuery) clearJournalSearch();

    if (calendarScope !== 'notebooks') {
        calendarScope = 'notebooks';
        updateScopeButtonsUI();
        updateJumpButtonLabel();
        if (sidebarMode === 'cal') updateSidebars();
    }
    openNotebookLinked(noteId);
}

function generateDayHtmlDocument(dStr, logs) {
    const p = dStr.split('-'); const d = new Date(p[0], p[1]-1, p[2]);
    const fd = `${parseInt(p[0], 10)}年${parseInt(p[1], 10)}月${parseInt(p[2], 10)}日 (${['日','月','火','水','木','金','土'][d.getDay()]})`;
    let h = "";
    logs.forEach(l => {
        const imgs = Array.isArray(l.images) ? l.images : (l.image ? [l.image] : []);
        let ih = imgs.length > 0 ? `<div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:8px;">` + imgs.map(i => `<img src="${i}" style="width:80px; height:80px; object-fit:cover; border-radius:10px; border:1px solid rgba(128,128,128,0.2);">`).join('') + `</div>` : "";
        const sT = l.slackType || (l.isSlack ? 'incoming' : null); let cH = "";
        if (sT === 'incoming') cH = `<div style="background: rgba(175, 82, 222, 0.06); border-radius: 12px; padding: 12px 14px; margin-top: 4px;"><div style="font-size: 11px; font-weight: 700; color: #af52de; margin-bottom: 4px;">💬 ${escapeHtml(l.category || 'ライフログ')} からのメッセージ</div><div style="font-size: 15px; line-height: 1.6; white-space: pre-wrap; word-break: break-all;">${parseLinksAndText(l.text)}</div></div>`;
        else if (sT === 'outgoing') cH = `<div style="background: rgba(41, 151, 255, 0.06); border-radius: 12px; padding: 12px 14px; margin-top: 4px;"><div style="font-size: 11px; font-weight: 700; color: #2997ff; margin-bottom: 4px;">💬 あなた → ${escapeHtml(l.category || 'ライフログ')} への送信</div><div style="font-size: 15px; line-height: 1.6; white-space: pre-wrap; word-break: break-all;">${parseLinksAndText(l.text)}</div></div>`;
        else cH = `<div class="content">${parseLinksAndText(l.text)}</div>`;
        h += `<div class="log-item"><div style="display:flex; gap:6px; align-items:center;"><span class="time">${l.time}</span><span class="cat">${escapeHtml(l.category || 'ライフログ')}</span>${l.backdated ? '<span class="cat" style="background:none;opacity:.7;">✎ 後日記入</span>' : ''}${l.pinned ? '<span class="cat" style="background:none;">🔖</span>' : ''}</div>${cH}${ih}${(l.tags && l.tags.length) ? `<div style="font-size:12px;color:var(--text-secondary);">${l.tags.map(t => '#' + escapeHtml(t)).join('　')}</div>` : ''}</div>`;
    });
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${fd} - Daily Journal</title><style>:root { color-scheme: light dark; --bg: #08080a; --card-bg: #121215; --item-bg: #1a1a1f; --border: rgba(255, 255, 255, 0.08); --text-primary: #ffffff; --text-secondary: #98989f; --accent: #2997ff; --accent-soft: rgba(41, 151, 255, 0.15); } @media (prefers-color-scheme: light) { :root { --bg: #f2f2f7; --card-bg: #ffffff; --item-bg: #f8f8fa; --border: rgba(0, 0, 0, 0.08); --text-primary: #1c1c1e; --text-secondary: #8e8e93; --accent: #007aff; --accent-soft: rgba(0, 122, 255, 0.12); } } * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; } body { background-color: var(--bg); color: var(--text-primary); padding: 30px 16px; display: flex; justify-content: center; } .container { width: 100%; max-width: 640px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 24px; padding: 28px; } header { margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 16px; } .eyebrow { font-size: 13px; font-weight: 700; color: var(--accent); letter-spacing: 0.5px; } h1 { font-size: 24px; font-weight: 700; margin-top: 4px; } .log-list { display: flex; flex-direction: column; gap: 14px; } .log-item { background: var(--item-bg); border: 1px solid var(--border); border-radius: 16px; padding: 16px 18px; display: flex; flex-direction: column; gap: 8px; } .time { font-size: 12px; font-weight: 700; color: var(--accent); background: var(--accent-soft); padding: 2px 8px; border-radius: 8px; } .cat { font-size: 11px; font-weight: 700; background: rgba(128,128,128,0.2); padding: 2px 8px; border-radius: 8px; } .content { font-size: 16px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; } .journal-link { color: var(--accent); text-decoration: none; font-weight: 600; padding: 1px 6px; margin: 0 2px; background: var(--accent-soft); border-radius: 6px; display: inline-flex; align-items: center; gap: 3px; word-break: break-all; }</style></head><body><div class="container"><header><div class="eyebrow">${dStr}</div><h1>${fd}</h1></header><div class="log-list">${h}</div></div></body></html>`;
}

async function exportArchiveHtml() {
    const journalDates = Object.keys(journalData).filter(d => Array.isArray(journalData[d]) && journalData[d].length > 0).sort().reverse();
    const validNotebooks = notebookData.filter(n => n.status !== 'trash');

    if (!journalDates.length && !validNotebooks.length) {
        alert("アーカイブ出力するデータ（Journals / Notebooks）がありません。");
        return;
    }

    closeModal('settingsModal');

    const now = new Date();
    const createdDateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const fileDateSuffix = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;

    const exportJournal = await getJournalDataForExport();
    const rawPayload = JSON.stringify({
        journalData: exportJournal,
        notebookData: validNotebooks,
        categories: categories,
        appTypes: appTypes
    }).replace(/<\/script>/gi, '<\\/script>');

    const archiveHtml = `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>Daily Journal Archive (${fileDateSuffix})</title>
    <style>
        :root {
            color-scheme: light dark;
            --bg-color: #08080a;
            --card-bg: #121215;
            --card-border: rgba(255, 255, 255, 0.08);
            --item-bg: #1a1a1f;
            --item-border: rgba(255, 255, 255, 0.06);
            --text-primary: #ffffff;
            --text-secondary: #98989f;
            --accent-color: #2997ff;
            --accent-soft: rgba(41, 151, 255, 0.15);
            --notebook-color: #30d158;
            --notebook-soft: rgba(48, 209, 88, 0.15);
        }
        @media (prefers-color-scheme: light) {
            :root {
                --bg-color: #f2f2f7;
                --card-bg: #ffffff;
                --card-border: rgba(0, 0, 0, 0.08);
                --item-bg: #f8f8fa;
                --item-border: rgba(0, 0, 0, 0.06);
                --text-primary: #1c1c1e;
                --text-secondary: #8e8e93;
                --accent-color: #007aff;
                --accent-soft: rgba(0, 122, 255, 0.12);
                --notebook-color: #34c759;
                --notebook-soft: rgba(52, 199, 89, 0.15);
            }
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif; }
        body { background: var(--bg-color); color: var(--text-primary); padding: 16px 12px 36px; display: flex; flex-direction: column; align-items: center; min-height: 100vh; overflow-x: hidden; }
        .archive-wrapper { width: 100%; max-width: 780px; display: flex; flex-direction: column; gap: 14px; flex: 1; }
        
        header { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 20px; padding: 16px 20px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
        .archive-title { font-size: 19px; font-weight: 800; }
        .archive-date { font-size: 11.5px; color: var(--text-secondary); margin-top: 2px; }
        
        .header-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .nav-segmented { display: inline-flex; background: var(--item-bg); border: 1px solid var(--item-border); border-radius: 12px; padding: 3px; gap: 3px; }
        .nav-seg-btn { background: transparent; border: none; color: var(--text-secondary); font-size: 12.5px; font-weight: 700; padding: 6px 13px; border-radius: 9px; cursor: pointer; transition: all 0.15s; }
        .nav-seg-btn.active { background: var(--accent-color); color: #fff; }
        .nav-seg-btn.notebook.active { background: var(--notebook-color); color: #fff; }

        .search-bar { width: 100%; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 14px; padding: 9px 14px; color: var(--text-primary); font-size: 13.5px; outline: none; }
        
        .archive-section { display: flex; flex-direction: column; gap: 14px; width: 100%; }

        .day-group { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 20px; padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; }
        .day-header { font-size: 16.5px; font-weight: 800; color: var(--accent-color); border-bottom: 1px solid var(--card-border); padding-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
        .log-item { background: var(--item-bg); border: 1px solid var(--item-border); border-radius: 14px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
        .log-meta { display: flex; gap: 6px; align-items: center; }
        .log-time { font-size: 11px; font-weight: 700; color: var(--accent-color); background: var(--accent-soft); padding: 2px 7px; border-radius: 6px; }
        .log-cat { font-size: 11px; font-weight: 700; background: rgba(128,128,128,0.18); padding: 2px 7px; border-radius: 6px; }
        .log-body { font-size: 14.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
        .log-bubble { border-radius: 12px; padding: 10px 12px; margin-top: 2px; }
        .log-bubble.incoming { background: rgba(175,82,222,0.1); border: 1px solid rgba(175,82,222,0.2); }
        .log-bubble.outgoing { background: var(--accent-soft); border: 1px solid rgba(41,151,255,0.2); }
        .bubble-header { font-size: 11px; font-weight: 700; margin-bottom: 3px; color: var(--accent-color); }
        .log-bubble.incoming .bubble-header { color: #af52de; }
        .photo-grid { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
        .photo-thumb { width: 75px; height: 75px; object-fit: cover; border-radius: 8px; cursor: pointer; }
        .notebook-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 18px; padding: 18px 20px; display: flex; flex-direction: column; gap: 10px; }
        .nb-title { font-size: 18px; font-weight: 800; color: var(--text-primary); }
        .nb-content { font-size: 14.5px; line-height: 1.65; word-break: break-word; }
        .nb-content h1 { font-size: 1.4em; margin: 0.6em 0 0.3em; font-weight: 800; }
        .nb-content h2 { font-size: 1.25em; margin: 0.5em 0 0.25em; font-weight: 750; }
        .nb-content h3 { font-size: 1.1em; margin: 0.4em 0 0.2em; font-weight: 700; }
        .nb-content ul, .nb-content ol { margin: 6px 0 6px 20px; }
        .nb-embedded-img { max-width: 100%; border-radius: 10px; margin: 6px 0; display: block; }
        .empty-msg { text-align: center; padding: 40px; color: var(--text-secondary); font-size: 14px; }

        .card-carousel-view { width: 100%; display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; }
        .carousel-nav-bar { display: flex; justify-content: space-between; align-items: center; padding: 0 4px; }
        .carousel-btn { background: var(--card-bg); border: 1px solid var(--card-border); color: var(--text-primary); padding: 6px 14px; border-radius: 10px; font-size: 12px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
        .carousel-btn:hover { background: var(--item-bg); }
        .carousel-indicator { font-size: 12px; font-weight: 700; color: var(--text-secondary); }
        
        .carousel-viewport {
            width: 100%;
            height: calc(100vh - 190px);
            min-height: 480px;
            display: flex;
            overflow-x: auto;
            scroll-snap-type: x mandatory;
            -webkit-overflow-scrolling: touch;
            scrollbar-width: none;
            gap: 14px;
            padding: 2px 2px 10px;
        }
        .carousel-viewport::-webkit-scrollbar { display: none; }
        
        .carousel-slide {
            min-width: 100%;
            width: 100%;
            height: 100%;
            scroll-snap-align: start;
            scroll-snap-stop: always;
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 24px;
            padding: 22px 24px;
            display: flex;
            flex-direction: column;
            box-shadow: 0 16px 36px rgba(0,0,0,0.18);
            overflow-y: auto;
        }
        .carousel-slide-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--card-border);
            padding-bottom: 12px;
            margin-bottom: 14px;
            flex-shrink: 0;
        }
        .carousel-slide-title { font-size: 21px; font-weight: 800; color: var(--text-primary); }
        .carousel-slide-body { display: flex; flex-direction: column; gap: 12px; flex: 1; }
    </style>
</head>
<body>
    <div class="archive-wrapper">
        <header>
            <div>
                <div class="archive-title">📔 Daily Journal Archive</div>
                <div class="archive-date">作成: ${createdDateStr}</div>
            </div>
            <div class="header-controls">
                <div class="nav-segmented">
                    <button type="button" class="nav-seg-btn active" id="btnTabJournals" onclick="switchArchiveTab('journals')">Journals (${journalDates.length})</button>
                    <button type="button" class="nav-seg-btn notebook" id="btnTabNotebooks" onclick="switchArchiveTab('notebooks')">Notebooks (${validNotebooks.length})</button>
                </div>
                <div class="nav-segmented">
                    <button type="button" class="nav-seg-btn active" id="btnViewList" onclick="switchViewMode('list')">📄 リスト</button>
                    <button type="button" class="nav-seg-btn" id="btnViewCard" onclick="switchViewMode('card')">🃏 カード</button>
                </div>
            </div>
        </header>

        <input type="text" class="search-bar" id="archiveSearch" placeholder="キーワードで絞り込む..." oninput="handleArchiveSearch()">

        <div class="archive-section" id="journalsSection"></div>
        <div class="archive-section" id="notebooksSection" style="display: none;"></div>
    </div>

    <script>
        const APP_DATA = ${rawPayload};
        let currentTab = 'journals';
        let currentView = 'list';
        let searchQuery = '';
        let currentCardIndex = 0;

        function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
        function parseUrl(t) { return escapeHtml(t).replace(/(https?:\\\/\\\/[^\\s]+)/g, '<a href="$1" target="_blank" style="color:var(--accent-color);font-weight:600;">🔗 $1</a>'); }

        function switchArchiveTab(t) {
            currentTab = t;
            document.getElementById('btnTabJournals').classList.toggle('active', t === 'journals');
            document.getElementById('btnTabNotebooks').classList.toggle('active', t === 'notebooks');
            document.getElementById('journalsSection').style.display = (t === 'journals') ? 'flex' : 'none';
            document.getElementById('notebooksSection').style.display = (t === 'notebooks') ? 'flex' : 'none';
            currentCardIndex = 0;
            renderArchiveContent();
        }

        function switchViewMode(v) {
            currentView = v;
            document.getElementById('btnViewList').classList.toggle('active', v === 'list');
            document.getElementById('btnViewCard').classList.toggle('active', v === 'card');
            currentCardIndex = 0;
            renderArchiveContent();
        }

        function handleArchiveSearch() {
            searchQuery = document.getElementById('archiveSearch').value.trim().toLowerCase();
            currentCardIndex = 0;
            renderArchiveContent();
        }

        function renderArchiveContent() {
            if (currentTab === 'journals') renderJournals();
            else renderNotebooks();
        }

        function renderJournals() {
            const container = document.getElementById('journalsSection');
            const dates = Object.keys(APP_DATA.journalData || {}).sort().reverse();
            const filteredDates = [];

            dates.forEach(d => {
                const logs = APP_DATA.journalData[d] || [];
                const matched = logs.filter(l => {
                    if (!searchQuery) return true;
                    return (l.text || '').toLowerCase().includes(searchQuery) || (l.category || '').toLowerCase().includes(searchQuery);
                });
                if (matched.length > 0) filteredDates.push({ date: d, logs: matched });
            });

            if (!filteredDates.length) {
                container.innerHTML = '<div class="empty-msg">該当するジャーナル記録はありません</div>';
                return;
            }

            if (currentView === 'list') {
                let html = '';
                filteredDates.forEach(item => {
                    html += '<div class="day-group">';
                    html += '<div class="day-header"><span>📅 ' + item.date + '</span><span style="font-size:12px;opacity:0.8;">' + item.logs.length + ' 件</span></div>';
                    item.logs.forEach(l => { html += renderSingleLogHtml(l); });
                    html += '</div>';
                });
                container.innerHTML = html;
            } else {
                let html = '<div class="card-carousel-view">';
                html += '<div class="carousel-nav-bar">';
                html += '<button type="button" class="carousel-btn" onclick="slideCarousel(-1)">◀ 前の日</button>';
                html += '<span class="carousel-indicator" id="journalSlideIndicator">1 / ' + filteredDates.length + ' 日</span>';
                html += '<button type="button" class="carousel-btn" onclick="slideCarousel(1)">次の日 ▶</button>';
                html += '</div>';
                html += '<div class="carousel-viewport" id="journalCarouselScroller" onscroll="handleCarouselScroll(this, ' + filteredDates.length + ', \\'journalSlideIndicator\\')">';
                
                filteredDates.forEach((item, idx) => {
                    html += '<div class="carousel-slide" data-index="' + idx + '">';
                    html += '<div class="carousel-slide-header">';
                    html += '<div class="carousel-slide-title">📅 ' + item.date + '</div>';
                    html += '<span style="font-size:12px;font-weight:700;color:var(--accent-color);background:var(--accent-soft);padding:3px 10px;border-radius:10px;">' + item.logs.length + ' 件の記録</span>';
                    html += '</div>';
                    html += '<div class="carousel-slide-body">';
                    item.logs.forEach(l => { html += renderSingleLogHtml(l); });
                    html += '</div>';
                    html += '</div>';
                });

                html += '</div></div>';
                container.innerHTML = html;
            }
        }

        function renderNotebooks() {
            const container = document.getElementById('notebooksSection');
            const list = (APP_DATA.notebookData || []).filter(n => {
                if (!searchQuery) return true;
                const title = (n.title || '').toLowerCase();
                const content = (n.content || '').toLowerCase();
                const cat = (n.category || '').toLowerCase();
                return title.includes(searchQuery) || content.includes(searchQuery) || cat.includes(searchQuery);
            });

            if (!list.length) {
                container.innerHTML = '<div class="empty-msg">該当するノートブックはありません</div>';
                return;
            }

            if (currentView === 'list') {
                let html = '';
                list.forEach(n => {
                    html += '<div class="notebook-card">';
                    html += '<div style="display:flex; justify-content:space-between; align-items:center;">';
                    html += '<div class="nb-title">📔 ' + escapeHtml(n.title || '無題のノート') + '</div>';
                    html += '<span class="log-cat" style="background:var(--notebook-soft);color:var(--notebook-color);">' + escapeHtml(n.category || 'ライフログ') + '</span>';
                    html += '</div>';
                    html += '<div class="nb-content">' + (n.content || '<span style="opacity:0.5;">(本文なし)</span>') + '</div>';
                    html += '</div>';
                });
                container.innerHTML = html;
            } else {
                let html = '<div class="card-carousel-view">';
                html += '<div class="carousel-nav-bar">';
                html += '<button type="button" class="carousel-btn" onclick="slideCarousel(-1)">◀ 前のノート</button>';
                html += '<span class="carousel-indicator" id="notebookSlideIndicator">1 / ' + list.length + ' 冊</span>';
                html += '<button type="button" class="carousel-btn" onclick="slideCarousel(1)">次のノート ▶</button>';
                html += '</div>';
                html += '<div class="carousel-viewport" id="notebookCarouselScroller" onscroll="handleCarouselScroll(this, ' + list.length + ', \\'notebookSlideIndicator\\')">';

                list.forEach((n, idx) => {
                    html += '<div class="carousel-slide" data-index="' + idx + '">';
                    html += '<div class="carousel-slide-header">';
                    html += '<div class="carousel-slide-title">📔 ' + escapeHtml(n.title || '無題のノート') + '</div>';
                    html += '<span style="font-size:12px;font-weight:700;color:var(--notebook-color);background:var(--notebook-soft);padding:3px 10px;border-radius:10px;">' + escapeHtml(n.category || 'ライフログ') + '</span>';
                    html += '</div>';
                    html += '<div class="carousel-slide-body">';
                    html += '<div class="nb-content">' + (n.content || '<span style="opacity:0.5;">(本文なし)</span>') + '</div>';
                    html += '</div>';
                    html += '</div>';
                });

                html += '</div></div>';
                container.innerHTML = html;
            }
        }

        function renderSingleLogHtml(l) {
            const imgs = Array.isArray(l.images) ? l.images : (l.image ? [l.image] : []);
            let imgHtml = '';
            if (imgs.length > 0) {
                imgHtml = '<div class="photo-grid">' + imgs.map(src => '<img class="photo-thumb" src="' + src + '" onclick="window.open(\\'' + src + '\\')">').join('') + '</div>';
            }
            const sType = l.slackType || (l.isSlack ? 'incoming' : null);
            let bodyHtml = '';
            if (sType === 'incoming') {
                bodyHtml = '<div class="log-bubble incoming"><div class="bubble-header">💬 ' + escapeHtml(l.category) + ' からの受信</div><div class="log-body">' + parseUrl(l.text) + '</div></div>';
            } else if (sType === 'outgoing') {
                bodyHtml = '<div class="log-bubble outgoing"><div class="bubble-header">💬 ' + escapeHtml(l.category) + ' への送信</div><div class="log-body">' + parseUrl(l.text) + '</div></div>';
            } else {
                bodyHtml = '<div class="log-body">' + parseUrl(l.text) + '</div>';
            }

            return '<div class="log-item">' +
                '<div class="log-meta"><span class="log-time">' + (l.time || '') + '</span><span class="log-cat">' + escapeHtml(l.category || 'ライフログ') + '</span>' + (l.backdated ? '<span class="log-cat" style="background:none;opacity:.7;">✎ 後日記入</span>' : '') + (l.pinned ? '<span class="log-cat" style="background:none;">🔖</span>' : '') + '</div>' +
                bodyHtml + imgHtml +
                ((l.tags && l.tags.length) ? '<div style="font-size:12px;color:var(--text-secondary);">' + l.tags.map(t => '#' + escapeHtml(t)).join('　') + '</div>' : '') +
                '</div>';
        }

        function slideCarousel(direction) {
            const scrollerId = (currentTab === 'journals') ? 'journalCarouselScroller' : 'notebookCarouselScroller';
            const scroller = document.getElementById(scrollerId);
            if (!scroller) return;
            const w = scroller.clientWidth;
            scroller.scrollBy({ left: direction * w, behavior: 'smooth' });
        }

        function handleCarouselScroll(scroller, totalCount, indicatorId) {
            const w = scroller.clientWidth;
            if (!w) return;
            const idx = Math.round(scroller.scrollLeft / w) + 1;
            const unit = (currentTab === 'journals') ? '日' : '冊';
            const indicator = document.getElementById(indicatorId);
            if (indicator) indicator.textContent = idx + ' / ' + totalCount + ' ' + unit;
        }

        window.addEventListener('keydown', (e) => {
            if (currentView !== 'card') return;
            if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
            if (e.key === 'ArrowLeft') slideCarousel(-1);
            if (e.key === 'ArrowRight') slideCarousel(1);
        });

        renderArchiveContent();
    <\/script>
</body>
</html>`;

    const blob = new Blob([archiveHtml], { type: 'text/html;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `daily_journal_archive_${fileDateSuffix}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

function openHtmlBatchExportModal() {
    selectedBatchExportOption = 'both';
    selectBatchExportOption('both');
    openModal('htmlBatchExportModal');
}

function selectBatchExportOption(opt) {
    selectedBatchExportOption = opt;
    ['both', 'journals', 'notebooks'].forEach(key => {
        const card = document.getElementById(`batchOptionLabel_${key}`);
        const radio = card ? card.querySelector('input[type="radio"]') : null;
        if (card) card.classList.toggle('selected', key === opt);
        if (radio) radio.checked = (key === opt);
    });
}

async function executeBatchHtmlExport() {
    const opt = selectedBatchExportOption || 'both';
    const journalDates = Object.keys(journalData).filter(d => Array.isArray(journalData[d]) && journalData[d].length > 0);
    const validNotebooks = notebookData.filter(n => n.status !== 'trash');

    if (opt === 'journals' && !journalDates.length) {
        alert("出力する Journals 記録データがありません。");
        return;
    }
    if (opt === 'notebooks' && !validNotebooks.length) {
        alert("出力する Notebooks データがありません。");
        return;
    }
    if (opt === 'both' && !journalDates.length && !validNotebooks.length) {
        alert("出力するデータがありません。");
        return;
    }

    closeModal('htmlBatchExportModal');
    closeModal('settingsModal');

    if ('showDirectoryPicker' in window) {
        try {
            const rootDir = await window.showDirectoryPicker();
            let journalCount = 0;
            let notebookCount = 0;

            if (opt === 'journals' || opt === 'both') {
                const targetDir = (opt === 'both') 
                    ? await rootDir.getDirectoryHandle('journal', { create: true }) 
                    : rootDir;
                for (const d of journalDates) {
                    const fh = await targetDir.getFileHandle(d.replace(/-/g, '') + '.html', { create: true });
                    const w = await fh.createWritable();
                    await w.write(generateDayHtmlDocument(d, await resolveLogsForExport(journalData[d])));
                    await w.close();
                    journalCount++;
                }
            }

            if (opt === 'notebooks' || opt === 'both') {
                const targetDir = (opt === 'both') 
                    ? await rootDir.getDirectoryHandle('notebooks', { create: true }) 
                    : rootDir;
                for (const n of validNotebooks) {
                    const safeTitle = (n.title && n.title.trim() ? n.title.trim().replace(/[\\/:*?"<>|]/g, '_') : 'notebook');
                    const fileName = `${safeTitle}_${n.id}.html`;
                    const fh = await targetDir.getFileHandle(fileName, { create: true });
                    const w = await fh.createWritable();
                    await w.write(generateNotebookHtmlDocument(n));
                    await w.close();
                    notebookCount++;
                }
            }

            let msg = "出力が完了しました！\n";
            if (opt === 'both') msg += `・journal フォルダ: ${journalCount} 件\n・notebooks フォルダ: ${notebookCount} 件`;
            else if (opt === 'journals') msg += `・Journals: ${journalCount} 件`;
            else if (opt === 'notebooks') msg += `・Notebooks: ${notebookCount} 件`;
            alert(msg);
        } catch (e) {
            if (e.name !== 'AbortError') alert("保存中にエラーが発生しました: " + e.message);
        }
    } else {
        try {
            const zip = new JSZip();
            let journalCount = 0;
            let notebookCount = 0;

            if (opt === 'journals' || opt === 'both') {
                const targetFolder = (opt === 'both') ? zip.folder('journal') : zip;
                for (const d of journalDates) {
                    targetFolder.file(d.replace(/-/g, '') + '.html', generateDayHtmlDocument(d, await resolveLogsForExport(journalData[d])));
                    journalCount++;
                }
            }

            if (opt === 'notebooks' || opt === 'both') {
                const targetFolder = (opt === 'both') ? zip.folder('notebooks') : zip;
                validNotebooks.forEach(n => {
                    const safeTitle = (n.title && n.title.trim() ? n.title.trim().replace(/[\\/:*?"<>|]/g, '_') : 'notebook');
                    const fileName = `${safeTitle}_${n.id}.html`;
                    targetFolder.file(fileName, generateNotebookHtmlDocument(n));
                    notebookCount++;
                });
            }

            const blob = await zip.generateAsync({ type: "blob" });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            const now = new Date();
            const dateSuffix = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
            const zipName = (opt === 'both') 
                ? `export_all_${dateSuffix}.zip` 
                : (opt === 'journals' ? `journal_html_${dateSuffix}.zip` : `notebooks_html_${dateSuffix}.zip`);

            a.download = zipName;
            document.body.appendChild(a);
            a.click();
            a.remove();

            let msg = `ZIPファイル (${zipName}) として保存しました！\n`;
            if (opt === 'both') msg += `・journal/: ${journalCount} 件\n・notebooks/: ${notebookCount} 件`;
            else if (opt === 'journals') msg += `・Journals: ${journalCount} 件`;
            else if (opt === 'notebooks') msg += `・Notebooks: ${notebookCount} 件`;
            alert(msg);
        } catch (e) {
            alert("ZIPアーカイブの作成に失敗しました: " + e.message);
        }
    }
}

// data: URI はサイズ上限があり、写真が多いと書き出しに失敗するため Blob で書き出す
async function exportData() {
    try {
        const p = { appTypes, categories, typeSlackSettings, typeNotebookSettings, typeHomeSettings, tagDefs, templateDefs, hideEmptyCards, deviceDisplayMode, journalData: await getJournalDataForExport(), notebookData: await getNotebookDataForExport() };
        const blob = new Blob([JSON.stringify(p)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url;
        const n = new Date(); a.download = `journal_backup_${n.getFullYear()}${String(n.getMonth()+1).padStart(2,'0')}${String(n.getDate()).padStart(2,'0')}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        markBackupDone();
    } catch (e) {
        console.error(e);
        alert("バックアップの書き出しに失敗しました: " + (e && e.message ? e.message : e));
    }
}

function triggerImport() { document.getElementById('importFile').click(); }
function importData(e) {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = async function(ev) {
        try {
            const imp = JSON.parse(ev.target.result);
            if (typeof imp === 'object' && imp !== null) {
                // 旧形式（ファイル全体がジャーナル）にも対応
                const looksLikeBareJournal = !imp.journalData && !imp.notebookData && !imp.appTypes && Object.keys(imp).some(k => /^\d{4}-\d{2}-\d{2}$/.test(k));
                const impJournal = imp.journalData ? sanitizeJournalData(imp.journalData) : (looksLikeBareJournal ? sanitizeJournalData(imp) : null);
                const impNotes = Array.isArray(imp.notebookData) ? imp.notebookData.map(sanitizeNote).filter(Boolean) : null;
                if (!impJournal && !impNotes && !Array.isArray(imp.appTypes) && !Array.isArray(imp.categories)) {
                    alert("このファイルにはインポートできるデータが含まれていません。");
                    e.target.value = "";
                    return;
                }
                if (confirm("バックアップの内容を現在のデータに統合しますか？\n（同じ記録・ノートはバックアップの内容で上書きされます。現在のデータは削除されません）")) {
                    if (imp.appTypes && Array.isArray(imp.appTypes)) { appTypes = imp.appTypes.filter(t => typeof t === 'string' && t.trim()); saveAppTypes(); }
                    if (imp.categories && Array.isArray(imp.categories)) { categories = imp.categories.filter(c => c && typeof c.name === 'string' && c.name.trim()).map(c => { const o = { name: c.name, type: typeof c.type === 'string' ? c.type : '一般' }; if (typeof c.archivedAt === 'string' && !isNaN(Date.parse(c.archivedAt))) o.archivedAt = c.archivedAt; return o; }); saveCategories(); }
                    if (imp.typeSlackSettings && typeof imp.typeSlackSettings === 'object') { typeSlackSettings = imp.typeSlackSettings; saveTypeSlackSettings(); }
                    if (imp.typeNotebookSettings && typeof imp.typeNotebookSettings === 'object') { typeNotebookSettings = imp.typeNotebookSettings; saveTypeNotebookSettings(); }
                    if (Array.isArray(imp.tagDefs)) { sanitizeTagDefs(imp.tagDefs).forEach(d => { const ex = tagDefs.find(x => x.name === d.name); if (ex) Object.assign(ex, d); else tagDefs.push(d); }); saveTagDefs(); }
                    if (Array.isArray(imp.templateDefs)) { sanitizeTemplateDefs(imp.templateDefs).forEach(d => { const i = templateDefs.findIndex(x => x.id === d.id); if (i !== -1) templateDefs[i] = d; else templateDefs.push(d); }); saveTemplateDefs(); }
                    if (imp.typeHomeSettings && typeof imp.typeHomeSettings === 'object') { typeHomeSettings = {}; Object.keys(imp.typeHomeSettings).forEach(k => { if (imp.typeHomeSettings[k] === false) typeHomeSettings[k] = false; }); saveTypeHomeSettings(); }
                    if (typeof imp.hideEmptyCards === 'boolean') { hideEmptyCards = imp.hideEmptyCards; localStorage.setItem('daily_journal_hide_empty', hideEmptyCards); applyHideEmptyCardsSetting(); }
                    if (['auto', 'mobile', 'desktop'].includes(imp.deviceDisplayMode)) { deviceDisplayMode = imp.deviceDisplayMode; localStorage.setItem('daily_journal_device_mode', deviceDisplayMode); applyDeviceModeSetting(); }

                    if (impNotes) {
                        impNotes.forEach(n => {
                            const idx = notebookData.findIndex(x => x.id === n.id);
                            if (idx !== -1) notebookData[idx] = n; else notebookData.push(n);
                        });
                        await saveNotebookData();
                    }

                    if (impJournal) {
                        Object.keys(impJournal).forEach(d => {
                            const cur = journalData[d] || [];
                            impJournal[d].forEach(log => {
                                const i = cur.findIndex(l => l.id === log.id);
                                if (i !== -1) cur[i] = log; else cur.push(log);
                            });
                            journalData[d] = cur;
                        });
                    }

                    await syncAndMigrateCategories(); 
                    await saveJournalData(); 
                    
                    Object.keys(journalData).forEach(d => { if (!dateList.includes(d)) dateList.push(d); }); dateList.sort();
                    calendarScope = 'day'; renderRightCards(); alert("データのインポートが完了しました！"); closeModal('settingsModal');
                }
            } else alert("無効なファイル形式です。");
        } catch (err) { alert("JSONファイルの解析に失敗しました。"); }
        e.target.value = "";
    };
    r.readAsText(f);
}

let scrollTimer = null;
document.getElementById('journalCarouselContainer').addEventListener('scroll', () => {
    if (isProgrammaticScroll) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
        if (isProgrammaticScroll) return;
        const c = document.getElementById('journalCarouselContainer'); const w = c.clientWidth; if (!w) return;
        const pnl = c.querySelectorAll('.card-carousel-panel')[Math.round(c.scrollLeft / w)];
        if (pnl && pnl.dataset.key) {
            const k = pnl.dataset.key;
            if (calendarScope === 'notebooks') {
                if (k.startsWith('notebook_')) {
                    const id = k.replace('notebook_', '');
                    const filtered = notebookData.filter(n => matchesCurrentFilter(n));
                    const idx = filtered.findIndex(n => n.id === id);
                    if (idx !== -1) {
                        currentNotebookIndex = idx;
                        if (sidebarMode === 'cal') renderNotebookSidebar();
                    }
                }
            } else if (calendarScope === 'day') { 
                activeDateKey = k;
                lastJournalDateKey = k;
                const p = k.split('-'); miniCalYear = parseInt(p[0], 10); miniCalMonth = parseInt(p[1], 10) - 1; 
            } else if (calendarScope === 'photo') {
                lastPhotoPanelKey = k;
                const dStr = pnl.dataset.date;
                if (dStr) { 
                    activeDateKey = dStr; 
                    lastJournalDateKey = dStr;
                    const p = dStr.split('-'); miniCalYear = parseInt(p[0], 10); miniCalMonth = parseInt(p[1], 10) - 1; 
                }
            } else if (calendarScope === 'week') {
                if (!isDateInWeek(activeDateKey, k)) {
                    const pD = new Date(activeDateKey.replace(/-/g, '/')); const mD = new Date(k.replace(/-/g, '/'));
                    mD.setDate(mD.getDate() + (pD.getDay() === 0 ? 6 : pD.getDay() - 1));
                    activeDateKey = `${mD.getFullYear()}-${String(mD.getMonth() + 1).padStart(2, '0')}-${String(mD.getDate()).padStart(2, '0')}`;
                }
                lastJournalDateKey = activeDateKey;
                const p = activeDateKey.split('-') ; miniCalYear = parseInt(p[0], 10); miniCalMonth = parseInt(p[1], 10) - 1;
            } else if (calendarScope === 'month') {
                if (activeDateKey.substring(0, 7) !== k) {
                    const [nY, nM] = k.split('-').map(v => parseInt(v, 10)); const prevD = parseInt(activeDateKey.split('-')[2], 10);
                    activeDateKey = `${k}-${String(Math.min(prevD, new Date(nY, nM, 0).getDate())).padStart(2, '0')}`;
                }
                lastJournalDateKey = activeDateKey;
                const p = activeDateKey.split('-'); miniCalYear = parseInt(p[0], 10); miniCalMonth = parseInt(p[1], 10) - 1;
            }
            if (sidebarMode === 'cal' && calendarScope !== 'notebooks') { renderMiniCalendar(); updateJumpButtonLabel(); }
        }
    }, 60);
}, { passive: true });

// ==========================================
// 過去の写真をまとめて縮小（設定 > データ）
// ==========================================
// 保存済みの記録の写真を、指定の大きさ・画質で保存し直す。元の画質には戻せないので、実行前にバックアップを促す。
// 縮小した写真は新しい画像として保存・同期され、古い画像は
//   ・端末内：画像ストアの掃除で自動的に削除
//   ・クラウド：「不要な画像を削除」で削除（古くアップロードされた画像なので、すぐに対象になる）
// ノートの画像は、図や画面写真など文字が読めないと困るものが多いので対象外。
let _bulkShrinkRunning = false;
// 画質ごとのファイルサイズの目安（画質85%を1とした比。計測値）
const _BULK_QUALITY_FACTOR = { 0.85: 1, 0.8: 0.9, 0.75: 0.84, 0.7: 0.83 };

function _bulkCutoffKey(months) {
    if (!months) return null;
    const d = new Date(); d.setMonth(d.getMonth() - months);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// JPEG / PNG の縦横を、画像を展開せずにファイルの先頭から読む
function _imageDimsFromDataUrl(d) {
    try {
        const comma = d.indexOf(',');
        const head = atob(d.substr(comma + 1, 87380).replace(/[^A-Za-z0-9+/]/g, '').slice(0, 87380 - (87380 % 4)));
        const b = i => head.charCodeAt(i);
        if (b(0) === 0x89 && b(1) === 0x50) return { w: (b(16) << 24 | b(17) << 16 | b(18) << 8 | b(19)) >>> 0, h: (b(20) << 24 | b(21) << 16 | b(22) << 8 | b(23)) >>> 0 };
        if (b(0) !== 0xFF || b(1) !== 0xD8) return null;
        let i = 2;
        while (i + 9 < head.length) {
            if (b(i) !== 0xFF) { i++; continue; }
            const m = b(i + 1);
            if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: b(i + 5) << 8 | b(i + 6), w: b(i + 7) << 8 | b(i + 8) };
            if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
            i += 2 + (b(i + 2) << 8 | b(i + 3));
        }
    } catch (e) {}
    return null;
}
function _resizeDataUrl(dataUrl, max, quality) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            try {
                const w0 = img.naturalWidth, h0 = img.naturalHeight, s = Math.min(1, max / Math.max(w0, h0));
                const c = document.createElement('canvas');
                c.width = Math.max(1, Math.round(w0 * s)); c.height = Math.max(1, Math.round(h0 * s));
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                const out = c.toDataURL('image/jpeg', quality);
                c.width = 0; c.height = 0; img.src = IMG_PLACEHOLDER;
                resolve(out);
            } catch (e) { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = dataUrl;
    });
}

// 対象の写真を集める（画像は1枚ずつ読み、縦横と大きさだけを見る）
async function collectBulkShrinkTargets(months, presetKey, onProgress) {
    const p = PHOTO_QUALITY_PRESETS[presetKey];
    const cutoff = _bulkCutoffKey(months);
    const items = [];
    let small = 0, missing = 0, beforeBytes = 0, estAfter = 0;
    const seen = new Set();
    const dates = Object.keys(journalData).filter(d => !cutoff || d < cutoff).sort();
    const all = [];
    for (const d of dates) for (const log of (journalData[d] || [])) (log.images || []).forEach((ref, idx) => all.push({ d, id: log.id, idx, ref }));
    let n = 0;
    for (const it of all) {
        if (onProgress && (++n % 10 === 0)) onProgress(n, all.length);
        const h = idbRefHash(it.ref);
        const data = h ? await readStoredImage(h) : (isDataImage(it.ref) ? it.ref : null);
        if (!data) { missing++; continue; }
        const dims = _imageDimsFromDataUrl(data) || await new Promise(res => { const i = new Image(); i.onload = () => { res({ w: i.naturalWidth, h: i.naturalHeight }); i.src = IMG_PLACEHOLDER; }; i.onerror = () => res(null); i.src = data; });
        const bytes = dataUrlBytes(data);
        const L = dims ? Math.max(dims.w, dims.h) : 0;
        if (!L || L <= p.maxDimension) { small++; continue; }
        // 同じ写真が複数の記録に付いている場合、容量は1回分だけ数える
        const key = h || _nbThumbKey(data);
        const dup = seen.has(key); seen.add(key);
        const est = Math.round(bytes * Math.pow(p.maxDimension / L, 2) * (_BULK_QUALITY_FACTOR[p.quality] || 0.85));
        if (!dup) { beforeBytes += bytes; estAfter += est; }
        items.push(Object.assign(it, { bytes, est }));
    }
    return { items, small, missing, beforeBytes, estAfter, preset: p, cutoff };
}

function clearBulkShrinkResult() {
    if (_bulkShrinkRunning) return;
    const el = document.getElementById('bulkShrinkResult');
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}
function _bulkShrinkOptions() {
    const months = parseInt(document.getElementById('bulkShrinkAge').value, 10) || 0;
    const presetKey = document.getElementById('bulkShrinkPreset').value;
    return { months, presetKey: PHOTO_QUALITY_PRESETS[presetKey] ? presetKey : 'saver' };
}
function _bulkShrinkShow(html) {
    const el = document.getElementById('bulkShrinkResult');
    el.style.display = 'block'; el.innerHTML = html;
}

async function previewBulkShrink() {
    if (_bulkShrinkRunning) return;
    const { months, presetKey } = _bulkShrinkOptions();
    _bulkShrinkShow('写真を確認しています…');
    const plan = await collectBulkShrinkTargets(months, presetKey, (i, t) => _bulkShrinkShow(`写真を確認しています… ${i} / ${t}`));
    const target = months ? `${plan.cutoff.replace(/-/g, '/')} より前の写真` : 'すべての写真';
    if (!plan.items.length) {
        _bulkShrinkShow(`${escapeHtml(target)}のうち、「${plan.preset.label}」より大きい写真はありません。` + (plan.small ? `<div class="bs-note">すでに ${plan.preset.maxDimension}px 以下の写真 ${plan.small} 枚はそのままです。</div>` : ''));
        return;
    }
    const freed = Math.max(0, plan.beforeBytes - plan.estAfter);
    _bulkShrinkShow(`
        <div>${escapeHtml(target)}：<span class="bs-num">${plan.items.length} 枚</span>を「${plan.preset.label}」（長い辺 ${plan.preset.maxDimension}px）に縮小</div>
        <div>容量：<span class="bs-num">${formatKB(plan.beforeBytes)} → 約 ${formatKB(plan.estAfter)}</span>（約 <span class="bs-num">${formatKB(freed)}</span> 空く見込み）</div>
        ${plan.small ? `<div class="bs-note">すでに ${plan.preset.maxDimension}px 以下の写真 ${plan.small} 枚はそのままです。</div>` : ''}
        ${plan.missing ? `<div class="bs-note">この端末に画像がない写真 ${plan.missing} 枚は対象外です。</div>` : ''}
        <div class="bs-note">クラウドの容量は、縮小の後に「クラウドの不要な画像を削除」を実行すると空きます。</div>
        <div class="bs-warn">⚠️ 元の画質には戻せません。先にバックアップ（データのエクスポート）を書き出しておくことをおすすめします。</div>
        <div class="bs-actions">
            <button type="button" class="data-action-btn" onclick="exportData()">① バックアップを書き出す</button>
            <button type="button" class="data-action-btn primary-btn" onclick="runBulkShrink()">② 縮小を実行する</button>
        </div>`);
}

async function runBulkShrink() {
    if (_bulkShrinkRunning) return;
    if (typeof isTabActive === 'function' && !isTabActive()) return;
    const { months, presetKey } = _bulkShrinkOptions();
    const plan = await collectBulkShrinkTargets(months, presetKey);
    if (!plan.items.length) { previewBulkShrink(); return; }
    if (!confirm(`${plan.items.length} 枚の写真を「${plan.preset.label}」（長い辺 ${plan.preset.maxDimension}px）に縮小します。\n元の画質には戻せません。バックアップは書き出しましたか？\n\n続行しますか？`)) return;

    _bulkShrinkRunning = true;
    const btn = document.getElementById('bulkShrinkCheckBtn'); if (btn) btn.disabled = true;
    let done = 0, changed = 0, before = 0, after = 0, sinceSave = 0;
    const counted = new Set();
    const progress = () => _bulkShrinkShow(`縮小しています… ${done} / ${plan.items.length}<div class="bulk-shrink-progress"><div style="width:${Math.round(done / plan.items.length * 100)}%"></div></div><div class="bs-note">完了までこの画面のままお待ちください。</div>`);
    progress();
    const converted = new Map(); // 元の参照 -> 縮小後（同じ写真を複数の記録で使っていれば1回だけ縮小）
    try {
        for (const it of plan.items) {
            if (typeof isTabActive === 'function' && !isTabActive()) break;
            done++;
            const log = findLogById(it.d, it.id);
            if (!log || !log.images || log.images[it.idx] !== it.ref) { progress(); continue; } // 途中で編集・削除された
            let out = converted.get(it.ref);
            if (out === undefined) {
                const h = idbRefHash(it.ref);
                const data = h ? await readStoredImage(h) : it.ref;
                out = data ? await _resizeDataUrl(data, plan.preset.maxDimension, plan.preset.quality) : null;
                if (out && dataUrlBytes(out) >= it.bytes) out = null; // 小さくならなければそのまま
                converted.set(it.ref, out);
                if (out && !counted.has(it.ref)) { counted.add(it.ref); before += it.bytes; after += dataUrlBytes(out); }
            }
            const cur = findLogById(it.d, it.id);
            if (out && cur && cur.images[it.idx] === it.ref) {
                cur.images[it.idx] = out; changed++; sinceSave++;
                // 置き換えた元の画像は、この起動中に保存したものでも掃除の対象にする（どこからも使われていなければ消える）
                const oh = idbRefHash(it.ref); if (oh && typeof _sessionStoredHashes !== 'undefined') _sessionStoredHashes.delete(oh);
            }
            // こまめに保存して、縮小後の画像を画像ストアへ移しメモリから手放す
            if (sinceSave >= 8) { await saveJournalData(); sinceSave = 0; converted.clear(); }
            progress();
        }
        await saveJournalData();
    } finally {
        _bulkShrinkRunning = false;
        if (btn) btn.disabled = false;
    }
    setTimeout(() => { if (typeof garbageCollectImages === 'function') garbageCollectImages(); }, 1500);
    renderRightCards();
    const loggedIn = typeof supabaseUser !== 'undefined' && supabaseUser;
    _bulkShrinkShow(`
        <div>✅ <span class="bs-num">${changed} 枚</span>を縮小しました（${formatKB(before)} → ${formatKB(after)}、<span class="bs-num">${formatKB(Math.max(0, before - after))}</span> 削減）</div>
        <div class="bs-note">この端末の古い画像は自動で削除されます。${loggedIn ? '縮小した写真はクラウドへ送信され、他の端末にも反映されます。' : ''}</div>
        ${loggedIn ? `<div class="bs-note">クラウドの古い画像を消して容量を空けるには、下のボタンを押してください（未送信の分は先に送信されます。7日以内にアップロードされた画像は安全のため後日の対象になります）。</div>
        <div class="bs-actions"><button type="button" class="data-action-btn" onclick="cleanupUnusedCloudImages()">クラウドの不要な画像を削除</button></div>` : ''}`);
}


// ==========================================
// 後日記入（あとから書き足した記録・日時を変えた記録）
// ==========================================
// その時に書くことに意味がある記録なので、日時を変えた記録には「✎ 後日記入」と角の折り返しを付ける（外せない）。
// 実際に書いた日時（writtenAt）は画面には出さず、マークをタップしたときだけ表示する。
function lateMarkHtml(log, dateStr) {
    if (!log || !log.backdated) return '';
    return `<button type="button" class="late-mark" onclick="event.stopPropagation(); showBackdateInfo(this, '${dateStr}', '${log.id}')" title="タップして実際に書いた日時を表示">✎ 後日記入</button>`;
}
function backdateInfoText(dateStr, log) {
    if (!log || !log.writtenAt) return '日時を変更した記録です';
    const w = new Date(log.writtenAt);
    const p2 = n => String(n).padStart(2, '0');
    const wKey = `${w.getFullYear()}-${p2(w.getMonth() + 1)}-${p2(w.getDate())}`;
    const label = `${w.getMonth() + 1}/${w.getDate()}(${['日', '月', '火', '水', '木', '金', '土'][w.getDay()]}) ${p2(w.getHours())}:${p2(w.getMinutes())} に記入`;
    const dayDiff = Math.round((new Date(wKey + 'T00:00:00') - new Date(dateStr + 'T00:00:00')) / 86400000);
    const minDiff = Math.round((w - new Date(slotToIso(dateStr, log.time))) / 60000);
    let rel;
    if (dayDiff >= 1) rel = `${dayDiff}日後`;
    else if (minDiff >= 60) rel = `${Math.floor(minDiff / 60)}時間後`;
    else if (minDiff > 0) rel = `${minDiff}分後`;
    else rel = '記入より後の時刻に変更';
    return `${label}（${rel}）`;
}
let _lateTipEl = null, _lateTipTimer = null;
function hideBackdateInfo() {
    clearTimeout(_lateTipTimer);
    if (_lateTipEl) { _lateTipEl.remove(); _lateTipEl = null; }
}
function showBackdateInfo(btn, dateStr, id) {
    const log = findLogById(dateStr, id);
    hideBackdateInfo();
    const tip = document.createElement('div');
    tip.className = 'late-tip';
    tip.textContent = backdateInfoText(dateStr, log);
    document.body.appendChild(tip);
    const r = btn.getBoundingClientRect();
    const w = tip.offsetWidth;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    tip.style.left = left + 'px';
    tip.style.top = (r.bottom + 8) + 'px';
    tip.style.setProperty('--arrow-x', Math.max(8, Math.min(w - 18, r.left + r.width / 2 - left - 5)) + 'px');
    _lateTipEl = tip;
    _lateTipTimer = setTimeout(hideBackdateInfo, 3500);
}
document.addEventListener('pointerdown', e => { if (_lateTipEl && !(e.target.closest && e.target.closest('.late-mark'))) hideBackdateInfo(); }, true);
document.addEventListener('scroll', () => hideBackdateInfo(), true);

// 追記・編集画面の日時（バッジをタップすると日付・時刻を選べる）
let _addSlot = null;   // null = いま
let _editSlot = null;  // 編集中の記録の日時
function openSlotPicker(inp) { try { if (inp.showPicker) inp.showPicker(); } catch (e) {} }
function _slotIsFuture(date, time) { return Date.parse(slotToIso(date, time)) > Date.now(); }
function _slotDateLabel(date) { return date === getTodayKey() ? '今日' : formatShortDate(date); }
function _readSlot(dateId, timeId, fallback) {
    const today = getTodayKey();
    let date = document.getElementById(dateId).value || fallback.date;
    let time = document.getElementById(timeId).value || fallback.time;
    if (!DATE_KEY_RE.test(date)) date = fallback.date;
    if (!/^\d{1,2}:\d{2}$/.test(time)) time = fallback.time;
    time = time.padStart(5, '0');
    if (date > today) date = today;                       // 未来の日付は選べない
    if (_slotIsFuture(date, time)) time = nowTimeStr();   // 今日の未来の時刻は「いま」に
    return { date, time };
}
function refreshAddSlotUI() {
    const today = getTodayKey();
    const slot = _addSlot || { date: today, time: nowTimeStr() };
    const dateEl = document.getElementById('addSlotDate'), timeEl = document.getElementById('addSlotTime');
    if (!dateEl) return;
    dateEl.max = today; dateEl.value = slot.date; timeEl.value = slot.time;
    document.getElementById('modalTargetDateBadge').textContent = _slotDateLabel(slot.date);
    document.getElementById('modalCurrentTimeBadge').textContent = slot.time;
    document.querySelectorAll('#addModal .slot-picker').forEach(el => el.classList.toggle('is-late', !!_addSlot));
    const hint = document.getElementById('addSlotHint');
    if (_addSlot) { hint.style.display = 'flex'; hint.innerHTML = `<span>✎ 後日記入として保存されます</span><button type="button" onclick="resetAddSlot()">いまに戻す</button>`; }
    else { hint.style.display = 'none'; hint.innerHTML = ''; }
}
function changeAddSlot() {
    const now = { date: getTodayKey(), time: nowTimeStr() };
    const s = _readSlot('addSlotDate', 'addSlotTime', _addSlot || now);
    _addSlot = (s.date === now.date && s.time === now.time) ? null : s;
    refreshAddSlotUI();
}
function resetAddSlot() { _addSlot = null; refreshAddSlotUI(); }
function refreshEditSlotUI() {
    const { dateStr: d, id } = currentEditTarget;
    const log = findLogById(d, id);
    if (!log || !_editSlot) return;
    const dateEl = document.getElementById('editSlotDate'), timeEl = document.getElementById('editSlotTime');
    dateEl.max = getTodayKey(); dateEl.value = _editSlot.date; timeEl.value = _editSlot.time;
    document.getElementById('editModalDateBadge').textContent = _slotDateLabel(_editSlot.date);
    document.getElementById('editModalTimeBadge').textContent = _editSlot.time;
    const changed = _editSlot.date !== d || _editSlot.time !== log.time;
    document.querySelectorAll('#editModal .slot-picker').forEach(el => el.classList.toggle('is-late', changed || !!log.backdated));
    const hint = document.getElementById('editSlotHint');
    if (changed) { hint.style.display = 'flex'; hint.innerHTML = `<span>✎ 日時を変えると「後日記入」の印が付きます（外せません）</span><button type="button" onclick="resetEditSlot()">元に戻す</button>`; }
    else if (log.backdated) { hint.style.display = 'flex'; hint.innerHTML = `<span>✎ 後日記入の記録です（${escapeHtml(backdateInfoText(d, log))}）</span>`; }
    else { hint.style.display = 'none'; hint.innerHTML = ''; }
}
function changeEditSlot() {
    _editSlot = _readSlot('editSlotDate', 'editSlotTime', _editSlot);
    refreshEditSlotUI();
}
function resetEditSlot() {
    const { dateStr: d, id } = currentEditTarget; const log = findLogById(d, id);
    if (log) _editSlot = { date: d, time: log.time };
    refreshEditSlotUI();
}
// カレンダー：表示中の記録がすべて後日記入の日（点を白抜きにする）
function isLateOnlyDate(d) {
    const l = (journalData[d] || []).filter(i => matchesCurrentFilter(i));
    return l.length > 0 && l.every(i => i.backdated);
}


// ==========================================
// しおり（お気に入りの記録）
// ==========================================
// どの記録にも編集ボタンの左に薄いしおりがあり、タップで付け外しする。付けた記録は生成り色のカードになる。
// 「表示ビュー > しおり」で、しおりを挟んだ記録だけを新しい順に見返せる。
let showPinnedList = false;
let showTagView = null; // タグの一覧を表示中なら、そのタグ名（tags.js）
function pinIconSvg(on) {
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M6 3h12v18l-6-4.5L6 21z"/></svg>`;
}
function pinButtonHtml(log, dateStr) {
    if (window.IS_READONLY_MODE) return '';
    const on = !!log.pinned;
    return `<button type="button" class="pin-btn${on ? ' is-on' : ''}" data-pin-id="${log.id}" onclick="event.stopPropagation(); togglePin('${dateStr}', '${log.id}')" title="${on ? 'しおりを外す' : 'しおりを挟む'}" aria-label="${on ? 'しおりを外す' : 'しおりを挟む'}" aria-pressed="${on}">${pinIconSvg(on)}</button>`;
}
async function togglePin(dateStr, id) {
    const log = findLogById(dateStr, id);
    if (!log) return;
    if (log.pinned) delete log.pinned; else log.pinned = true;
    const on = !!log.pinned;
    // 画面を描き直さずにその場で切り替える（スクロール位置を保つ）
    document.querySelectorAll(`.pin-btn[data-pin-id="${id}"]`).forEach(b => {
        b.classList.toggle('is-on', on);
        b.innerHTML = pinIconSvg(on);
        b.title = on ? 'しおりを外す' : 'しおりを挟む';
        b.setAttribute('aria-label', b.title); b.setAttribute('aria-pressed', String(on));
        const li = b.closest('.log-item'); if (li) li.classList.toggle('is-pinned', on);
        const dr = b.closest('.journal-bottom-drawer'); if (dr) dr.classList.toggle('is-pinned', on);
    });
    await saveJournalData();
}
function selectPinnedFromModal() {
    closeModal('viewScopeModal');
    triggerSmoothViewSwitch(() => {
        if (calendarScope === 'notebooks') {
            calendarScope = lastJournalScope || 'day';
            if (lastJournalDateKey) activeDateKey = lastJournalDateKey;
        }
        showPinnedList = true; showTagView = null;
        if (journalSearchQuery) {
            journalSearchQuery = '';
            ['journalSearchInput', 'fsJournalSearchInput'].forEach(i => { const el = document.getElementById(i); if (el) el.value = ''; });
            ['journalSearchClearBtn', 'fsJournalSearchClearBtn'].forEach(i => { const el = document.getElementById(i); if (el) el.classList.remove('active'); });
        }
        updateScopeButtonsUI(); updateJumpButtonLabel();
        if (sidebarMode === 'cal') updateSidebars();
        renderRightCards();
    });
}
function closePinnedList() {
    triggerSmoothViewSwitch(() => { showPinnedList = false; updateScopeButtonsUI(); renderRightCards(); });
}
function getPinnedLogs() {
    const out = [];
    Object.keys(journalData).forEach(d => (journalData[d] || []).forEach((log, i) => { if (log.pinned && matchesCurrentFilter(log)) out.push({ dateStr: d, log, index: i }); }));
    return out.sort((a, b) => (b.dateStr + (b.log.time || '')).localeCompare(a.dateStr + (a.log.time || '')));
}
function renderPinnedListCard() {
    const container = document.getElementById('journalCarouselContainer');
    container.innerHTML = '';
    const items = getPinnedLogs();
    let body = '';
    if (!items.length) {
        body = `<div class="empty-state"><span style="font-size: 32px;">🔖</span><span style="font-size: 15px; font-weight: 600; margin-top: 8px;">しおりを挟んだ記録はまだありません</span><span style="font-size: 13px; opacity: 0.7;">記録の右上のしおりをタップすると挟めます</span></div>`;
    } else {
        let cur = null;
        body = '<ul class="log-list">';
        items.forEach(m => {
            if (m.dateStr !== cur) {
                cur = m.dateStr;
                body += `</ul><div class="timeline-date-divider" data-date="${cur}"><span class="timeline-date-label" onclick="jumpToDayFromTimeline('${cur}')">📅 ${formatDateHeader(cur)}<span style="opacity:.6; font-weight:600; margin-left:6px;">${cur.slice(0, 4)}</span></span><div class="timeline-date-line"></div></div><ul class="log-list">`;
            }
            body += createLogItemHtml(m.log, m.dateStr, m.index);
        });
        body += '</ul>';
    }
    const panel = document.createElement('div');
    panel.className = 'card-carousel-panel';
    panel.style.width = '100%';
    panel.dataset.key = 'pins';
    panel.innerHTML = `<div class="main-display"><div class="display-header compact-header"><div class="date-title-wrapper"><span class="date-eyebrow" style="color: var(--pin);">BOOKMARKS</span><h1 class="date-title">🔖 しおり</h1></div><div class="header-actions">${getActiveFilterBadgeHtml()}<button type="button" class="data-action-btn" onclick="closePinnedList()" style="font-size: 11px; padding: 4px 9px;">閉じる</button><span class="header-badge" style="background: var(--pin); color: #fff;">${items.length} 件</span></div></div><div class="logs-container-wrapper" style="padding: 4px 2px;">${body}</div></div>`;
    container.appendChild(panel);
    if (cardScrollPositions['pins'] !== undefined) { const sw = panel.querySelector('.logs-container-wrapper'); if (sw) sw.scrollTop = cardScrollPositions['pins']; }
}


// ==========================================
// 下のメニューのラベルを「…」で切らない
// ==========================================
// 枠に収まらないラベルだけ、文字を少しずつ小さくして全部表示する（最小 8px）。
function fitBarLabels() {
    document.querySelectorAll('.bottom-launcher-bar .bar-btn > span:last-child').forEach(el => {
        el.style.fontSize = '';
        const box = el.parentElement;
        const avail = box.clientWidth - 2;
        if (!avail) return;
        let size = parseFloat(getComputedStyle(el).fontSize) || 10.5;
        while (el.scrollWidth > avail && size > 8) { size -= 0.5; el.style.fontSize = size + 'px'; }
    });
}
window.addEventListener('resize', () => fitBarLabels());


// ==========================================
// 集中モード（PC）
// ==========================================
// 左右のサイドバーを隠して、記録・ノートを画面の中央に大きく表示する。もう一度押すか Esc で元に戻る。
let focusMode = false;
let _focusPrev = null;
function updateFocusButtonUI() {
    const b = document.getElementById('btnFocus');
    if (!b) return;
    b.classList.toggle('is-on', focusMode);
    const label = document.getElementById('btnFocusLabel');
    if (label) label.textContent = focusMode ? '戻す' : '集中';
    b.title = focusMode ? '集中モードを終える（Esc）' : '集中モード（左右のサイドバーを隠す）  Esc で戻る';
    if (typeof fitBarLabels === 'function') fitBarLabels();
}
function setFocusMode(on) {
    if (on === focusMode) return;
    if (on) {
        _focusPrev = { left: sidebarMode, right: (typeof isRightSidebarOpen !== 'undefined') ? isRightSidebarOpen : true };
        focusMode = true;
        document.body.classList.add('focus-mode');
        sidebarMode = 'none';
        updateSidebars();
        if (typeof isRightSidebarOpen !== 'undefined' && isRightSidebarOpen) toggleRightSidebar(false);
    } else {
        focusMode = false;
        document.body.classList.remove('focus-mode');
        const prev = _focusPrev || { left: 'cal', right: true };
        _focusPrev = null;
        sidebarMode = prev.left;
        updateSidebars();
        if (typeof isRightSidebarOpen !== 'undefined' && isRightSidebarOpen !== prev.right) toggleRightSidebar(prev.right);
    }
    updateFocusButtonUI();
    updateSidebarReopenButtons();
}
function toggleFocusMode() { setFocusMode(!focusMode); }
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !focusMode) return;
    if (document.querySelector('.modal-overlay.active, .lightbox-overlay.active')) return; // 画面（モーダル）を閉じる Esc を優先
    setFocusMode(false);
});

// ==========================================
// 書きかけの自動保存（下書き）
// ==========================================
// 追記・編集画面、ノートの編集中の内容を、この端末の中だけにこまめに残す。
// アプリが落ちたり、画面の外をタップして閉じてしまっても、次に開いたときに戻せる。
// 保存して閉じた・キャンセルを押したときは消す。クラウドには送らない。
const DRAFT_KEY = 'drafts';
const DRAFT_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
let _drafts = { add: null, edit: null, notes: {} };
let _draftsLoaded = false;
let _draftTimer = null;
let _draftWrite = Promise.resolve();
const _noteDirty = new Set();

async function initDrafts() {
    wireDrafts();
    let d = null;
    try { d = await getDBData(DRAFT_KEY); } catch (e) {}
    const now = Date.now();
    const fresh = x => x && x.savedAt && (now - Date.parse(x.savedAt)) < DRAFT_MAX_AGE_MS;
    _drafts = { add: null, edit: null, notes: {} };
    if (d && typeof d === 'object') {
        if (fresh(d.add)) _drafts.add = d.add;
        if (fresh(d.edit) && findLogById(d.edit.dateStr, d.edit.id)) _drafts.edit = d.edit;
        if (d.notes && typeof d.notes === 'object') for (const id of Object.keys(d.notes)) {
            if (fresh(d.notes[id]) && notebookData.some(n => n.id === id)) _drafts.notes[id] = d.notes[id];
        }
    }
    _draftsLoaded = true;
    _writeDrafts();
    showDraftNotices();
}

function _writeDrafts() {
    if (typeof _tabInactive !== 'undefined' && _tabInactive) return _draftWrite;
    const snap = JSON.parse(JSON.stringify(_drafts));
    _draftWrite = _draftWrite.then(() => setDBData(DRAFT_KEY, snap)).catch(e => console.warn('書きかけの保存に失敗しました', e));
    return _draftWrite;
}

function scheduleDraftSave(delay = 700) {
    if (!_draftsLoaded) return;
    clearTimeout(_draftTimer);
    _draftTimer = setTimeout(() => { flushDrafts(); }, delay);
}

async function _imagesToRefs(list) {
    const out = [];
    for (const s of list) {
        if (isDataImage(s)) {
            try { const h = await hashImage(s); await storeImage(h, s); out.push(IDB_IMG_PREFIX + h); } catch (e) { /* 取れなかった写真は下書きに入れない */ }
        } else out.push(s);
    }
    return out;
}
async function _htmlImagesToRefs(html) {
    const found = Array.from(new Set(html.match(DATA_URI_RE) || []));
    if (!found.length) return html;
    const map = new Map();
    for (const s of found) { try { const h = await hashImage(s); await storeImage(h, s); map.set(s, IDB_IMG_PREFIX + h); } catch (e) {} }
    return html.replace(DATA_URI_RE, m => map.get(m) || m);
}
async function _htmlRefsToImages(html) {
    const hashes = new Set(); let m; const re = new RegExp(IDB_REF_RE.source, 'g');
    while ((m = re.exec(html))) hashes.add(m[1]);
    const map = new Map();
    for (const h of hashes) { const d = await getImageData(h); if (d) { map.set(h, d); _hashByData.set(d, h); } }
    return html.replace(IDB_REF_RE, (x, h) => map.get(h) || x);
}

// 今の画面の状態から下書きを作り直して保存する
async function flushDrafts() {
    if (!_draftsLoaded) return;
    clearTimeout(_draftTimer);
    const now = new Date().toISOString();
    const jobs = [];

    const addOpen = document.getElementById('addModal')?.classList.contains('active');
    if (addOpen) {
        const text = document.getElementById('journalInputText').value;
        const photos = [...currentAddPhotos];
        if (!text.trim() && !photos.length && !currentAddTags.length) _drafts.add = null;
        else {
            const snap = { text, category: selectedAddCategory, msgType: currentAddMsgType, slot: _addSlot ? { ..._addSlot } : null, photos: [], tags: [...currentAddTags], savedAt: now };
            _drafts.add = snap;
            jobs.push(_imagesToRefs(photos).then(r => { if (_drafts.add === snap) snap.photos = r; }));
        }
    }

    const editOpen = document.getElementById('editModal')?.classList.contains('active');
    if (editOpen && currentEditTarget && currentEditTarget.id) {
        const { dateStr, id } = currentEditTarget;
        const log = findLogById(dateStr, id);
        const text = document.getElementById('editInputText').value;
        const changed = log && (text !== (log.text || '') || selectedEditCategory !== (log.category || 'ライフログ') || JSON.stringify(currentEditTags) !== JSON.stringify(log.tags || []));
        if (changed) _drafts.edit = { dateStr, id, text, category: selectedEditCategory, msgType: currentEditMsgType, tags: [...currentEditTags], savedAt: now };
        else if (_drafts.edit && _drafts.edit.id === id) _drafts.edit = null;
    }

    for (const id of Array.from(_noteDirty)) {
        const area = document.getElementById(`nb_content_view_${id}`);
        if (!area || !area.classList.contains('is-editing')) continue;
        const titleEl = document.getElementById(`nb_title_edit_${id}`);
        const note = notebookData.find(n => n.id === id);
        const snap = { title: titleEl ? titleEl.value : (note ? note.title : ''), content: '', baseUpdatedAt: note ? (note.updatedAt || '') : '', savedAt: now };
        _drafts.notes[id] = snap;
        const html = area.innerHTML;
        jobs.push(_htmlImagesToRefs(html).then(h => { if (_drafts.notes[id] === snap) snap.content = h; }));
    }

    await Promise.all(jobs);
    return _writeDrafts();
}

function clearDraft(kind, id) {
    clearTimeout(_draftTimer);
    if (kind === 'add') _drafts.add = null;
    else if (kind === 'edit') { if (!id || (_drafts.edit && _drafts.edit.id === id)) _drafts.edit = null; }
    else if (kind === 'note') { delete _drafts.notes[id]; _noteDirty.delete(id); }
    if (_draftsLoaded) _writeDrafts();
}

function _fmtDraftTime(iso) {
    const d = new Date(iso); if (isNaN(d)) return '';
    const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    const today = new Date(); const same = d.toDateString() === today.toDateString();
    return same ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
function _setDraftBar(m, text) {
    const bar = document.getElementById(m === 'add' ? 'addDraftBar' : 'editDraftBar');
    if (!bar) return;
    if (!text) { bar.style.display = 'none'; return; }
    bar.querySelector('.draft-bar-text').textContent = text;
    bar.style.display = '';
}

// 追記・編集画面を開いたときに書きかけを戻す
function restoreModalDraft(m) {
    _setDraftBar(m, '');
    if (m === 'add') {
        const d = _drafts.add; if (!d) return;
        document.getElementById('journalInputText').value = d.text || '';
        if (d.category && categories.some(c => c.name === d.category)) {
            selectedAddCategory = d.category;
            renderModalCategoryChips('add', selectedAddCategory);
            updateMsgTypeVisibility('add', selectedAddCategory);
        }
        setMessageType('add', d.msgType || 'normal');
        if (d.slot && d.slot.date) { _addSlot = { ...d.slot }; refreshAddSlotUI(); }
        currentAddPhotos = Array.isArray(d.photos) ? [...d.photos] : [];
        renderPhotoPreviews('add');
        currentAddTags = sanitizeTagList(d.tags); renderTagSection('add');
        _setDraftBar('add', `書きかけを戻しました（${_fmtDraftTime(d.savedAt)}）`);
    } else {
        const d = _drafts.edit;
        if (!d || !currentEditTarget || d.id !== currentEditTarget.id) return;
        document.getElementById('editInputText').value = d.text || '';
        if (d.category && categories.some(c => c.name === d.category)) {
            selectedEditCategory = d.category;
            renderModalCategoryChips('edit', selectedEditCategory);
            updateMsgTypeVisibility('edit', selectedEditCategory);
        }
        setMessageType('edit', d.msgType || 'normal');
        if (Array.isArray(d.tags)) { currentEditTags = sanitizeTagList(d.tags); renderTagSection('edit'); }
        _setDraftBar('edit', `編集途中の内容を戻しました（${_fmtDraftTime(d.savedAt)}）`);
    }
}

function discardModalDraft(m) {
    if (m === 'add') {
        clearDraft('add');
        _addSlot = null; refreshAddSlotUI();
        document.getElementById('journalInputText').value = '';
        currentAddPhotos = []; resetModalPhotoQuality('add'); renderPhotoPreviews('add');
        currentAddTags = []; renderTagSection('add');
        setMessageType('add', 'normal');
    } else {
        const t = currentEditTarget;
        clearDraft('edit');
        const log = t && findLogById(t.dateStr, t.id);
        if (log) {
            document.getElementById('editInputText').value = log.text || '';
            selectedEditCategory = log.category || 'ライフログ';
            renderModalCategoryChips('edit', selectedEditCategory);
            updateMsgTypeVisibility('edit', selectedEditCategory);
            setMessageType('edit', log.slackType || (log.isSlack ? 'incoming' : 'normal'));
            currentEditTags = Array.isArray(log.tags) ? [...log.tags] : []; renderTagSection('edit');
        }
    }
    _setDraftBar(m, '');
}

function cancelAddModal() { clearDraft('add'); _setDraftBar('add', ''); closeModal('addModal'); }
function cancelEditModal() { clearDraft('edit'); _setDraftBar('edit', ''); closeModal('editModal'); }

// 起動時：前回の書きかけが残っていれば、画面下に控えめに知らせる
function showDraftNotices() {
    const items = [];
    if (_drafts.add) items.push({ key: 'add', label: '書きかけの記録があります', open: () => openAddModal(), discard: () => clearDraft('add') });
    if (_drafts.edit) items.push({ key: 'edit', label: '編集途中の記録があります', open: () => { const d = _drafts.edit; if (d) openEditModal(d.dateStr, d.id); }, discard: () => clearDraft('edit') });
    for (const id of Object.keys(_drafts.notes)) {
        const n = notebookData.find(x => x.id === id);
        const title = (_drafts.notes[id].title || (n && n.title) || '無題').slice(0, 18);
        items.push({ key: 'note_' + id, label: `ノート「${title}」の書きかけがあります`, open: () => restoreNoteDraft(id), discard: () => clearDraft('note', id) });
    }
    if (!items.length) return;
    let box = document.getElementById('appToastBox');
    if (!box) { box = document.createElement('div'); box.id = 'appToastBox'; box.className = 'app-toast-box'; document.body.appendChild(box); }
    items.slice(0, 3).forEach(it => {
        const t = document.createElement('div');
        t.className = 'app-toast draft-toast'; t.setAttribute('role', 'status'); t.dataset.draft = it.key;
        t.innerHTML = `<span class="draft-toast-text"></span><span class="draft-toast-actions"><button type="button" class="draft-toast-btn ghost">破棄</button><button type="button" class="draft-toast-btn">開く</button></span>`;
        t.querySelector('.draft-toast-text').textContent = it.label;
        const [bDiscard, bOpen] = t.querySelectorAll('button');
        bDiscard.onclick = (e) => { e.stopPropagation(); it.discard(); t.remove(); };
        bOpen.onclick = (e) => { e.stopPropagation(); t.remove(); it.open(); };
        t.onclick = null;
        box.appendChild(t);
        setTimeout(() => t.remove(), 20000); // 消えても下書きは残る（次回また知らせる）
    });
}

async function restoreNoteDraft(id) {
    const d = _drafts.notes[id]; if (!d) return;
    if (!notebookData.some(n => n.id === id)) { clearDraft('note', id); return; }
    const content = await _htmlRefsToImages(d.content || '');
    if (typeof jumpFromGlobalSearchToNotebook === 'function') jumpFromGlobalSearchToNotebook(id);
    let area = null;
    for (let i = 0; i < 40 && !area; i++) { await new Promise(r => setTimeout(r, 60)); area = document.getElementById(`nb_content_view_${id}`); }
    if (!area) { showToast('ノートを開けませんでした。もう一度お試しください。'); return; }
    enableNotebookEdit(id);
    const titleEl = document.getElementById(`nb_title_edit_${id}`);
    if (titleEl && typeof d.title === 'string') titleEl.value = d.title;
    if (content) area.innerHTML = content;
    _noteDirty.add(id);
    recordNotebookHistory(id, true);
    showToast('書きかけを戻しました。確認して「保存」してください。キャンセルすると書きかけは消えます。', 6000);
}

// 既存の処理に「変わったら下書きを保存」を差し込む
let _draftsWired = false;
function wireDrafts() {
    if (_draftsWired) return; _draftsWired = true;
    const wrap = (name, after) => {
        const orig = window[name];
        if (typeof orig !== 'function') return;
        window[name] = function (...args) { const r = orig.apply(this, args); try { after(...args); } catch (e) {} return r; };
    };
    wrap('renderPhotoPreviews', () => scheduleDraftSave());
    wrap('renderModalCategoryChips', () => scheduleDraftSave());
    wrap('setMessageType', () => scheduleDraftSave());
    wrap('changeAddSlot', () => scheduleDraftSave());
    wrap('openAddModal', () => restoreModalDraft('add'));
    wrap('openEditModal', () => restoreModalDraft('edit'));
    wrap('recordNotebookHistory', (id) => { if (id) { _noteDirty.add(id); scheduleDraftSave(1500); } });
    wrap('saveNotebookEdit', (id) => clearDraft('note', id));
    wrap('cancelNotebookEdit', (id) => clearDraft('note', id));
    // 画面の外をタップして閉じたときは、その時点の内容を残す
    const origOutside = window.outsideClose;
    window.outsideClose = function (e, id) {
        if ((id === 'addModal' || id === 'editModal') && e.target.id === id) flushDrafts();
        return origOutside.apply(this, arguments);
    };
    document.addEventListener('input', (e) => {
        const t = e.target;
        if (t && (t.id === 'journalInputText' || t.id === 'editInputText')) scheduleDraftSave();
    }, true);
    // アプリを切り替えた・閉じたときはすぐ残す（iPhoneはこの後に終了されることがある）
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDrafts(); });
    window.addEventListener('pagehide', () => { flushDrafts(); });
}


// ==========================================
// 容量メーターとバックアップのお知らせ（設定 > データ）
// ==========================================
// ・この端末：ブラウザが数えた、このアプリの使用量（記録・画像・アプリのファイルを含む）
// ・クラウドの画像：Supabase Storage の自分のフォルダの合計（無料枠 1GB に対して）
// ・バックアップ：この端末で最後に「データのエクスポート」をした日。間隔を過ぎたら設定アイコンに点を付けて知らせる
const CLOUD_STORAGE_LIMIT_BYTES = 1000 * 1000 * 1000; // 無料枠 1GB（少なめに見積もる）
const CLOUD_USAGE_WARN_RATIO = 0.8;
const CLOUD_USAGE_KEY = 'daily_journal_cloud_usage';
const BACKUP_LAST_KEY = 'daily_journal_last_backup_at';
const BACKUP_INTERVAL_KEY = 'daily_journal_backup_interval';
const BACKUP_NAG_KEY = 'daily_journal_backup_nag_at';
const DAY_MS = 86400000;

function formatBytes(b) {
    if (!b) return '0KB';
    if (b >= 1000 * 1000 * 1000) return (b / 1e9).toFixed(2) + 'GB';
    if (b >= 1000 * 1000) return (b / 1e6).toFixed(1) + 'MB';
    return Math.max(1, Math.round(b / 1000)) + 'KB';
}
function _daysAgoText(iso) {
    const t = Date.parse(iso || '');
    if (isNaN(t)) return '';
    const d = Math.floor((Date.now() - t) / DAY_MS);
    return d <= 0 ? '今日' : `${d}日前`;
}

// ---- バックアップ ----
function getBackupIntervalDays() {
    const v = parseInt(localStorage.getItem(BACKUP_INTERVAL_KEY) || '30', 10);
    return [0, 14, 30, 90].includes(v) ? v : 30;
}
function changeBackupInterval(v) {
    localStorage.setItem(BACKUP_INTERVAL_KEY, String(parseInt(v, 10) || 0));
    updateSettingsAlertDot();
    renderStorageStatus(false);
}
function markBackupDone() {
    try { localStorage.setItem(BACKUP_LAST_KEY, new Date().toISOString()); } catch (e) {}
    document.querySelectorAll('.app-toast[data-backup-nag]').forEach(t => t.remove());
    updateSettingsAlertDot();
    const page = document.getElementById('settingsPageData');
    if (page && page.classList.contains('active')) renderStorageStatus(false);
}
function _hasAnyData() {
    return Object.keys(journalData).length > 0 || notebookData.length > 0;
}
function isBackupOverdue() {
    const days = getBackupIntervalDays();
    if (!days || !_hasAnyData()) return false;
    const last = Date.parse(localStorage.getItem(BACKUP_LAST_KEY) || '');
    return isNaN(last) || (Date.now() - last) > days * DAY_MS;
}

// 設定アイコンの点：同期の問題（supabase-sync.js）とバックアップの期限切れをまとめて表示する
function updateSettingsAlertDot() {
    const sync = window._syncAlertState || { level: null, text: '' };
    const backup = isBackupOverdue();
    const level = sync.level === 'error' ? 'error' : (sync.level === 'warn' || backup ? 'warn' : null);
    const dot = document.getElementById('syncAlertDot');
    if (dot) { dot.classList.toggle('warn', level === 'warn'); dot.classList.toggle('error', level === 'error'); }
    const notes = [];
    if (sync.level) notes.push(`同期：${sync.text}`);
    if (backup) notes.push('バックアップの時期です');
    const btn = document.getElementById('btnSettings');
    if (btn) btn.title = notes.length ? `設定（${notes.join('／')}）` : '設定';
    const dataTab = document.getElementById('tabBtnData');
    if (dataTab) dataTab.classList.toggle('has-alert', backup);
}

// 起動時：期限を過ぎていたら、画面下に控えめに知らせる（同じお知らせは1週間に1回まで）
function maybeShowBackupReminder() {
    if (!isBackupOverdue()) return;
    const lastNag = Date.parse(localStorage.getItem(BACKUP_NAG_KEY) || '');
    if (!isNaN(lastNag) && Date.now() - lastNag < 7 * DAY_MS) return;
    localStorage.setItem(BACKUP_NAG_KEY, new Date().toISOString());
    const last = localStorage.getItem(BACKUP_LAST_KEY);
    const label = last ? `前回のバックアップから${_daysAgoText(last).replace('前', '')}たちました` : 'まだバックアップを書き出していません';
    let box = document.getElementById('appToastBox');
    if (!box) { box = document.createElement('div'); box.id = 'appToastBox'; box.className = 'app-toast-box'; document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'app-toast draft-toast'; t.setAttribute('role', 'status'); t.dataset.backupNag = '1';
    t.innerHTML = `<span class="draft-toast-text"></span><span class="draft-toast-actions"><button type="button" class="draft-toast-btn ghost">あとで</button><button type="button" class="draft-toast-btn">書き出す</button></span>`;
    t.querySelector('.draft-toast-text').textContent = '💾 ' + label;
    const [bLater, bExport] = t.querySelectorAll('button');
    bLater.onclick = (e) => { e.stopPropagation(); t.remove(); };
    bExport.onclick = (e) => { e.stopPropagation(); t.remove(); exportData(); };
    t.onclick = null;
    box.appendChild(t);
    setTimeout(() => t.remove(), 20000);
}

// ---- クラウドの使用量 ----
function _loadCloudUsage() {
    try { const v = JSON.parse(localStorage.getItem(CLOUD_USAGE_KEY) || 'null'); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
}
let _cloudCheckRunning = false;
// force=false のときは、前回の結果が6時間以内ならそれを使う（一覧の取得にも通信量がかかるため）
async function refreshCloudStorageStatus(force = false) {
    if (_cloudCheckRunning || typeof measureCloudImages !== 'function' || !isCloudLoggedIn() || !navigator.onLine) { renderStorageStatus(false); return; }
    const prev = _loadCloudUsage();
    const fresh = prev && prev.userId === supabaseUser.id && (Date.now() - Date.parse(prev.checkedAt || 0)) < 6 * 3600000;
    if (!force && fresh) { renderStorageStatus(false); return; }
    _cloudCheckRunning = true;
    const btn = document.getElementById('storageCloudRefreshBtn');
    if (btn) { btn.disabled = true; btn.textContent = '調べています…'; }
    try {
        const r = await measureCloudImages();
        if (r) localStorage.setItem(CLOUD_USAGE_KEY, JSON.stringify(r));
        if (r && r.bytes >= CLOUD_STORAGE_LIMIT_BYTES * CLOUD_USAGE_WARN_RATIO) {
            showToast(`⚠️ クラウドの画像が無料枠の${Math.round(r.bytes / CLOUD_STORAGE_LIMIT_BYTES * 100)}%に達しています。設定 > クラウド の「不要な画像を削除」や、設定 > データ の「過去の写真をまとめて縮小」で空きを作れます。`, 15000);
        }
    } catch (e) {
        console.warn('クラウドの使用量を調べられませんでした', e);
    } finally {
        _cloudCheckRunning = false;
        if (btn) { btn.disabled = false; btn.textContent = 'もう一度調べる'; }
        renderStorageStatus(false);
    }
}

function _remainingText(u) {
    if (!u || !u.perDay || u.perDay < 1000) return u && u.perDay !== null && u.perDay < 1000 ? '最近はほとんど増えていません' : '';
    const days = (CLOUD_STORAGE_LIMIT_BYTES - u.bytes) / u.perDay;
    if (days <= 0) return '';
    const span = days >= 730 ? `約${Math.floor(days / 365)}年` : days >= 60 ? `約${Math.floor(days / 30)}か月` : `約${Math.floor(days)}日`;
    return `最近のペース（1日あたり約${formatBytes(u.perDay)}）なら、あと${span}使えます`;
}

// 表示を作る。withCheck=true なら、必要に応じてクラウドも調べ直す
async function renderStorageStatus(withCheck = true) {
    const $ = id => document.getElementById(id);
    if (!$('storageStatusBox')) return;

    // この端末
    try {
        const est = (navigator.storage && navigator.storage.estimate) ? await navigator.storage.estimate() : null;
        $('storageDeviceValue').textContent = est && typeof est.usage === 'number' ? `約${formatBytes(est.usage)}` : '確認できません';
        const imgCount = typeof _storedImageHashes !== 'undefined' ? _storedImageHashes.size : 0;
        const persisted = (navigator.storage && navigator.storage.persisted) ? await navigator.storage.persisted().catch(() => false) : false;
        $('storageDeviceNote').textContent = `画像 ${imgCount} 枚を含む（端末内では画像を文字で保存するため、実際の写真より約1.3倍大きく数えられます）` + (persisted ? '。空き容量が減っても、ブラウザが勝手に消さない設定になっています。' : '');
    } catch (e) { $('storageDeviceValue').textContent = '確認できません'; }

    // クラウドの画像
    const loggedIn = typeof isCloudLoggedIn === 'function' && isCloudLoggedIn();
    const meter = $('storageCloudMeter'), fill = $('storageCloudMeterFill'), refresh = $('storageCloudRefreshBtn');
    if (!loggedIn) {
        $('storageCloudValue').textContent = '未ログイン';
        $('storageCloudNote').textContent = 'ログインすると、無料枠（1GB）に対する使用量を表示します。';
        meter.style.display = 'none'; refresh.style.display = 'none';
    } else {
        refresh.style.display = '';
        const u = _loadCloudUsage();
        if (u && u.userId === supabaseUser.id) {
            const ratio = Math.min(1, u.bytes / CLOUD_STORAGE_LIMIT_BYTES);
            $('storageCloudValue').textContent = `${formatBytes(u.bytes)} / 1GB（${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}%）`;
            meter.style.display = '';
            fill.style.width = Math.max(1, ratio * 100) + '%';
            meter.classList.toggle('is-warn', ratio >= CLOUD_USAGE_WARN_RATIO);
            const lines = [`画像 ${u.count} 枚（使われていない画像も含む）`, _remainingText(u), `${_daysAgoText(u.checkedAt) === '今日' ? '今日' : _daysAgoText(u.checkedAt)}の時点`].filter(Boolean);
            $('storageCloudNote').textContent = lines.join('・');
        } else {
            $('storageCloudValue').textContent = '…';
            meter.style.display = 'none';
            $('storageCloudNote').textContent = '調べています…';
        }
        if (withCheck) refreshCloudStorageStatus(false);
    }

    // オフライン起動
    const st = typeof getOfflineReadyState === 'function' ? await getOfflineReadyState() : 'unsupported';
    $('offlineReadyValue').textContent = st === 'ready' ? '✅ 準備できています' : st === 'preparing' ? '準備中…' : '使えません';
    $('offlineReadyNote').textContent = st === 'ready' ? '電波がなくても起動できます（記録は本体に保存され、つながったときに送信されます）。'
        : st === 'preparing' ? '一度オンラインで開いておくと、次回から電波がなくても起動できます。'
        : 'この開き方ではオフライン起動は使えません（いつものURLから開くと使えます）。';

    // バックアップ
    const last = localStorage.getItem(BACKUP_LAST_KEY);
    const overdue = isBackupOverdue();
    $('backupLastValue').textContent = last ? `${_daysAgoText(last)}（${new Date(last).toLocaleDateString('ja-JP')}）` : 'まだありません';
    $('backupLastValue').classList.toggle('is-warn', overdue);
    $('backupLastNote').textContent = (overdue ? '⚠️ バックアップの時期です。' : '') + 'この端末で「データのエクスポート」をした日です。書き出したファイルは、パソコンやクラウドドライブなど、この端末以外の場所にも保存しておくと安心です。';
    $('backupIntervalSelect').value = String(getBackupIntervalDays());
    updateSettingsAlertDot();
}

// 起動後：点の表示と、バックアップのお知らせ。クラウドの使用量は1日1回だけ裏で調べる（80%を超えたら知らせる）
(async function initStorageAndBackupNotices() {
    try { await appDataReady; } catch (e) { return; }
    updateSettingsAlertDot();
    setTimeout(maybeShowBackupReminder, 5000);
    setTimeout(() => {
        const u = _loadCloudUsage();
        const stale = !u || (Date.now() - Date.parse(u.checkedAt || 0)) > DAY_MS;
        if (stale && typeof isCloudLoggedIn === 'function' && isCloudLoggedIn()) refreshCloudStorageStatus(true);
    }, 30000);
})();


// ==========================================
// カテゴリのボタン：4列で同じ幅に並べ、入りきらない名前だけ文字を小さくする
// ==========================================
// 並べ方は style.css（.category-chips-wrap を4列のマスにする）。ここでは、はみ出す文字だけを縮める（最小 9.5px）。
let _chipMeasureCtx = null;
function fitCategoryChips(root) {
    if (!root) return;
    if (!_chipMeasureCtx) _chipMeasureCtx = document.createElement('canvas').getContext('2d');
    const ctx = _chipMeasureCtx;
    const run = () => root.querySelectorAll('.category-chip').forEach(el => {
        el.style.fontSize = '';
        const cs = getComputedStyle(el);
        const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
        if (avail <= 0) return; // まだ画面に出ていない
        // ※ボタンの中で測ると、はみ出した分が正しく取れないので、同じ書体で文字の幅だけを測る
        const measure = size => { ctx.font = `${cs.fontWeight} ${size}px ${cs.fontFamily}`; return ctx.measureText(el.textContent).width; };
        let size = parseFloat(cs.fontSize) || 12.5;
        const base = size;
        while (measure(size) > avail && size > 9.5) size -= 0.5;
        if (size !== base) el.style.fontSize = size + 'px';
    });
    run();
    // 画面を開いた直後は幅が決まっていないことがあるので、表示されてからもう一度測る
    requestAnimationFrame(() => requestAnimationFrame(run));
}
window.addEventListener('resize', () => {
    ['addCategoryChipsContainer', 'editCategoryChipsContainer', 'changeNotebookCategoryChipsContainer'].forEach(id => fitCategoryChips(document.getElementById(id)));
});

document.addEventListener('click', e => {
    const b = e.target.closest ? e.target.closest('[data-orphan]') : null;
    if (!b) return;
    const o = findOrphanCategories().find(x => x.name === b.dataset.orphan);
    if (o) openCategoryFateModal('orphan', o.name, o.usage);
});
