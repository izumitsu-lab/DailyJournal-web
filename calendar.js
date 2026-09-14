// ==========================================
// calendar.js (カレンダー描画・日付操作・Journal検索)
// ==========================================

let journalSearchQuery = "";

function adjustActiveDateToLatestLog() {
    if (calendarScope === 'day') {
        const withLogs = dateList.filter(d => getFilteredDayLogs(d).length > 0);
        if (withLogs.length > 0 && !withLogs.includes(activeDateKey)) {
            activeDateKey = withLogs[withLogs.length - 1];
            const parts = activeDateKey.split('-');
            miniCalYear = parseInt(parts[0], 10);
            miniCalMonth = parseInt(parts[1], 10) - 1;
        }
    }
}

function formatDateHeader(dateStr) {
    const parts = dateStr.split('-'); const d = new Date(parts[0], parts[1] - 1, parts[2]);
    return `${d.getMonth() + 1}月 ${d.getDate()}日 (${['日', '月', '火', '水', '木', '金', '土'][d.getDay()]})`;
}
function formatShortDate(dateStr) {
    const parts = dateStr.split('-'); const d = new Date(parts[0], parts[1] - 1, parts[2]);
    return `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}(${['日', '月', '火', '水', '木', '金', '土'][d.getDay()]})`;
}

function getWeekRangeFromDate(dateStr) {
    const parts = dateStr.split('-'); const d = new Date(parts[0], parts[1] - 1, parts[2]);
    const diff = d.getDate() - (d.getDay() === 0 ? 6 : d.getDay() - 1);
    const mon = new Date(d.setDate(diff)); const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const f = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    return { monStr: f(mon), sunStr: f(sun), monDate: mon, sunDate: sun };
}
function isDateInWeek(tStr, bStr) { const { monStr, sunStr } = getWeekRangeFromDate(bStr); return tStr >= monStr && tStr <= sunStr; }

function hasVisibleLogsForDate(d) {
    const l = journalData[d] || [];
    if (calendarScope === 'photo') return l.some(i => matchesCurrentFilter(i) && ((i.images && i.images.length > 0) || i.image));
    return l.some(i => matchesCurrentFilter(i));
}

function renderMiniCalendar(anim = null) {
    const titleEl = document.getElementById('miniCalTitle');
    if (titleEl) titleEl.textContent = `${miniCalYear}年 ${miniCalMonth + 1}月`;
    const g = document.getElementById('miniCalGrid');
    if (!g) return;
    g.innerHTML = "";
    g.classList.remove('slide-next', 'slide-prev'); if (anim === 'next') g.classList.add('slide-next'); if (anim === 'prev') g.classList.add('slide-prev');

    const fDi = new Date(miniCalYear, miniCalMonth, 1).getDay(); const lDd = new Date(miniCalYear, miniCalMonth + 1, 0).getDate();
    const todayStr = getTodayKey();

    for (let i = 0; i < fDi; i++) { const e = document.createElement('div'); e.className = 'mini-cal-day empty'; g.appendChild(e); }

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

        b.className = cls.join(' '); b.textContent = d;
        b.onclick = () => {
            // カレンダーの日付タップ時は検索を解除して通常ビューへ復帰
            if (journalSearchQuery) {
                clearJournalSearch();
            }

            activeDateKey = dk;
            if (!dateList.includes(dk)) { dateList.push(dk); dateList.sort(); }
            renderMiniCalendar();
            if (typeof renderFullscreenCalendar === 'function') renderFullscreenCalendar();
            const c = document.getElementById('journalCarouselContainer');

            if (calendarScope === 'day') {
                if (c.querySelector(`[data-key="${dk}"]`)) smoothScrollToKey(dk);
                else { renderDayCarousel(); smoothScrollToKey(dk); }
            } else if (calendarScope === 'photo') { 
                smoothScrollToPhotoDate(dk);
            } else if (calendarScope === 'week') {
                const { monStr } = getWeekRangeFromDate(dk); const a = getActiveCarouselPanel();
                if (a && a.dataset.key === monStr) scrollToTimelineDateInPanel(a, dk, true);
                else if (c.querySelector(`[data-key="${monStr}"]`)) { smoothScrollToKey(monStr); scrollToTimelineDateInPanel(c.querySelector(`[data-key="${monStr}"]`), dk, true); }
                else renderWeekCarousel();
            } else if (calendarScope === 'month') {
                const mPre = dk.substring(0, 7); const a = getActiveCarouselPanel();
                if (a && a.dataset.key === mPre) scrollToTimelineDateInPanel(a, dk, true);
                else if (c.querySelector(`[data-key="${mPre}"]`)) { smoothScrollToKey(mPre); scrollToTimelineDateInPanel(c.querySelector(`[data-key="${mPre}"]`), dk, true); }
                else renderMonthCarousel();
            }
        };
        g.appendChild(b);
    }

    // 検索入力の同期
    const jInput = document.getElementById('journalSearchInput');
    const jClear = document.getElementById('journalSearchClearBtn');
    if (jInput) jInput.value = journalSearchQuery;
    if (jClear) jClear.classList.toggle('active', !!journalSearchQuery);
}

