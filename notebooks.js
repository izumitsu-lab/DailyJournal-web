// ==========================================
// notebooks.js (ノートブック管理・連携ノート・Graph View・表/引用ペースト対応)
// ==========================================

let notebookSearchQuery = "";
let currentActiveEditorNotebookId = null;
let notebookEditorOriginalBackup = null; // 編集前のバックアップ用（キャンセル時に完全復旧）
const freshNotebookIds = new Set(); // ＋ボタンで作成し、まだ一度も保存確定していないノート
const notebookEditConflicts = new Map(); // 編集中に他端末で削除されたノート（id -> {deleted, editedAt}）
const _conflictCopiedKeys = new Set();

// 同期モジュールから呼ばれる：このノートを編集中なら、編集開始時点の更新時刻を返す（編集中でなければ null）
function getEditingNotebookBase(id) {
    if (currentActiveEditorNotebookId !== id || !notebookEditorOriginalBackup || notebookEditorOriginalBackup.id !== id) return null;
    return notebookEditorOriginalBackup.baseUpdatedAt || '';
}

// 編集中に他端末で同じノートが更新・削除されたとき
// - 更新：画面の編集内容は守りつつ、相手の版を「（他の端末の版）」として別ノートに保存（どちらも失わない）
// - 削除：保存すれば編集内容で復元、キャンセルすれば削除を受け入れる
async function handleRemoteEditConflict(id, remote) {
    if (remote.deleted) {
        notebookEditConflicts.set(id, remote);
        showToast('編集中のノートが他の端末で削除されました。「保存」すると編集内容で復元され、「キャンセル」すると削除されます。');
        return;
    }
    const key = id + '@' + remote.updatedAt;
    if (_conflictCopiedKeys.has(key)) return;
    _conflictCopiedKeys.add(key);
    const now = new Date().toISOString();
    const copy = {
        id: generateId('nb_'),
        title: `${remote.title || '無題のノート'}（他の端末の版）`,
        content: remote.content || '',
        category: remote.category || 'ライフログ',
        status: remote.status === 'trash' ? 'archive' : (remote.status || 'active'),
        linkedNoteIds: [],
        createdAt: now,
        updatedAt: now
    };
    notebookData.push(copy);
    await saveNotebookData();
    showToast(`編集中に、このノートが他の端末で更新されました。相手の版は「${copy.title}」として別ノートに保存しました。`);
}

// Undo / Redo 履歴管理（直近10件まで保持）
let editorHistoryStack = [];
let editorHistoryIndex = -1;
let historyDebounceTimer = null;
const MAX_EDITOR_HISTORY = 10;

// 右サイドバー（Linked Notes）の表示・非表示フラグ
let isRightSidebarOpen = true;

// Graph View 内のモード: 'local' (基本) または 'global'
let notebookGraphMode = 'local';

// 関連ノートリンクモーダル用ステート
let currentLinkingNotebookId = null;
let tempSelectedLinkIds = new Set();
let linkModalSearchQuery = "";

// ノートカテゴリ変更用ステート
let currentTargetNotebookIdForCategory = null;
let selectedNewNotebookCategory = "ライフログ";

// ノートエクスポート用ステート
let currentExportingNotebookId = null;

// Graph View (Canvas) 用ステート
let graphAnimId = null;
let graphNodes = [];
let graphEdges = [];
let draggedNode = null;
let hoveredNode = null;
let graphPointerStart = { x: 0, y: 0 };
let isGraphDragMoved = false;

function isNotebookEnabledForCurrentFilter() {
    if (currentFilter.mode === 'all') {
        return typeNotebookSettings['all'] !== false;
    } else if (currentFilter.mode === 'type') {
        return typeNotebookSettings[currentFilter.value] !== false;
    } else if (currentFilter.mode === 'category') {
        const t = getLogCategoryType(currentFilter.value);
        return typeNotebookSettings[t] !== false;
    }
    return true;
}

// 検索語句・カテゴリフィルターに合致するノートを抽出
function getFilteredNotebooks() {
    const q = (notebookSearchQuery || '').trim().toLowerCase();
    const isTrashMode = (notebookViewMode === 'trash');

    const statusPriority = {
        active: 1,
        permanent: 2,
        archive: 3,
        trash: 4
    };

    const list = notebookData.filter(n => {
        if (!matchesCurrentFilter(n)) return false;

        const noteStatus = n.status || 'archive';
        
        if (isTrashMode) {
            if (noteStatus !== 'trash') return false;
        } else {
            if (noteStatus === 'trash') return false;
        }

        if (!q) return true;

        const titleText = (n.title || '').toLowerCase();
        const contentText = stripHtml(n.content || '').toLowerCase();
        const categoryText = (n.category || '').toLowerCase();

        return titleText.includes(q) || contentText.includes(q) || categoryText.includes(q);
    });

    list.sort((a, b) => {
        const pA = statusPriority[a.status || 'archive'] || 99;
        const pB = statusPriority[b.status || 'archive'] || 99;
        if (pA !== pB) return pA - pB;
        const dateA = a.updatedAt || a.createdAt || '';
        const dateB = b.updatedAt || b.createdAt || '';
        return dateB.localeCompare(dateA);
    });

    return list;
}

function renderNotebookSidebar() {
    const modes = [
        { id: 'nb-nav-grid', mode: 'grid' },
        { id: 'nb-nav-linked', mode: 'card' },
        { id: 'nb-nav-graph', mode: 'graph' },
        { id: 'nb-nav-trash', mode: 'trash' }
    ];

    modes.forEach(m => {
        const el = document.getElementById(m.id);
        if (!el) return;
        const isActive = (notebookViewMode === m.mode || (m.mode === 'card' && notebookViewMode === 'linked'));
        el.className = `todo-nav-item ${isActive ? 'active' : ''}`;
        
        if (m.mode === 'trash') {
            el.style.backgroundColor = isActive ? 'var(--reset-btn-soft)' : 'transparent';
            el.style.borderColor = isActive ? 'rgba(255, 69, 58, 0.3)' : 'transparent';
            const txt = el.querySelector('.todo-nav-text');
            if (txt) txt.style.color = isActive ? 'var(--reset-btn-bg)' : '';
        } else {
            el.style.backgroundColor = isActive ? 'var(--notebook-soft)' : 'transparent';
            el.style.borderColor = isActive ? 'rgba(48, 209, 88, 0.3)' : 'transparent';
            const txt = el.querySelector('.todo-nav-text');
            if (txt) txt.style.color = isActive ? 'var(--notebook-color)' : '';
        }
    });

    const searchInput = document.getElementById('notebookSearchInput');
    const clearBtn = document.getElementById('notebookSearchClearBtn');
    if (searchInput) searchInput.value = notebookSearchQuery;
    if (clearBtn) clearBtn.classList.toggle('active', !!notebookSearchQuery);
}

function handleNotebookSearchInput(e) {
    notebookSearchQuery = e.target.value;
    const clearBtn = document.getElementById('notebookSearchClearBtn');
    if (clearBtn) clearBtn.classList.toggle('active', !!notebookSearchQuery);

    currentNotebookIndex = 0;
    renderRightCards();
}

function clearNotebookSearch() {
    notebookSearchQuery = "";
    const searchInput = document.getElementById('notebookSearchInput');
    const clearBtn = document.getElementById('notebookSearchClearBtn');
    if (searchInput) {
        searchInput.value = "";
        searchInput.focus();
    }
    if (clearBtn) clearBtn.classList.remove('active');

    currentNotebookIndex = 0;
    renderRightCards();
}

function setNotebookViewMode(mode, targetIndex = null) {
    if (graphAnimId) {
        cancelAnimationFrame(graphAnimId);
        graphAnimId = null;
    }
    triggerSmoothViewSwitch(() => {
        notebookViewMode = (mode === 'linked') ? 'card' : mode;
        if (targetIndex !== null) {
            currentNotebookIndex = targetIndex;
        }
        if (sidebarMode === 'cal') renderNotebookSidebar();
        updateScopeButtonsUI();
        renderRightCards();
    });
}

// 下部メニューの「表示ビュー切り替え」から Notebooks の Gallery/Card/Graph を直接選択
function selectNotebookViewFromModal(mode) {
    if (graphAnimId) {
        cancelAnimationFrame(graphAnimId);
        graphAnimId = null;
    }
    saveCurrentScrollPositions();
    triggerSmoothViewSwitch(() => {
        if (['day', 'week', 'month', 'photo'].includes(calendarScope)) {
            lastJournalScope = calendarScope;
            lastJournalDateKey = activeDateKey;
            previousCalendarScope = calendarScope;
        }
        calendarScope = 'notebooks';
        notebookViewMode = mode;
        updateScopeButtonsUI(); updateJumpButtonLabel();
        if (sidebarMode === 'cal') updateSidebars();
        renderRightCards();
    });
    closeModal('viewScopeModal');
}

// ==========================================
// ノート本文HTMLのサニタイズ（XSS対策）
// ==========================================
// ノート本文はペーストや他端末からの同期で外部由来のHTMLが入りうるため、
// 画面に出す前・保存する前に必ず sanitizeNoteHtml を通す。
// アプリ自身が本文に埋め込むインラインハンドラ（画像サイズ切替・表の行列追加）だけは、完全一致で許可する。
const _NOTE_HANDLER_ALLOW = [
    /^event\.stopPropagation\(\);?$/,
    /^event\.preventDefault\(\);?$/,
    /^setNotebookImageSize\(this, 'size-(full|half|quarter)', '[A-Za-z0-9_-]{1,100}'\)$/,
    /^removeNotebookImage\(this, '[A-Za-z0-9_-]{1,100}'\)$/,
    /^handleNotebookTableAdd(Column|Row)Click\(this, event\);?$/
];
const _NOTE_URI_RE = /^(?:(?:(?:f|ht)tps?|mailto|tel|idbimg|sbimg):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;
const _NOTE_FORBID_TAGS = ['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'link', 'meta', 'base', 'form', 'svg', 'math', 'template', 'noscript'];
let _purifyReady = false;

function _isAllowedNoteHandler(v) {
    const t = (v || '').trim();
    return _NOTE_HANDLER_ALLOW.some(re => re.test(t));
}

function _setupPurify() {
    if (_purifyReady || !window.DOMPurify || !DOMPurify.isSupported) return _purifyReady;
    DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
        const name = (data.attrName || '').toLowerCase();
        if (name.startsWith('on')) {
            if (_isAllowedNoteHandler(data.attrValue)) data.forceKeepAttr = true;
            else data.keepAttr = false;
        } else if (name === 'contenteditable') {
            if (String(data.attrValue).toLowerCase() === 'false') data.forceKeepAttr = true;
            else data.keepAttr = false;
        }
    });
    _purifyReady = true;
    return true;
}

// DOMPurify が読み込めなかった場合（オフライン初回など）の保守的なフォールバック
function _fallbackSanitize(html) {
    const tpl = document.createElement('template'); // template内は不活性（画像読込もスクリプト実行もしない）
    tpl.innerHTML = html;
    tpl.content.querySelectorAll(_NOTE_FORBID_TAGS.join(',')).forEach(el => el.remove());
    tpl.content.querySelectorAll('*').forEach(el => {
        for (const attr of Array.from(el.attributes)) {
            const n = attr.name.toLowerCase();
            if (n.startsWith('on')) { if (!_isAllowedNoteHandler(attr.value)) el.removeAttribute(attr.name); }
            else if (n === 'contenteditable') { if (attr.value.toLowerCase() !== 'false') el.removeAttribute(attr.name); }
            else if (['href', 'src', 'xlink:href', 'action', 'formaction', 'srcset', 'background', 'poster'].includes(n)) {
                const v = attr.value.replace(/[\u0000-\u0020]/g, '');
                const ok = (n === 'src' && /^data:image\//i.test(v)) || (_NOTE_URI_RE.test(v) && !/^(javascript|vbscript|data):/i.test(v));
                if (!ok || n === 'srcset') el.removeAttribute(attr.name);
            }
        }
    });
    return tpl.innerHTML;
}

let _noteSanitizeCache = new Map();
function sanitizeNoteHtml(html) {
    if (!html) return '';
    if (typeof html !== 'string') return '';
    const cached = _noteSanitizeCache.get(html);
    if (cached !== undefined) return cached;
    let out;
    if (_setupPurify()) {
        out = DOMPurify.sanitize(html, {
            FORBID_TAGS: _NOTE_FORBID_TAGS,
            ADD_ATTR: ['target', 'contenteditable'],
            ALLOWED_URI_REGEXP: _NOTE_URI_RE
        });
    } else {
        out = _fallbackSanitize(html);
    }
    if (_noteSanitizeCache.size > 400) _noteSanitizeCache = new Map();
    _noteSanitizeCache.set(html, out);
    _noteSanitizeCache.set(out, out);
    return out;
}

// 不活性な <template> で解析する（div.innerHTML と違い、img onerror 等が発火しない）
function _parseInert(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html || '';
    return tpl;
}

function stripHtml(html) {
    if (!html) return '';
    return _parseInert(html).content.textContent || '';
}

function openNotebookLinked(id) {
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) return;

    let filteredNotebooks = getFilteredNotebooks();
    let idx = filteredNotebooks.findIndex(n => n.id === id);

    if (idx === -1) {
        notebookSearchQuery = "";
        const searchInput = document.getElementById('notebookSearchInput');
        if (searchInput) searchInput.value = "";
        if (currentFilter.mode !== 'all') {
            currentFilter = { mode: 'all', value: '' };
            updateCategoryButtonUI();
        }
        filteredNotebooks = getFilteredNotebooks();
        idx = filteredNotebooks.findIndex(n => n.id === id);
    }

    const targetIdx = (idx !== -1) ? idx : 0;
    currentNotebookIndex = targetIdx;

    if (notebookViewMode !== 'card' && notebookViewMode !== 'linked') {
        setNotebookViewMode('card', targetIdx);
    } else {
        const scroller = document.getElementById('connectedCenterScroller');
        const cardSlide = scroller ? scroller.querySelector(`[data-id="${id}"]`) : null;
        
        if (cardSlide && scroller) {
            ensureCardContentRendered(scroller, Number(cardSlide.dataset.index) || 0);
            scroller.scrollTo({ left: cardSlide.offsetLeft, behavior: 'auto' });
            const targetNote = notebookData.find(n => n.id === id);
            if (targetNote) {
                updateConnectedRightSidebar(targetNote);
                if (typeof renderFullscreenLinkedNotes === 'function') renderFullscreenLinkedNotes();
            }
        } else {
            renderRightCards();
        }
    }
}

function renderNotebookCarousel() {
    const container = document.getElementById('journalCarouselContainer');
    container.innerHTML = "";
    container.classList.remove('grid-mode-active');
    
    if (graphAnimId) {
        cancelAnimationFrame(graphAnimId);
        graphAnimId = null;
    }

    const filterBadgeHtml = getActiveFilterBadgeHtml();
    const filteredNotebooks = getFilteredNotebooks();
    const q = (notebookSearchQuery || '').trim();

    if (filteredNotebooks.length === 0 && notebookViewMode !== 'graph') {
        const isTrashMode = (notebookViewMode === 'trash');
        let emptyMsg = isTrashMode ? 'Trash is empty' : 'ノートがありません';
        if (q) emptyMsg = `「${escapeHtml(q)}」に一致するノートはありません`;

        const panel = document.createElement('div');
        panel.className = 'card-carousel-panel';
        panel.innerHTML = `
            <div class="main-display" style="--tab-color: ${isTrashMode ? 'var(--reset-btn-bg)' : 'var(--notebook-color)'};">
                <div class="display-header compact-header">
                    <div class="date-title-wrapper">
                        <span class="date-eyebrow" style="color: ${isTrashMode ? 'var(--reset-btn-bg)' : 'var(--notebook-color)'};">${isTrashMode ? 'NOTEBOOKS • TRASH' : 'NOTEBOOKS'}</span>
                        <h1 class="date-title">${isTrashMode ? '🗑️ Trash' : '📔 ノートブック'}</h1>
                    </div>
                    <div class="header-actions">${filterBadgeHtml}</div>
                </div>
                <div class="empty-state">
                    <span style="font-size: 32px;">${isTrashMode ? '🗑️' : '🔍'}</span>
                    <span style="font-size: 15px; font-weight: 600; margin-top: 8px;">${emptyMsg}</span>
                    <span style="font-size: 13px; opacity: 0.7;">${q ? '検索キーワードを変更してください' : (isTrashMode ? 'Trash に入っているノートはありません' : '下部の「＋」ボタンから追加できます')}</span>
                </div>
            </div>
        `;
        container.appendChild(panel);
        return;
    }

    if (notebookViewMode === 'grid') {
        renderGridMode(container, filteredNotebooks, filterBadgeHtml);
    } else if (notebookViewMode === 'trash') {
        renderTrashMode(container, filteredNotebooks, filterBadgeHtml);
    } else if (notebookViewMode === 'card' || notebookViewMode === 'linked' || notebookViewMode === 'single') {
        renderCardViewMode(container, filteredNotebooks, filterBadgeHtml);
    } else if (notebookViewMode === 'graph') {
        renderGraphMode(container, filterBadgeHtml);
    }
}

