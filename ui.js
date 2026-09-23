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

function triggerSmoothViewSwitch(updateCallback) {
    saveCurrentScrollPositions();
    const container = document.getElementById('journalCarouselContainer');
    isProgrammaticScroll = true;
    container.classList.add('is-transitioning');
    setTimeout(() => {
        updateCallback();
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

function smoothScrollToPhotoDate(dateKey) {
    const container = document.getElementById('journalCarouselContainer');
    let t = container.querySelector(`[data-date="${dateKey}"]`);
    if (!t) {
        const panels = Array.from(container.querySelectorAll('.card-carousel-panel[data-date]'));
        t = panels.find(p => p.dataset.date >= dateKey) || panels[panels.length - 1];
    }
    if (t) {
        isProgrammaticScroll = true;
        if (t.dataset.key) lastPhotoPanelKey = t.dataset.key;
        container.scrollTo({ left: t.offsetLeft - container.offsetLeft, behavior: 'smooth' });
        clearTimeout(programmaticScrollTimer);
        programmaticScrollTimer = setTimeout(() => { isProgrammaticScroll = false; }, 500);
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

function resizeImageFile(file, maxDimension = 1400, quality = 0.85) {
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
                resolve(cvs.toDataURL('image/jpeg', quality));
            };
            img.onerror = reject; img.src = e.target.result;
        };
        reader.onerror = reject; reader.readAsDataURL(file);
    });
}
function triggerPhotoSelect(m) { document.getElementById(m === 'add' ? 'addPhotoInput' : 'editPhotoInput').click(); }
async function handlePhotosSelected(e, m) {
    const files = Array.from(e.target.files); if (!files.length) return;
    for (const f of files) {
        try {
            const b = await resizeImageFile(f);
            if (m === 'add') currentAddPhotos.push(b); else currentEditPhotos.push(b);
        } catch (err) {}
    }
    renderPhotoPreviews(m); e.target.value = "";
}
function renderPhotoPreviews(m) {
    const c = document.getElementById(m === 'add' ? 'addPhotoPreviewsContainer' : 'editPhotoPreviewsContainer');
    const p = m === 'add' ? currentAddPhotos : currentEditPhotos;
    c.innerHTML = "";
    if (!p.length) { c.classList.remove('has-photos'); return; }
    c.classList.add('has-photos');
    p.forEach((d, i) => {
        const div = document.createElement('div'); div.className = 'photo-preview-item';
        div.innerHTML = `<img src="${d}"><button class="photo-preview-del-btn" onclick="removePhotoAtIndex('${m}', ${i})">✕</button>`;
        c.appendChild(div);
    });
}
function removePhotoAtIndex(m, i) { if (m === 'add') currentAddPhotos.splice(i, 1); else currentEditPhotos.splice(i, 1); renderPhotoPreviews(m); }
function openLightbox(s) { document.getElementById('lightboxImg').src = s; document.getElementById('lightboxModal').classList.add('active'); }
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
    
    if (currentFilter.mode === 'all') {
        if (isSlackMsg && typeSlackSettings['all'] === false) {
            return false;
        }
        return true;
    }
    
    const cat = item.category || "ライフログ";
    const catType = getLogCategoryType(cat);
    
    if (isSlackMsg && !isSlackEnabledForType(catType)) {
        return false;
    }

    if (currentFilter.mode === 'category') return cat === currentFilter.value;
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
    
    const allBtn = document.createElement('div');
    allBtn.className = `cat-filter-all-btn ${currentFilter.mode === 'all' ? 'selected' : ''}`;
    allBtn.innerHTML = `<div style="display: flex; align-items: center; gap: 9px;"><span style="font-size: 18px;">🌐</span><span class="cat-filter-name">すべて表示 (All)</span></div>`;
    allBtn.onclick = () => selectFilter('all'); c.appendChild(allBtn);

    const types = appTypes.filter(t => categories.some(ca => (ca.type || "一般") === t));
    types.forEach(t => {
        const card = document.createElement('div'); card.className = 'cat-filter-type-card';
        const isT = currentFilter.mode === 'type' && currentFilter.value === t;
        const row = document.createElement('button'); row.className = `cat-filter-type-row-btn ${isT ? 'selected' : ''}`;
        row.innerHTML = `<div class="cat-filter-type-title-area"><span class="cat-filter-type-icon">${getTypeIcon(t)}</span><span class="cat-filter-type-title">${escapeHtml(t)}</span><span class="cat-filter-type-subtext">${isT ? '(全件選択中)' : '(タイプ全件)'}</span></div>`;
        row.onclick = () => selectFilter('type', t); card.appendChild(row);

        const wrap = document.createElement('div'); wrap.className = 'cat-filter-chips-grid';
        categories.filter(ca => (ca.type || "一般") === t).forEach(cat => {
            const isC = currentFilter.mode === 'category' && currentFilter.value === cat.name;
            const b = document.createElement('button'); b.className = `cat-filter-subchip ${isC ? 'selected' : ''}`;
            b.innerHTML = `<span>${escapeHtml(cat.name)}</span>`;
            b.onclick = () => selectFilter('category', cat.name); wrap.appendChild(b);
        });
        card.appendChild(wrap); c.appendChild(card);
    });
}