function changeMiniCalMonth(d, a = null) {
    miniCalMonth += d;
    if (miniCalMonth > 11) { miniCalMonth = 0; miniCalYear++; } else if (miniCalMonth < 0) { miniCalMonth = 11; miniCalYear--; }
    renderMiniCalendar(a);
    if (typeof renderFullscreenCalendar === 'function') renderFullscreenCalendar();
}

function setupMiniCalSwipe() {
    const containers = [
        document.getElementById('miniCalContainer'),
        document.getElementById('fsMiniCalContainer')
    ];

    containers.forEach(c => {
        if (!c) return;
        let sX = 0, sY = 0, isS = false;
        c.addEventListener('touchstart', e => { 
            if (e.touches.length !== 1) return; 
            sX = e.touches[0].clientX; 
            sY = e.touches[0].clientY; 
            isS = true; 
        }, { passive: true });

        c.addEventListener('touchend', e => {
            if (!isS) return; 
            isS = false; 
            const diffX = e.changedTouches[0].clientX - sX;
            const diffY = e.changedTouches[0].clientY - sY;
            if (Math.abs(diffX) > 30 && Math.abs(diffX) > Math.abs(diffY)) {
                changeMiniCalMonth(diffX < 0 ? 1 : -1, diffX < 0 ? 'next' : 'prev');
            }
        }, { passive: true });
    });
}

// ==========================================
// Journal 左サイドバー内検索処理
// ==========================================
function handleJournalSearchInput(e) {
    journalSearchQuery = (e.target.value || '').trim();
    const clearBtn = document.getElementById('journalSearchClearBtn');
    if (clearBtn) clearBtn.classList.toggle('active', !!journalSearchQuery);
    renderRightCards();
}

function clearJournalSearch() {
    journalSearchQuery = "";
    const input = document.getElementById('journalSearchInput');
    const clearBtn = document.getElementById('journalSearchClearBtn');
    if (input) {
        input.value = "";
        input.focus();
    }
    if (clearBtn) clearBtn.classList.remove('active');
    renderRightCards();
}

function jumpToCurrentScopePeriod() {
    if (journalSearchQuery) {
        clearJournalSearch();
    }

    // Notebooksモード時は Gallery View（一覧）へ復帰
    if (calendarScope === 'notebooks') {
        if (notebookViewMode !== 'grid') {
            setNotebookViewMode('grid');
        } else {
            renderRightCards();
        }
        return;
    }
    
    const todayStr = getTodayKey(); activeDateKey = todayStr;
    const now = new Date(); miniCalYear = now.getFullYear(); miniCalMonth = now.getMonth();
    if (!dateList.includes(todayStr)) { dateList.push(todayStr); dateList.sort(); }

    updateScopeButtonsUI(); updateJumpButtonLabel(); 
    if (sidebarMode === 'cal') updateSidebars();
    
    const c = document.getElementById('journalCarouselContainer');

    if (calendarScope === 'day') {
        if (c.querySelector(`[data-key="${todayStr}"]`)) smoothScrollToKey(todayStr);
        else { renderDayCarousel(); smoothScrollToKey(todayStr); }
    } else if (calendarScope === 'photo') { 
        smoothScrollToPhotoDate(todayStr);
    } else if (calendarScope === 'week') {
        const { monStr } = getWeekRangeFromDate(todayStr);
        const a = getActiveCarouselPanel();
        if (a && a.dataset.key === monStr) scrollToTimelineDateInPanel(a, todayStr, true);
        else if (c.querySelector(`[data-key="${monStr}"]`)) { smoothScrollToKey(monStr); scrollToTimelineDateInPanel(c.querySelector(`[data-key="${monStr}"]`), todayStr, true); }
        else { renderWeekCarousel(); }
    } else if (calendarScope === 'month') {
        const pre = todayStr.substring(0, 7); const a = getActiveCarouselPanel();
        if (a && a.dataset.key === pre) scrollToTimelineDateInPanel(a, todayStr, true);
        else if (c.querySelector(`[data-key="${pre}"]`)) { smoothScrollToKey(pre); scrollToTimelineDateInPanel(c.querySelector(`[data-key="${pre}"]`), todayStr, true); }
        else { renderMonthCarousel(); }
    }

    setTimeout(() => {
        const p = getActiveCarouselPanel();
        if (p) {
            const m = p.querySelector('.main-display'); if (m) { m.classList.remove('highlight-today-jump'); void m.offsetWidth; m.classList.add('highlight-today-jump'); }
            const b = p.querySelector('.header-badge'); if (b) { b.classList.remove('today-pulse'); void b.offsetWidth; b.classList.add('today-pulse'); }
        }
    }, 150);
}

function jumpToDayFromTimeline(dStr) {
    if (journalSearchQuery) {
        clearJournalSearch();
    }
    triggerSmoothViewSwitch(() => {
        if (calendarScope !== 'day' && calendarScope !== 'photo') calendarScope = 'day';
        activeDateKey = dStr; const p = dStr.split('-'); miniCalYear = parseInt(p[0], 10); miniCalMonth = parseInt(p[1], 10) - 1;
        if (!dateList.includes(dStr)) { dateList.push(dStr); dateList.sort(); }
        updateScopeButtonsUI(); updateJumpButtonLabel(); 
        if (sidebarMode === 'cal') updateSidebars(); 
        renderRightCards();
    });
}