function buildNotebookCategoryBadge(n) {
    const catClass = getCategoryTypeClass(n.category || 'ライフログ');
    const catName = escapeHtml(n.category || 'ライフログ');
    if (window.IS_READONLY_MODE) {
        return `<span class="log-category-badge ${catClass}" style="font-size: 10px; padding: 2px 6px;">${catName}</span>`;
    }
    return `<span class="log-category-badge ${catClass} nb-category-badge-clickable" onclick="event.stopPropagation(); openChangeNotebookCategoryModal('${n.id}')" title="クリックしてカテゴリを変更" style="font-size: 10px; padding: 2px 7px;">${catName}</span>`;
}

function cleanNotebookPreviewHtml(html) {
    if (!html) return '';
    const tpl = _parseInert(sanitizeNoteHtml(html));
    tpl.content.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
    return tpl.innerHTML;
}

function createNotebookCardElement(n) {
    const card = document.createElement('div');
    card.className = 'notebook-grid-card';
    card.onclick = () => openNotebookLinked(n.id);
    
    const catBadgeHtml = buildNotebookCategoryBadge(n);
    const statusBadgeHtml = buildStatusBadgeHtml(n.status || 'archive', n.id);
    const rawContent = (n.content && n.content.trim()) ? cleanNotebookPreviewHtml(n.content) : '<span style="opacity:0.4;">(空のノート)</span>';
    
    card.innerHTML = `
        <h3 class="notebook-grid-title">${escapeHtml(n.title || '無題のノート')}</h3>
        <div class="notebook-grid-preview">${rawContent}</div>
        <div class="notebook-grid-meta" style="justify-content: flex-end; gap: 6px;">
            ${statusBadgeHtml}
            ${catBadgeHtml}
        </div>
    `;
    return card;
}

function renderGridMode(container, filteredNotebooks, filterBadgeHtml) {
    container.classList.add('grid-mode-active');
    
    const gridWrapper = document.createElement('div');
    gridWrapper.className = 'notebook-grid-wrapper';
    
    const gridHeader = document.createElement('div');
    gridHeader.className = 'display-header compact-header';
    gridHeader.style.alignItems = 'flex-start';
    gridHeader.innerHTML = `
        <div class="date-title-wrapper" style="width: 100%;">
            <span class="date-eyebrow" style="color: var(--notebook-color); margin-bottom: 4px;">NOTEBOOKS</span>
            <h1 class="date-title">Gallery View</h1>
        </div>
        <div class="header-actions" style="margin-top: 2px;">
            ${filterBadgeHtml}
            <span class="header-badge" style="background: var(--notebook-color); color: #fff;">${filteredNotebooks.length} 冊</span>
        </div>
    `;
    gridWrapper.appendChild(gridHeader);

    const gridLogsContainer = document.createElement('div');
    gridLogsContainer.className = 'logs-container-wrapper';
    gridLogsContainer.style.padding = '10px 4px';

    const groupsContainer = document.createElement('div');
    groupsContainer.className = 'nb-status-groups-container';

    const sectionDefs = [
        { key: 'active', label: 'Active', titleColor: 'active' },
        { key: 'permanent', label: 'Permanent', titleColor: 'permanent' },
        { key: 'archive', label: 'Archive', titleColor: 'archive' }
    ];

    const colsClass = (galleryColumns === '3' || galleryColumns === '4' || galleryColumns === '5') ? `cols-${galleryColumns}` : 'cols-auto';

    sectionDefs.forEach(sec => {
        const notesInSec = filteredNotebooks.filter(n => (n.status || 'archive') === sec.key);
        if (notesInSec.length === 0) return;

        const groupDiv = document.createElement('div');
        groupDiv.className = 'nb-status-group';

        const headerDiv = document.createElement('div');
        headerDiv.className = 'nb-status-section-header';
        headerDiv.innerHTML = `
            <div class="nb-status-section-title-wrap">
                <span class="nb-status-dot ${sec.titleColor}"></span>
                <span class="nb-status-section-title ${sec.titleColor}">${sec.label}</span>
            </div>
            <span class="nb-status-section-count ${sec.titleColor}">${notesInSec.length}</span>
        `;
        groupDiv.appendChild(headerDiv);

        const groupGrid = document.createElement('div');
        groupGrid.className = `notebook-grid-container ${colsClass}`;
        notesInSec.forEach(n => {
            groupGrid.appendChild(createNotebookCardElement(n));
        });
        groupDiv.appendChild(groupGrid);

        groupsContainer.appendChild(groupDiv);
    });

    gridLogsContainer.appendChild(groupsContainer);
    gridWrapper.appendChild(gridLogsContainer);
    container.appendChild(gridWrapper);
}