function updateCategoryButtonUI() {
    const b = document.getElementById('btnCategory'), l = document.getElementById('btnCategoryLabel');
    if (!b || !l) return;
    if (currentFilter.mode === 'all') { l.textContent = "カテゴリ"; b.classList.remove('active-filter'); }
    else { l.textContent = currentFilter.value; b.classList.add('active-filter'); }
}

function switchSettingsTab(t) {
    // ★ 'cloud' タブを配列に追加しました
    ['general', 'types', 'categories', 'data', 'cloud', 'sync'].forEach(p => {
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
        if (i) i.classList.toggle('selected', calendarScope === s);
    });

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
    if (bDay) bDay.classList.toggle('active', calendarScope === 'day');
    if (bWeek) bWeek.classList.toggle('active', calendarScope === 'week');
    if (bMonth) bMonth.classList.toggle('active', calendarScope === 'month');
    if (bPhoto) bPhoto.classList.toggle('active', calendarScope === 'photo');

    const isNbEnabled = isNotebookEnabledForCurrentFilter();
    const sbNb = document.getElementById('btnSidebarNotebook');
    if (sbNb) {
        sbNb.style.display = isNbEnabled ? 'flex' : 'none';
        sbNb.classList.toggle('active', calendarScope === 'notebooks');
    }

    const si = document.getElementById('btnViewScopeIcon'), sl = document.getElementById('btnViewScopeLabel'), v = document.getElementById('btnViewScope');
    if (v && si && sl) {
        v.className = 'bar-btn'; 
        if (calendarScope === 'day') { si.textContent = '☀️'; sl.textContent = 'DAILY'; }
        else if (calendarScope === 'week') { si.textContent = '🗓️'; sl.textContent = 'WEEKLY'; v.classList.add('active-scope'); }
        else if (calendarScope === 'month') { si.textContent = '📅'; sl.textContent = 'MONTHLY'; v.classList.add('active-scope'); }
        else if (calendarScope === 'photo') { si.textContent = '📸'; sl.textContent = 'PHOTO'; v.classList.add('active-scope'); }
        else if (calendarScope === 'notebooks') {
            const m = (notebookViewMode === 'linked' || notebookViewMode === 'single') ? 'card' : notebookViewMode;
            if (m === 'card') { si.textContent = '📖'; sl.textContent = 'CARD'; }
            else if (m === 'graph') { si.textContent = '🎯'; sl.textContent = 'GRAPH'; }
            else if (m === 'trash') { si.textContent = '🗑️'; sl.textContent = 'TRASH'; }
            else { si.textContent = '🗂️'; sl.textContent = 'GALLERY'; }
            v.classList.add('notebook-active-scope');
        }
    }

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
    if (clLabel) clLabel.textContent = isNb ? "リンク" : "カレンダー";
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
        if (hasVisibleLogsForDate(dk)) cls.push('has-log');
        
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
        b.onclick = () => {
            if (journalSearchQuery) clearJournalSearch();
            activeDateKey = dk;
            if (!dateList.includes(dk)) { dateList.push(dk); dateList.sort(); }
            renderFullscreenCalendar();
            renderMiniCalendar();

            const c = document.getElementById('journalCarouselContainer');
            if (calendarScope === 'day') {
                if (c.querySelector(`[data-key="${dk}"]`)) smoothScrollToKey(dk);
                else { renderDayCarousel(); smoothScrollToKey(dk); }
            } else if (calendarScope === 'photo') { 
                smoothScrollToPhotoDate(dk);
            } else if (calendarScope === 'week') {
                const { monStr } = getWeekRangeFromDate(dk);
                if (c.querySelector(`[data-key="${monStr}"]`)) smoothScrollToKey(monStr);
                else renderWeekCarousel();
            } else if (calendarScope === 'month') {
                const mPre = dk.substring(0, 7);
                if (c.querySelector(`[data-key="${mPre}"]`)) smoothScrollToKey(mPre);
                else renderMonthCarousel();
            }
            closeModal('fullscreenCalendarModal');
        };
        g.appendChild(b);
    }

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
    jumpToCurrentScopePeriod();
    renderFullscreenCalendar();
    closeModal('fullscreenCalendarModal');
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
    if (!container) return;

    const filteredNotebooks = getFilteredNotebooks();
    const currentNote = filteredNotebooks[currentNotebookIndex] || filteredNotebooks[0];

    if (!currentNote) {
        container.innerHTML = '<div class="connected-side-empty">ノートがありません</div>';
        if (countBadge) countBadge.textContent = '0';
        return;
    }

    const hasLinks = Array.isArray(currentNote.linkedNoteIds) && currentNote.linkedNoteIds.length > 0;
    const linkedNotes = [];
    
    if (hasLinks) {
        currentNote.linkedNoteIds.forEach(lid => {
            const found = notebookData.find(n => n.id === lid && n.status !== 'trash');
            if (found) linkedNotes.push(found);
        });
    }

    if (countBadge) countBadge.textContent = String(linkedNotes.length);

    if (linkedNotes.length === 0) {
        container.innerHTML = `
            <div class="connected-side-empty" style="padding: 40px 10px;">
                <span>🔗 リンクされたノートはありません</span>
            </div>
        `;
        return;
    }

    let html = "";
    linkedNotes.forEach(ln => {
        const catBadgeHtml = buildNotebookCategoryBadge(ln);
        const statusBadgeHtml = buildStatusBadgeHtml(ln.status || 'archive', ln.id);
        const rawContent = (ln.content && ln.content.trim()) ? cleanNotebookPreviewHtml(ln.content) : '<span style="opacity:0.4;">(空のノート)</span>';
        
        const unlinkBtnHtml = window.IS_READONLY_MODE ? '' : `<button type="button" class="nb-unlink-btn" onclick="unlinkNotebook('${currentNote.id}', '${ln.id}', event)" title="このノートとのリンクを解除">✕ 解除</button>`;

        html += `
            <div class="connected-side-card-item notebook-grid-card" onclick="openNotebookLinkedFromPopup('${ln.id}')">
                <h3 class="notebook-grid-title">${escapeHtml(ln.title || '無題のノート')}</h3>
                <div class="notebook-grid-preview">${rawContent}</div>
                <div class="notebook-grid-meta">
                    <div>${unlinkBtnHtml}</div>
                    <div style="display: flex; gap: 4px; align-items: center;">${statusBadgeHtml}${catBadgeHtml}</div>
                </div>
            </div>
        `;
    });
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
    if (currentFilter.mode === 'all') {
        return typeSlackSettings['all'] === true;
    }
    const catType = getLogCategoryType(log.category || "ライフログ");
    return isSlackEnabledForType(catType);
}

