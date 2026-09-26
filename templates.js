// ==========================================
// templates.js（定型文：追記画面を「少し進めた状態」で開く）
// ==========================================
// 定型文は、追記画面の項目（カテゴリ・本文の書き出し・タグ・Slack の相手/自分）のうち、決めておきたいものだけを入れたひな形。
// 呼び出し方は2つ：
//   1. 下の「追記」ボタンを長押し → 一覧（指を離さずに滑らせて選ぶこともできる）→ 中身の入った追記画面が開く
//   2. 追記画面の本文欄の右上のアイコン → 一覧 → 今の画面に中身を足す（書いた内容は消さない）
// 範囲（scope）はタグと同じ：'common'＝共通 ／ タイプ名＝そのタイプ全体 ／ 'cat:カテゴリ名'＝そのカテゴリだけ（記録先もそのカテゴリ）
// 登録簿（templateDefs）は main.js。設定と一緒にクラウドで同期される。
// 「前回そのひな形で記録したカテゴリ」は端末ごとに覚える（同期しない）。

const TPL_LONG_PRESS_MS = 450;
const TPL_MARK = '＿';                       // 本文の書き出しの中で、開いたときにカーソルを置く位置
const TPL_LASTCAT_KEY = 'daily_journal_template_lastcat';
let _addTemplateId = null;                  // いまの追記画面に最後に使った定型文

// ------------------------------------------
// 範囲・表示
// ------------------------------------------
function tplTypeOf(t) {
    if (t.scope === TAG_COMMON) return null;
    const c = scopeCat(t.scope);
    return c !== null ? getLogCategoryType(c) : t.scope;
}
function tplScopeHeading(scope) {
    if (scope === TAG_COMMON) return '共通';
    const c = scopeCat(scope);
    return c !== null ? `${c}だけ` : `${scope}全体`;
}
function tplIcon(t) { return t.icon || '📝'; }
function _tplSort(list) {
    return list.slice().sort((a, b) => (scopeLevel(a.scope) - scopeLevel(b.scope)) || (templateDefs.indexOf(a) - templateDefs.indexOf(b)));
}
// 長押し：下のメニューで選んでいる範囲（ホーム・すべて・タイプ・カテゴリ）に合うもの
function getTemplatesForFilter() {
    const f = currentFilter;
    return _tplSort(templateDefs.filter(t => {
        if (f.mode === 'category') return isTagVisibleFor(t, f.value);
        if (t.scope === TAG_COMMON) return true;
        const ty = tplTypeOf(t);
        if (f.mode === 'type') return ty === f.value;
        if (f.mode === 'all') return isTypeShownOnHome(ty);
        return true;
    }));
}
// 追記画面のアイコン：画面で選んでいるカテゴリに合うもの（タグの候補と同じ考え方）
function getTemplatesForCategory(cat) {
    return _tplSort(templateDefs.filter(t => isTagVisibleFor(t, cat)));
}

