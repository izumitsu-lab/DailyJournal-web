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
function _modalCat(m) { return m === 'add' ? selectedAddCategory : selectedEditCategory; }
function _modalType(m) { return getLogCategoryType(_modalCat(m)); }
// 範囲（scope）：'common'＝共通 ／ タイプ名＝そのタイプ全体 ／ 'cat:カテゴリ名'＝そのカテゴリだけ
const TAG_CAT_PREFIX = 'cat:';
function catScope(cat) { return TAG_CAT_PREFIX + cat; }
function scopeCat(s) { return (typeof s === 'string' && s.startsWith(TAG_CAT_PREFIX)) ? s.slice(TAG_CAT_PREFIX.length) : null; }
function scopeLevel(s) { return s === TAG_COMMON ? 2 : (scopeCat(s) !== null ? 0 : 1); } // 狭い順に 0,1,2
function tagScopeLabel(s) { if (s === TAG_COMMON) return '共通'; const c = scopeCat(s); return c !== null ? c : `${s}全体`; }
// そのカテゴリで書いているときに候補に出るか
function isTagVisibleFor(t, cat) { return t.scope === TAG_COMMON || t.scope === catScope(cat) || t.scope === getLogCategoryType(cat); }
function _byLevel(a, b) { return (scopeLevel(a.scope) - scopeLevel(b.scope)) || _byCount(a, b); }
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
function getTagsForCategory(cat) { return getAllTags().filter(t => isTagVisibleFor(t, cat)); }
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
    const favs = getTagsForCategory(_modalCat(m)).filter(t => t.fav && !sel.includes(t.name)).sort(_byLevel);
    favBox.innerHTML = favs.length ? `<span class="tag-fav-mark" aria-hidden="true">☆</span>` + favs.map(t => `<button type="button" class="tag-chip-fav" data-tag-add="${escapeHtml(t.name)}" data-tag-mode="${m}">${escapeHtml(t.name)}</button>`).join('') : '';
    favBox.style.display = favs.length ? '' : 'none';
    renderTagSuggest(m);
}