function createLogItemHtml(log, dateStr, originalIndex) {
    const catName = log.category || "ライフログ"; const tCls = getCategoryTypeClass(catName);
    const showSlack = shouldShowSlackFormatting(log);
    const sType = showSlack ? (log.slackType || (log.isSlack ? 'incoming' : null)) : null;

    const showCat = (currentFilter.mode === 'all' || currentFilter.mode === 'type');
    const catBadge = showCat ? `<span class="log-category-badge ${tCls}">${escapeHtml(catName)}</span>` : '';
    let sBadge = "";
    if (sType === 'incoming') sBadge = `<span class="slack-direction-badge incoming"><span>📥</span><span>相手から</span></span>`;
    else if (sType === 'outgoing') sBadge = `<span class="slack-direction-badge outgoing"><span>📤</span><span>自分から</span></span>`;

    const p = Array.isArray(log.images) ? log.images : (log.image ? [log.image] : []);
    const pHtml = p.length > 0 ? `<div class="log-photos-grid">` + p.map(img => `<div class="log-photo-thumb-wrap" onclick="event.stopPropagation(); openLightbox(this.querySelector('img').src)"><img class="log-photo-thumb" src="${img}" loading="lazy"></div>`).join('') + `</div>` : "";

    let cHtml = "";
    if (sType === 'incoming') cHtml = `<div class="chat-bubble-card incoming"><div class="chat-bubble-header"><span>💬</span><span>${escapeHtml(catName)}</span></div><div class="chat-bubble-text">${parseLinksAndText(log.text)}</div></div>`;
    else if (sType === 'outgoing') cHtml = `<div class="chat-bubble-card outgoing"><div class="chat-bubble-header"><span>💬</span><span>あなた → ${escapeHtml(catName)}</span></div><div class="chat-bubble-text">${parseLinksAndText(log.text)}</div></div>`;
    else cHtml = `<div class="log-content">${parseLinksAndText(log.text)}</div>`;

    return `<li class="log-item" id="logItem_${dateStr}_${log.id}"><div class="log-header-row"><div class="log-meta-group"><span class="log-badge">${escapeHtml(log.time)}</span>${catBadge}${sBadge}</div><button class="log-edit-btn" onclick="openEditModal('${dateStr}', '${log.id}')"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button></div>${cHtml}${pHtml}</li>`;
}