function renderTrashMode(container, filteredNotebooks, filterBadgeHtml) {
    container.classList.add('grid-mode-active');
    
    const gridWrapper = document.createElement('div');
    gridWrapper.className = 'notebook-grid-wrapper';
    
    const gridHeader = document.createElement('div');
    gridHeader.className = 'display-header compact-header';
    gridHeader.style.alignItems = 'flex-start';
    gridHeader.innerHTML = `
        <div class="date-title-wrapper" style="width: 100%;">
            <span class="date-eyebrow" style="color: var(--reset-btn-bg); margin-bottom: 4px;">NOTEBOOKS • TRASH</span>
            <h1 class="date-title">🗑️ Trash</h1>
        </div>
        <div class="header-actions" style="margin-top: 2px;">
            ${filterBadgeHtml}
            <button type="button" class="data-action-btn" onclick="emptyTrashAll()" style="color: var(--reset-btn-bg); border-color: var(--reset-btn-bg); background: var(--reset-btn-soft); font-size: 11px; padding: 5px 10px;">Trash を空にする</button>
            <span class="header-badge" style="background: var(--reset-btn-bg); color: #fff;">${filteredNotebooks.length} 件</span>
        </div>
    `;
    gridWrapper.appendChild(gridHeader);

    const gridLogsContainer = document.createElement('div');
    gridLogsContainer.className = 'logs-container-wrapper';
    gridLogsContainer.style.padding = '10px 4px';

    const colsClass = (galleryColumns === '3' || galleryColumns === '4' || galleryColumns === '5') ? `cols-${galleryColumns}` : 'cols-auto';
    const gridContainer = document.createElement('div');
    gridContainer.className = `notebook-grid-container ${colsClass}`;

    filteredNotebooks.forEach(n => {
        const card = document.createElement('div');
        card.className = 'notebook-grid-card';
        card.style.cursor = 'default';

        const catBadgeHtml = buildNotebookCategoryBadge(n);
        const rawContent = (n.content && n.content.trim()) ? cleanNotebookPreviewHtml(n.content) : '<span style="opacity:0.4;">(空のノート)</span>';

        card.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
                <h3 class="notebook-grid-title" style="margin-bottom: 0;">${escapeHtml(n.title || '無題のノート')}</h3>
                ${catBadgeHtml}
            </div>
            <div class="notebook-grid-preview">${rawContent}</div>
            <div class="trash-card-actions" onclick="event.stopPropagation()">
                <button type="button" class="trash-action-btn restore" onclick="restoreNotebookFromTrash('${n.id}')" title="Trashから戻す">
                    ↺ 元に戻す
                </button>
                <button type="button" class="trash-action-btn purge" onclick="purgeNotebookPermanent('${n.id}')" title="完全に削除する">
                    ✕ 完全削除
                </button>
            </div>
        `;
        gridContainer.appendChild(card);
    });

    gridLogsContainer.appendChild(gridContainer);
    gridWrapper.appendChild(gridLogsContainer);
    container.appendChild(gridWrapper);
}

async function emptyTrashAll() {
    const trashNotes = notebookData.filter(n => n.status === 'trash');
    if (!trashNotes.length) return;
    if (!confirm(`Trash 内の ${trashNotes.length} 件のノートを完全に削除しますか？\n（この操作は取り消せません）`)) return;

    const trashIds = new Set(trashNotes.map(n => n.id));
    notebookData = notebookData.filter(n => !trashIds.has(n.id));

    notebookData.forEach(other => {
        if (Array.isArray(other.linkedNoteIds)) {
            other.linkedNoteIds = other.linkedNoteIds.filter(id => !trashIds.has(id));
        }
    });

    await saveNotebookData();
    renderRightCards();
}

// ==========================================
// Undo / Redo 履歴管理ロジック
// ==========================================
function recordNotebookHistory(id, immediate = false) {
    if (immediate) {
        clearTimeout(historyDebounceTimer);
        doRecordHistory(id);
    } else {
        clearTimeout(historyDebounceTimer);
        historyDebounceTimer = setTimeout(() => {
            doRecordHistory(id);
        }, 350);
    }
}

function doRecordHistory(id) {
    const titleEdit = document.getElementById(`nb_title_edit_${id}`);
    const contentArea = document.getElementById(`nb_content_view_${id}`);
    if (!contentArea) return;

    const titleVal = titleEdit ? titleEdit.value : "";
    const contentVal = contentArea.innerHTML;

    if (editorHistoryIndex >= 0 && editorHistoryIndex < editorHistoryStack.length) {
        const cur = editorHistoryStack[editorHistoryIndex];
        if (cur.title === titleVal && cur.content === contentVal) {
            return;
        }
    }

    if (editorHistoryIndex < editorHistoryStack.length - 1) {
        editorHistoryStack = editorHistoryStack.slice(0, editorHistoryIndex + 1);
    }

    editorHistoryStack.push({ title: titleVal, content: contentVal });

    if (editorHistoryStack.length > MAX_EDITOR_HISTORY) {
        editorHistoryStack.shift();
    }
    editorHistoryIndex = editorHistoryStack.length - 1;

    updateUndoRedoButtonUI(id);
}

function undoNotebookEdit(id) {
    if (editorHistoryIndex <= 0) return;
    editorHistoryIndex--;
    applyHistorySnapshot(id, editorHistoryStack[editorHistoryIndex]);
}

function redoNotebookEdit(id) {
    if (editorHistoryIndex >= editorHistoryStack.length - 1) return;
    editorHistoryIndex++;
    applyHistorySnapshot(id, editorHistoryStack[editorHistoryIndex]);
}

function applyHistorySnapshot(id, snapshot) {
    if (!snapshot) return;
    const titleEdit = document.getElementById(`nb_title_edit_${id}`);
    const contentArea = document.getElementById(`nb_content_view_${id}`);

    if (titleEdit && snapshot.title !== undefined) {
        titleEdit.value = snapshot.title;
    }
    if (contentArea && snapshot.content !== undefined) {
        contentArea.innerHTML = snapshot.content;
    }

    const idx = notebookData.findIndex(x => x.id === id);
    if (idx !== -1) {
        if (snapshot.title !== undefined) notebookData[idx].title = snapshot.title;
        if (snapshot.content !== undefined) notebookData[idx].content = snapshot.content;
    }

    updateUndoRedoButtonUI(id);
}

function updateUndoRedoButtonUI(id) {
    const undoBtn = document.getElementById(`nb_undo_btn_${id}`);
    const redoBtn = document.getElementById(`nb_redo_btn_${id}`);

    const canUndo = (editorHistoryIndex > 0);
    const canRedo = (editorHistoryIndex >= 0 && editorHistoryIndex < editorHistoryStack.length - 1);

    if (undoBtn) {
        undoBtn.disabled = !canUndo;
        undoBtn.classList.toggle('is-disabled', !canUndo);
    }
    if (redoBtn) {
        redoBtn.disabled = !canRedo;
        redoBtn.classList.toggle('is-disabled', !canRedo);
    }
}

// ==========================================
// 引用・bubble・コードブロック 汎用トグル
// ==========================================
function toggleNotebookBlockWrapper(id, blockTag, blockClass) {
    const contentArea = document.getElementById(`nb_content_view_${id}`);
    if (!contentArea) return;
    contentArea.focus();

    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);

    let container = range.commonAncestorContainer;
    if (container.nodeType === Node.TEXT_NODE) container = container.parentElement;
    const existingBlock = container ? container.closest(`.${blockClass}`) : null;

    if (existingBlock) {
        const innerHtml = existingBlock.innerHTML.trim();
        const normalDiv = document.createElement('div');
        normalDiv.innerHTML = innerHtml.length > 0 ? innerHtml : '<br>';
        existingBlock.parentNode.replaceChild(normalDiv, existingBlock);
        deferCursorToElement(normalDiv, false);
        saveNotebookContentDirect(id);
        recordNotebookHistory(id, true);
        return;
    }

    if (!range.collapsed) {
        const frag = range.extractContents();
        const block = document.createElement(blockTag);
        block.className = blockClass;
        block.appendChild(frag);

        insertNodeAtSelection(block);
        deferCursorToElement(block, false);
        saveNotebookContentDirect(id);
        recordNotebookHistory(id, true);
        return;
    }

    let lineNode = range.startContainer;
    while (lineNode && lineNode.parentElement !== contentArea && lineNode !== contentArea) {
        lineNode = lineNode.parentElement;
    }

    const block = document.createElement(blockTag);
    block.className = blockClass;

    if (lineNode && lineNode !== contentArea) {
        const lineContent = lineNode.innerHTML;
        const isBlank = !lineNode.textContent.trim() && (lineContent === '<br>' || lineContent === '');
        if (isBlank) {
            lineNode.parentNode.replaceChild(block, lineNode);
            placeCursorInEmptyBlock(block);
        } else {
            block.innerHTML = lineContent;
            lineNode.parentNode.replaceChild(block, lineNode);
            deferCursorToElement(block, false);
        }
    } else {
        insertNodeAtSelection(block);
        placeCursorInEmptyBlock(block);
    }

    saveNotebookContentDirect(id);
    recordNotebookHistory(id, true);
}

function placeCursorInEmptyBlock(block) {
    const textNode = document.createTextNode('');
    block.insertBefore(textNode, block.firstChild || null);
    if (!block.querySelector('br') && block.childNodes.length === 1) {
        block.appendChild(document.createElement('br'));
    }
    const range = document.createRange();
    const sel = window.getSelection();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 0);
    sel.removeAllRanges();
    sel.addRange(range);
}

function deferCursorToElement(el, selectAll = false) {
    requestAnimationFrame(() => {
        el.focus && el.focus();
        setCursorToElement(el, selectAll);
    });
}

function insertNotebookQuote(id) { toggleNotebookBlockWrapper(id, 'blockquote', 'nb-quote-block'); }
function insertNotebookBubble(id) { toggleNotebookBlockWrapper(id, 'div', 'nb-ai-prompt-block'); }
function insertNotebookCodeBlock(id) { toggleNotebookBlockWrapper(id, 'pre', 'nb-code-block'); }

function insertNotebookTable(id) {
    const contentArea = document.getElementById(`nb_content_view_${id}`);
    if (!contentArea) return;
    contentArea.focus();

    const wrap = document.createElement('div');
    wrap.className = 'nb-table-wrapper';
    wrap.innerHTML = `
        <table class="nb-editor-table">
            <thead>
                <tr>
                    <th>項目 1</th>
                    <th>項目 2</th>
                    <th>項目 3</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>内容</td>
                    <td>内容</td>
                    <td>内容</td>
                </tr>
            </tbody>
        </table>
    `;

    decorateNotebookTable(wrap);
    insertNodeAtSelection(wrap);
    const firstTh = wrap.querySelector('th');
    if (firstTh) setCursorToElement(firstTh, true);
    saveNotebookContentDirect(id);
    recordNotebookHistory(id, true);
}

function decorateNotebookTable(wrap) {
    const table = wrap.querySelector('table');
    if (!table) return;
    if (wrap.querySelector('.nb-table-add-row-btn')) return;

    const scrollRow = document.createElement('div');
    scrollRow.className = 'nb-table-scroll-row';
    table.parentNode.insertBefore(scrollRow, table);
    scrollRow.appendChild(table);

    const addColBtn = document.createElement('button');
    addColBtn.type = 'button';
    addColBtn.className = 'nb-table-add-col-btn';
    addColBtn.setAttribute('contenteditable', 'false');
    addColBtn.setAttribute('title', '列を追加');
    addColBtn.setAttribute('onmousedown', 'event.preventDefault();');
    addColBtn.setAttribute('onclick', 'handleNotebookTableAddColumnClick(this, event);');
    addColBtn.textContent = '+';
    scrollRow.appendChild(addColBtn);

    const addRowBtn = document.createElement('button');
    addRowBtn.type = 'button';
    addRowBtn.className = 'nb-table-add-row-btn';
    addRowBtn.setAttribute('contenteditable', 'false');
    addRowBtn.setAttribute('title', '行を追加');
    addRowBtn.setAttribute('onmousedown', 'event.preventDefault();');
    addRowBtn.setAttribute('onclick', 'handleNotebookTableAddRowClick(this, event);');
    addRowBtn.textContent = '＋ 行を追加';
    wrap.appendChild(addRowBtn);
}

function handleNotebookTableAddColumnClick(btn, event) {
    if (event) event.stopPropagation();
    const wrap = btn.closest('.nb-table-wrapper');
    const table = wrap ? wrap.querySelector('table') : null;
    if (!table) return;
    handleNotebookTableAddColumn(table);
}

function handleNotebookTableAddRowClick(btn, event) {
    if (event) event.stopPropagation();
    const wrap = btn.closest('.nb-table-wrapper');
    const table = wrap ? wrap.querySelector('table') : null;
    if (!table) return;
    handleNotebookTableAddRow(table);
}

function getNotebookIdFromTableElement(el) {
    const contentArea = el.closest('.notebook-content-view');
    if (!contentArea || !contentArea.id) return null;
    return contentArea.id.replace('nb_content_view_', '');
}

function handleNotebookTableAddColumn(table) {
    const id = getNotebookIdFromTableElement(table);
    const contentArea = id ? document.getElementById(`nb_content_view_${id}`) : null;
    if (contentArea) contentArea.focus();
    addNotebookTableColumn(table);
    if (id) {
        saveNotebookContentDirect(id);
        recordNotebookHistory(id, true);
    }
}

function handleNotebookTableAddRow(table) {
    const id = getNotebookIdFromTableElement(table);
    const contentArea = id ? document.getElementById(`nb_content_view_${id}`) : null;
    if (contentArea) contentArea.focus();
    addNotebookTableRow(table);
    if (id) {
        saveNotebookContentDirect(id);
        recordNotebookHistory(id, true);
    }
}

function addNotebookTableColumn(table) {
    const headerRow = table.querySelector('thead tr');
    if (headerRow) {
        const th = document.createElement('th');
        th.innerHTML = '<br>';
        headerRow.appendChild(th);
    }
    table.querySelectorAll('tbody tr').forEach(tr => {
        const td = document.createElement('td');
        td.innerHTML = '<br>';
        tr.appendChild(td);
    });
    const target = headerRow ? headerRow.lastElementChild : null;
    if (target) setCursorToElement(target, true);
    return target;
}

function addNotebookTableRow(table) {
    const headerRow = table.querySelector('thead tr');
    const anyRow = table.querySelector('tr');
    const colCount = headerRow ? headerRow.children.length : (anyRow ? anyRow.children.length : 1);

    let tbody = table.querySelector('tbody');
    if (!tbody) {
        tbody = document.createElement('tbody');
        table.appendChild(tbody);
    }

    const tr = document.createElement('tr');
    for (let i = 0; i < colCount; i++) {
        const td = document.createElement('td');
        td.innerHTML = '<br>';
        tr.appendChild(td);
    }
    tbody.appendChild(tr);

    const target = tr.firstElementChild;
    if (target) setCursorToElement(target, true);
    return tr;
}

function insertNotebookTableColumnAt(table, index) {
    const headerRow = table.querySelector('thead tr');
    if (headerRow) {
        const th = document.createElement('th');
        th.innerHTML = '<br>';
        headerRow.insertBefore(th, headerRow.children[index] || null);
    }
    table.querySelectorAll('tbody tr').forEach(tr => {
        const td = document.createElement('td');
        td.innerHTML = '<br>';
        tr.insertBefore(td, tr.children[index] || null);
    });
}

function insertNotebookTableRowRelative(table, refCell, position) {
    const refRow = refCell.closest('tr');
    if (!refRow) return;
    const isRefHeader = refRow.parentElement && refRow.parentElement.tagName === 'THEAD';
    const colCount = refRow.children.length;

    let tbody = table.querySelector('tbody');
    if (!tbody) {
        tbody = document.createElement('tbody');
        table.appendChild(tbody);
    }

    const newRow = document.createElement('tr');
    for (let i = 0; i < colCount; i++) {
        const td = document.createElement('td');
        td.innerHTML = '<br>';
        newRow.appendChild(td);
    }

    if (isRefHeader) {
        tbody.insertBefore(newRow, tbody.firstChild);
    } else if (position === 'above') {
        refRow.parentElement.insertBefore(newRow, refRow);
    } else {
        refRow.parentElement.insertBefore(newRow, refRow.nextSibling);
    }
}

function deleteNotebookTableRow(table, row) {
    const tbody = row.closest('tbody');
    if (!tbody) return;
    if (tbody.querySelectorAll('tr').length <= 1) return;
    row.remove();
}

function deleteNotebookTableColumn(table, colIndex) {
    const headerRow = table.querySelector('thead tr');
    if (headerRow && headerRow.children.length <= 1) return;
    if (headerRow && headerRow.children[colIndex]) headerRow.children[colIndex].remove();
    table.querySelectorAll('tbody tr').forEach(tr => {
        if (tr.children[colIndex]) tr.children[colIndex].remove();
    });
}

let activeContextMenuTime = 0;

function handleNotebookTableContextMenu(e, id) {
    const targetEl = e.target.nodeType === Node.TEXT_NODE ? e.target.parentElement : e.target;
    if (!targetEl) return;

    let cell = targetEl.closest('td, th');
    const table = targetEl.closest('table') || (cell ? cell.closest('table') : null);
    if (!table) return;

    if (!cell) {
        const row = targetEl.closest('tr');
        if (row && row.children.length > 0) {
            cell = row.children[0];
        } else {
            cell = table.querySelector('td, th');
        }
    }
    if (!cell) return;

    e.preventDefault();
    e.stopPropagation();

    closeNotebookTableMenu();

    const isHeaderCell = cell.tagName === 'TH';
    const row = cell.parentElement;
    const colIndex = Array.from(row.children).indexOf(cell);
    const bodyRowCount = table.querySelectorAll('tbody tr').length;
    const colCount = row.children.length;

    const items = [
        { label: '↑ 上に行を追加', action: () => insertNotebookTableRowRelative(table, cell, 'above') },
        { label: '↓ 下に行を追加', action: () => insertNotebookTableRowRelative(table, cell, 'below') },
        { label: '← 左に列を追加', action: () => insertNotebookTableColumnAt(table, colIndex) },
        { label: '→ 右に列を追加', action: () => insertNotebookTableColumnAt(table, colIndex + 1) },
    ];
    if (!isHeaderCell && bodyRowCount > 1) {
        items.push({ label: '✕ この行を削除', action: () => deleteNotebookTableRow(table, row), danger: true });
    }
    if (colCount > 1) {
        items.push({ label: '✕ この列を削除', action: () => deleteNotebookTableColumn(table, colIndex), danger: true });
    }

    const menu = document.createElement('div');
    menu.className = 'nb-table-context-menu';
    menu.id = 'nbTableContextMenu';

    menu.addEventListener('mousedown', (ev) => ev.stopPropagation());
    menu.addEventListener('click', (ev) => ev.stopPropagation());
    menu.addEventListener('contextmenu', (ev) => ev.preventDefault());

    items.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nb-table-menu-item' + (item.danger ? ' danger' : '');
        btn.textContent = item.label;
        btn.onmousedown = (ev) => ev.preventDefault();
        btn.onclick = (ev) => {
            ev.stopPropagation();
            enableNotebookEdit(id, 'content');
            item.action();
            saveNotebookContentDirect(id);
            recordNotebookHistory(id, true);
            closeNotebookTableMenu();
        };
        menu.appendChild(btn);
    });

    document.body.appendChild(menu);

    const menuWidth = 175;
    const menuHeight = items.length * 36 + 16;
    let posX = e.clientX;
    let posY = e.clientY;

    if (posX + menuWidth > window.innerWidth) {
        posX = Math.max(8, window.innerWidth - menuWidth - 12);
    }
    if (posY + menuHeight > window.innerHeight) {
        posY = Math.max(8, window.innerHeight - menuHeight - 12);
    }

    menu.style.left = `${posX}px`;
    menu.style.top = `${posY}px`;

    activeContextMenuTime = Date.now();

    const handleOutsideClick = (ev) => {
        if (Date.now() - activeContextMenuTime < 150) return;
        const curMenu = document.getElementById('nbTableContextMenu');
        if (curMenu && !curMenu.contains(ev.target)) {
            closeNotebookTableMenu();
            document.removeEventListener('pointerdown', handleOutsideClick, true);
            document.removeEventListener('contextmenu', handleOutsideClick, true);
        }
    };

    setTimeout(() => {
        document.addEventListener('pointerdown', handleOutsideClick, true);
        document.addEventListener('contextmenu', handleOutsideClick, true);
    }, 50);
}

function closeNotebookTableMenu() {
    const existing = document.getElementById('nbTableContextMenu');
    if (existing) existing.remove();
}

// ツールバー描画
function buildNotebookToolbarHtml(n) {
    if (window.IS_READONLY_MODE) return '';
    return `
        <div class="notebook-toolbar" id="nb_toolbar_${n.id}">
            <!-- Undo / Redo -->
            <button type="button" class="nb-tool-btn history-btn is-disabled" id="nb_undo_btn_${n.id}" disabled onmousedown="event.preventDefault(); undoNotebookEdit('${n.id}');" title="元に戻す (Ctrl+Z)">↩</button>
            <button type="button" class="nb-tool-btn history-btn is-disabled" id="nb_redo_btn_${n.id}" disabled onmousedown="event.preventDefault(); redoNotebookEdit('${n.id}');" title="やり直す (Ctrl+Y / Ctrl+Shift+Z)">↪</button>

            <div style="width: 1px; height: 16px; background: var(--item-border); margin: 0 2px;"></div>

            <!-- 文字装飾 -->
            <button type="button" class="nb-tool-btn" onmousedown="event.preventDefault(); document.execCommand('bold', false, null); recordNotebookHistory('${n.id}', true);" title="太字"><b>B</b></button>
            <button type="button" class="nb-tool-btn" onmousedown="event.preventDefault(); document.execCommand('italic', false, null); recordNotebookHistory('${n.id}', true);" title="斜体"><i>I</i></button>
            <button type="button" class="nb-tool-btn" onmousedown="event.preventDefault(); document.execCommand('underline', false, null); recordNotebookHistory('${n.id}', true);" title="下線"><u>U</u></button>
            <button type="button" class="nb-tool-btn" onmousedown="event.preventDefault(); document.execCommand('strikeThrough', false, null); recordNotebookHistory('${n.id}', true);" title="取り消し線"><s>S</s></button>
            
            <div style="width: 1px; height: 16px; background: var(--item-border); margin: 0 2px;"></div>

            <!-- H1, H2, H3, 標準テキスト -->
            <button type="button" class="nb-tool-btn" onmousedown="event.preventDefault(); setNotebookBlockFormat('${n.id}', 'H1');" title="大見出し (H1)" style="font-weight: 800;">H1</button>
            <button type="button" class="nb-tool-btn" onmousedown="event.preventDefault(); setNotebookBlockFormat('${n.id}', 'H2');" title="中見出し (H2)" style="font-weight: 700;">H2</button>
            <button type="button" class="nb-tool-btn" onmousedown="event.preventDefault(); setNotebookBlockFormat('${n.id}', 'H3');" title="小見出し (H3)" style="font-weight: 600;">H3</button>
            <button type="button" class="nb-tool-btn" onmousedown="event.preventDefault(); setNotebookBlockFormat('${n.id}', 'DIV');" title="標準テキスト">Aa</button>

            <div style="width: 1px; height: 16px; background: var(--item-border); margin: 0 2px;"></div>

            <!-- 箇条書き, ToDoリスト, 区切り線 -->
            <button type="button" class="nb-tool-btn" onmousedown="event.preventDefault(); document.execCommand('insertUnorderedList', false, null); recordNotebookHistory('${n.id}', true);" title="箇条書き (リスト)" style="font-size: 16px; line-height: 1;">•</button>
            <button type="button" class="nb-tool-btn" onmousedown="event.preventDefault(); toggleNotebookCheckbox('${n.id}');" title="チェックリスト (ToDo)" style="font-size: 14px;">☑</button>
            <button type="button" class="nb-tool-btn" onmousedown="event.preventDefault(); insertNotebookHr('${n.id}');" title="区切り線 (水平線)">―</button>

            <div style="width: 1px; height: 16px; background: var(--item-border); margin: 0 2px;"></div>

            <!-- 画像, 表, 引用, bubble, コードブロック -->
            <button type="button" class="nb-tool-btn" onmousedown="event.preventDefault(); triggerNotebookPhotoSelect('${n.id}');" title="画像を挿入">📷</button>
            <button type="button" class="nb-tool-btn" onmousedown="event.preventDefault(); insertNotebookTable('${n.id}');" title="表を挿入 (/table)" style="font-size: 14px;">⊞</button>
            <button type="button" class="nb-tool-btn" onmousedown="event.preventDefault(); insertNotebookQuote('${n.id}');" title="引用ブロック (quote)" style="font-size: 16px; font-weight: 700; line-height: 1;">”</button>
            <button type="button" class="nb-tool-btn" onmousedown="event.preventDefault(); insertNotebookBubble('${n.id}');" title="bubble (右寄せバブル)" style="font-size: 15px; line-height: 1;">💬</button>
            <button type="button" class="nb-tool-btn" onmousedown="event.preventDefault(); insertNotebookCodeBlock('${n.id}');" title="コードブロック (code)" style="font-family: monospace; font-weight: 700; font-size: 12px;">&lt;/&gt;</button>

            <div style="width: 1px; height: 16px; background: var(--item-border); margin: 0 2px;"></div>

            <!-- 文字カラー -->
            <button type="button" class="nb-tool-btn color-btn" onmousedown="event.preventDefault(); document.execCommand('foreColor', false, '#ff453a'); recordNotebookHistory('${n.id}', true);" title="赤文字" style="color: #ff453a;">A</button>
            <button type="button" class="nb-tool-btn color-btn" onmousedown="event.preventDefault(); document.execCommand('foreColor', false, '#2997ff'); recordNotebookHistory('${n.id}', true);" title="青文字" style="color: #2997ff;">A</button>
            <button type="button" class="nb-tool-btn color-btn" onmousedown="event.preventDefault(); document.execCommand('foreColor', false, '#30d158'); recordNotebookHistory('${n.id}', true);" title="緑文字" style="color: #30d158;">A</button>
            <button type="button" class="nb-tool-btn color-btn" onmousedown="event.preventDefault(); document.execCommand('removeFormat', false, null); recordNotebookHistory('${n.id}', true);" title="色・書式リセット" style="font-size: 11px; opacity: 0.7;">✕色</button>

            <div style="flex: 1;"></div>

            <!-- 操作アクション -->
            <button type="button" class="nb-tool-btn danger" onmousedown="event.preventDefault(); deleteNotebookDirect('${n.id}');" title="このノートを Trash へ移動">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 3px;">
                    <polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
                <span>Trash へ</span>
            </button>

            <button type="button" class="nb-tool-btn cancel" onmousedown="event.preventDefault(); cancelNotebookEdit('${n.id}');" title="変更を破棄して終了">キャンセル</button>
            <button type="button" class="nb-tool-btn primary" onmousedown="event.preventDefault(); saveNotebookEdit('${n.id}');">保存して完了</button>
        </div>
    `;
}

// カードビューは全ノートの枠だけ作り、本文は表示中のカードの前後だけ描画する（ノート数が多くても軽くするため）
const CARD_RENDER_RADIUS = 2;
function ensureCardContentRendered(scroller, index) {
    if (!scroller) return;
    const slides = scroller.children;
    for (let i = Math.max(0, index - CARD_RENDER_RADIUS); i <= Math.min(slides.length - 1, index + CARD_RENDER_RADIUS); i++) {
        const ph = slides[i].querySelector('.nb-lazy-content[data-lazy-id]');
        if (!ph) continue;
        const note = notebookData.find(n => n.id === ph.dataset.lazyId);
        if (note) ph.outerHTML = buildNotebookContentHtml(note); else ph.remove();
    }
}

function renderCardViewMode(container, filteredNotebooks, filterBadgeHtml) {
    if (currentNotebookIndex >= filteredNotebooks.length || currentNotebookIndex < 0) {
        currentNotebookIndex = 0;
    }

    const isMobile = (typeof isCurrentMobileMode === 'function') ? isCurrentMobileMode() : false;
    const hideRightClass = (!isRightSidebarOpen || isMobile) ? 'hide-right-sidebar' : '';

    const connectedWrapper = document.createElement('div');
    connectedWrapper.className = `connected-view-container ${hideRightClass}`;

    const centerArea = document.createElement('div');
    centerArea.className = 'connected-center-carousel';
    centerArea.id = 'connectedCenterScroller';

    filteredNotebooks.forEach((n, idx) => {
        const hasLinks = Array.isArray(n.linkedNoteIds) && n.linkedNoteIds.length > 0;
        const linkCount = hasLinks ? n.linkedNoteIds.length : 0;
        const noteStatus = n.status || 'archive';

        const cardPanel = document.createElement('div');
        cardPanel.className = 'connected-card-slide';
        cardPanel.dataset.id = n.id;
        cardPanel.dataset.index = idx;

        cardPanel.innerHTML = `
            <div class="main-display" style="--tab-color: var(--notebook-color);">
                <div class="display-header compact-header" style="align-items: flex-start;">
                    <div class="date-title-wrapper" style="width: 100%;">
                        <span class="date-eyebrow" style="color: var(--notebook-color); margin-bottom: 4px;">NOTEBOOKS</span>
                        ${buildNotebookTitleHtml(n)}
                        <div style="display: flex; align-items: center; gap: 8px; margin-top: 6px; flex-wrap: wrap;">
                            ${buildStatusBadgeHtml(noteStatus, n.id)}
                            ${buildNotebookCategoryBadge(n)}
                        </div>
                    </div>
                    <div class="header-actions" style="margin-top: 2px;">
                        ${filterBadgeHtml}
                        <button class="log-edit-btn" onclick="openLinkNotebookModal('${n.id}')" style="padding: 6px; ${hasLinks ? 'color: var(--notebook-color); opacity: 0.9;' : ''}" title="関連ノートをリンク (${linkCount}件)">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                            </svg>
                        </button>
                        <button class="log-edit-btn" onclick="openExportNotebookModal('${n.id}')" style="padding: 6px;" title="このノートをエクスポート (HTML / PDF)">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                <polyline points="7 10 12 15 17 10"></polyline>
                                <line x1="12" y1="15" x2="12" y2="3"></line>
                            </svg>
                        </button>
                        <button class="log-edit-btn" onclick="enableNotebookEdit('${n.id}', 'content')" style="margin-right: 4px; padding: 6px;" title="このノートを編集">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                            </svg>
                        </button>
                        <span class="header-badge" style="background: var(--notebook-color); color: #fff;">${idx + 1} / ${filteredNotebooks.length}</span>
                    </div>
                </div>

                ${buildNotebookToolbarHtml(n)}

                <div class="logs-container-wrapper" id="nb_logs_wrapper_${n.id}" style="padding: 4px 2px;" ondblclick="handleNotebookContainerDblClick(event, '${n.id}')">
                    ${Math.abs(idx - currentNotebookIndex) <= CARD_RENDER_RADIUS ? buildNotebookContentHtml(n) : `<div class="nb-lazy-content" data-lazy-id="${n.id}"></div>`}
                </div>
            </div>
        `;
        centerArea.appendChild(cardPanel);
    });

    const sidebarArea = document.createElement('div');
    sidebarArea.className = 'connected-right-sidebar';
    sidebarArea.id = 'connectedRightSidebar';

    connectedWrapper.appendChild(centerArea);
    connectedWrapper.appendChild(sidebarArea);
    container.appendChild(connectedWrapper);

    const currentNote = filteredNotebooks[currentNotebookIndex];
    updateConnectedRightSidebar(currentNote);
    if (typeof renderFullscreenLinkedNotes === 'function') {
        renderFullscreenLinkedNotes();
    }
    
    setupConnectedSwipeListener(centerArea, filteredNotebooks);

    requestAnimationFrame(() => {
        const targetPanel = centerArea.children[currentNotebookIndex];
        if (targetPanel) {
            centerArea.scrollLeft = targetPanel.offsetLeft;
        }
    });
}

let connectedSwipeTimer = null;
function setupConnectedSwipeListener(scroller, filteredNotebooks) {
    scroller.addEventListener('scroll', () => {
        clearTimeout(connectedSwipeTimer);
        connectedSwipeTimer = setTimeout(() => {
            const w = scroller.clientWidth;
            if (!w) return;
            const newIndex = Math.round(scroller.scrollLeft / w);
            if (newIndex >= 0 && newIndex < filteredNotebooks.length) {
                ensureCardContentRendered(scroller, newIndex);
                if (currentNotebookIndex !== newIndex) {
                    currentNotebookIndex = newIndex;
                    const cNote = filteredNotebooks[currentNotebookIndex];
                    updateConnectedRightSidebar(cNote);
                    if (typeof renderFullscreenLinkedNotes === 'function') {
                        renderFullscreenLinkedNotes();
                    }
                }
            }
        }, 60);
    }, { passive: true });
}

function updateConnectedRightSidebar(currentNote) {
    const sidebarEl = document.getElementById('connectedRightSidebar');
    if (!sidebarEl || !currentNote) return;

    const hasLinks = Array.isArray(currentNote.linkedNoteIds) && currentNote.linkedNoteIds.length > 0;
    const linkedNotes = [];
    
    if (hasLinks) {
        currentNote.linkedNoteIds.forEach(lid => {
            const found = notebookData.find(n => n.id === lid && n.status !== 'trash');
            if (found) linkedNotes.push(found);
        });
    }

    let sideCardsHtml = "";
    if (linkedNotes.length > 0) {
        linkedNotes.forEach(ln => {
            const catBadgeHtml = buildNotebookCategoryBadge(ln);
            const statusBadgeHtml = buildStatusBadgeHtml(ln.status || 'archive', ln.id);
            const rawContent = (ln.content && ln.content.trim()) ? cleanNotebookPreviewHtml(ln.content) : '<span style="opacity:0.4;">(空のノート)</span>';
            
            const unlinkBtnHtml = window.IS_READONLY_MODE ? '' : `<button type="button" class="nb-unlink-btn" onclick="unlinkNotebook('${currentNote.id}', '${ln.id}', event)" title="このノートとのリンクを解除">✕ 解除</button>`;

            sideCardsHtml += `
                <div class="connected-side-card-item notebook-grid-card" onclick="openNotebookLinked('${ln.id}')" title="クリックしてこのノートを中央に表示">
                    <h3 class="notebook-grid-title">${escapeHtml(ln.title || '無題のノート')}</h3>
                    <div class="notebook-grid-preview">${rawContent}</div>
                    <div class="notebook-grid-meta">
                        <div>${unlinkBtnHtml}</div>
                        <div style="display: flex; gap: 4px; align-items: center;">${statusBadgeHtml}${catBadgeHtml}</div>
                    </div>
                </div>
            `;
        });
    } else {
        sideCardsHtml = `
            <div class="connected-side-empty">
                <span>🔗 リンクされたノートはありません</span>
            </div>
        `;
    }

    sidebarEl.innerHTML = `
        <div class="connected-side-sidebar-header">
            <div class="connected-side-title-area">
                <span>🔗 LINKED NOTES</span>
                <span class="connected-side-count">${linkedNotes.length}</span>
            </div>
            <div class="connected-side-actions">
                <button type="button" class="connected-side-link-btn" onclick="openLinkNotebookModal('${currentNote.id}')">＋ リンク</button>
                <button type="button" class="connected-side-close-btn" onclick="toggleRightSidebar(false)" title="右サイドバーを閉じる">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
        </div>
        <div class="connected-side-scroller">
            ${sideCardsHtml}
        </div>
    `;
}

let currentTargetNotebookIdForStatus = null;

function buildStatusBadgeHtml(status, id = null) {
    const map = {
        permanent: { label: 'Permanent', cls: 'status-permanent' },
        active: { label: 'Active', cls: 'status-active' },
        archive: { label: 'Archive', cls: 'status-archive' },
        trash: { label: 'Trash', cls: 'status-trash' }
    };
    const s = map[status] || map.archive;
    if (id && !window.IS_READONLY_MODE && status !== 'trash') {
        return `<span class="nb-status-pill ${s.cls} clickable" onclick="event.stopPropagation(); openChangeNotebookStatusModal('${id}')" title="クリックしてステータスを変更">${s.label}</span>`;
    }
    return `<span class="nb-status-pill ${s.cls}">${s.label}</span>`;
}

function openChangeNotebookStatusModal(id) {
    const note = notebookData.find(n => n.id === id);
    if (!note) return;

    currentTargetNotebookIdForStatus = id;
    const targetBadge = document.getElementById('changeNbStatusTargetTitle');
    if (targetBadge) {
        targetBadge.textContent = note.title && note.title.trim() ? note.title.trim().substring(0, 15) : 'NOTEBOOK';
    }

    renderStatusOptionsForModal(note.status || 'archive');
    openModal('changeNotebookStatusModal');
}

function renderStatusOptionsForModal(currentStatus) {
    const container = document.getElementById('changeNotebookStatusList');
    if (!container) return;
    container.innerHTML = "";

    const options = [
        { key: 'active', label: 'Active', color: 'var(--nb-status-active)', desc: '進行中・よく使うノート' },
        { key: 'permanent', label: 'Permanent', color: 'var(--nb-status-permanent)', desc: '恒久保存・重要ノート' },
        { key: 'archive', label: 'Archive', color: 'var(--nb-status-archive)', desc: '保管庫・過去の記録' }
    ];

    options.forEach(opt => {
        const isSel = (opt.key === currentStatus);
        const btn = document.createElement('div');
        btn.className = `nb-status-option-btn ${isSel ? 'selected' : ''}`;
        btn.onclick = () => applyNotebookStatusChange(opt.key);

        btn.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px;">
                <span class="nb-status-dot" style="background: ${opt.color};"></span>
                <div>
                    <div style="font-size: 14px; font-weight: 700; color: ${opt.color};">${opt.label}</div>
                    <div style="font-size: 11.5px; color: var(--text-secondary); margin-top: 2px;">${opt.desc}</div>
                </div>
            </div>
            ${isSel ? '<span style="color: var(--notebook-color); font-weight: 800; font-size: 15px;">✓</span>' : ''}
        `;
        container.appendChild(btn);
    });
}