// ------------------------------------------
// 前回のカテゴリ（端末ごと）
// ------------------------------------------
function _loadLastCats() { try { const v = JSON.parse(localStorage.getItem(TPL_LASTCAT_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } }
function _saveLastCats(m) { try { localStorage.setItem(TPL_LASTCAT_KEY, JSON.stringify(m)); } catch (e) {} }
function getTemplateLastCategory(id) { return _loadLastCats()[id] || null; }
function setTemplateLastCategory(id, cat) {
    if (!id || !cat) return;
    const m = _loadLastCats();
    // 使われなくなった定型文の分は捨てる
    for (const k of Object.keys(m)) if (!templateDefs.some(t => t.id === k)) delete m[k];
    m[id] = cat;
    _saveLastCats(m);
}
function renameTemplateLastCategory(from, to) {
    const m = _loadLastCats();
    let changed = false;
    for (const k of Object.keys(m)) if (m[k] === from) { m[k] = to; changed = true; }
    if (changed) _saveLastCats(m);
}

// 長押しで開くときの記録先カテゴリ
// 1. 「〜だけ」の定型文ならそのカテゴリ  2. 下のメニューでカテゴリを選んでいればそのカテゴリ
// 3. 前回この定型文で記録したカテゴリ（範囲と下のメニューの選択に合うもの）  4. 今までどおりの初期値
function resolveTemplateCategory(t) {
    const exists = n => !!n && categories.some(c => c.name === n);
    const sc = scopeCat(t.scope);
    if (sc !== null && exists(sc)) return sc;
    const f = currentFilter;
    if (f.mode === 'category' && exists(f.value)) return f.value;
    const tType = (sc === null && t.scope !== TAG_COMMON) ? t.scope : null;
    const fitsFilter = n => {
        const ty = getLogCategoryType(n);
        if (f.mode === 'type') return ty === f.value;
        if (f.mode === 'all') return isTypeShownOnHome(ty);
        return true;
    };
    const last = getTemplateLastCategory(t.id);
    if (exists(last) && (!tType || getLogCategoryType(last) === tType) && fitsFilter(last)) return last;
    const firstOf = ty => { const c = categories.find(x => (x.type || '一般') === ty); return c ? c.name : null; };
    if (tType) return firstOf(tType);
    if (f.mode === 'type') return firstOf(f.value);
    return null; // 追記画面のいつもの初期値のまま
}

// ------------------------------------------
// 追記画面に中身を入れる
// ------------------------------------------
// fresh=true：長押しから開いたばかりの画面（カテゴリも決め直す）
// fresh=false：画面のアイコンから（書いた内容は消さず、「〜だけ」の定型文のときだけカテゴリを切り替える）
function applyTemplateToAddModal(t, fresh) {
    if (!t) return;
    const cat = fresh ? resolveTemplateCategory(t) : scopeCat(t.scope);
    if (cat && cat !== selectedAddCategory && categories.some(c => c.name === cat)) {
        selectedAddCategory = cat;
        renderModalCategoryChips('add', cat);
        updateMsgTypeVisibility('add', cat);
    }
    if (t.tags && t.tags.length) {
        const merged = currentAddTags.slice();
        t.tags.forEach(x => { if (!merged.includes(x)) merged.push(x); });
        currentAddTags = merged;
        renderTagSection('add');
    }
    if (t.slackType && isSlackEnabledForType(getLogCategoryType(selectedAddCategory))) setMessageType('add', t.slackType);

    const ta = document.getElementById('journalInputText');
    const raw = t.text || '';
    const mark = raw.indexOf(TPL_MARK);
    const body = mark === -1 ? raw : raw.slice(0, mark) + raw.slice(mark + 1);
    let pos;
    if (raw) {
        const cur = ta.value;
        if (!cur.trim()) { ta.value = body; pos = mark === -1 ? body.length : mark; }
        else {
            const sep = cur.endsWith('\n') ? '' : '\n';
            ta.value = cur + sep + body;
            pos = cur.length + sep.length + (mark === -1 ? body.length : mark);
        }
    } else pos = ta.value.length;

    _addTemplateId = t.id;
    _showTemplateNote(t);
    // 追記画面を開いたときのフォーカス（約200ms後）より後に、カーソルを置き直す
    setTimeout(() => { try { ta.focus(); ta.setSelectionRange(pos, pos); } catch (e) {} }, fresh ? 260 : 0);
    if (typeof scheduleDraftSave === 'function') scheduleDraftSave();
}
function _showTemplateNote(t) {
    const el = document.getElementById('addTemplateNote');
    if (!el) return;
    if (!t) { el.style.display = 'none'; el.textContent = ''; return; }
    el.textContent = `${tplIcon(t)} 定型文「${t.name}」から`;
    el.style.display = '';
}
function openAddModalWithTemplate(id) {
    const t = templateDefs.find(x => x.id === id);
    openAddModal();
    if (t) applyTemplateToAddModal(t, true);
}

// 追記画面を開くたびに、使った定型文の記録を消す
(function wrapAddModalForTemplates() {
    const origOpen = window.openAddModal;
    if (typeof origOpen === 'function') {
        window.openAddModal = function (...args) { _addTemplateId = null; _showTemplateNote(null); return origOpen.apply(this, args); };
    }
    // 保存できたら、その定型文で最後に記録したカテゴリを覚える（この端末だけ）
    const origSave = window.saveNewLog;
    if (typeof origSave === 'function') {
        window.saveNewLog = async function (...args) {
            const id = _addTemplateId, cat = selectedAddCategory;
            const r = await origSave.apply(this, args);
            const stillOpen = document.getElementById('addModal').classList.contains('active');
            if (id && !stillOpen) { setTemplateLastCategory(id, cat); _addTemplateId = null; }
            return r;
        };
    }
})();

// ------------------------------------------
// 一覧（長押し・画面のアイコンで共通）
// ------------------------------------------
let _tplPopMode = null;       // 'launch'（長押し） / 'modal'（追記画面のアイコン）
let _tplPopAnchor = null;
function _tplPop() {
    let pop = document.getElementById('tplPopover');
    if (!pop) {
        pop = document.createElement('div');
        pop.id = 'tplPopover';
        pop.className = 'tpl-pop';
        pop.setAttribute('role', 'menu');
        document.body.appendChild(pop);
    }
    return pop;
}
function isTemplatePopoverOpen() { const p = document.getElementById('tplPopover'); return !!(p && p.classList.contains('open')); }
function openTemplatePopover(mode, anchor) {
    _tplPopMode = mode; _tplPopAnchor = anchor;
    const pop = _tplPop();
    const list = mode === 'launch' ? getTemplatesForFilter() : getTemplatesForCategory(selectedAddCategory);
    const title = mode === 'launch' ? '定型文から書く' : `定型文（${selectedAddCategory}）`;
    let html = `<div class="tpl-pop-title">${escapeHtml(title)}</div><div class="tpl-pop-list">`;
    if (!list.length) {
        html += `<div class="tpl-pop-empty">${templateDefs.length ? 'この表示で使える定型文はありません' : 'まだ定型文がありません'}</div>`;
    } else {
        let cur = null;
        list.forEach(t => {
            if (t.scope !== cur) { cur = t.scope; html += `<div class="tpl-pop-sec">${escapeHtml(tplScopeHeading(t.scope))}</div>`; }
            html += `<button type="button" class="tpl-item" role="menuitem" data-tpl-id="${t.id}"><span class="tpl-item-icon">${escapeHtml(tplIcon(t))}</span><span class="tpl-item-main"><span class="tpl-item-name">${escapeHtml(t.name)}</span><span class="tpl-item-sub">${escapeHtml(templateSummary(t))}</span></span></button>`;
        });
    }
    html += '</div>';
    if (mode === 'launch') html += `<button type="button" class="tpl-item tpl-item-plain" data-tpl-id="">✏️ 白紙から書く</button>`;
    html += `<button type="button" class="tpl-pop-manage" data-tpl-manage="1">定型文を編集・追加</button>`;
    pop.innerHTML = html;
    pop.classList.toggle('is-launch', mode === 'launch');
    pop.classList.add('open');
    positionTemplatePopover();
    document.querySelectorAll('.tpl-open-btn.is-on').forEach(b => b.classList.remove('is-on'));
    if (mode === 'modal' && anchor) anchor.classList.add('is-on');
}
function closeTemplatePopover() {
    const pop = document.getElementById('tplPopover');
    if (pop) { pop.classList.remove('open'); pop.querySelectorAll('.is-hover').forEach(e => e.classList.remove('is-hover')); }
    document.querySelectorAll('.tpl-open-btn.is-on').forEach(b => b.classList.remove('is-on'));
    _tplPopAnchor = null; _tplPopMode = null;
}
function positionTemplatePopover() {
    const pop = document.getElementById('tplPopover');
    if (!pop || !_tplPopAnchor || !pop.classList.contains('open')) return;
    const r = _tplPopAnchor.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(300, vw - 24);
    pop.style.width = w + 'px';
    if (_tplPopMode === 'launch') {
        // ボタンの上に出す（指で隠れないように）
        const left = Math.max(12, Math.min(vw - w - 12, r.left + r.width / 2 - w / 2));
        pop.style.left = left + 'px';
        pop.style.top = '';
        pop.style.bottom = (vh - r.top + 10) + 'px';
        pop.style.maxHeight = Math.max(180, r.top - 24) + 'px';
    } else {
        const left = Math.max(12, Math.min(vw - w - 12, r.right - w));
        const top = r.bottom + 6;
        pop.style.left = left + 'px';
        pop.style.bottom = '';
        pop.style.top = top + 'px';
        pop.style.maxHeight = Math.max(180, vh - top - 16) + 'px';
    }
}
// 一覧の2行目：何が入るか（本文の書き出し・タグ・カテゴリ）
function templateSummary(t) {
    const parts = [];
    const text = (t.text || '').replace(new RegExp(TPL_MARK, 'g'), '').replace(/\s+/g, ' ').trim();
    if (text) parts.push(text.length > 18 ? text.slice(0, 18) + '…' : text);
    if (t.tags && t.tags.length) parts.push(t.tags.map(x => '#' + x).join(' '));
    if (!parts.length) { const c = scopeCat(t.scope); parts.push(c !== null ? `カテゴリ：${c}` : '（中身なし）'); }
    return parts.join('　');
}
function chooseTemplateFromPopover(id) {
    const mode = _tplPopMode;
    closeTemplatePopover();
    if (mode === 'launch') {
        if (!id) { openAddModal(); return; }
        openAddModalWithTemplate(id);
    } else {
        const t = templateDefs.find(x => x.id === id);
        if (t) applyTemplateToAddModal(t, false);
    }
}
function openTemplateSettings() {
    closeTemplatePopover();
    openModal('settingsModal');
    switchSettingsTab('templates');
}
// 追記画面のアイコン
function toggleTemplatePopoverInModal(btn) {
    if (isTemplatePopoverOpen() && _tplPopAnchor === btn) { closeTemplatePopover(); return; }
    openTemplatePopover('modal', btn);
}

document.addEventListener('click', e => {
    const pop = document.getElementById('tplPopover');
    if (!pop || !pop.classList.contains('open')) return;
    const item = e.target.closest ? e.target.closest('#tplPopover [data-tpl-id]') : null;
    if (item) { e.stopPropagation(); chooseTemplateFromPopover(item.dataset.tplId); return; }
    const manage = e.target.closest ? e.target.closest('#tplPopover [data-tpl-manage]') : null;
    if (manage) { e.stopPropagation(); openTemplateSettings(); return; }
    if (!pop.contains(e.target) && !(_tplPopAnchor && _tplPopAnchor.contains(e.target))) closeTemplatePopover();
}, true);
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isTemplatePopoverOpen()) { e.stopPropagation(); closeTemplatePopover(); }
}, true);
window.addEventListener('resize', () => positionTemplatePopover());