function getFilteredDayLogs(dStr) {
    const raw = journalData[dStr] || []; const res = [];
    raw.forEach((l, i) => { if (matchesCurrentFilter(l)) res.push({ log: l, index: i }); });
    return res.sort((a, b) => a.log.time.localeCompare(b.log.time));
}

function getActiveFilterBadgeHtml() {
    if (currentFilter.mode === 'type') return `<span class="filter-status-badge type-badge"><span>${getTypeIcon(currentFilter.value)}</span><span>${escapeHtml(currentFilter.value)} (全件)</span></span>`;
    if (currentFilter.mode === 'category') return `<span class="filter-status-badge"><span>🏷️</span><span>${escapeHtml(currentFilter.value)}</span></span>`;
    return '';
}

function getEmptyStateMessage() {
    if (currentFilter.mode === 'type') return `「${currentFilter.value}」タイプの記録はありません`;
    if (currentFilter.mode === 'category') return `「${currentFilter.value}」の記録はありません`;
    return 'まだ記録がありません';
}

function renderRightCards() {
    saveCurrentScrollPositions();
    const container = document.getElementById('journalCarouselContainer');
    if (container) container.classList.remove('grid-mode-active');
    
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

            if (textMatch || catMatch || typeMatch || slackMatch) {
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
        let sHtml = ""; photos.forEach(u => sHtml += `<div class="photo-stage-slide"><img class="photo-stage-full-img" src="${u}" onclick="openLightbox(this.src)" loading="lazy"></div>`);
        const cp = photos.length > 1 ? `<div class="photo-count-pill">📷 1 / ${photos.length}</div>` : '';
        
        let mb = "";
        if (sType === 'incoming') mb = `<div class="chat-bubble-card incoming" style="margin-top: 2px;"><div class="chat-bubble-header"><span>💬</span><span>${escapeHtml(cat)}</span></div><div class="chat-bubble-text">${parseLinksAndText(log.text)}</div></div>`;
        else if (sType === 'outgoing') mb = `<div class="chat-bubble-card outgoing" style="margin-top: 2px;"><div class="chat-bubble-header"><span>💬</span><span>あなた → ${escapeHtml(cat)}</span></div><div class="chat-bubble-text">${parseLinksAndText(log.text)}</div></div>`;
        else mb = `<div class="journal-drawer-text">${parseLinksAndText(log.text)}</div>`;

        const panelKey = `photo_${dateStr}_${log.id}`;
        const p = document.createElement('div'); p.className = 'card-carousel-panel'; p.dataset.key = panelKey; p.dataset.date = dateStr;
        p.innerHTML = `<div class="main-display journal-card-layout"><div class="display-header compact-header"><div class="date-title-wrapper"><span class="date-eyebrow">PHOTO JOURNAL</span><h1 class="date-title">${formatDateHeader(dateStr)}</h1></div><div class="header-actions">${filterBadgeHtml}<span style="font-size: 11px; font-weight: 700; color: var(--text-secondary); opacity: 0.8; margin-right: 4px;">${dateStr}</span><span class="header-badge">${pIdx + 1} / ${pLogs.length}</span></div></div><div class="photo-stage-viewport">${cp}<div class="photo-stage-scroller" onscroll="updateSlideCounter(this)">${sHtml}</div></div><div class="journal-bottom-drawer"><div class="journal-drawer-header"><div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;"><span class="log-badge">${escapeHtml(log.time)}</span><span class="log-category-badge ${tCls}">${escapeHtml(cat)}</span>${sb}</div><button class="log-edit-btn" onclick="openEditModal('${dateStr}', '${log.id}')"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button></div>${mb}</div></div>`;
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
        else { const fb = eM.find(ew => ew.isF) || eM[eM.length - 1]; wToR = [fb]; }
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
    const types = appTypes.filter(t => categories.some(ca => (ca.type || "一般") === t));
    types.forEach(t => {
        const r = document.createElement('div'); r.className = 'category-type-row';
        r.innerHTML = `<div style="display: flex; align-items: center; gap: 5px;"><span style="font-size: 12px;">${getTypeIcon(t)}</span><span class="category-type-name">${escapeHtml(t)}</span></div>`;
        const w = document.createElement('div'); w.className = 'category-chips-wrap';
        categories.filter(ca => (ca.type || "一般") === t).forEach(cat => {
            const b = document.createElement('button'); b.type = 'button'; b.className = `category-chip ${cat.name === cSel ? 'selected' : ''}`; b.textContent = cat.name;
            b.onclick = () => { 
                if (mode === 'add') { 
                    selectedAddCategory = cat.name; 
                    renderModalCategoryChips('add', selectedAddCategory); 
                    updateMsgTypeVisibility('add', cat.name); 
                } else { 
                    selectedEditCategory = cat.name; 
                    renderModalCategoryChips('edit', selectedEditCategory); 
                    updateMsgTypeVisibility('edit', cat.name); 
                } 
            };
            w.appendChild(b);
        });
        r.appendChild(w); c.appendChild(r);
    });
}

function openAddModal() {
    const n = new Date(); document.getElementById('modalCurrentTimeBadge').textContent = `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
    document.getElementById('modalTargetDateBadge').textContent = `今日 (${formatShortDate(getTodayKey())})`;
    document.getElementById('journalInputText').value = "";
    
    if (currentFilter.mode === 'category' && categories.some(c => c.name === currentFilter.value)) selectedAddCategory = currentFilter.value;
    else if (currentFilter.mode === 'type') { const f = categories.find(c => (c.type || "一般") === currentFilter.value); selectedAddCategory = f ? f.name : "ライフログ"; }
    else selectedAddCategory = "ライフログ";
    
    renderModalCategoryChips('add', selectedAddCategory); 
    setMessageType('add', 'normal'); 
    updateMsgTypeVisibility('add', selectedAddCategory);
    currentAddPhotos = []; renderPhotoPreviews('add'); openModal('addModal');
    setTimeout(() => document.getElementById('journalInputText').focus(), 200);
}

function findLogById(dStr, id) {
    return (journalData[dStr] || []).find(l => l.id === id) || null;
}

// 記録は配列の位置ではなくIDで特定する（編集中に同期で並びが変わっても別の記録を上書きしない）
function openEditModal(dStr, id) {
    const log = findLogById(dStr, id); if (!log) return;
    currentEditTarget = { dateStr: dStr, id: id };
    document.getElementById('editModalTimeBadge').textContent = log.time || ""; document.getElementById('editInputText').value = log.text || "";
    selectedEditCategory = log.category || "ライフログ"; 
    renderModalCategoryChips('edit', selectedEditCategory);
    const m = log.slackType || (log.isSlack ? 'incoming' : 'normal'); 
    setMessageType('edit', m); 
    updateMsgTypeVisibility('edit', selectedEditCategory);
    currentEditPhotos = Array.isArray(log.images) ? [...log.images] : (log.image ? [log.image] : []); renderPhotoPreviews('edit');
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
    const t = document.getElementById('journalInputText').value.trim();
    if (!t && !currentAddPhotos.length) { alert("内容または写真を添付してください。"); return; }
    if (!selectedAddCategory) { alert("カテゴリを選択してください。"); return; }
    const n = new Date(); const tStr = `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`; const dStr = getTodayKey();
    if (!journalData[dStr]) journalData[dStr] = [];
    
    const sA = isSlackEnabledForType(getLogCategoryType(selectedAddCategory));

    journalData[dStr].push({ 
        id: generateId('lg_'),
        time: tStr, 
        text: t, 
        category: selectedAddCategory, 
        slackType: (sA && currentAddMsgType !== 'normal') ? currentAddMsgType : null, 
        images: [...currentAddPhotos] 
    });
    
    await saveJournalData();
    
    if (!dateList.includes(dStr)) { dateList.push(dStr); dateList.sort(); }
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
    
    await saveJournalData();
    
    closeModal('editModal'); renderRightCards(); 
    if (sidebarMode === 'cal' && calendarScope !== 'notebooks') renderMiniCalendar();
}

async function deleteFromEditModal() {
    const { dateStr: d, id } = currentEditTarget; if (!d || !id) return;
    if (confirm("この記録を削除しますか？")) { 
        const i = (journalData[d] || []).findIndex(l => l.id === id);
        if (i !== -1) journalData[d].splice(i, 1); 
        if (journalData[d] && !journalData[d].length) delete journalData[d]; 
        
        await saveJournalData();
        
        closeModal('editModal'); 
        triggerSmoothViewSwitch(() => { 
            renderRightCards(); 
            if (sidebarMode === 'cal' && calendarScope !== 'notebooks') renderMiniCalendar(); 
        }); 
    }
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
    if (indicator) indicator.textContent = `${categories.length}/30`;

    const newCatTypeSelect = document.getElementById('newCatType');
    if (newCatTypeSelect) {
        const curVal = newCatTypeSelect.value;
        newCatTypeSelect.innerHTML = appTypes.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
        if (appTypes.includes(curVal)) newCatTypeSelect.value = curVal;
    }

    categories.forEach((cat, i) => {
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
                ${categories.length > 1 ? `<button type="button" class="category-manage-del-btn" onclick="deleteCategory(${i})" title="削除">🗑️</button>` : ''}
            </div>
        `;
        c.appendChild(r);
    });

    setupCategorySortable();
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
            const moved = categories.splice(evt.oldIndex, 1)[0];
            categories.splice(evt.newIndex, 0, moved);
            saveCategories();
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
    if (categories.length >= 30) { alert("最大30件までです。"); return; }
    const n = document.getElementById('newCatName').value.trim(); 
    const selEl = document.getElementById('newCatType');
    const t = selEl ? selEl.value : (appTypes[0] || "一般");
    if (!n) { alert("カテゴリ名を入力してください。"); return; }
    if (categories.some(c => c.name === n)) { alert("同名が存在します。"); return; }
    categories.push({ name: n, type: t }); 
    saveCategories(); 
    document.getElementById('newCatName').value = "";
    renderSettingsCategoryList(); 
    renderSettingsTypeList();
}