async function applyNotebookStatusChange(newStatus) {
    if (!currentTargetNotebookIdForStatus) return;
    await changeNotebookStatus(currentTargetNotebookIdForStatus, newStatus);
    closeModal('changeNotebookStatusModal');
    currentTargetNotebookIdForStatus = null;
}

async function changeNotebookStatus(id, newStatus) {
    const idx = notebookData.findIndex(n => n.id === id);
    if (idx !== -1) {
        notebookData[idx].status = newStatus;
        notebookData[idx].updatedAt = new Date().toISOString();
        await saveNotebookData();

        const filtered = getFilteredNotebooks();
        if (currentNotebookIndex >= filtered.length) {
            currentNotebookIndex = Math.max(0, filtered.length - 1);
        }
        renderRightCards();
    }
}

async function restoreNotebookFromTrash(id) {
    await changeNotebookStatus(id, 'active');
}

async function purgeNotebookPermanent(id) {
    if (!confirm("このノートを完全に削除しますか？\n（この操作は取り消せません）")) return;
    const idx = notebookData.findIndex(x => x.id === id);
    if (idx !== -1) {
        notebookData.splice(idx, 1);
        notebookData.forEach(other => {
            if (Array.isArray(other.linkedNoteIds)) {
                other.linkedNoteIds = other.linkedNoteIds.filter(lid => lid !== id);
            }
        });
        await saveNotebookData();

        const filtered = getFilteredNotebooks();
        if (currentNotebookIndex >= filtered.length) {
            currentNotebookIndex = Math.max(0, filtered.length - 1);
        }
        renderRightCards();
    }
}

async function unlinkNotebook(sourceId, targetId, event) {
    event.stopPropagation();
    if (!confirm("このノートとのリンクを解除しますか？")) return;

    const sourceNote = notebookData.find(n => n.id === sourceId);
    const targetNote = notebookData.find(n => n.id === targetId);

    let updated = false;
    if (sourceNote && Array.isArray(sourceNote.linkedNoteIds)) {
        sourceNote.linkedNoteIds = sourceNote.linkedNoteIds.filter(id => id !== targetId);
        sourceNote.updatedAt = new Date().toISOString();
        updated = true;
    }
    if (targetNote && Array.isArray(targetNote.linkedNoteIds)) {
        targetNote.linkedNoteIds = targetNote.linkedNoteIds.filter(id => id !== sourceId);
        targetNote.updatedAt = new Date().toISOString();
        updated = true;
    }

    if (updated) {
        await saveNotebookData();
        renderRightCards();
        if (typeof renderFullscreenLinkedNotes === 'function') {
            renderFullscreenLinkedNotes();
        }
    }
}

function openChangeNotebookCategoryModal(id) {
    const note = notebookData.find(n => n.id === id);
    if (!note) return;

    currentTargetNotebookIdForCategory = id;
    const targetBadge = document.getElementById('changeNbCategoryTargetTitle');
    if (targetBadge) {
        targetBadge.textContent = note.title && note.title.trim() ? note.title.trim().substring(0, 15) : 'NOTEBOOK';
    }

    renderCategoryChipsForChangeModal(note.category || "ライフログ");
    openModal('changeNotebookCategoryModal');
}

function renderCategoryChipsForChangeModal(currentCatName) {
    const container = document.getElementById('changeNotebookCategoryChipsContainer');
    if (!container) return;
    container.innerHTML = "";

    const validTypes = appTypes.filter(t => typeNotebookSettings[t] !== false && categories.some(ca => (ca.type || "一般") === t));
    validTypes.forEach(t => {
        const row = document.createElement('div');
        row.className = 'category-type-row';
        row.innerHTML = `<div style="display: flex; align-items: center; gap: 5px;"><span style="font-size: 12px;">${getTypeIcon(t)}</span><span class="category-type-name">${escapeHtml(t)}</span></div>`;

        const chipsWrap = document.createElement('div');
        chipsWrap.className = 'category-chips-wrap';

        categories.filter(ca => (ca.type || "一般") === t).forEach(cat => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `category-chip ${cat.name === currentCatName ? 'selected notebook-selected' : ''}`;
            btn.textContent = cat.name;
            btn.onclick = () => {
                applyNotebookCategoryChange(cat.name);
            };
            chipsWrap.appendChild(btn);
        });

        row.appendChild(chipsWrap);
        container.appendChild(row);
    });
}

async function applyNotebookCategoryChange(newCatName) {
    if (!currentTargetNotebookIdForCategory) return;
    const note = notebookData.find(n => n.id === currentTargetNotebookIdForCategory);
    if (note) {
        note.category = newCatName;
        note.updatedAt = new Date().toISOString();
        await saveNotebookData();
    }
    closeModal('changeNotebookCategoryModal');
    currentTargetNotebookIdForCategory = null;
    renderRightCards();
}

function getConnectedComponentNotes(visibleNotes, centerNote) {
    if (!centerNote) return { notes: [], centerId: null };
    const centerId = centerNote.id;
    
    const adjList = new Map();
    visibleNotes.forEach(n => adjList.set(n.id, new Set()));
    
    visibleNotes.forEach(n => {
        const links = Array.isArray(n.linkedNoteIds) ? n.linkedNoteIds : [];
        links.forEach(targetId => {
            if (adjList.has(targetId)) {
                adjList.get(n.id).add(targetId);
                adjList.get(targetId).add(n.id);
            }
        });
    });
    
    const connectedIds = new Set();
    const queue = [centerId];
    connectedIds.add(centerId);
    
    while (queue.length > 0) {
        const currentId = queue.shift();
        const neighbors = adjList.get(currentId);
        if (neighbors) {
            neighbors.forEach(neighborId => {
                if (!connectedIds.has(neighborId)) {
                    connectedIds.add(neighborId);
                    queue.push(neighborId);
                }
            });
        }
    }
    
    return {
        notes: visibleNotes.filter(n => connectedIds.has(n.id)),
        centerId: centerId
    };
}

function setGraphSubMode(subMode) {
    notebookGraphMode = subMode;
    const isLocal = (notebookGraphMode === 'local');
    const localBtn = document.getElementById('graphModeBtn_local');
    const globalBtn = document.getElementById('graphModeBtn_global');
    if (localBtn) localBtn.classList.toggle('active', isLocal);
    if (globalBtn) globalBtn.classList.toggle('active', !isLocal);

    resetGraphPhysics();
}

