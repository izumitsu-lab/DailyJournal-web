// ==========================================
// mentions.js（@メンション：記録の本文でカテゴリを呼ぶ）
// ==========================================
// 本文に「@カテゴリ名」と書くと、そのカテゴリを表示しているときにもこの記録が並ぶ（コピーはしない）。
// ・メンションは保存せず、表示のたびに本文から読み取る（記録の形も同期もそのまま）
// ・「@」（全角の「＠」も可）の直後がカテゴリ名とぴったり一致するものだけを扱う。長い名前を優先する
//   （「M2松」と「M2松田」があっても「@M2松田」は M2松田）。それ以外の @ はただの文字（メールアドレス等）
// ・全カテゴリ（アーカイブ済みも含む）を呼べる。削除したカテゴリの名前はただの文字に戻る

let _mentionKey = null;
let _mentionRe = null;
let _mentionCache = new Map();

function _escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// カテゴリ名の一覧から、メンションを見つける正規表現を作る（名前が変わったら作り直す）
function _mentionRegex(extraNames = null) {
    const names = categories.map(c => c.name).concat(extraNames || []).filter(Boolean);
    const key = names.join('\u0001');
    if (!extraNames && key === _mentionKey) return _mentionRe;
    const sorted = [...new Set(names)].sort((a, b) => b.length - a.length);
    const re = sorted.length ? new RegExp('[@＠](' + sorted.map(_escapeRe).join('|') + ')', 'g') : null;
    if (!extraNames) { _mentionKey = key; _mentionRe = re; _mentionCache = new Map(); }
    return re;
}
// 本文の中の @カテゴリ名（重複なし）
function getTextMentions(text) {
    if (!text || (text.indexOf('@') === -1 && text.indexOf('＠') === -1)) return [];
    const re = _mentionRegex();
    if (!re) return [];
    let v = _mentionCache.get(text);
    if (v) return v;
    v = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) if (!v.includes(m[1])) v.push(m[1]);
    if (_mentionCache.size > 3000) _mentionCache = new Map();
    _mentionCache.set(text, v);
    return v;
}
function logMentions(log) { return log && typeof log.text === 'string' ? getTextMentions(log.text) : []; }
// カテゴリを表示しているとき、この記録が「言及」で並んでいるか
function isMentionedOnlyInCurrentView(log) {
    return currentFilter.mode === 'category' && (log.category || 'ライフログ') !== currentFilter.value && logMentions(log).includes(currentFilter.value);
}

// ------------------------------------------
// 表示：本文の @カテゴリ名 を小さなグレーのタグにする（リンクもこれまでどおり）
// ------------------------------------------
function renderLogText(text) {
    if (!text) return '';
    const re = _mentionRegex();
    const urlRe = /(https?:\/\/[^\s]+)/g;
    let out = '', last = 0, m;
    const plain = (s) => {
        const esc = escapeHtml(s);
        if (!re || (s.indexOf('@') === -1 && s.indexOf('＠') === -1)) return esc;
        // エスケープ前の文字で探し、1つずつ組み立てる（名前に記号が入っていても崩れないように）
        let r = '', p = 0, mm;
        re.lastIndex = 0;
        while ((mm = re.exec(s))) {
            r += escapeHtml(s.slice(p, mm.index)) + `<button type="button" class="mention-pill${isCategoryArchived(mm[1]) ? ' is-archived' : ''}" data-mention="${escapeHtml(mm[1])}">@${escapeHtml(mm[1])}</button>`;
            p = mm.index + mm[0].length;
        }
        return r + escapeHtml(s.slice(p));
    };
    while ((m = urlRe.exec(text))) {
        out += plain(text.slice(last, m.index));
        const url = escapeHtml(m[1]);
        out += `<a href="${url}" target="_blank" rel="noopener noreferrer" class="journal-link" onclick="event.stopPropagation()">🔗 ${url}</a>`;
        last = m.index + m[0].length;
    }
    return out + plain(text.slice(last));
}
// 「〜から」の行（カテゴリを表示しているときに、よそのカテゴリの記録が並ぶ場合）。本文・写真・タグの後ろに小さく出す
function mentionViaHtml(log) {
    if (!isMentionedOnlyInCurrentView(log)) return '';
    return `<div class="mention-via">${escapeHtml(log.category || 'ライフログ')}から</div>`;
}
// ボタンを押すと、そのカテゴリの表示へ
document.addEventListener('click', e => {
    const b = e.target.closest ? e.target.closest('.mention-pill[data-mention]') : null;
    if (!b) return;
    e.stopPropagation();
    const name = b.dataset.mention;
    if (!categories.some(c => c.name === name)) return;
    if (typeof selectFilter === 'function') selectFilter('category', name);
});