function deleteCategory(i) {
    const t = categories[i]; if (!confirm(`「${t.name}」を削除しますか？`)) return;
    categories.splice(i, 1); saveCategories();
    if (currentFilter.mode === 'category' && currentFilter.value === t.name) { currentFilter = { mode: 'all', value: '' }; updateCategoryButtonUI(); }
    else if (currentFilter.mode === 'type' && !categories.some(c => (c.type || "一般") === currentFilter.value)) { currentFilter = { mode: 'all', value: '' }; updateCategoryButtonUI(); }
    renderSettingsCategoryList(); 
    renderSettingsTypeList();
    renderRightCards(); if (sidebarMode === 'cal') updateSidebars();
}

function openSearchModal() {
    const input = document.getElementById('searchInput');
    if (input) input.value = "";
    const clearBtn = document.getElementById('searchClearBtn');
    if (clearBtn) clearBtn.classList.remove('active');
    
    globalSearchTab = 'all';
    globalSearchOperator = 'AND';
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

    if (tokens.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; color: var(--text-secondary); font-size: 13.5px; padding: 40px 10px;">
                キーワードを入力して検索を開始してください
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
        (journalData[d] || []).forEach((l, idx) => {
            const sT = l.slackType || (l.isSlack ? 'incoming' : null);
            const textContent = `${l.text || ''} ${l.category || ''} ${getLogCategoryType(l.category || '')} ${sT === 'incoming' ? '受信 slack 相手' : sT === 'outgoing' ? '送信 slack 自分' : ''}`;

            if (matchesSearchTokens(textContent, tokens, operator)) {
                journalMatches.push({
                    type: 'journal',
                    date: d,
                    time: l.time,
                    text: l.text,
                    category: l.category || 'ライフログ',
                    slackType: sT,
                    index: l.id
                });
            }
        });
    });

    const notebookMatches = [];
    notebookData.filter(n => n.status !== 'trash').forEach(n => {
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
                <span style="font-size: 12px; color: var(--text-secondary);">「${operator}」条件で検索しています。キーワードを変更するか、OR検索をお試しください</span>
            </div>
        `;
        return;
    }

    let html = "";
    displayedItems.forEach(item => {
        if (item.type === 'journal') {
            const catClass = getCategoryTypeClass(item.category);
            let sBadge = "";
            if (item.slackType === 'incoming') sBadge = `<span class="slack-direction-badge incoming" style="font-size:10px;padding:1px 6px;">📥 相手</span>`;
            else if (item.slackType === 'outgoing') sBadge = `<span class="slack-direction-badge outgoing" style="font-size:10px;padding:1px 6px;">📤 自分</span>`;

            html += `
                <div class="search-result-item" onclick="jumpFromGlobalSearchToDay('${item.date}', '${item.index}')">
                    <div class="search-result-header">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <span class="search-type-pill journal">JOURNAL</span>
                            <span>📅 ${item.date} (${item.time})</span>
                        </div>
                        <div style="display:flex; align-items:center; gap:4px;">
                            ${sBadge}
                            <span class="log-category-badge ${catClass}" style="font-size:10px;padding:1px 6px;">${escapeHtml(item.category)}</span>
                        </div>
                    </div>
                    <div class="search-result-text">${escapeHtml(item.text)}</div>
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

    container.innerHTML = html;
}

function jumpFromGlobalSearchToDay(dateStr, targetLogIndex = null) {
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
        h += `<div class="log-item"><div style="display:flex; gap:6px; align-items:center;"><span class="time">${l.time}</span><span class="cat">${escapeHtml(l.category || 'ライフログ')}</span></div>${cH}${ih}</div>`;
    });
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${fd} - Daily Journal</title><style>:root { color-scheme: light dark; --bg: #08080a; --card-bg: #121215; --item-bg: #1a1a1f; --border: rgba(255, 255, 255, 0.08); --text-primary: #ffffff; --text-secondary: #98989f; --accent: #2997ff; --accent-soft: rgba(41, 151, 255, 0.15); } @media (prefers-color-scheme: light) { :root { --bg: #f2f2f7; --card-bg: #ffffff; --item-bg: #f8f8fa; --border: rgba(0, 0, 0, 0.08); --text-primary: #1c1c1e; --text-secondary: #8e8e93; --accent: #007aff; --accent-soft: rgba(0, 122, 255, 0.12); } } * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; } body { background-color: var(--bg); color: var(--text-primary); padding: 30px 16px; display: flex; justify-content: center; } .container { width: 100%; max-width: 640px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 24px; padding: 28px; } header { margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 16px; } .eyebrow { font-size: 13px; font-weight: 700; color: var(--accent); letter-spacing: 0.5px; } h1 { font-size: 24px; font-weight: 700; margin-top: 4px; } .log-list { display: flex; flex-direction: column; gap: 14px; } .log-item { background: var(--item-bg); border: 1px solid var(--border); border-radius: 16px; padding: 16px 18px; display: flex; flex-direction: column; gap: 8px; } .time { font-size: 12px; font-weight: 700; color: var(--accent); background: var(--accent-soft); padding: 2px 8px; border-radius: 8px; } .cat { font-size: 11px; font-weight: 700; background: rgba(128,128,128,0.2); padding: 2px 8px; border-radius: 8px; } .content { font-size: 16px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; } .journal-link { color: var(--accent); text-decoration: none; font-weight: 600; padding: 1px 6px; margin: 0 2px; background: var(--accent-soft); border-radius: 6px; display: inline-flex; align-items: center; gap: 3px; word-break: break-all; }</style></head><body><div class="container"><header><div class="eyebrow">${dStr}</div><h1>${fd}</h1></header><div class="log-list">${h}</div></div></body></html>`;
}