function renderGraphMode(container, filterBadgeHtml) {
    const isLocal = (notebookGraphMode === 'local');
    const wrapper = document.createElement('div');
    wrapper.className = 'notebook-graph-wrapper';

    let visibleNotes = notebookData.filter(n => matchesCurrentFilter(n) && (n.status !== 'trash'));
    let centerNoteId = null;

    const filteredNotebooks = getFilteredNotebooks();
    
    if (currentNotebookIndex >= filteredNotebooks.length || currentNotebookIndex < 0) {
        currentNotebookIndex = 0;
    }
    const centerNote = filteredNotebooks[currentNotebookIndex] || filteredNotebooks[0];
    
    if (centerNote) {
        centerNoteId = centerNote.id;
    }
    if (isLocal && centerNote) {
        const comp = getConnectedComponentNotes(visibleNotes, centerNote);
        visibleNotes = comp.notes;
        centerNoteId = comp.centerId;
    }

    wrapper.innerHTML = `
        <div class="graph-overlay-header">
            <div class="date-title-wrapper">
                <span class="date-eyebrow" style="color: var(--notebook-color);">NOTEBOOKS • GRAPH VIEW</span>
                <div style="display: flex; align-items: center; gap: 12px; margin-top: 2px;">
                    <h1 class="date-title" style="margin: 0;">Knowledge Graph</h1>
                    <div class="graph-mode-segmented">
                        <button type="button" class="graph-mode-btn ${isLocal ? 'active' : ''}" id="graphModeBtn_local" onclick="setGraphSubMode('local')" title="選択中のノートとリンク関係のあるノートのみ表示">Local</button>
                        <button type="button" class="graph-mode-btn ${!isLocal ? 'active' : ''}" id="graphModeBtn_global" onclick="setGraphSubMode('global')" title="すべてのノートとリンク関係を表示">Global</button>
                    </div>
                </div>
            </div>
            <div class="header-actions">
                ${filterBadgeHtml}
                <span class="header-badge" id="graphNodeCountBadge" style="background: var(--notebook-color); color: #fff;">${visibleNotes.length} ノード</span>
            </div>
        </div>
        <canvas class="graph-canvas-layer" id="notebookGraphCanvas"></canvas>
        <div class="graph-tooltip" id="graphTooltip"></div>
        <div class="graph-controls-dock">
            <button class="graph-ctrl-btn" onclick="resetGraphPhysics()" title="ノード配置を再計算">↺</button>
        </div>
    `;
    container.appendChild(wrapper);

    setupGraphSimulation(visibleNotes, centerNoteId);
}

function setupGraphSimulation(notes, centerNoteId = null) {
    const canvas = document.getElementById('notebookGraphCanvas');
    const tooltip = document.getElementById('graphTooltip');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || canvas.parentElement.clientWidth || 600;
    const height = rect.height || canvas.parentElement.clientHeight || 500;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const noteMap = new Map();
    graphNodes = notes.map((n, i) => {
        const angle = (i / Math.max(notes.length, 1)) * Math.PI * 2;
        const radius = Math.min(width, height) * 0.32;
        const links = Array.isArray(n.linkedNoteIds) ? n.linkedNoteIds : [];
        const isCenter = (n.id === centerNoteId);
        const baseR = 7;
        
        const node = {
            id: n.id,
            title: n.title || '無題のノート',
            category: n.category || 'ライフログ',
            status: n.status || 'archive',
            x: isCenter ? (width / 2) : (width / 2) + Math.cos(angle) * radius + (Math.random() - 0.5) * 40,
            y: isCenter ? (height / 2) : (height / 2) + Math.sin(angle) * radius + (Math.random() - 0.5) * 40,
            vx: 0,
            vy: 0,
            r: Math.min(18, Math.max(8, baseR + links.length * 1.8)),
            links: links,
            isCenter: isCenter
        };
        noteMap.set(n.id, node);
        return node;
    });

    graphEdges = [];
    const addedEdgeSet = new Set();
    graphNodes.forEach(source => {
        source.links.forEach(targetId => {
            const target = noteMap.get(targetId);
            if (target) {
                const edgeKey = [source.id, target.id].sort().join('--');
                if (!addedEdgeSet.has(edgeKey)) {
                    addedEdgeSet.add(edgeKey);
                    graphEdges.push({ source, target });
                }
            }
        });
    });

    canvas.onpointerdown = (e) => {
        const cRect = canvas.getBoundingClientRect();
        const mx = e.clientX - cRect.left;
        const my = e.clientY - cRect.top;
        graphPointerStart = { x: mx, y: my };
        isGraphDragMoved = false;

        draggedNode = getNodeAt(mx, my);
        if (draggedNode) {
            canvas.setPointerCapture(e.pointerId);
        }
    };

    canvas.onpointermove = (e) => {
        const cRect = canvas.getBoundingClientRect();
        const mx = e.clientX - cRect.left;
        const my = e.clientY - cRect.top;

        if (Math.hypot(mx - graphPointerStart.x, my - graphPointerStart.y) > 10) {
            isGraphDragMoved = true;
        }

        if (draggedNode) {
            draggedNode.x = mx;
            draggedNode.y = my;
            draggedNode.vx = 0;
            draggedNode.vy = 0;
            if (tooltip) tooltip.style.display = 'none';
            return;
        }

        const h = getNodeAt(mx, my);
        hoveredNode = h;
        if (h && tooltip) {
            tooltip.textContent = `📔 ${h.title} (${h.category}) [${h.status.toUpperCase()}]`;
            tooltip.style.left = `${mx}px`;
            tooltip.style.top = `${my}px`;
            tooltip.style.display = 'block';
        } else if (tooltip) {
            tooltip.style.display = 'none';
        }
    };

    canvas.onpointerup = (e) => {
        if (!isGraphDragMoved && draggedNode) {
            const targetId = draggedNode.id;
            draggedNode = null;
            openNotebookLinked(targetId);
            return;
        }
        draggedNode = null;
    };

    canvas.onpointerleave = () => {
        hoveredNode = null;
        if (tooltip) tooltip.style.display = 'none';
    };

    function graphTick() {
        if (notebookViewMode !== 'graph') return;

        const repFactor = 1600;
        for (let i = 0; i < graphNodes.length; i++) {
            for (let j = i + 1; j < graphNodes.length; j++) {
                const n1 = graphNodes[i];
                const n2 = graphNodes[j];
                const dx = n2.x - n1.x;
                const dy = n2.y - n1.y;
                const distSq = Math.max(dx * dx + dy * dy, 120);
                const dist = Math.sqrt(distSq);
                const force = repFactor / distSq;
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;

                if (n1 !== draggedNode) { n1.vx -= fx; n1.vy -= fy; }
                if (n2 !== draggedNode) { n2.vx += fx; n2.vy += fy; }
            }
        }

        const springLength = 80;
        const springK = 0.045;
        graphEdges.forEach(edge => {
            const dx = edge.target.x - edge.source.x;
            const dy = edge.target.y - edge.source.y;
            const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
            const force = (dist - springLength) * springK;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;

            if (edge.source !== draggedNode) { edge.source.vx += fx; edge.source.vy += fy; }
            if (edge.target !== draggedNode) { edge.target.vx -= fx; edge.target.vy -= fy; }
        });

        const cx = width / 2;
        const cy = height / 2;
        const centerGravity = 0.015;
        graphNodes.forEach(node => {
            if (node === draggedNode) return;
            node.vx += (cx - node.x) * centerGravity;
            node.vy += (cy - node.y) * centerGravity;

            node.vx *= 0.82;
            node.vy *= 0.82;

            node.x += node.vx;
            node.y += node.vy;

            node.x = Math.max(node.r + 10, Math.min(width - node.r - 10, node.x));
            node.y = Math.max(node.r + 65, Math.min(height - node.r - 15, node.y));
        });

        drawGraphScene(ctx, width, height);
        graphAnimId = requestAnimationFrame(graphTick);
    }

    graphAnimId = requestAnimationFrame(graphTick);
}

function drawGraphScene(ctx, width, height) {
    ctx.clearRect(0, 0, width, height);

    const isLight = document.body.classList.contains('light-theme');
    const edgeColor = isLight ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.12)';
    const edgeActiveColor = isLight ? 'rgba(52, 199, 89, 0.65)' : 'rgba(48, 209, 88, 0.65)';
    const textColor = isLight ? '#1c1c1e' : '#f2f2f7';

    ctx.lineWidth = 1.4;
    graphEdges.forEach(edge => {
        const isConnectedToHover = (hoveredNode && (edge.source === hoveredNode || edge.target === hoveredNode));
        ctx.strokeStyle = isConnectedToHover ? edgeActiveColor : edgeColor;
        ctx.lineWidth = isConnectedToHover ? 2.2 : 1.2;

        ctx.beginPath();
        ctx.moveTo(edge.source.x, edge.source.y);
        ctx.lineTo(edge.target.x, edge.target.y);
        ctx.stroke();
    });

    graphNodes.forEach(node => {
        const isHover = (node === hoveredNode || node === draggedNode);
        const isCenter = node.isCenter;
        
        if (isHover || isCenter) {
            ctx.beginPath();
            ctx.arc(node.x, node.y, node.r + 6, 0, Math.PI * 2);
            ctx.fillStyle = isCenter ? 'rgba(255, 69, 58, 0.28)' : (isLight ? 'rgba(52, 199, 89, 0.22)' : 'rgba(48, 209, 88, 0.22)');
            ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
        
        let fillColor = isLight ? '#8e8e93' : '#636366';
        if (node.status === 'permanent') {
            fillColor = isLight ? '#34c759' : '#30d158';
        } else if (node.status === 'active') {
            fillColor = isLight ? '#007aff' : '#2997ff';
        } else if (node.status === 'trash') {
            fillColor = '#ff453a';
        } else {
            fillColor = isLight ? '#8e8e93' : '#636366';
        }
        
        if (isHover) fillColor = isLight ? '#34c759' : '#30d158';
        if (isCenter) fillColor = '#ff453a';
        
        ctx.fillStyle = fillColor;
        ctx.fill();

        ctx.lineWidth = 2;
        ctx.strokeStyle = isLight ? '#ffffff' : '#121215';
        ctx.stroke();

        ctx.font = (isCenter ? '700 11px ' : '600 11px ') + '-apple-system, sans-serif';
        ctx.fillStyle = isHover ? (isLight ? '#34c759' : '#30d158') : (isCenter ? '#ff453a' : textColor);
        ctx.textAlign = 'center';
        ctx.fillText(truncateTitle(node.title, 12), node.x, node.y + node.r + 14);
    });
}

function getNodeAt(x, y) {
    for (let i = graphNodes.length - 1; i >= 0; i--) {
        const n = graphNodes[i];
        if (Math.hypot(n.x - x, n.y - y) <= n.r + 8) {
            return n;
        }
    }
    return null;
}

function truncateTitle(str, maxLen) {
    if (!str) return '無題';
    return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

function resetGraphPhysics() {
    if (notebookViewMode === 'graph') {
        const isLocal = (notebookGraphMode === 'local');
        let visibleNotes = notebookData.filter(n => matchesCurrentFilter(n) && (n.status !== 'trash'));
        let centerNoteId = null;

        const filteredNotebooks = getFilteredNotebooks();
        if (currentNotebookIndex >= filteredNotebooks.length || currentNotebookIndex < 0) {
            currentNotebookIndex = 0;
        }
        const centerNote = filteredNotebooks[currentNotebookIndex] || filteredNotebooks[0];
        if (centerNote) {
            centerNoteId = centerNote.id;
        }
        if (isLocal && centerNote) {
            const comp = getConnectedComponentNotes(visibleNotes, centerNote);
            visibleNotes = comp.notes;
            centerNoteId = comp.centerId;
        }

        const badge = document.getElementById('graphNodeCountBadge');
        if (badge) badge.textContent = `${visibleNotes.length} ノード`;

        setupGraphSimulation(visibleNotes, centerNoteId);
    }
}

function buildNotebookTitleHtml(n) {
    return `
        <div class="notebook-title-container" style="position: relative; flex: 1; display: flex; flex-direction: column;">
            <h1 class="date-title notebook-title-view" id="nb_title_view_${n.id}" style="cursor: text; padding: 2px 4px; border-radius: 6px; transition: background 0.2s; margin-left: -4px;" ondblclick="enableNotebookEdit('${n.id}', 'title')" title="ダブルクリックして編集">📔 ${escapeHtml(n.title || '無題のノート')}</h1>
            <input type="text" class="notebook-title-edit" id="nb_title_edit_${n.id}" value="${escapeHtml(n.title || '')}" placeholder="タイトル..." style="display: none; width: 100%; font-size: 22px; font-weight: 700; background: transparent; border: 1px solid var(--item-border); color: var(--text-primary); padding: 4px 8px; border-radius: 8px; outline: none; margin-left: -4px;" oninput="handleNotebookTitleInput('${n.id}')" onkeydown="handleNotebookTitleKeyDown(event, '${n.id}')">
        </div>
    `;
}

function handleNotebookTitleInput(id) {
    recordNotebookHistory(id, false);
}

function handleNotebookTitleKeyDown(event, id) {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const isCtrl = isMac ? event.metaKey : event.ctrlKey;

    if (isCtrl && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault();
        if (event.shiftKey) redoNotebookEdit(id);
        else undoNotebookEdit(id);
        return;
    }
    if (isCtrl && (event.key === 'y' || event.key === 'Y')) {
        event.preventDefault();
        redoNotebookEdit(id);
        return;
    }

    if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        const contentArea = document.getElementById(`nb_content_view_${id}`);
        if (contentArea) contentArea.focus();
    }
}

function buildNotebookContentHtml(n) {
    let cleanContent = n.content || '';
    if (!cleanContent.trim()) {
        cleanContent = '';
    } else {
        cleanContent = cleanNotebookPreviewHtml(cleanContent);
    }

    if (window.IS_READONLY_MODE) {
        return `
            <div class="notebook-content-container" style="position: relative; flex: 1; display: flex; flex-direction: column; min-height: 200px;">
                <div class="log-content notebook-content-view rich-text-area" style="padding: 8px 4px 40px; border-radius: 8px; flex: 1; font-size: 15.5px; line-height: 1.6;">${cleanContent}</div>
            </div>
        `;
    }

    return `
        <div class="notebook-content-container" style="position: relative; flex: 1; display: flex; flex-direction: column; min-height: 200px;">
            <div class="log-content notebook-content-view rich-text-area" id="nb_content_view_${n.id}" data-placeholder="ここをダブルクリックして入力..." style="cursor: text; padding: 8px 4px 60px; border-radius: 8px; transition: background 0.2s; flex: 1; font-size: 15.5px; line-height: 1.6; outline: none;" onclick="handleNotebookContentClick(event, '${n.id}')" ondblclick="handleNotebookContentDblClick(event, '${n.id}')" oninput="handleNotebookContentInput('${n.id}')" onkeydown="handleNotebookKeyDown(event, '${n.id}')" onpaste="handleNotebookPaste(event, '${n.id}')" oncopy="handleNotebookCopy(event)" oncontextmenu="handleNotebookTableContextMenu(event, '${n.id}')">${cleanContent}</div>
        </div>
    `;
}

function handleNotebookContentInput(id) {
    recordNotebookHistory(id, false);
}

function openLinkNotebookModal(id) {
    const note = notebookData.find(n => n.id === id);
    if (!note) return;

    currentLinkingNotebookId = id;
    tempSelectedLinkIds = new Set(Array.isArray(note.linkedNoteIds) ? note.linkedNoteIds : []);
    linkModalSearchQuery = "";

    const searchInput = document.getElementById('linkNotebookSearchInput');
    if (searchInput) searchInput.value = "";

    renderLinkNotebookList();
    openModal('linkNotebookModal');

    setTimeout(() => {
        if (searchInput) searchInput.focus();
    }, 200);
}

function handleLinkNotebookSearchInput(e) {
    linkModalSearchQuery = e.target.value;
    renderLinkNotebookList();
}