// ------------------------------------------
// 追記ボタンの長押し
// ------------------------------------------
// 約0.45秒押し続けると一覧を出す。指を離さずに滑らせて離すと、その定型文で開く。
// 押してすぐ離したときは、今までどおり白紙の追記画面（ボタン本来の動作）。
(function setupLaunchLongPress() {
    const btn = document.getElementById('launcherMainBtn');
    if (!btn) return;
    let timer = null, start = null, pressed = false, fired = false, hovered = null, suppressUntil = 0;
    const enabled = () => calendarScope !== 'notebooks' && !window.IS_READONLY_MODE && !(typeof isTabActive === 'function' && !isTabActive());
    const setHover = el => {
        if (hovered === el) return;
        if (hovered) hovered.classList.remove('is-hover');
        hovered = el;
        if (hovered) hovered.classList.add('is-hover');
    };
    const itemAt = (x, y) => {
        const el = document.elementFromPoint(x, y);
        return el && el.closest ? el.closest('#tplPopover [data-tpl-id]') : null;
    };
    const fire = () => {
        timer = null;
        if (!pressed || !enabled()) return;
        fired = true;
        openTemplatePopover('launch', btn);
        try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) {}
    };
    btn.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (!enabled()) return;
        pressed = true; fired = false; start = { x: e.clientX, y: e.clientY }; setHover(null);
        if (isTemplatePopoverOpen()) closeTemplatePopover();
        try { btn.setPointerCapture(e.pointerId); } catch (err) {}
        clearTimeout(timer);
        timer = setTimeout(fire, TPL_LONG_PRESS_MS);
    });
    btn.addEventListener('pointermove', e => {
        if (!pressed) return;
        if (!fired) {
            if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 12) { clearTimeout(timer); timer = null; }
            return;
        }
        setHover(itemAt(e.clientX, e.clientY));
    });
    const end = (e, cancelled) => {
        if (!pressed) return;
        pressed = false;
        clearTimeout(timer); timer = null;
        if (!fired) return;
        // 長押しの後に続く click（白紙の追記画面を開く）を止める
        suppressUntil = Date.now() + 600;
        const target = !cancelled && e ? itemAt(e.clientX, e.clientY) : null;
        setHover(null);
        if (target) chooseTemplateFromPopover(target.dataset.tplId);
        // 何も選ばずに離したときは一覧を開いたままにする（あとからタップで選べる）
    };
    btn.addEventListener('pointerup', e => end(e, false));
    btn.addEventListener('pointercancel', e => end(e, true));
    // パソコンでは右クリックでも一覧を出す。スマホの長押しメニューは出さない
    btn.addEventListener('contextmenu', e => {
        e.preventDefault();
        if (!fired && enabled()) { openTemplatePopover('launch', btn); suppressUntil = Date.now() + 600; }
    });
    document.addEventListener('click', e => {
        if (Date.now() < suppressUntil && btn.contains(e.target)) { e.stopPropagation(); e.preventDefault(); }
    }, true);
})();