// 入力中の候補（入力欄の上に重ねて出す。下の要素は動かさない）
function _suggestItems(m, q) {
    const cat = _modalCat(m);
    const sel = _modalTags(m);
    const all = getAllTags();
    const visible = all.filter(t => isTagVisibleFor(t, cat));
    const others = all.filter(t => !isTagVisibleFor(t, cat));
    const hit = arr => arr.filter(t => t.name.includes(q)).sort((a, b) => ((b.name === q) - (a.name === q)) || _byLevel(a, b));
    const items = hit(visible).slice(0, 6).map(t => ({ kind: 'use', t }));
    hit(others).slice(0, 3).forEach(t => items.push({ kind: 'use', t, other: true }));
    const exists = all.some(t => t.name === q);
    if (!exists) items.push({ kind: 'new', name: q, cat, type: getLogCategoryType(cat) });
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
            return `<button type="button" class="tag-sg-row${act}" data-tag-add="${escapeHtml(it.t.name)}" data-tag-mode="${m}"><span>#${escapeHtml(it.t.name)}${added ? '<span class="tag-sg-note">追加済み</span>' : ''}</span><span class="tag-sg-meta"><span class="tag-level">${it.other ? '他・' : ''}${escapeHtml(tagScopeLabel(it.t.scope))}</span>${it.t.count}件</span></button>`;
        }
        return `<div class="tag-sg-row tag-sg-new${act}"><span>＋「${escapeHtml(it.name)}」を新しく作る</span><span class="tag-sg-scopes">${_scopeButtonsHtml(it.cat, it.type, b => `data-tag-new="${escapeHtml(it.name)}" data-tag-scope="${escapeHtml(b)}" data-tag-mode="${m}"`)}</span></div>`;
    }).join('');
    box.classList.add('open');
}
// 新しく作るときの3つの選択肢（狭い順）
function _scopeButtonsHtml(cat, type, attrs) {
    return [[catScope(cat), `${cat}だけ`], [type, `${type}全体`], [TAG_COMMON, '共通']]
        .map(([s, label]) => `<button type="button" class="tag-scope-btn" ${attrs(s)}>${escapeHtml(label)}</button>`).join('');
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
        else createTagFromModal(m, it.name, catScope(it.cat)); // Enter で作るときは、一番狭い「このカテゴリだけ」
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
    const cat = _modalCat(m);
    const type = _modalType(m);
    const lab = document.getElementById('tagPickerType');
    if (lab) lab.textContent = `${cat} ／ ${type} ／ 共通`;
    const sel = _modalTags(m);
    const q = _tagPickerQuery;
    const all = getAllTags().filter(t => !q || t.name.includes(q));
    const vis = all.filter(t => isTagVisibleFor(t, cat));
    const row = t => `<div class="tag-pk-row${sel.includes(t.name) ? ' is-on' : ''}" onclick="toggleTagFromPicker(this.dataset.name)" data-name="${escapeHtml(t.name)}"><button type="button" class="tag-pk-star${t.fav ? ' is-fav' : ''}" onclick="toggleTagFavFromPicker(event, this.parentNode.dataset.name)" aria-label="${t.fav ? 'お気に入りから外す' : 'お気に入りにする'}">${t.fav ? '★' : '☆'}</button><span class="tag-pk-name">#${escapeHtml(t.name)}</span><span class="tag-level">${escapeHtml(tagScopeLabel(t.scope))}</span><span class="tag-pk-count">${t.count}件</span><span class="tag-pk-check">${sel.includes(t.name) ? '✓' : ''}</span></div>`;
    const sec = (title, arr) => arr.length ? `<div class="tag-pk-sec">${escapeHtml(title)}</div>` + arr.map(row).join('') : '';
    let html = sec('お気に入り', vis.filter(t => t.fav).sort(_byLevel))
        + sec(`${cat}のタグ`, vis.filter(t => !t.fav && t.scope === catScope(cat)).sort(_byCount))
        + sec(`${type}全体のタグ`, vis.filter(t => !t.fav && t.scope === type).sort(_byCount))
        + sec('共通のタグ', vis.filter(t => !t.fav && t.scope === TAG_COMMON).sort(_byCount));
    if (q) html += sec('ほかのカテゴリ・タイプのタグ', all.filter(t => !isTagVisibleFor(t, cat)).sort(_byLevel));
    if (q && !getAllTags().some(t => t.name === q)) {
        html += `<div class="tag-pk-new"><span>＋「${escapeHtml(q)}」を新しく作る</span><span class="tag-sg-scopes">${_scopeButtonsHtml(cat, type, s => `onclick="createTagFromPicker(this.dataset.n, this.dataset.s)" data-n="${escapeHtml(q)}" data-s="${escapeHtml(s)}"`)}</span></div>`;
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
    // カテゴリボタンの選択（ホーム・すべて・タイプ・カテゴリ）に従う
    Object.keys(journalData).forEach(d => (journalData[d] || []).forEach((log, i) => { if ((log.tags || []).includes(tag) && matchesCurrentFilter(log)) items.push({ dateStr: d, log, index: i }); }));
    items.sort((a, b) => (b.dateStr + (b.log.time || '')).localeCompare(a.dateStr + (a.log.time || '')));
    const def = getTagDef(tag);
    let body = '';
    if (!items.length) {
        body = `<div class="empty-state"><span style="font-size: 15px; font-weight: 600;">#${escapeHtml(tag)} の記録はありません</span>${currentFilter.mode !== 'all' || getHomeHiddenTypes().length ? '<span style="font-size: 13px; opacity: 0.7;">カテゴリの選択を変えると見つかるかもしれません</span>' : ''}</div>`;
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
    panel.innerHTML = `<div class="main-display"><div class="display-header compact-header"><div class="date-title-wrapper"><span class="date-eyebrow">TAG${def ? ' · ' + escapeHtml(tagScopeLabel(def.scope)) : ''}</span><h1 class="date-title">#${escapeHtml(tag)}</h1></div><div class="header-actions">${getActiveFilterBadgeHtml()}<button type="button" class="data-action-btn" onclick="closeTagView()" style="font-size: 11px; padding: 4px 9px;">閉じる</button><span class="header-badge">${items.length} 件</span></div></div><div class="logs-container-wrapper" style="padding: 4px 2px;">${body}</div></div>`;
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
    // 範囲の並び：共通 → タイプごとに「タイプ全体」とその中のカテゴリ
    const tree = appTypes.map(ty => ({ ty, cats: categories.filter(c => (c.type || '一般') === ty).map(c => c.name) }));
    const scopes = [TAG_COMMON];
    tree.forEach(g => { scopes.push(g.ty); g.cats.forEach(c => scopes.push(catScope(c))); });
    const opt = (s, cur, label) => `<option value="${escapeHtml(s)}" ${s === cur ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    const opts = cur => opt(TAG_COMMON, cur, '共通') + tree.map(g => `<optgroup label="${escapeHtml(g.ty)}">${opt(g.ty, cur, g.ty + '全体')}${g.cats.map(c => opt(catScope(c), cur, c)).join('')}</optgroup>`).join('')
        + (cur && !scopes.includes(cur) ? opt(cur, cur, tagScopeLabel(cur) + '（なし）') : '');
    if (scopeSel) { const v = scopeSel.value; scopeSel.innerHTML = opts(scopes.includes(v) ? v : TAG_COMMON); }
    if (!all.length) { box.innerHTML = '<div class="tag-pk-empty">まだタグがありません。追記画面のタグ欄か、下の欄から作れます</div>'; return; }
    const groups = scopes.map(s => ({ s, list: all.filter(t => t.scope === s).sort(_byCount) }))
        .concat([{ s: null, list: all.filter(t => !scopes.includes(t.scope)).sort(_byCount) }]) // 削除されたタイプ・カテゴリ名が残っている場合
        .filter(g => g.list.length);
    box.innerHTML = groups.map(g => `<div class="tag-set-group"><div class="tag-set-head">${g.s === null ? 'その他' : (g.s === TAG_COMMON ? '共通のタグ' : (scopeCat(g.s) !== null ? '　' + escapeHtml(scopeCat(g.s)) + 'のタグ' : escapeHtml(g.s) + '全体のタグ'))}</div>` + g.list.map(t => `
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
    if (!getAllTags().some(t => t.name === q)) createTagDef(q, catScope(_modalCat(m)));
    if (!_modalTags(m).includes(q)) _setModalTags(m, _modalTags(m).concat([q]));
    inp.value = '';
}


// ------------------------------------------
// タグから探す（左サイドバー・スマホのカレンダーの検索欄の横）
// ------------------------------------------
// 今のカテゴリの選択で見える記録に、1件以上付いているタグだけを出す（件数もその中で数える）
let _tagBrowseAnchor = null, _tagBrowseFrom = null, _tagBrowseQuery = '';
function getFilteredTagCounts() {
    const c = new Map();
    for (const d of Object.keys(journalData)) for (const log of (journalData[d] || [])) {
        if (!log.tags || !log.tags.length || !matchesCurrentFilter(log)) continue;
        for (const t of log.tags) c.set(t, (c.get(t) || 0) + 1);
    }
    return c;
}
function toggleTagBrowse(btn, from) {
    const pop = document.getElementById('tagBrowsePopover');
    if (pop && pop.classList.contains('open') && _tagBrowseAnchor === btn) { closeTagBrowse(); return; }
    openTagBrowse(btn, from);
}
function openTagBrowse(btn, from) {
    let pop = document.getElementById('tagBrowsePopover');
    if (!pop) {
        pop = document.createElement('div');
        pop.id = 'tagBrowsePopover';
        pop.className = 'tag-browse-pop';
        pop.setAttribute('role', 'dialog');
        pop.setAttribute('aria-label', 'タグから探す');
        pop.innerHTML = `<div class="tag-browse-head"><span>タグから探す</span><span class="tag-browse-filter" id="tagBrowseFilter"></span><button type="button" class="tag-browse-close" onclick="closeTagBrowse()" aria-label="閉じる">✕</button></div>
            <input type="text" class="tag-browse-search" id="tagBrowseSearch" placeholder="タグを絞り込む" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" oninput="_tagBrowseQuery = normalizeTagName(this.value); renderTagBrowse()">
            <div class="tag-browse-list" id="tagBrowseList"></div>`;
        document.body.appendChild(pop);
    }
    document.querySelectorAll('.tag-browse-btn.is-on').forEach(b => b.classList.remove('is-on'));
    _tagBrowseAnchor = btn; _tagBrowseFrom = from; _tagBrowseQuery = '';
    document.getElementById('tagBrowseSearch').value = '';
    btn.classList.add('is-on');
    renderTagBrowse();
    pop.classList.add('open');
    positionTagBrowse();
    // スマホではキーボードを勝手に出さない
    if (!isCurrentMobileMode()) setTimeout(() => { const s = document.getElementById('tagBrowseSearch'); if (s) s.focus(); }, 30);
}
function positionTagBrowse() {
    const pop = document.getElementById('tagBrowsePopover');
    if (!pop || !_tagBrowseAnchor) return;
    const r = _tagBrowseAnchor.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(300, vw - 24);
    let left = _tagBrowseFrom === 'sidebar' ? r.left - 190 : r.right - w;
    left = Math.max(12, Math.min(vw - w - 12, left));
    const top = r.bottom + 8;
    pop.style.width = w + 'px';
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    pop.style.maxHeight = Math.max(200, vh - top - 16) + 'px';
}
function closeTagBrowse() {
    const pop = document.getElementById('tagBrowsePopover');
    if (pop) pop.classList.remove('open');
    document.querySelectorAll('.tag-browse-btn.is-on').forEach(b => b.classList.remove('is-on'));
    _tagBrowseAnchor = null;
}
function renderTagBrowse() {
    const list = document.getElementById('tagBrowseList');
    if (!list) return;
    const fl = document.getElementById('tagBrowseFilter');
    if (fl) fl.textContent = currentFilter.mode === 'all' ? 'ホーム' : (currentFilter.mode === 'everything' ? 'すべて' : currentFilter.value);
    const counts = getFilteredTagCounts();
    const q = _tagBrowseQuery;
    const items = [...counts.entries()].map(([name, count]) => { const d = getTagDef(name); return { name, count, fav: !!(d && d.fav), scope: d ? d.scope : TAG_COMMON }; })
        .filter(t => !q || t.name.includes(q));
    const favs = items.filter(t => t.fav).sort(_byCount);
    const rest = items.filter(t => !t.fav).sort(_byCount);
    const row = t => `<button type="button" class="tag-browse-row" data-tag-browse="${escapeHtml(t.name)}">${t.fav ? '<span class="tag-browse-star">★</span>' : ''}<span class="tag-browse-name">#${escapeHtml(t.name)}</span><span class="tag-level">${escapeHtml(tagScopeLabel(t.scope))}</span><span class="tag-pk-count">${t.count}件</span></button>`;
    let html = '';
    if (favs.length) html += '<div class="tag-pk-sec">お気に入り</div>' + favs.map(row).join('');
    if (rest.length) html += `<div class="tag-pk-sec">${favs.length ? 'よく使う順' : 'よく使う順'}</div>` + rest.map(row).join('');
    if (!html) html = `<div class="tag-pk-empty">${q ? '見つかりません' : (counts.size ? '' : 'この表示の記録には、まだタグが付いていません')}</div>`;
    list.innerHTML = html;
}
document.addEventListener('click', e => {
    const row = e.target.closest ? e.target.closest('[data-tag-browse]') : null;
    if (row) {
        const tag = row.dataset.tagBrowse;
        const from = _tagBrowseFrom;
        closeTagBrowse();
        if (from === 'popup') closeModal('fullscreenCalendarModal');
        openTagView(tag);
        return;
    }
    const pop = document.getElementById('tagBrowsePopover');
    if (pop && pop.classList.contains('open') && !pop.contains(e.target) && !(e.target.closest && e.target.closest('.tag-browse-btn'))) closeTagBrowse();
}, true);
document.addEventListener('keydown', e => {
    const pop = document.getElementById('tagBrowsePopover');
    if (e.key === 'Escape' && pop && pop.classList.contains('open')) { e.stopPropagation(); closeTagBrowse(); }
}, true);
window.addEventListener('resize', () => positionTagBrowse());