function renderLinkNotebookList() {
    const container = document.getElementById('linkNotebookListContainer');
    if (!container) return;
    container.innerHTML = "";

    const q = (linkModalSearchQuery || '').trim().toLowerCase();
    const candidateNotes = notebookData.filter(n => {
        if (n.id === currentLinkingNotebookId) return false;
        if (n.status === 'trash') return false;
        if (!q) return true;

        const titleText = (n.title || '').toLowerCase();
        const contentText = stripHtml(n.content || '').toLowerCase();
        const categoryText = (n.category || '').toLowerCase();

        return titleText.includes(q) || contentText.includes(q) || categoryText.includes(q);
    });

    if (candidateNotes.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; color: var(--text-secondary); font-size: 13px; padding: 32px 10px;">
                ${q ? '該当するノートが見つかりません' : 'リンク可能な他のノートがまだありません'}
            </div>
        `;
        return;
    }

    candidateNotes.forEach(n => {
        const isChecked = tempSelectedLinkIds.has(n.id);
        const item = document.createElement('div');
        item.className = `nb-link-item ${isChecked ? 'selected' : ''}`;
        item.onclick = () => toggleLinkNotebookSelection(n.id);

        const plainContent = stripHtml(n.content || '').replace(/\s+/g, ' ').trim();
        const snippet = plainContent ? plainContent.substring(0, 60) : '(本文なし)';
        const title = (n.title && n.title.trim()) ? n.title : '無題のノート';

        item.innerHTML = `
            <label class="nb-link-checkbox-wrap" onclick="event.stopPropagation()">
                <input type="checkbox" class="nb-link-checkbox" ${isChecked ? 'checked' : ''} onchange="toggleLinkNotebookSelection('${n.id}')">
            </label>
            <div class="nb-link-info">
                <div class="nb-link-title">📔 ${escapeHtml(title)}</div>
                <div class="nb-link-snippet">${escapeHtml(snippet)}</div>
            </div>
        `;
        container.appendChild(item);
    });
}

function toggleLinkNotebookSelection(noteId) {
    if (tempSelectedLinkIds.has(noteId)) {
        tempSelectedLinkIds.delete(noteId);
    } else {
        tempSelectedLinkIds.add(noteId);
    }
    renderLinkNotebookList();
}

async function saveNotebookLinksFromModal() {
    if (!currentLinkingNotebookId) return;
    const currentNote = notebookData.find(n => n.id === currentLinkingNotebookId);
    if (!currentNote) return;

    const oldLinks = new Set(Array.isArray(currentNote.linkedNoteIds) ? currentNote.linkedNoteIds : []);
    const newLinks = new Set(tempSelectedLinkIds);

    currentNote.linkedNoteIds = Array.from(newLinks);
    currentNote.updatedAt = new Date().toISOString();

    newLinks.forEach(targetId => {
        if (!oldLinks.has(targetId)) {
            const targetNote = notebookData.find(n => n.id === targetId);
            if (targetNote) {
                if (!Array.isArray(targetNote.linkedNoteIds)) targetNote.linkedNoteIds = [];
                if (!targetNote.linkedNoteIds.includes(currentLinkingNotebookId)) {
                    targetNote.linkedNoteIds.push(currentLinkingNotebookId);
                    targetNote.updatedAt = new Date().toISOString();
                }
            }
        }
    });

    oldLinks.forEach(targetId => {
        if (!newLinks.has(targetId)) {
            const targetNote = notebookData.find(n => n.id === targetId);
            if (targetNote && Array.isArray(targetNote.linkedNoteIds)) {
                targetNote.linkedNoteIds = targetNote.linkedNoteIds.filter(id => id !== currentLinkingNotebookId);
                targetNote.updatedAt = new Date().toISOString();
            }
        }
    });

    await saveNotebookData();
    closeModal('linkNotebookModal');
    renderRightCards();
    if (typeof renderFullscreenLinkedNotes === 'function') {
        renderFullscreenLinkedNotes();
    }
}

function openExportNotebookModal(id) {
    const note = notebookData.find(n => n.id === id);
    if (!note) return;
    currentExportingNotebookId = id;
    const targetTitleEl = document.getElementById('exportNotebookTargetTitle');
    if (targetTitleEl) {
        targetTitleEl.textContent = note.title && note.title.trim() ? `「${note.title.trim()}」` : '「無題のノート」';
    }
    openModal('exportNotebookModal');
}

function generateNotebookHtmlDocument(n) {
    const title = n.title && n.title.trim() ? escapeHtml(n.title.trim()) : '無題のノート';
    const catName = escapeHtml(n.category || 'ライフログ');
    const statusStr = (n.status || 'archive').toUpperCase();
    const createdDate = n.createdAt ? new Date(n.createdAt).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    const updatedDate = n.updatedAt ? new Date(n.updatedAt).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    const dateStr = updatedDate ? `更新: ${updatedDate}` : (createdDate ? `作成: ${createdDate}` : '');

    const tempDiv = _parseInert(sanitizeNoteHtml(n.content || '')).content;
    tempDiv.querySelectorAll('.nb-img-controls').forEach(el => el.remove());
    tempDiv.querySelectorAll('.nb-img-wrapper').forEach(el => el.classList.remove('selected'));
    tempDiv.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
    tempDiv.querySelectorAll('*').forEach(el => { for (const a of Array.from(el.attributes)) if (a.name.toLowerCase().startsWith('on')) el.removeAttribute(a.name); });
    const _wrap = document.createElement('template'); _wrap.content.appendChild(tempDiv);
    const cleanContent = _wrap.innerHTML;

    return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - Notebook</title>
    <style>
        :root {
            color-scheme: light dark;
            --bg: #08080a;
            --card-bg: #121215;
            --item-border: rgba(255, 255, 255, 0.08);
            --text-primary: #ffffff;
            --text-secondary: #98989f;
            --notebook-color: #30d158;
            --notebook-soft: rgba(48, 209, 88, 0.15);
        }
        @media (prefers-color-scheme: light) {
            :root {
                --bg: #f2f2f7;
                --card-bg: #ffffff;
                --item-border: rgba(0, 0, 0, 0.08);
                --text-primary: #1c1c1e;
                --text-secondary: #8e8e93;
                --notebook-color: #34c759;
                --notebook-soft: rgba(52, 199, 89, 0.15);
            }
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", Arial, sans-serif; }
        body { background-color: var(--bg); color: var(--text-primary); padding: 40px 20px; display: flex; justify-content: center; line-height: 1.6; }
        .notebook-container { width: 100%; max-width: 740px; background: var(--card-bg); border: 1px solid var(--item-border); border-radius: 20px; padding: 32px 36px; box-shadow: 0 10px 30px rgba(0,0,0,0.12); }
        header { margin-bottom: 24px; border-bottom: 1px solid var(--item-border); padding-bottom: 18px; }
        .eyebrow { font-size: 11px; font-weight: 800; letter-spacing: 0.8px; color: var(--notebook-color); text-transform: uppercase; margin-bottom: 6px; }
        h1.title { font-size: 26px; font-weight: 800; margin-bottom: 12px; line-height: 1.3; word-break: break-word; }
        .meta-row { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--text-secondary); }
        .badge { font-size: 11px; font-weight: 700; background: var(--notebook-soft); color: var(--notebook-color); padding: 2px 8px; border-radius: 6px; }
        .content-view { font-size: 15.5px; line-height: 1.7; word-break: break-word; }
        .content-view h1 { font-size: 1.55em; margin-top: 0.8em; margin-bottom: 0.35em; font-weight: 800; }
        .content-view h2 { font-size: 1.3em; margin-top: 0.75em; margin-bottom: 0.3em; font-weight: 750; }
        .content-view h3 { font-size: 1.15em; margin-top: 0.65em; margin-bottom: 0.25em; font-weight: 700; }
        .content-view ul, .content-view ol { margin: 8px 0 8px 24px; }
        .content-view li { margin-bottom: 4px; }
        .content-view hr { border: none; border-top: 1px solid var(--item-border); margin: 18px 0; }
        .nb-todo-item { display: flex; align-items: flex-start; gap: 8px; margin: 5px 0; }
        .nb-todo-checkbox { appearance: none; -webkit-appearance: none; width: 17px; height: 17px; border: 1.5px solid var(--text-secondary); border-radius: 4px; margin-top: 4px; flex-shrink: 0; position: relative; }
        .nb-todo-checkbox:checked { background-color: var(--notebook-color); border-color: var(--notebook-color); }
        .nb-todo-checkbox:checked::after { content: ''; position: absolute; left: 4.5px; top: 1px; width: 4px; height: 8px; border: solid #ffffff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
        .nb-todo-text { flex: 1; }
        .nb-todo-item.completed .nb-todo-text { text-decoration: line-through; opacity: 0.5; }
        .nb-img-wrapper { position: relative; display: inline-block; vertical-align: top; box-sizing: border-box; padding: 4px 0; line-height: 0; font-size: 0; }
        .nb-img-wrapper.size-full { width: 100%; display: block; }
        .nb-img-wrapper.size-half { width: 50%; }
        .nb-img-wrapper.size-quarter { width: 25%; }
        .nb-embedded-img { width: 100%; height: auto; max-height: 520px; object-fit: cover; border-radius: 10px; display: block; }
        .nb-img-controls { display: none !important; }

        .nb-quote-block {
            margin: 12px 0;
            padding: 8px 14px;
            border-left: 3.5px solid var(--notebook-color);
            background-color: rgba(128, 128, 128, 0.06);
            border-radius: 0 8px 8px 0;
            line-height: 1.6;
        }

        .nb-ai-prompt-block {
            margin: 12px 0 12px auto;
            max-width: 86%;
            padding: 10px 16px;
            background-color: rgba(128, 128, 128, 0.14);
            border-radius: 18px 18px 4px 18px;
            line-height: 1.6;
        }

        .nb-code-block {
            background-color: rgba(128, 128, 128, 0.12);
            border: 1px solid var(--item-border);
            border-radius: 10px;
            padding: 12px 14px;
            margin: 10px 0;
            font-family: monospace;
            font-size: 13.5px;
            white-space: pre-wrap;
            word-break: break-all;
        }
        .nb-table-wrapper { width: 100%; overflow-x: auto; margin: 10px 0; }
        .nb-editor-table { width: 100%; border-collapse: collapse; font-size: 14px; border: 1px solid var(--item-border); }
        .nb-editor-table th, .nb-editor-table td { border: 1px solid var(--item-border); padding: 8px 12px; text-align: left; }
        .nb-editor-table th { background-color: rgba(128, 128, 128, 0.14); font-weight: 700; }
        
        @media print {
            body { background: #ffffff !important; color: #000000 !important; padding: 0 !important; }
            .notebook-container { border: none !important; box-shadow: none !important; padding: 0 !important; max-width: 100% !important; }
            @page { size: auto; margin: 15mm; }
        }
    </style>
</head>
<body>
    <div class="notebook-container">
        <header>
            <div class="eyebrow">DAILY JOURNAL NOTEBOOK</div>
            <h1 class="title">📔 ${title}</h1>
            <div class="meta-row">
                <span class="badge">${catName}</span>
                <span class="badge">${statusStr}</span>
                ${dateStr ? `<span>${dateStr}</span>` : ''}
            </div>
        </header>
        <div class="content-view">${cleanContent}</div>
    </div>
</body>
</html>`;
}

function executeNotebookExport(format) {
    if (!currentExportingNotebookId) return;
    const note = notebookData.find(n => n.id === currentExportingNotebookId);
    if (!note) return;

    const htmlStr = generateNotebookHtmlDocument(note);
    const baseTitle = (note.title && note.title.trim() ? note.title.trim().replace(/[\\/:*?"<>|]/g, '_') : 'notebook');

    closeModal('exportNotebookModal');

    if (format === 'html') {
        const blob = new Blob([htmlStr], { type: 'text/html;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${baseTitle}.html`;
        document.body.appendChild(a);
        a.click();
        a.remove();
    } else if (format === 'pdf') {
        const iframe = document.createElement('iframe');
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = '0';
        document.body.appendChild(iframe);

        const doc = iframe.contentWindow.document;
        doc.open();
        doc.write(htmlStr);
        doc.close();

        setTimeout(() => {
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
            setTimeout(() => {
                if (iframe.parentNode) document.body.removeChild(iframe);
            }, 2000);
        }, 350);
    }
}

function triggerNotebookPhotoSelect(id) {
    currentActiveEditorNotebookId = id;
    const fileInput = document.getElementById('notebookPhotoInput');
    if (fileInput) fileInput.click();
}

async function handleNotebookPhotosSelected(e) {
    const files = Array.from(e.target.files);
    if (!files.length || !currentActiveEditorNotebookId) return;
    
    for (const f of files) {
        if (!f.type.startsWith('image/')) continue;
        try {
            const b64 = await resizeImageFile(f);
            insertImageToNotebook(currentActiveEditorNotebookId, b64);
        } catch (err) {}
    }
    e.target.value = "";
}

function parseMarkdownTableToHtml(plainText) {
    if (!plainText) return null;
    const lines = plainText.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length < 2) return null;

    const isMarkdownTable = lines.every(l => l.startsWith('|') && l.endsWith('|')) || lines.some(l => /^\|?\s*:?-+:?\s*(\|?\s*:?-+:?\s*)+\|?$/.test(l));
    if (!isMarkdownTable) return null;

    let headerRow = null;
    const bodyRows = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\|?\s*:?-+:?\s*(\|?\s*:?-+:?\s*)+\|?$/.test(line)) {
            continue;
        }

        const trimmed = line.replace(/^\|/, '').replace(/\|$/, '');
        const cells = trimmed.split('|').map(c => c.trim());

        if (!headerRow) {
            headerRow = cells;
        } else {
            bodyRows.push(cells);
        }
    }

    if (!headerRow || headerRow.length === 0) return null;

    const wrap = document.createElement('div');
    wrap.className = 'nb-table-wrapper';
    
    let theadHtml = '<thead><tr>' + headerRow.map(h => `<th>${escapeHtml(h)}</th>`).join('') + '</tr></thead>';
    let tbodyHtml = '<tbody>';
    if (bodyRows.length > 0) {
        bodyRows.forEach(row => {
            tbodyHtml += '<tr>';
            for (let c = 0; c < headerRow.length; c++) {
                const cellVal = row[c] !== undefined ? row[c] : '';
                tbodyHtml += `<td>${escapeHtml(cellVal)}</td>`;
            }
            tbodyHtml += '</tr>';
        });
    } else {
        tbodyHtml += '<tr>' + headerRow.map(() => `<td></td>`).join('') + '</tr>';
    }
    tbodyHtml += '</tbody>';

    wrap.innerHTML = `<table class="nb-editor-table">${theadHtml}${tbodyHtml}</table>`;
    decorateNotebookTable(wrap);
    return wrap;
}

function parseMixedMarkdownAndText(text) {
    const lines = text.split(/\r?\n/);
    const nodes = [];
    let tableBuffer = [];
    let quoteBuffer = [];

    function flushTable() {
        if (!tableBuffer.length) return;
        const wrap = parseMarkdownTableToHtml(tableBuffer.join('\n'));
        if (wrap) {
            nodes.push(wrap);
        } else {
            tableBuffer.forEach(l => {
                const d = document.createElement('div');
                d.textContent = l;
                nodes.push(d);
            });
        }
        tableBuffer = [];
    }

    function flushQuote() {
        if (!quoteBuffer.length) return;
        const bq = document.createElement('blockquote');
        bq.className = 'nb-quote-block';
        bq.innerHTML = quoteBuffer.map(l => escapeHtml(l)).join('<br>');
        nodes.push(bq);
        quoteBuffer = [];
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (trimmed.startsWith('>')) {
            flushTable();
            quoteBuffer.push(trimmed.replace(/^>\s?/, ''));
        } else if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
            flushQuote();
            tableBuffer.push(line);
        } else {
            flushTable();
            flushQuote();
            const d = document.createElement('div');
            if (trimmed === '') {
                d.innerHTML = '<br>';
            } else {
                d.textContent = line;
            }
            nodes.push(d);
        }
    }
    flushTable();
    flushQuote();

    return nodes.length ? nodes : null;
}

async function handleNotebookPaste(e, id) {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return;

    // 画像判定
    const items = clipboardData.items;
    if (items) {
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') !== -1) {
                e.preventDefault();
                const blob = items[i].getAsFile();
                if (blob) {
                    try {
                        const b64 = await resizeImageFile(blob);
                        insertImageToNotebook(id, b64);
                    } catch (err) {}
                }
                return;
            }
        }
    }

    // HTML判定
    const htmlData = clipboardData.getData('text/html');
    if (htmlData && (htmlData.includes('<table') || htmlData.includes('<blockquote') || htmlData.includes('border-left'))) {
        e.preventDefault();

        // クリップボードのHTMLは外部由来なので、整形前にサニタイズする（img onerror 等を除去）
        const parser = new DOMParser();
        const doc = parser.parseFromString(sanitizeNoteHtml(htmlData), 'text/html');

        const quotes = doc.querySelectorAll('blockquote, [style*="border-left"]');
        quotes.forEach(q => {
            if (q.tagName === 'TABLE' || q.closest('table')) return;
            const bq = doc.createElement('blockquote');
            bq.className = 'nb-quote-block';
            bq.innerHTML = q.innerHTML;
            q.parentNode.replaceChild(bq, q);
        });

        const tables = doc.querySelectorAll('table');
        tables.forEach(table => {
            table.className = 'nb-editor-table';
            table.removeAttribute('style');
            table.removeAttribute('width');
            table.removeAttribute('border');
            table.removeAttribute('cellpadding');
            table.removeAttribute('cellspacing');

            table.querySelectorAll('th, td').forEach(cell => {
                cell.removeAttribute('style');
                cell.removeAttribute('width');
                cell.removeAttribute('height');
                cell.removeAttribute('class');
            });

            const wrap = doc.createElement('div');
            wrap.className = 'nb-table-wrapper';
            table.parentNode.insertBefore(wrap, table);
            wrap.appendChild(table);
            decorateNotebookTable(wrap);
        });

        const fragment = document.createDocumentFragment();
        while (doc.body.firstChild) {
            fragment.appendChild(doc.body.firstChild);
        }

        insertNodeAtSelection(fragment);
        saveNotebookContentDirect(id);
        recordNotebookHistory(id, true);
        return;
    }

    // プレーンテキスト Markdown判定
    const plainText = clipboardData.getData('text/plain');
    if (plainText && (plainText.includes('|') || plainText.split('\n').some(l => l.trim().startsWith('>')))) {
        const parsedNodes = parseMixedMarkdownAndText(plainText);
        if (parsedNodes) {
            e.preventDefault();
            const fragment = document.createDocumentFragment();
            parsedNodes.forEach(node => fragment.appendChild(node));

            insertNodeAtSelection(fragment);
            saveNotebookContentDirect(id);
            recordNotebookHistory(id, true);
            return;
        }
    }
}

