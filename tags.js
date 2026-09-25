// ==========================================
// tags.js (タグ：入力・候補・選択画面・表示・タグ一覧・設定)
// ==========================================
// タグは本文とは別の項目（log.tags）。本文の文字は一切変えない。
// ・タイプのタグ：そのタイプのカテゴリで入力しているときだけ候補に出る
// ・共通のタグ：どのタイプでも候補に出る
// 登録簿（tagDefs）は main.js。設定と一緒にクラウドで同期される。

let currentAddTags = [];
let currentEditTags = [];
let _tagPickerMode = null;
let _tagPickerQuery = '';
const _tagSuggestIndex = { add: 0, edit: 0 };

function _modalTags(m) { return m === 'add' ? currentAddTags : currentEditTags; }
function _setModalTags(m, arr) { if (m === 'add') currentAddTags = arr; else currentEditTags = arr; }
function _modalType(m) { return getLogCategoryType(m === 'add' ? selectedAddCategory : selectedEditCategory); }
function tagScopeLabel(s) { return s === TAG_COMMON ? '共通' : s; }
function getTagDef(name) { return tagDefs.find(d => d.name === name) || null; }

function getTagCounts() {
    const c = new Map();
    for (const d of Object.keys(journalData)) for (const log of (journalData[d] || [])) for (const t of (log.tags || [])) c.set(t, (c.get(t) || 0) + 1);
    return c;
}

// すべてのタグ（登録簿＋記録に使われているが未登録のもの＝共通扱い）
function getAllTags() {
    const counts = getTagCounts();
    const out = tagDefs.map(d => Object.assign({}, d, { count: counts.get(d.name) || 0, registered: true }));
    counts.forEach((n, name) => { if (!getTagDef(name)) out.push({ name, scope: TAG_COMMON, fav: false, count: n, registered: false }); });
    return out;
}
function getTagsForType(type) { return getAllTags().filter(t => t.scope === type || t.scope === TAG_COMMON); }
function _byCount(a, b) { return (b.count - a.count) || a.name.localeCompare(b.name, 'ja'); }

function createTagDef(name, scope) {
    name = normalizeTagName(name);
    if (!name) return null;
    const ex = getTagDef(name);
    if (ex) return ex;
    const d = { name, scope: scope || TAG_COMMON, fav: false };
    tagDefs.push(d);
    saveTagDefs();
    return d;
}
function toggleTagFav(name) {
    let d = getTagDef(name);
    if (!d) { d = { name, scope: TAG_COMMON, fav: false }; tagDefs.push(d); }
    d.fav = !d.fav;
    saveTagDefs();
}

// ------------------------------------------
// 追記・編集画面のタグ欄
// ------------------------------------------
function addTagToModal(m, name) {
    name = normalizeTagName(name);
    if (!name) return;
    const list = _modalTags(m);
    if (!list.includes(name)) _setModalTags(m, list.concat([name]));
    const inp = document.getElementById(m + 'TagInput');
    if (inp) inp.value = '';
    renderTagSection(m);
    if (typeof scheduleDraftSave === 'function') scheduleDraftSave();
}
function removeTagFromModal(m, name) {
    _setModalTags(m, _modalTags(m).filter(t => t !== name));
    renderTagSection(m);
    if (typeof scheduleDraftSave === 'function') scheduleDraftSave();
}
function createTagFromModal(m, name, scope) {
    const d = createTagDef(name, scope);
    if (d) addTagToModal(m, d.name);
    const inp = document.getElementById(m + 'TagInput');
    if (inp) inp.focus();
}