function exportArchiveHtml() {
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

    const rawPayload = JSON.stringify({
        journalData: journalData,
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
                '<div class="log-meta"><span class="log-time">' + (l.time || '') + '</span><span class="log-cat">' + escapeHtml(l.category || 'ライフログ') + '</span></div>' +
                bodyHtml + imgHtml +
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
                    await w.write(generateDayHtmlDocument(d, journalData[d]));
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
                journalDates.forEach(d => {
                    targetFolder.file(d.replace(/-/g, '') + '.html', generateDayHtmlDocument(d, journalData[d]));
                    journalCount++;
                });
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

function exportData() {
    const p = { appTypes, categories, typeSlackSettings, typeNotebookSettings, hideEmptyCards, deviceDisplayMode, journalData, notebookData };
    const a = document.createElement('a'); a.setAttribute("href", "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(p, null, 2)));
    const n = new Date(); a.setAttribute("download", `journal_backup_${n.getFullYear()}${String(n.getMonth()+1).padStart(2,'0')}${String(n.getDate()).padStart(2,'0')}.json`);
    document.body.appendChild(a); a.click(); a.remove();
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
                    if (imp.categories && Array.isArray(imp.categories)) { categories = imp.categories.filter(c => c && typeof c.name === 'string' && c.name.trim()).map(c => ({ name: c.name, type: typeof c.type === 'string' ? c.type : '一般' })); saveCategories(); }
                    if (imp.typeSlackSettings && typeof imp.typeSlackSettings === 'object') { typeSlackSettings = imp.typeSlackSettings; saveTypeSlackSettings(); }
                    if (imp.typeNotebookSettings && typeof imp.typeNotebookSettings === 'object') { typeNotebookSettings = imp.typeNotebookSettings; saveTypeNotebookSettings(); }
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