// ------------------------------------------
// 設定 > 定型文
// ------------------------------------------
let _tplSortables = [];
function _scopeTree() {
    const tree = appTypes.map(ty => ({ ty, cats: categories.filter(c => (c.type || '一般') === ty).map(c => c.name) }));
    const scopes = [TAG_COMMON];
    tree.forEach(g => { scopes.push(g.ty); g.cats.forEach(c => scopes.push(catScope(c))); });
    return { tree, scopes };
}
function templateScopeOptionsHtml(cur) {
    const { tree, scopes } = _scopeTree();
    const opt = (s, label) => `<option value="${escapeHtml(s)}" ${s === cur ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    return opt(TAG_COMMON, '共通（どこでも）')
        + tree.map(g => `<optgroup label="${escapeHtml(g.ty)}">${opt(g.ty, g.ty + '全体')}${g.cats.map(c => opt(catScope(c), c + 'だけ')).join('')}</optgroup>`).join('')
        + (cur && !scopes.includes(cur) ? opt(cur, tagScopeLabel(cur) + '（なし）') : '');
}
function renderSettingsTemplateList() {
    const box = document.getElementById('settingsTemplateList');
    if (!box) return;
    const cnt = document.getElementById('templateCountIndicator');
    if (cnt) cnt.textContent = `${templateDefs.length}件`;
    _tplSortables.forEach(s => { try { s.destroy(); } catch (e) {} });
    _tplSortables = [];
    if (!templateDefs.length) {
        box.innerHTML = '<div class="tag-pk-empty">まだ定型文がありません。「＋ 定型文を作る」か、記録の編集画面の「この記録を定型文にする」から作れます</div>';
        return;
    }
    const { scopes } = _scopeTree();
    const groups = scopes.map(s => ({ s, list: templateDefs.filter(t => t.scope === s) }))
        .concat([{ s: null, list: templateDefs.filter(t => !scopes.includes(t.scope)) }])
        .filter(g => g.list.length);
    box.innerHTML = groups.map(g => `<div class="tag-set-group"><div class="tag-set-head">${g.s === null ? 'その他' : escapeHtml(tplScopeHeading(g.s))}</div><div class="tpl-set-list">` + g.list.map(t => `
        <div class="tpl-set-row" data-id="${t.id}">
            <span class="drag-handle" title="ドラッグして並べ替え">⠿</span>
            <span class="tpl-set-icon">${escapeHtml(tplIcon(t))}</span>
            <span class="tpl-set-main"><span class="tpl-set-name">${escapeHtml(t.name)}</span><span class="tpl-set-sub">${escapeHtml(templateSummary(t))}</span></span>
            <button type="button" class="settings-icon-btn edit-btn" data-tpl-edit="${t.id}" title="編集">✏️</button>
        </div>`).join('') + '</div></div>').join('');
    if (window.Sortable) {
        box.querySelectorAll('.tpl-set-list').forEach(el => {
            _tplSortables.push(new Sortable(el, {
                handle: '.drag-handle', animation: 160, ghostClass: 'sortable-ghost', chosenClass: 'sortable-chosen',
                onEnd: () => {
                    const ids = Array.from(box.querySelectorAll('.tpl-set-row')).map(r => r.dataset.id);
                    templateDefs.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
                    saveTemplateDefs();
                }
            }));
        });
    }
}
document.addEventListener('click', e => {
    const b = e.target.closest ? e.target.closest('[data-tpl-edit]') : null;
    if (b) openTemplateEditor(b.dataset.tplEdit);
});

// ------------------------------------------
// 定型文の編集画面
// ------------------------------------------
let _tplEditingId = null;
function _tplEditorEl() {
    let ov = document.getElementById('templateEditModal');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.id = 'templateEditModal';
    ov.style.zIndex = '2550';
    ov.onclick = e => { if (e.target === ov) closeModal('templateEditModal'); };
    ov.innerHTML = `
        <div class="modal-content tpl-edit-content">
            <div class="modal-header"><span id="tplEditTitle">定型文を作る</span></div>
            <div class="tpl-edit-row">
                <input type="text" class="settings-text-input tpl-edit-icon" id="tplEditIcon" placeholder="📝" maxlength="4" aria-label="記号（絵文字）">
                <input type="text" class="settings-text-input" id="tplEditName" placeholder="名前（例：面談メモ）" maxlength="40">
            </div>
            <div class="tpl-edit-field">
                <label class="tpl-edit-label" for="tplEditScope">範囲（どこで出るか）</label>
                <select class="settings-select" id="tplEditScope" onchange="renderTemplateEditorTagSuggest()"></select>
                <div class="tpl-edit-hint" id="tplEditScopeHint"></div>
            </div>
            <div class="tpl-edit-field">
                <div class="tpl-edit-label-row"><label class="tpl-edit-label" for="tplEditText">本文の書き出し（なくてもよい）</label><button type="button" class="storage-link-btn" onclick="insertTemplateMark()">＿ を入れる</button></div>
                <textarea id="tplEditText" class="tpl-edit-text" placeholder="進み具合：＿&#10;困っていること：&#10;次回までに："></textarea>
                <div class="tpl-edit-hint">「＿」の位置に、開いたときのカーソルが来ます（なければ末尾）。</div>
            </div>
            <div class="tpl-edit-field">
                <label class="tpl-edit-label" for="tplEditTags">タグ（なくてもよい）</label>
                <input type="text" class="settings-text-input" id="tplEditTags" placeholder="#面談 #進捗" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false">
                <div class="tpl-edit-tagsg" id="tplEditTagSuggest"></div>
            </div>
            <div class="tpl-edit-field">
                <label class="tpl-edit-label" for="tplEditSlack">Slack（Slack を使うタイプでだけ反映）</label>
                <select class="settings-select" id="tplEditSlack">
                    <option value="">通常のメモ</option>
                    <option value="incoming">相手から</option>
                    <option value="outgoing">自分から</option>
                </select>
            </div>
            <div class="modal-actions three-columns" id="tplEditActions">
                <button class="modal-btn delete" id="tplEditDeleteBtn" onclick="deleteTemplateFromEditor()">削除</button>
                <button class="modal-btn cancel" onclick="closeModal('templateEditModal')">キャンセル</button>
                <button class="modal-btn submit" onclick="saveTemplateFromEditor()">保存</button>
            </div>
        </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('change', e => { if (e.target.id === 'tplEditScope') _updateScopeHint(); });
    return ov;
}
function _updateScopeHint() {
    const s = document.getElementById('tplEditScope').value;
    const c = scopeCat(s);
    document.getElementById('tplEditScopeHint').textContent = s === TAG_COMMON
        ? 'どのカテゴリでも出ます。記録先は、表示中のカテゴリ・前回このひな形で記録したカテゴリの順で決まります。'
        : c !== null ? `「${c}」を表示中・選択中のときに出て、記録先は常に「${c}」です。`
        : `${s}のどのカテゴリでも出ます。記録先は、表示中のカテゴリ・前回このひな形で記録したカテゴリの順で決まります。`;
}
// prefill：新しく作るときの初期値（「この記録を定型文にする」から）
function openTemplateEditor(id, prefill = null) {
    _tplEditorEl();
    const t = id ? templateDefs.find(x => x.id === id) : null;
    const d = t || Object.assign({ name: '', icon: '', scope: TAG_COMMON, text: '', tags: [], slackType: null }, prefill || {});
    _tplEditingId = t ? t.id : null;
    document.getElementById('tplEditTitle').textContent = t ? '定型文を編集' : '定型文を作る';
    document.getElementById('tplEditIcon').value = d.icon || '';
    document.getElementById('tplEditName').value = d.name || '';
    document.getElementById('tplEditScope').innerHTML = templateScopeOptionsHtml(d.scope || TAG_COMMON);
    document.getElementById('tplEditText').value = d.text || '';
    document.getElementById('tplEditTags').value = (d.tags || []).map(x => '#' + x).join(' ');
    document.getElementById('tplEditSlack').value = d.slackType || '';
    document.getElementById('tplEditDeleteBtn').style.display = t ? '' : 'none';
    document.getElementById('tplEditActions').classList.toggle('three-columns', !!t);
    _updateScopeHint();
    renderTemplateEditorTagSuggest();
    openModal('templateEditModal');
    if (!t) setTimeout(() => { const n = document.getElementById('tplEditName'); if (n && !n.value) n.focus(); }, 200);
}
function _parseTagInput(v) { return sanitizeTagList(String(v || '').split(/[\s,、，]+/)); }
function renderTemplateEditorTagSuggest() {
    const box = document.getElementById('tplEditTagSuggest');
    if (!box) return;
    const s = document.getElementById('tplEditScope').value;
    const c = scopeCat(s);
    const have = _parseTagInput(document.getElementById('tplEditTags').value);
    const all = getAllTags().filter(t => !have.includes(t.name) && (
        s === TAG_COMMON ? true
        : c !== null ? isTagVisibleFor(t, c)
        : (t.scope === TAG_COMMON || t.scope === s || (scopeCat(t.scope) !== null && getLogCategoryType(scopeCat(t.scope)) === s))
    )).sort((a, b) => (b.fav - a.fav) || _byCount(a, b)).slice(0, 12);
    box.innerHTML = all.map(t => `<button type="button" class="tag-chip-fav" data-tpl-addtag="${escapeHtml(t.name)}">${escapeHtml(t.name)}</button>`).join('');
}
document.addEventListener('click', e => {
    const b = e.target.closest ? e.target.closest('[data-tpl-addtag]') : null;
    if (!b) return;
    const inp = document.getElementById('tplEditTags');
    const tags = _parseTagInput(inp.value);
    if (!tags.includes(b.dataset.tplAddtag)) tags.push(b.dataset.tplAddtag);
    inp.value = tags.map(x => '#' + x).join(' ') + ' ';
    renderTemplateEditorTagSuggest();
});
document.addEventListener('input', e => { if (e.target && e.target.id === 'tplEditTags') renderTemplateEditorTagSuggest(); });
function insertTemplateMark() {
    const ta = document.getElementById('tplEditText');
    const re = new RegExp(TPL_MARK, 'g');
    const a = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    const before = ta.value.slice(0, a).replace(re, ''); // 印は1つだけにする
    const after = ta.value.slice(a).replace(re, '');
    ta.value = before + TPL_MARK + after;
    ta.focus(); ta.setSelectionRange(before.length + 1, before.length + 1);
}
function saveTemplateFromEditor() {
    const name = document.getElementById('tplEditName').value.trim();
    if (!name) { alert('名前を入力してください。'); document.getElementById('tplEditName').focus(); return; }
    const scope = document.getElementById('tplEditScope').value || TAG_COMMON;
    const tags = _parseTagInput(document.getElementById('tplEditTags').value);
    // 登録されていないタグは、定型文と同じ範囲のタグとして登録する
    tags.forEach(x => { if (!getAllTags().some(t => t.name === x)) createTagDef(x, scope); });
    const d = {
        id: _tplEditingId || generateId('tp_'),
        name,
        icon: document.getElementById('tplEditIcon').value,
        scope,
        text: document.getElementById('tplEditText').value.replace(/\s+$/, ''),
        tags,
        slackType: document.getElementById('tplEditSlack').value || null
    };
    const clean = sanitizeTemplateDefs([d])[0];
    if (!clean) { alert('保存できませんでした。'); return; }
    const i = templateDefs.findIndex(x => x.id === clean.id);
    if (i !== -1) templateDefs[i] = clean; else templateDefs.push(clean);
    saveTemplateDefs();
    closeModal('templateEditModal');
    renderSettingsTemplateList();
    if (!document.getElementById('settingsModal').classList.contains('active')) showToast(`定型文「${clean.name}」を保存しました。追記ボタンの長押しか、追記画面のアイコンから使えます。`, 5000);
}
function deleteTemplateFromEditor() {
    const t = templateDefs.find(x => x.id === _tplEditingId);
    if (!t || !confirm(`定型文「${t.name}」を削除しますか？\n（これまでの記録には影響しません）`)) return;
    templateDefs.splice(templateDefs.indexOf(t), 1);
    saveTemplateDefs();
    closeModal('templateEditModal');
    renderSettingsTemplateList();
}
// 記録の編集画面から：いまの内容をひな形にする
function createTemplateFromEditModal() {
    const text = document.getElementById('editInputText').value.trim();
    const first = (text.split('\n')[0] || '').trim();
    openTemplateEditor(null, {
        name: first ? first.slice(0, 16) : selectedEditCategory,
        scope: catScope(selectedEditCategory),
        text,
        tags: (currentEditTags || []).slice(),
        slackType: currentEditMsgType !== 'normal' ? currentEditMsgType : null
    });
}

// 同期などで登録簿が変わったとき、開いている画面を描き直す
function refreshOpenTemplateUIs() {
    const page = document.getElementById('settingsPageTemplates');
    if (page && page.classList.contains('active')) renderSettingsTemplateList();
    if (isTemplatePopoverOpen() && _tplPopAnchor) openTemplatePopover(_tplPopMode, _tplPopAnchor);
}