function insertImageToNotebook(id, base64Url, size = 'size-quarter') {
    const contentArea = document.getElementById(`nb_content_view_${id}`);
    if (!contentArea) return;
    contentArea.focus();

    const wrapper = document.createElement('span');
    wrapper.className = `nb-img-wrapper ${size}`;
    wrapper.setAttribute('contenteditable', 'false');

    wrapper.innerHTML = `
        <img class="nb-embedded-img" src="${base64Url}" alt="挿入画像">
        <div class="nb-img-controls" onclick="event.stopPropagation()">
            <button type="button" class="nb-img-btn ${size === 'size-full' ? 'active' : ''}" onclick="setNotebookImageSize(this, 'size-full', '${id}')">1/1</button>
            <button type="button" class="nb-img-btn ${size === 'size-half' ? 'active' : ''}" onclick="setNotebookImageSize(this, 'size-half', '${id}')">1/2</button>
            <button type="button" class="nb-img-btn ${size === 'size-quarter' ? 'active' : ''}" onclick="setNotebookImageSize(this, 'size-quarter', '${id}')">1/4</button>
            <button type="button" class="nb-img-btn del" onclick="removeNotebookImage(this, '${id}')">✕</button>
        </div>
    `;

    insertNodeAtSelection(wrapper);

    if (wrapper.nextSibling && wrapper.nextSibling.nodeName === 'BR') {
        wrapper.nextSibling.remove();
    }

    saveNotebookContentDirect(id);
    recordNotebookHistory(id, true);
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.nb-img-wrapper')) {
        document.querySelectorAll('.nb-img-wrapper.selected').forEach(w => w.classList.remove('selected'));
    }
});

function setNotebookImageSize(btn, sizeClass, notebookId) {
    const wrapper = btn.closest('.nb-img-wrapper');
    if (!wrapper) return;

    wrapper.classList.remove('size-full', 'size-half', 'size-quarter');
    wrapper.classList.add(sizeClass);

    const controls = wrapper.querySelector('.nb-img-controls');
    if (controls) {
        controls.querySelectorAll('.nb-img-btn').forEach(b => {
            if (b.classList.contains('del')) return;
            b.classList.toggle('active', b.textContent === (sizeClass === 'size-full' ? '1/1' : sizeClass === 'size-half' ? '1/2' : '1/4'));
        });
    }

    saveNotebookContentDirect(notebookId);
    recordNotebookHistory(notebookId, true);
}

function removeNotebookImage(btn, notebookId) {
    const wrapper = btn.closest('.nb-img-wrapper');
    if (wrapper) {
        wrapper.remove();
        saveNotebookContentDirect(notebookId);
        recordNotebookHistory(notebookId, true);
    }
}

function toggleNotebookCheckbox(id) {
    const contentArea = document.getElementById(`nb_content_view_${id}`);
    if (!contentArea) return;
    contentArea.focus();

    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);

    const blocks = getSelectedBlocks(contentArea, range);

    if (!blocks || blocks.length === 0) {
        const todoDiv = document.createElement('div');
        todoDiv.className = 'nb-todo-item';
        todoDiv.innerHTML = `<input type="checkbox" class="nb-todo-checkbox" contenteditable="false"><span class="nb-todo-text"></span>`;
        insertNodeAtSelection(todoDiv);
        const textSpan = todoDiv.querySelector('.nb-todo-text');
        if (textSpan) setCursorToTodoText(textSpan);
        saveNotebookContentDirect(id);
        recordNotebookHistory(id, true);
        return;
    }

    const allAreTodos = blocks.every(b => b.classList && b.classList.contains('nb-todo-item'));

    if (allAreTodos) {
        let lastDiv = null;
        blocks.forEach(b => {
            const textSpan = b.querySelector('.nb-todo-text');
            const content = textSpan ? textSpan.innerHTML : '<br>';
            const div = document.createElement('div');
            div.innerHTML = content.trim() ? content : '<br>';
            b.parentNode.replaceChild(div, b);
            lastDiv = div;
        });
        if (lastDiv) setCursorToElement(lastDiv, false);
    } else {
        let targetTextSpan = null;
        blocks.forEach(b => {
            if (b.classList && b.classList.contains('nb-todo-item')) return;

            let textHtml = b.innerHTML.trim();
            if (textHtml === '<br>' || textHtml === '&nbsp;') textHtml = '';

            const todoDiv = document.createElement('div');
            todoDiv.className = 'nb-todo-item';
            todoDiv.innerHTML = `<input type="checkbox" class="nb-todo-checkbox" contenteditable="false"><span class="nb-todo-text">${textHtml}</span>`;
            
            b.parentNode.replaceChild(todoDiv, b);
            targetTextSpan = todoDiv.querySelector('.nb-todo-text');
        });
        if (targetTextSpan) setCursorToTodoText(targetTextSpan);
    }

    saveNotebookContentDirect(id);
    recordNotebookHistory(id, true);
}

function getSelectedBlocks(root, range) {
    const blocks = [];
    normalizeEditorChildNodes(root);

    Array.from(root.children).forEach(child => {
        if (range.intersectsNode(child)) {
            blocks.push(child);
        }
    });

    if (blocks.length === 0) {
        let node = range.startContainer;
        while (node && node.parentElement !== root && node !== root) {
            node = node.parentElement;
        }
        if (node && node !== root) blocks.push(node);
    }
    return blocks;
}

function normalizeEditorChildNodes(root) {
    const nodes = Array.from(root.childNodes);
    nodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
            const div = document.createElement('div');
            div.textContent = node.textContent;
            root.replaceChild(div, node);
        }
    });
}

function getDirectChildBlock(container, node) {
    if (!node || !container) return null;
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el) return null;
    while (el.parentElement && el.parentElement !== container) {
        el = el.parentElement;
    }
    return (el.parentElement === container) ? el : null;
}

function stripNestedBlockTags(html, tagNames) {
    const temp = _parseInert(html).content;
    const selector = tagNames.join(', ');
    temp.querySelectorAll(selector).forEach(elToUnwrap => {
        while (elToUnwrap.firstChild) {
            elToUnwrap.parentNode.insertBefore(elToUnwrap.firstChild, elToUnwrap);
        }
        elToUnwrap.remove();
    });
    const out = document.createElement('template'); out.content.appendChild(temp);
    return out.innerHTML;
}

function setNotebookBlockFormat(id, tag) {
    const contentArea = document.getElementById(`nb_content_view_${id}`);
    if (!contentArea) return;
    contentArea.focus();

    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);

    let startBlock = getDirectChildBlock(contentArea, range.startContainer);
    let endBlock = getDirectChildBlock(contentArea, range.endContainer);
    if (!startBlock || !endBlock) return;

    if (startBlock !== endBlock) {
        const pos = startBlock.compareDocumentPosition(endBlock);
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) {
            const tmp = startBlock; startBlock = endBlock; endBlock = tmp;
        }
    }

    const blocks = [];
    let node = startBlock;
    while (node) {
        blocks.push(node);
        if (node === endBlock) break;
        node = node.nextElementSibling;
    }

    const SKIP_TAGS = ['HR', 'TABLE', 'UL', 'OL'];
    const SKIP_CLASSES = ['nb-todo-item', 'nb-quote-block', 'nb-ai-prompt-block', 'nb-code-block'];
    const HEADING_TAGS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'];

    let lastNewEl = null;
    blocks.forEach(block => {
        if (!block || SKIP_TAGS.includes(block.tagName)) return;
        if (block.classList && SKIP_CLASSES.some(c => block.classList.contains(c))) return;

        const newEl = document.createElement(tag);
        const cleanedHtml = stripNestedBlockTags(block.innerHTML, HEADING_TAGS);
        newEl.innerHTML = cleanedHtml && cleanedHtml.trim() !== '' ? cleanedHtml : '<br>';
        block.parentNode.replaceChild(newEl, block);
        lastNewEl = newEl;
    });

    if (lastNewEl) {
        setCursorToElement(lastNewEl, false);
    }
    saveNotebookContentDirect(id);
    recordNotebookHistory(id, true);
}

function isCaretAtBlockStart(block, range) {
    if (!range || !range.collapsed) return false;
    const testRange = document.createRange();
    testRange.selectNodeContents(block);
    try {
        testRange.setEnd(range.startContainer, range.startOffset);
    } catch (err) {
        return false;
    }
    if (testRange.toString().length > 0) return false;
    const fragment = testRange.cloneContents();
    return fragment.querySelectorAll('img, hr, input').length === 0;
}

function insertNotebookHr(id) {
    const contentArea = document.getElementById(`nb_content_view_${id}`);
    if (!contentArea) return;
    contentArea.focus();

    const hr = document.createElement('hr');
    insertNodeAtSelection(hr);
    setCursorToElement(hr, false);
    saveNotebookContentDirect(id);
    recordNotebookHistory(id, true);
}

function insertNodeAtSelection(node) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(node);
    range.collapse(false);
}

function setCursorToElement(el, selectAll = false) {
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(el);
    if (!selectAll) {
        range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
}

function setCursorToTodoText(textSpan) {
    textSpan.focus();
    if (!textSpan.firstChild) {
        textSpan.appendChild(document.createTextNode(''));
    }
    const targetNode = textSpan.lastChild;
    const range = document.createRange();
    const sel = window.getSelection();

    if (targetNode.nodeType === Node.TEXT_NODE) {
        range.setStart(targetNode, targetNode.length);
        range.setEnd(targetNode, targetNode.length);
    } else {
        range.selectNodeContents(textSpan);
        range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
}

function insertLineBreakInBlock(blockNode) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);

    range.deleteContents();

    const br = document.createElement('br');
    range.insertNode(br);

    let nextNode = br.nextSibling;
    while (nextNode && nextNode.nodeType === Node.TEXT_NODE && nextNode.textContent === '') {
        nextNode = nextNode.nextSibling;
    }

    if (!nextNode) {
        const dummyBr = document.createElement('br');
        dummyBr.setAttribute('data-dummy-br', 'true');
        br.parentNode.appendChild(dummyBr);
    }

    range.setStartAfter(br);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
}

function breakOutOfSpecialBlock(blockNode, id) {
    const newDiv = document.createElement('div');
    newDiv.innerHTML = '<br>';

    let parentContainer = blockNode;
    const tableWrapper = blockNode.closest('.nb-table-wrapper');
    if (tableWrapper) parentContainer = tableWrapper;

    if (parentContainer.nextSibling) {
        parentContainer.parentNode.insertBefore(newDiv, parentContainer.nextSibling);
    } else {
        parentContainer.parentNode.appendChild(newDiv);
    }

    setCursorToElement(newDiv, true);
    saveNotebookContentDirect(id);
    recordNotebookHistory(id, true);
}

function handleNotebookKeyDown(e, id) {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const isCtrl = isMac ? e.metaKey : e.ctrlKey;

    if (isCtrl && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redoNotebookEdit(id);
        else undoNotebookEdit(id);
        return;
    }

    if (isCtrl && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redoNotebookEdit(id);
        return;
    }

    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const anchor = sel.anchorNode;
    if (!anchor) return;
    const contentArea = document.getElementById(`nb_content_view_${id}`);

    if (e.key === 'Backspace' && !e.isComposing && contentArea) {
        const currentBlock = getDirectChildBlock(contentArea, anchor);
        const prevHr = currentBlock && currentBlock.previousElementSibling && currentBlock.previousElementSibling.tagName === 'HR'
            ? currentBlock.previousElementSibling
            : null;
        if (prevHr) {
            const range = sel.getRangeAt(0);
            if (isCaretAtBlockStart(currentBlock, range)) {
                e.preventDefault();
                prevHr.remove();
                saveNotebookContentDirect(id);
                recordNotebookHistory(id, true);
                return;
            }
        }
    }

    const todoItem = anchor.nodeType === Node.ELEMENT_NODE ? anchor.closest('.nb-todo-item') : anchor.parentElement ? anchor.parentElement.closest('.nb-todo-item') : null;
    const listItem = anchor.nodeType === Node.ELEMENT_NODE ? anchor.closest('li') : anchor.parentElement ? anchor.parentElement.closest('li') : null;
    const quoteItem = anchor.nodeType === Node.ELEMENT_NODE ? anchor.closest('.nb-quote-block') : anchor.parentElement ? anchor.parentElement.closest('.nb-quote-block') : null;
    const promptItem = anchor.nodeType === Node.ELEMENT_NODE ? anchor.closest('.nb-ai-prompt-block') : anchor.parentElement ? anchor.parentElement.closest('.nb-ai-prompt-block') : null;
    const codeItem = anchor.nodeType === Node.ELEMENT_NODE ? anchor.closest('.nb-code-block') : anchor.parentElement ? anchor.parentElement.closest('.nb-code-block') : null;
    const tableCell = anchor.nodeType === Node.ELEMENT_NODE ? anchor.closest('td, th') : anchor.parentElement ? anchor.parentElement.closest('td, th') : null;

    if (e.key === 'Tab' && !e.isComposing && tableCell) {
        e.preventDefault();
        const table = tableCell.closest('table');
        const row = tableCell.parentElement;
        const cellsInRow = Array.from(row.children).filter(c => c.tagName === 'TD' || c.tagName === 'TH');
        const cellIndex = cellsInRow.indexOf(tableCell);
        let targetCell = null;

        if (e.shiftKey) {
            if (cellIndex > 0) {
                targetCell = cellsInRow[cellIndex - 1];
            } else {
                const prevRow = row.previousElementSibling
                    || (row.parentElement.tagName === 'TBODY' ? table.querySelector('thead tr') : null);
                if (prevRow) {
                    const prevCells = Array.from(prevRow.children).filter(c => c.tagName === 'TD' || c.tagName === 'TH');
                    targetCell = prevCells[prevCells.length - 1] || null;
                }
            }
        } else {
            if (cellIndex < cellsInRow.length - 1) {
                targetCell = cellsInRow[cellIndex + 1];
            } else {
                let nextRow = row.nextElementSibling;
                if (!nextRow && row.parentElement.tagName === 'THEAD') {
                    nextRow = table.querySelector('tbody tr');
                }
                if (nextRow) {
                    targetCell = nextRow.children[0] || null;
                } else {
                    const newRow = addNotebookTableRow(table);
                    targetCell = newRow ? newRow.firstElementChild : null;
                    saveNotebookContentDirect(id);
                    recordNotebookHistory(id, true);
                }
            }
        }

        if (targetCell) setCursorToElement(targetCell, true);
        return;
    }

    if (e.key === 'Enter' && e.shiftKey && !e.isComposing) {
        if (codeItem) {
            e.preventDefault();
            breakOutOfSpecialBlock(codeItem, id);
            return;
        }
        if (quoteItem) {
            e.preventDefault();
            breakOutOfSpecialBlock(quoteItem, id);
            return;
        }
        if (promptItem) {
            e.preventDefault();
            breakOutOfSpecialBlock(promptItem, id);
            return;
        }
        if (tableCell) {
            e.preventDefault();
            breakOutOfSpecialBlock(tableCell, id);
            return;
        }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        if (codeItem) {
            e.preventDefault();
            insertLineBreakInBlock(codeItem);
            saveNotebookContentDirect(id);
            recordNotebookHistory(id, false);
            return;
        }

        if (quoteItem) {
            e.preventDefault();
            insertLineBreakInBlock(quoteItem);
            saveNotebookContentDirect(id);
            recordNotebookHistory(id, false);
            return;
        }

        if (promptItem) {
            e.preventDefault();
            insertLineBreakInBlock(promptItem);
            saveNotebookContentDirect(id);
            recordNotebookHistory(id, false);
            return;
        }

        if (tableCell) {
            e.preventDefault();
            insertLineBreakInBlock(tableCell);
            saveNotebookContentDirect(id);
            recordNotebookHistory(id, false);
            return;
        }

        if (todoItem) {
            e.preventDefault();
            const textSpan = todoItem.querySelector('.nb-todo-text');
            const textContent = textSpan ? textSpan.textContent.replace(/\u00a0/g, '').trim() : '';

            if (!textContent) {
                const normalDiv = document.createElement('div');
                normalDiv.innerHTML = '<br>';
                todoItem.parentNode.replaceChild(normalDiv, todoItem);
                setCursorToElement(normalDiv, true);
                saveNotebookContentDirect(id);
                recordNotebookHistory(id, true);
                return;
            }

            const newTodo = document.createElement('div');
            newTodo.className = 'nb-todo-item';
            newTodo.innerHTML = `<input type="checkbox" class="nb-todo-checkbox" contenteditable="false"><span class="nb-todo-text"></span>`;

            if (todoItem.nextSibling) {
                todoItem.parentNode.insertBefore(newTodo, todoItem.nextSibling);
            } else {
                todoItem.parentNode.appendChild(newTodo);
            }

            const newText = newTodo.querySelector('.nb-todo-text');
            if (newText) setCursorToTodoText(newText);
            saveNotebookContentDirect(id);
            recordNotebookHistory(id, true);
            return;
        }

        if (listItem) {
            const listText = listItem.textContent.replace(/\u00a0/g, '').trim();
            if (!listText) {
                e.preventDefault();
                const listParent = listItem.closest('ul, ol');
                const normalDiv = document.createElement('div');
                normalDiv.innerHTML = '<br>';

                if (listParent) {
                    listItem.remove();
                    if (listParent.children.length === 0) {
                        listParent.parentNode.replaceChild(normalDiv, listParent);
                    } else {
                        if (listParent.nextSibling) {
                            listParent.parentNode.insertBefore(normalDiv, listParent.nextSibling);
                        } else {
                            listParent.parentNode.appendChild(normalDiv);
                        }
                    }
                }
                setCursorToElement(normalDiv, true);
                saveNotebookContentDirect(id);
                recordNotebookHistory(id, true);
                return;
            }
        }
    }

    if (e.key === 'Backspace' && !e.isComposing) {
        if (todoItem) {
            const textSpan = todoItem.querySelector('.nb-todo-text');
            const textContent = textSpan ? textSpan.textContent.replace(/\u00a0/g, '').trim() : '';
            const isAtStart = sel.anchorOffset === 0;

            if (!textContent || isAtStart) {
                e.preventDefault();
                const prev = todoItem.previousElementSibling;
                
                if (prev) {
                    const prevTodoText = prev.querySelector ? prev.querySelector('.nb-todo-text') : null;
                    todoItem.remove();
                    if (prevTodoText) {
                        setCursorToTodoText(prevTodoText);
                    } else {
                        setCursorToElement(prev, false);
                    }
                } else {
                    const normalDiv = document.createElement('div');
                    normalDiv.innerHTML = '<br>';
                    todoItem.parentNode.replaceChild(normalDiv, todoItem);
                    setCursorToElement(normalDiv, true);
                }
                saveNotebookContentDirect(id);
                recordNotebookHistory(id, true);
                return;
            }
        }

        if (quoteItem) {
            const entireQuoteText = quoteItem.textContent.replace(/\u00a0/g, '').trim();
            if (!entireQuoteText) {
                e.preventDefault();
                const normalDiv = document.createElement('div');
                normalDiv.innerHTML = '<br>';
                quoteItem.parentNode.replaceChild(normalDiv, quoteItem);
                setCursorToElement(normalDiv, true);
                saveNotebookContentDirect(id);
                recordNotebookHistory(id, true);
                return;
            }
        }

        if (promptItem) {
            const entirePromptText = promptItem.textContent.replace(/\u00a0/g, '').trim();
            if (!entirePromptText) {
                e.preventDefault();
                const normalDiv = document.createElement('div');
                normalDiv.innerHTML = '<br>';
                promptItem.parentNode.replaceChild(normalDiv, promptItem);
                setCursorToElement(normalDiv, true);
                saveNotebookContentDirect(id);
                recordNotebookHistory(id, true);
                return;
            }
        }

        if (codeItem) {
            const entireCodeText = codeItem.textContent.replace(/\u00a0/g, '').trim();
            if (!entireCodeText) {
                e.preventDefault();
                const normalDiv = document.createElement('div');
                normalDiv.innerHTML = '<br>';
                codeItem.parentNode.replaceChild(normalDiv, codeItem);
                setCursorToElement(normalDiv, true);
                saveNotebookContentDirect(id);
                recordNotebookHistory(id, true);
                return;
            }
        }

        if (listItem) {
            const listText = listItem.textContent.replace(/\u00a0/g, '').trim();
            const listParent = listItem.closest('ul, ol');

            if (!listText) {
                e.preventDefault();
                const prev = listItem.previousElementSibling;
                listItem.remove();

                if (listParent && listParent.children.length === 0) {
                    const normalDiv = document.createElement('div');
                    normalDiv.innerHTML = '<br>';
                    listParent.parentNode.replaceChild(normalDiv, listParent);
                    setCursorToElement(normalDiv, true);
                } else if (prev) {
                    setCursorToElement(prev, false);
                } else if (listParent) {
                    const normalDiv = document.createElement('div');
                    normalDiv.innerHTML = '<br>';
                    listParent.parentNode.insertBefore(normalDiv, listParent);
                    setCursorToElement(normalDiv, true);
                }
                saveNotebookContentDirect(id);
                recordNotebookHistory(id, true);
                return;
            }
        }
    }
}