function renderTagSection(m) {
    const selBox = document.getElementById(m + 'TagSelected');
    const favBox = document.getElementById(m + 'TagFavs');
    if (!selBox || !favBox) return;
    const sel = _modalTags(m);
    selBox.innerHTML = sel.map(t => `<span class="tag-chip-sel">#${escapeHtml(t)}<button type="button" class="tag-chip-x" data-tag-remove="${escapeHtml(t)}" data-tag-mode="${m}" aria-label="外す">✕</button></span>`).join('');
    const favs = getTagsForType(_modalType(m)).filter(t => t.fav && !sel.includes(t.name));
    favBox.innerHTML = favs.length ? `<span class="tag-fav-mark" aria-hidden="true">☆</span>` + favs.map(t => `<button type="button" class="tag-chip-fav" data-tag-add="${escapeHtml(t.name)}" data-tag-mode="${m}">${escapeHtml(t.name)}</button>`).join('') : '';
    favBox.style.display = favs.length ? '' : 'none';
    renderTagSuggest(m);
}

// 入力中の候補（入力欄の上に重ねて出す。下の要素は動かさない）
function _suggestItems(m, q) {
    const type = _modalType(m);
    const sel = _modalTags(m);
    const all = getAllTags();
    const visible = all.filter(t => t.scope === type || t.scope === TAG_COMMON);
    const others = all.filter(t => !(t.scope === type || t.scope === TAG_COMMON));
    const hit = arr => arr.filter(t => t.name.includes(q)).sort((a, b) => ((b.name === q) - (a.name === q)) || _byCount(a, b));
    const items = hit(visible).slice(0, 6).map(t => ({ kind: 'use', t }));
    hit(others).slice(0, 3).forEach(t => items.push({ kind: 'use', t, other: true }));
    const exists = all.some(t => t.name === q);
    if (!exists) items.push({ kind: 'new', name: q, type });
    return { items, sel };
}
function renderTagSuggest(m) {
    const box = document.getElementById(m + 'TagSuggest');
    const inp = document.getElementById(m + 'TagInput');
    if (!box || !inp) return;
    const q = normalizeTagName(inp.value);
    if (!q || document.activeElement !== inp) { box.classList.remove('open'); box.innerHTML = ''; return; }
    const { items, sel } = _suggestItems(m, q);
    if (_tagSuggestIndex[m] >= items.length) _tagSuggestIndex[m] = 0;
    box.innerHTML = items.map((it, i) => {
        const act = i === _tagSuggestIndex[m] ? ' is-active' : '';
        if (it.kind === 'use') {
            const added = sel.includes(it.t.name);
            return `<button type="button" class="tag-sg-row${act}" data-tag-add="${escapeHtml(it.t.name)}" data-tag-mode="${m}"><span>#${escapeHtml(it.t.name)}${added ? '<span class="tag-sg-note">追加済み</span>' : ''}</span><span class="tag-sg-meta">${it.other ? '他のタイプ・' : ''}${escapeHtml(tagScopeLabel(it.t.scope))}・${it.t.count}件</span></button>`;
        }
        return `<div class="tag-sg-row tag-sg-new${act}"><span>＋「${escapeHtml(it.name)}」を新しく作る</span><span class="tag-sg-scopes"><button type="button" class="tag-scope-btn" data-tag-new="${escapeHtml(it.name)}" data-tag-scope="${escapeHtml(it.type)}" data-tag-mode="${m}">${escapeHtml(it.type)}のタグ</button><button type="button" class="tag-scope-btn" data-tag-new="${escapeHtml(it.name)}" data-tag-scope="${TAG_COMMON}" data-tag-mode="${m}">共通のタグ</button></span></div>`;
    }).join('');
    box.classList.add('open');
}
function handleTagInput(m) { _tagSuggestIndex[m] = 0; renderTagSuggest(m); }
function handleTagInputKeydown(e, m) {
    if (e.isComposing || e.keyCode === 229) return;
    const inp = e.target;
    const q = normalizeTagName(inp.value);
    if (e.key === 'Backspace' && !inp.value) {
        const sel = _modalTags(m);
        if (sel.length) { e.preventDefault(); removeTagFromModal(m, sel[sel.length - 1]); }
        return;
    }
    if (!q) return;
    const { items } = _suggestItems(m, q);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        _tagSuggestIndex[m] = (_tagSuggestIndex[m] + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        renderTagSuggest(m);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        const it = items[_tagSuggestIndex[m]] || items[0];
        if (!it) return;
        if (it.kind === 'use') addTagToModal(m, it.t.name);
        else createTagFromModal(m, it.name, it.type); // Enter で作るときは、今のタイプのタグ
    } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        inp.value = ''; renderTagSuggest(m);
    }
}
function handleTagInputBlur(m) { setTimeout(() => renderTagSuggest(m), 150); }