// ------------------------------------------
// 名前が変わったとき：本文の @旧名前 も書き換える
// ------------------------------------------
// ※「M2松」を「M2杉」に変えても「@M2松田」は書き換えないよう、名前の一覧全体で一番長く一致したものだけを対象にする
function replaceMentionsInLogs(from, to) {
    if (!from || from === to) return false;
    const re = _mentionRegex([from, to]);
    if (!re) return false;
    let changed = false;
    for (const d of Object.keys(journalData)) for (const l of (journalData[d] || [])) {
        if (typeof l.text !== 'string' || (l.text.indexOf('@') === -1 && l.text.indexOf('＠') === -1)) continue;
        re.lastIndex = 0;
        const next = l.text.replace(re, (all, name) => name === from ? all[0] + to : all);
        if (next !== l.text) { l.text = next; changed = true; }
    }
    _mentionKey = null; // 作り直す
    return changed;
}

// ------------------------------------------
// 入力：@ を打つとカテゴリの候補
// ------------------------------------------
const MENTION_INPUT_IDS = ['journalInputText', 'editInputText'];
let _mnState = null; // { ta, start, query, items, index }
function _mentionPop() {
    let pop = document.getElementById('mentionPopover');
    if (!pop) {
        pop = document.createElement('div');
        pop.id = 'mentionPopover';
        pop.className = 'mention-pop';
        pop.setAttribute('role', 'listbox');
        document.body.appendChild(pop);
        // 候補を押したときに本文のフォーカスが外れないようにする
        pop.addEventListener('mousedown', e => e.preventDefault());
        pop.addEventListener('click', e => {
            const it = e.target.closest('[data-mn]');
            if (it) chooseMention(it.dataset.mn);
        });
    }
    return pop;
}
function closeMentionPopover() {
    const pop = document.getElementById('mentionPopover');
    if (pop) pop.classList.remove('open');
    _mnState = null;
}
// カーソルの直前の「@〜」（空白・改行・次の@までの間）を探す
function _mentionQueryAt(ta) {
    const pos = ta.selectionStart;
    if (pos == null || pos !== ta.selectionEnd) return null;
    const before = ta.value.slice(Math.max(0, pos - 30), pos);
    const m = before.match(/[@＠]([^\s@＠]{0,20})$/);
    if (!m) return null;
    const at = pos - m[0].length;
    // 直前が英数字なら（メールアドレスなど）候補を出さない
    const prev = at > 0 ? ta.value[at - 1] : '';
    if (/[A-Za-z0-9._-]/.test(prev)) return null;
    return { start: at, query: m[1] };
}
function _mentionCandidates(q) {
    const ql = q.toLowerCase();
    const hit = c => !ql || c.name.toLowerCase().includes(ql);
    const score = c => (c.name.toLowerCase().startsWith(ql) ? 0 : 1);
    const active = getActiveCategories().filter(hit).sort((a, b) => score(a) - score(b));
    // アーカイブしたカテゴリは、文字を打って絞り込んだときだけ出す
    const archived = q ? getArchivedCategories().filter(hit).sort((a, b) => score(a) - score(b)) : [];
    return active.concat(archived).slice(0, 8);
}
function updateMentionPopover(ta) {
    const found = _mentionQueryAt(ta);
    if (!found) { closeMentionPopover(); return; }
    const items = _mentionCandidates(found.query);
    if (!items.length) { closeMentionPopover(); return; }
    const prevIndex = _mnState && _mnState.ta === ta && _mnState.query === found.query ? _mnState.index : 0;
    _mnState = { ta, start: found.start, query: found.query, items, index: Math.min(prevIndex, items.length - 1) };
    const pop = _mentionPop();
    pop.innerHTML = items.map((c, i) => `<button type="button" class="mention-item${i === _mnState.index ? ' is-active' : ''}" data-mn="${escapeHtml(c.name)}"><span class="mention-item-name">${escapeHtml(c.name)}</span><span class="mention-item-type">${c.archivedAt ? 'アーカイブ' : escapeHtml(c.type || '一般')}</span></button>`).join('');
    pop.classList.add('open');
    _positionMentionPopover(ta);
}
function _positionMentionPopover(ta) {
    const pop = document.getElementById('mentionPopover');
    if (!pop || !pop.classList.contains('open')) return;
    const r = ta.getBoundingClientRect();
    const vv = window.visualViewport;
    const viewH = vv ? vv.height + vv.offsetTop : window.innerHeight; // iPhone ではキーボードの上までが見える範囲
    const w = Math.min(260, window.innerWidth - 24);
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + 8));
    pop.style.width = w + 'px';
    pop.style.left = left + 'px';
    const h = pop.offsetHeight || 200;
    // 本文欄の下に入らなければ（キーボードで隠れるなら）上に出す
    if (r.bottom + 6 + h <= viewH - 8) { pop.style.top = (r.bottom + 6) + 'px'; }
    else { pop.style.top = Math.max(8, r.top - h - 6) + 'px'; }
}
function chooseMention(name) {
    const s = _mnState;
    if (!s) return;
    const ta = s.ta;
    const end = s.start + 1 + s.query.length;
    const after = ta.value.slice(end);
    const insert = '@' + name + (after.startsWith(' ') || after.startsWith('\n') ? '' : ' ');
    ta.value = ta.value.slice(0, s.start) + insert + after;
    const pos = s.start + insert.length;
    closeMentionPopover();
    ta.focus();
    try { ta.setSelectionRange(pos, pos); } catch (e) {}
    ta.dispatchEvent(new Event('input', { bubbles: true })); // 書きかけの保存など
}
document.addEventListener('input', e => {
    if (e.target && MENTION_INPUT_IDS.includes(e.target.id)) updateMentionPopover(e.target);
});
document.addEventListener('keydown', e => {
    if (!_mnState || e.target !== _mnState.ta) return;
    if (e.isComposing || e.keyCode === 229) return; // 日本語の変換中は変換を優先
    const n = _mnState.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        _mnState.index = (_mnState.index + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        document.querySelectorAll('#mentionPopover .mention-item').forEach((b, i) => b.classList.toggle('is-active', i === _mnState.index));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        chooseMention(_mnState.items[_mnState.index].name);
    } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        closeMentionPopover();
    }
}, true);
// カーソルの移動・フォーカスが外れたとき
document.addEventListener('selectionchange', () => {
    const a = document.activeElement;
    if (a && MENTION_INPUT_IDS.includes(a.id)) { if (_mnState || /[@＠]/.test(a.value)) updateMentionPopover(a); }
});
document.addEventListener('focusout', e => { if (e.target && MENTION_INPUT_IDS.includes(e.target.id)) setTimeout(() => { if (document.activeElement !== e.target) closeMentionPopover(); }, 150); });
window.addEventListener('resize', () => { if (_mnState) _positionMentionPopover(_mnState.ta); });
if (window.visualViewport) window.visualViewport.addEventListener('resize', () => { if (_mnState) _positionMentionPopover(_mnState.ta); });