function handleNotebookCopy(e) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;

    const container = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) {
        container.appendChild(sel.getRangeAt(i).cloneContents());
    }

    const todoElements = container.querySelectorAll('.nb-todo-item');
    if (todoElements.length > 0) {
        e.preventDefault();

        const htmlContainer = document.createElement('div');
        const plainTextLines = [];

        Array.from(container.childNodes).forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE && node.classList && node.classList.contains('nb-todo-item')) {
                const checkbox = node.querySelector('.nb-todo-checkbox');
                const textSpan = node.querySelector('.nb-todo-text');
                const isChecked = checkbox && (checkbox.checked || checkbox.hasAttribute('checked'));
                const text = textSpan ? textSpan.textContent.replace(/\u00a0/g, ' ').trim() : '';

                const ul = document.createElement('ul');
                ul.style.listStyleType = 'none';
                ul.style.paddingLeft = '0';
                ul.style.margin = '0';
                
                const li = document.createElement('li');
                li.setAttribute('data-type', 'to-do');
                li.innerHTML = `<input type="checkbox" ${isChecked ? 'checked' : ''} disabled> <span>${escapeHtml(text)}</span>`;
                ul.appendChild(li);
                htmlContainer.appendChild(ul);

                plainTextLines.push(`${isChecked ? '[x]' : '[ ]'} ${text}`);
            } else {
                htmlContainer.appendChild(node.cloneNode(true));
                const txt = node.textContent ? node.textContent.trim() : '';
                if (txt) plainTextLines.push(txt);
            }
        });

        if (e.clipboardData) {
            e.clipboardData.setData('text/html', htmlContainer.innerHTML);
            e.clipboardData.setData('text/plain', plainTextLines.join('\n'));
        }
    }
}

function handleNotebookContentClick(event, id) {
    const target = event.target;
    if (!target) return;

    if (target.tagName === 'IMG' || target.classList.contains('nb-embedded-img')) {
        event.stopPropagation();
        const contentArea = document.getElementById(`nb_content_view_${id}`);
        const isEditing = contentArea && contentArea.classList.contains('is-editing');

        if (isEditing) {
            const wrapper = target.closest('.nb-img-wrapper');
            if (wrapper) {
                const isSelected = wrapper.classList.contains('selected');
                document.querySelectorAll('.nb-img-wrapper.selected').forEach(w => w.classList.remove('selected'));
                if (!isSelected) wrapper.classList.add('selected');
            }
        } else {
            document.querySelectorAll('.nb-img-wrapper.selected').forEach(w => w.classList.remove('selected'));
            openLightbox(target.src);
        }
        return;
    }

    if (target.classList.contains('nb-todo-checkbox')) {
        const item = target.closest('.nb-todo-item');
        if (item) {
            item.classList.toggle('completed', target.checked);
            if (target.checked) target.setAttribute('checked', 'checked');
            else target.removeAttribute('checked');
        }
        saveNotebookContentDirect(id);
        recordNotebookHistory(id, true);
        return;
    }
}

function handleNotebookContainerDblClick(event, id) {
    const target = event.target;
    const contentArea = document.getElementById(`nb_content_view_${id}`);
    if (!contentArea) return;

    if (target && target.id === `nb_logs_wrapper_${id}`) {
        enableNotebookEdit(id, 'content');
        const newDiv = document.createElement('div');
        newDiv.innerHTML = '<br>';
        contentArea.appendChild(newDiv);
        setCursorToElement(newDiv, true);
        saveNotebookContentDirect(id);
        recordNotebookHistory(id, true);
        event.stopPropagation();
    }
}

function handleNotebookContentDblClick(event, id) {
    const target = event.target;
    if (target && (target.classList.contains('nb-todo-checkbox') || target.tagName === 'IMG' || target.classList.contains('nb-embedded-img') || target.closest('.nb-img-controls'))) {
        return;
    }
    
    enableNotebookEdit(id, 'content');

    if (target && target.id === `nb_content_view_${id}`) {
        const lastChild = target.lastElementChild;
        if (lastChild && (lastChild.classList.contains('nb-code-block') || lastChild.classList.contains('nb-quote-block') || lastChild.classList.contains('nb-ai-prompt-block') || lastChild.classList.contains('nb-table-wrapper'))) {
            const newDiv = document.createElement('div');
            newDiv.innerHTML = '<br>';
            target.appendChild(newDiv);
            setCursorToElement(newDiv, true);
            saveNotebookContentDirect(id);
            recordNotebookHistory(id, true);
        }
    }
}

function enableNotebookEdit(id, focusTarget = 'content') {
    currentActiveEditorNotebookId = id;
    const _scroller = document.getElementById('connectedCenterScroller');
    const _slide = _scroller ? _scroller.querySelector(`[data-id="${id}"]`) : null;
    if (_slide) ensureCardContentRendered(_scroller, Number(_slide.dataset.index) || 0);

    const note = notebookData.find(n => n.id === id);
    if (note) {
        notebookEditorOriginalBackup = {
            id: note.id,
            title: note.title || '',
            content: note.content || '',
            // 「新規」は＋ボタンで作った直後のノートだけ（既存の空ノートをキャンセルで消さない）
            isNew: freshNotebookIds.has(note.id),
            baseUpdatedAt: note.updatedAt || ''
        };

        clearTimeout(historyDebounceTimer);
        editorHistoryStack = [{ title: note.title || '', content: note.content || '' }];
        editorHistoryIndex = 0;
    }

    const toolbar = document.getElementById(`nb_toolbar_${id}`);
    const titleView = document.getElementById(`nb_title_view_${id}`);
    const titleEdit = document.getElementById(`nb_title_edit_${id}`);
    const contentArea = document.getElementById(`nb_content_view_${id}`);

    if (toolbar) toolbar.style.display = 'flex';
    
    if (titleView && titleEdit) {
        titleView.style.display = 'none';
        titleEdit.style.display = 'block';
    }
    
    if (contentArea) {
        contentArea.setAttribute('contenteditable', 'true');
        contentArea.classList.add('is-editing');
    }

    updateUndoRedoButtonUI(id);

    if (focusTarget === 'title' && titleEdit) {
        titleEdit.focus();
        titleEdit.select();
    } else if (contentArea) {
        contentArea.focus();
    }
}

async function saveNotebookContentDirect(id) {
    const contentArea = document.getElementById(`nb_content_view_${id}`);
    const idx = notebookData.findIndex(x => x.id === id);
    if (idx !== -1 && contentArea) {
        notebookData[idx].content = contentArea.innerHTML;
        notebookData[idx].updatedAt = new Date().toISOString();
        await saveNotebookData();
    }
}

async function saveNotebookEdit(id) {
    const titleEdit = document.getElementById(`nb_title_edit_${id}`);
    const contentArea = document.getElementById(`nb_content_view_${id}`);
    
    const idx = notebookData.findIndex(x => x.id === id);
    
    if (idx !== -1) {
        if (titleEdit) {
            notebookData[idx].title = titleEdit.value.trim();
        }
        if (contentArea) {
            contentArea.querySelectorAll('.nb-img-wrapper.selected').forEach(w => w.classList.remove('selected'));
            contentArea.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
            contentArea.removeAttribute('contenteditable');
            contentArea.classList.remove('is-editing');
            notebookData[idx].content = contentArea.innerHTML;
        }
        notebookData[idx].updatedAt = new Date().toISOString();
        freshNotebookIds.delete(id);
        notebookEditConflicts.delete(id);
        
        await saveNotebookData();
        
        clearTimeout(historyDebounceTimer);
        editorHistoryStack = [];
        editorHistoryIndex = -1;
        notebookEditorOriginalBackup = null;
        currentActiveEditorNotebookId = null;

        currentNotebookIndex = getFilteredNotebooks().findIndex(x => x.id === id);
        if (currentNotebookIndex === -1) currentNotebookIndex = 0;
        renderRightCards();
        if (sidebarMode === 'cal') renderNotebookSidebar();
    }
}

async function cancelNotebookEdit(id) {
    clearTimeout(historyDebounceTimer);
    editorHistoryStack = [];
    editorHistoryIndex = -1;

    if (!notebookEditorOriginalBackup || notebookEditorOriginalBackup.id !== id) {
        currentActiveEditorNotebookId = null;
        renderRightCards();
        return;
    }

    const backup = notebookEditorOriginalBackup;
    const idx = notebookData.findIndex(n => n.id === id);

    // 編集中に他端末で削除されていた場合、キャンセル＝削除を受け入れる
    const conflict = notebookEditConflicts.get(id);
    notebookEditConflicts.delete(id);
    if (conflict && conflict.deleted && idx !== -1) {
        notebookData.splice(idx, 1);
        notebookData.forEach(o => { if (Array.isArray(o.linkedNoteIds) && o.linkedNoteIds.includes(id)) o.linkedNoteIds = o.linkedNoteIds.filter(x => x !== id); });
        notebookTombstones[id] = conflict.editedAt;
        rebaselineNotebooks(notebookData.map(n => n.id).concat([id]));
        await persistNotebooks();
        notebookEditorOriginalBackup = null;
        currentActiveEditorNotebookId = null;
        currentNotebookIndex = Math.max(0, Math.min(currentNotebookIndex, getFilteredNotebooks().length - 1));
        renderRightCards();
        if (sidebarMode === 'cal') renderNotebookSidebar();
        return;
    }

    if (idx !== -1) {
        if (backup.isNew) {
            freshNotebookIds.delete(id);
            notebookData.splice(idx, 1);
            await saveNotebookData();
            currentNotebookIndex = Math.max(0, currentNotebookIndex - 1);
        } else {
            notebookData[idx].title = backup.title;
            notebookData[idx].content = backup.content;
            await saveNotebookData();
        }
    }

    notebookEditorOriginalBackup = null;
    currentActiveEditorNotebookId = null;

    renderRightCards();
    if (sidebarMode === 'cal') renderNotebookSidebar();
}

async function deleteNotebookDirect(id) {
    if (confirm("このノートを Trash に移動しますか？")) {
        clearTimeout(historyDebounceTimer);
        editorHistoryStack = [];
        editorHistoryIndex = -1;
        notebookEditorOriginalBackup = null;
        currentActiveEditorNotebookId = null;
        await changeNotebookStatus(id, 'trash');
    }
}

async function openAddNotebookModal() {
    const validTypes = appTypes.filter(t => typeNotebookSettings[t] !== false && categories.some(c => (c.type || "一般") === t));
    if (!validTypes.length) { 
        alert("Notebooksが有効なカテゴリがありません。設定を確認してください。"); 
        return; 
    }

    let defCat = categories.find(c => (c.type || "一般") === validTypes[0]).name;
    if (currentFilter.mode === 'category' && categories.some(c => c.name === currentFilter.value && validTypes.includes(c.type || "一般"))) {
        defCat = currentFilter.value;
    } else if (currentFilter.mode === 'type' && validTypes.includes(currentFilter.value)) { 
        const f = categories.find(c => (c.type || "一般") === currentFilter.value); 
        if (f) defCat = f.name; 
    }

    const newId = 'nb_' + Date.now().toString() + Math.floor(Math.random() * 1000);
    freshNotebookIds.add(newId);

    notebookData.unshift({
        id: newId,
        title: '',
        content: '',
        category: defCat,
        status: 'active',
        linkedNoteIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    if (notebookViewMode === 'grid' || notebookViewMode === 'graph' || notebookViewMode === 'trash') {
        notebookViewMode = 'card';
    }

    currentNotebookIndex = 0;
    notebookSearchQuery = "";

    await saveNotebookData();

    if (calendarScope !== 'notebooks') { 
        calendarScope = 'notebooks'; 
        updateScopeButtonsUI(); 
        updateJumpButtonLabel(); 
        if (sidebarMode === 'cal') updateSidebars();
    }

    renderRightCards(); 
    if (sidebarMode === 'cal') renderNotebookSidebar();

    setTimeout(() => {
        enableNotebookEdit(newId, 'title');
        const titleEdit = document.getElementById(`nb_title_edit_${newId}`);
        if (titleEdit) titleEdit.focus();
    }, 150);
}