// タグ欄・選択画面・候補のボタン（まとめて受け取る）
document.addEventListener('mousedown', e => {
    // 候補をタップしたときに入力欄のフォーカスが外れて候補が消えないようにする
    if (e.target.closest && e.target.closest('.tag-suggest')) e.preventDefault();
}, true);
document.addEventListener('click', e => {
    const t = e.target.closest ? e.target.closest('[data-tag-add],[data-tag-remove],[data-tag-new],[data-tag-open]') : null;
    if (!t) return;
    const m = t.dataset.tagMode;
    if (t.dataset.tagOpen !== undefined) { e.stopPropagation(); openTagView(t.dataset.tagOpen); return; }
    if (t.dataset.tagRemove !== undefined) removeTagFromModal(m, t.dataset.tagRemove);
    else if (t.dataset.tagNew !== undefined) createTagFromModal(m, t.dataset.tagNew, t.dataset.tagScope);
    else if (t.dataset.tagAdd !== undefined) {
        addTagToModal(m, t.dataset.tagAdd);
        if (t.closest('.tag-suggest')) { const inp = document.getElementById(m + 'TagInput'); if (inp) inp.focus(); }
    }
});

// ------------------------------------------
// タグを選ぶ画面（追記・編集画面の上に重ねて開く）
// ------------------------------------------
function openTagPicker(m) {
    _tagPickerMode = m;
    _tagPickerQuery = '';
    const s = document.getElementById('tagPickerSearch');
    if (s) s.value = '';
    renderTagPicker();
    openModal('tagPickerModal');
}
function closeTagPicker() {
    closeModal('tagPickerModal');
    if (_tagPickerMode) renderTagSection(_tagPickerMode);
}
function handleTagPickerSearch(e) { _tagPickerQuery = normalizeTagName(e.target.value); renderTagPicker(); }
function toggleTagFromPicker(name) {
    const m = _tagPickerMode; if (!m) return;
    const list = _modalTags(m);
    _setModalTags(m, list.includes(name) ? list.filter(t => t !== name) : list.concat([name]));
    renderTagPicker(); renderTagSection(m);
    if (typeof scheduleDraftSave === 'function') scheduleDraftSave();
}
function toggleTagFavFromPicker(e, name) {
    e.stopPropagation();
    toggleTagFav(name);
    renderTagPicker();
    if (_tagPickerMode) renderTagSection(_tagPickerMode);
}
function createTagFromPicker(name, scope) {
    const d = createTagDef(name, scope);
    if (!d) return;
    const m = _tagPickerMode;
    if (m && !_modalTags(m).includes(d.name)) _setModalTags(m, _modalTags(m).concat([d.name]));
    _tagPickerQuery = '';
    const s = document.getElementById('tagPickerSearch'); if (s) s.value = '';
    renderTagPicker();
    if (m) renderTagSection(m);
}
function renderTagPicker() {
    const box = document.getElementById('tagPickerList');
    const m = _tagPickerMode;
    if (!box || !m) return;
    const type = _modalType(m);
    const lab = document.getElementById('tagPickerType');
    if (lab) lab.textContent = `${type} ＋ 共通`;
    const sel = _modalTags(m);
    const q = _tagPickerQuery;
    const all = getAllTags().filter(t => !q || t.name.includes(q));
    const vis = all.filter(t => t.scope === type || t.scope === TAG_COMMON);
    const row = t => `<div class="tag-pk-row${sel.includes(t.name) ? ' is-on' : ''}" onclick="toggleTagFromPicker(this.dataset.name)" data-name="${escapeHtml(t.name)}"><button type="button" class="tag-pk-star${t.fav ? ' is-fav' : ''}" onclick="toggleTagFavFromPicker(event, this.parentNode.dataset.name)" aria-label="${t.fav ? 'お気に入りから外す' : 'お気に入りにする'}">${t.fav ? '★' : '☆'}</button><span class="tag-pk-name">#${escapeHtml(t.name)}</span><span class="tag-pk-count">${t.count}件</span><span class="tag-pk-check">${sel.includes(t.name) ? '✓' : ''}</span></div>`;
    const sec = (title, arr) => arr.length ? `<div class="tag-pk-sec">${escapeHtml(title)}</div>` + arr.map(row).join('') : '';
    let html = sec('お気に入り', vis.filter(t => t.fav))
        + sec(`${type}のタグ`, vis.filter(t => !t.fav && t.scope === type).sort(_byCount))
        + sec('共通のタグ', vis.filter(t => !t.fav && t.scope === TAG_COMMON).sort(_byCount));
    if (q) html += sec('他のタイプのタグ', all.filter(t => !(t.scope === type || t.scope === TAG_COMMON)).sort(_byCount));
    if (q && !getAllTags().some(t => t.name === q)) {
        html += `<div class="tag-pk-new"><span>＋「${escapeHtml(q)}」を新しく作る</span><span class="tag-sg-scopes"><button type="button" class="tag-scope-btn" onclick="createTagFromPicker(this.dataset.n, this.dataset.s)" data-n="${escapeHtml(q)}" data-s="${escapeHtml(type)}">${escapeHtml(type)}のタグ</button><button type="button" class="tag-scope-btn" onclick="createTagFromPicker(this.dataset.n, this.dataset.s)" data-n="${escapeHtml(q)}" data-s="${TAG_COMMON}">共通のタグ</button></span></div>`;
    }
    if (!html) html = `<div class="tag-pk-empty">${q ? '見つかりません' : 'まだタグがありません。上の欄に名前を入れると作れます'}</div>`;
    box.innerHTML = html;
}

// 同期などで登録簿が変わったとき、開いている画面を描き直す
function refreshOpenTagUIs() {
    ['add', 'edit'].forEach(m => { const md = document.getElementById(m + 'Modal'); if (md && md.classList.contains('active')) renderTagSection(m); });
    const pk = document.getElementById('tagPickerModal');
    if (pk && pk.classList.contains('active')) renderTagPicker();
}

// ------------------------------------------
// 記録での表示（本文・写真の下に小さく薄く）
// ------------------------------------------
function logTagsHtml(log) {
    const tags = (log && Array.isArray(log.tags)) ? log.tags : [];
    if (!tags.length) return '';
    return `<div class="log-tags">${tags.map(t => `<button type="button" class="log-tag" data-tag-open="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join('')}</div>`;
}

// ------------------------------------------
// タグの一覧（タグをタップしたとき）
// ------------------------------------------
function openTagView(tag) {
    if (!tag) return;
    closeModal('searchModal');
    triggerSmoothViewSwitch(() => {
        if (calendarScope === 'notebooks') {
            calendarScope = lastJournalScope || 'day';
            if (lastJournalDateKey) activeDateKey = lastJournalDateKey;
        }
        showPinnedList = false;
        showTagView = tag;
        if (journalSearchQuery) {
            journalSearchQuery = '';
            ['journalSearchInput', 'fsJournalSearchInput'].forEach(i => { const el = document.getElementById(i); if (el) el.value = ''; });
            ['journalSearchClearBtn', 'fsJournalSearchClearBtn'].forEach(i => { const el = document.getElementById(i); if (el) el.classList.remove('active'); });
        }
        delete cardScrollPositions['tag'];
        updateScopeButtonsUI(); updateJumpButtonLabel();
        if (sidebarMode === 'cal') updateSidebars();
        renderRightCards();
    });
}
function closeTagView() {
    triggerSmoothViewSwitch(() => { showTagView = null; updateScopeButtonsUI(); renderRightCards(); });
}
function renderTagListCard(tag) {
    const container = document.getElementById('journalCarouselContainer');
    container.innerHTML = '';
    const items = [];
    Object.keys(journalData).forEach(d => (journalData[d] || []).forEach((log, i) => { if ((log.tags || []).includes(tag)) items.push({ dateStr: d, log, index: i }); }));
    items.sort((a, b) => (b.dateStr + (b.log.time || '')).localeCompare(a.dateStr + (a.log.time || '')));
    const def = getTagDef(tag);
    let body = '';
    if (!items.length) {
        body = `<div class="empty-state"><span style="font-size: 15px; font-weight: 600;">#${escapeHtml(tag)} の記録はまだありません</span></div>`;
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
    panel.dataset.key = 'tag';
    panel.innerHTML = `<div class="main-display"><div class="display-header compact-header"><div class="date-title-wrapper"><span class="date-eyebrow">TAG${def ? ' · ' + escapeHtml(tagScopeLabel(def.scope)) : ''}</span><h1 class="date-title">#${escapeHtml(tag)}</h1></div><div class="header-actions"><button type="button" class="data-action-btn" onclick="closeTagView()" style="font-size: 11px; padding: 4px 9px;">閉じる</button><span class="header-badge">${items.length} 件</span></div></div><div class="logs-container-wrapper" style="padding: 4px 2px;">${body}</div></div>`;
    container.appendChild(panel);
}

// ------------------------------------------
// 設定 > タグ
// ------------------------------------------
function renderSettingsTagList() {
    const box = document.getElementById('settingsTagList');
    if (!box) return;
    const all = getAllTags();
    const cnt = document.getElementById('tagCountIndicator');
    if (cnt) cnt.textContent = `${all.length}件`;
    const scopeSel = document.getElementById('newTagScope');
    const scopes = [TAG_COMMON].concat(appTypes);
    const opts = cur => scopes.map(s => `<option value="${escapeHtml(s)}" ${s === cur ? 'selected' : ''}>${escapeHtml(tagScopeLabel(s))}</option>`).join('');
    if (scopeSel) { const v = scopeSel.value; scopeSel.innerHTML = opts(scopes.includes(v) ? v : TAG_COMMON); }
    if (!all.length) { box.innerHTML = '<div class="tag-pk-empty">まだタグがありません。追記画面のタグ欄か、下の欄から作れます</div>'; return; }
    const groups = scopes.map(s => ({ s, list: all.filter(t => t.scope === s).sort(_byCount) }))
        .concat([{ s: null, list: all.filter(t => !scopes.includes(t.scope)).sort(_byCount) }]) // 削除されたタイプ名が残っている場合
        .filter(g => g.list.length);
    box.innerHTML = groups.map(g => `<div class="tag-set-group"><div class="tag-set-head">${g.s === null ? 'その他' : (g.s === TAG_COMMON ? '共通のタグ' : escapeHtml(g.s) + ' のタグ')}</div>` + g.list.map(t => `
        <div class="tag-set-row" data-name="${escapeHtml(t.name)}">
            <button type="button" class="tag-pk-star${t.fav ? ' is-fav' : ''}" onclick="toggleTagFav(this.parentNode.dataset.name); renderSettingsTagList();" aria-label="お気に入り">${t.fav ? '★' : '☆'}</button>
            <span class="tag-set-name">#${escapeHtml(t.name)}</span>
            <span class="tag-pk-count">${t.count}件</span>
            <select class="category-item-type-select" onchange="changeTagScope(this.parentNode.dataset.name, this.value)" aria-label="タグの種類">${opts(t.scope)}</select>
            <button type="button" class="settings-icon-btn edit-btn" onclick="renameTagPrompt(this.parentNode.dataset.name)" title="名前を変える">✏️</button>
            <button type="button" class="settings-icon-btn del-btn" onclick="deleteTagConfirm(this.parentNode.dataset.name)" title="削除">🗑️</button>
        </div>`).join('') + '</div>').join('');
}
function addTagFromSettings() {
    const inp = document.getElementById('newTagName');
    const sel = document.getElementById('newTagScope');
    const name = normalizeTagName(inp ? inp.value : '');
    if (!name) { alert('タグ名を入力してください。'); return; }
    if (getAllTags().some(t => t.name === name)) { alert('同じ名前のタグがあります。'); return; }
    createTagDef(name, sel ? sel.value : TAG_COMMON);
    inp.value = '';
    renderSettingsTagList();
}
function changeTagScope(name, scope) {
    let d = getTagDef(name);
    if (!d) { d = { name, scope, fav: false }; tagDefs.push(d); } else d.scope = scope;
    saveTagDefs();
    renderSettingsTagList();
}
// 記録についているタグ名を置き換える（to が null なら外す）
async function _replaceTagInLogs(from, to) {
    let changed = false;
    for (const d of Object.keys(journalData)) for (const log of (journalData[d] || [])) {
        if (!Array.isArray(log.tags) || !log.tags.includes(from)) continue;
        let tags = log.tags.map(t => t === from ? to : t).filter(Boolean);
        tags = tags.filter((t, i) => tags.indexOf(t) === i);
        if (tags.length) log.tags = tags; else delete log.tags;
        changed = true;
    }
    if (changed) await saveJournalData();
}
async function renameTagPrompt(name) {
    const input = prompt(`「${name}」の新しい名前`, name);
    if (input === null) return;
    const to = normalizeTagName(input);
    if (!to || to === name) return;
    const exists = getAllTags().some(t => t.name === to);
    if (exists && !confirm(`「${to}」はすでにあります。「${name}」を「${to}」にまとめますか？\n（「${name}」が付いた記録は「${to}」になります）`)) return;
    const src = getTagDef(name);
    const dst = getTagDef(to);
    if (exists) {
        if (dst && src && src.fav) dst.fav = true;
        const i = tagDefs.indexOf(src); if (i !== -1) tagDefs.splice(i, 1);
    } else if (src) src.name = to;
    else tagDefs.push({ name: to, scope: TAG_COMMON, fav: false });
    saveTagDefs();
    await _replaceTagInLogs(name, to);
    if (showTagView === name) showTagView = to;
    renderSettingsTagList();
    renderRightCards();
}
async function deleteTagConfirm(name) {
    const n = getTagCounts().get(name) || 0;
    if (!confirm(n ? `タグ「${name}」を削除しますか？\n${n} 件の記録からこのタグを外します（記録そのものは消えません）。` : `タグ「${name}」を削除しますか？`)) return;
    const i = tagDefs.findIndex(d => d.name === name);
    if (i !== -1) { tagDefs.splice(i, 1); saveTagDefs(); }
    await _replaceTagInLogs(name, null);
    if (showTagView === name) showTagView = null;
    renderSettingsTagList();
    renderRightCards();
}

// 保存ボタンを押したとき、タグ欄に打ちかけの文字が残っていれば付ける（既存ならそのタグ、なければ今のタイプのタグとして作る）
function commitPendingTagInput(m) {
    const inp = document.getElementById(m + 'TagInput');
    const q = normalizeTagName(inp ? inp.value : '');
    if (!q) return;
    if (!getAllTags().some(t => t.name === q)) createTagDef(q, _modalType(m));
    if (!_modalTags(m).includes(q)) _setModalTags(m, _modalTags(m).concat([q]));
    inp.value = '';
}
