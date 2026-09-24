// 下のメニューのラベルが途切れない
const { serve, FakeServer, makeDevice, launchBrowser } = require('./harness');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function check(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }
(async () => {
  const srv = await serve(); const base = 'http://localhost:' + srv.address().port;
  const browser = await launchBrowser();
  for (const width of [390, 320]) {
    const p = await makeDevice(browser, base, new FakeServer(), { name: 'W' + width, configure: false, viewport: { width, height: 800 } });
    await p.evaluate(async () => { notebookData.push({ id: 'nb_1', title: 'n', content: '<p>x</p>', category: 'ライフログ', status: 'active', linkedNoteIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); await saveNotebookData(); });
    const states = [
      ['day', () => selectScopeFromModal('day'), '☀️', '日表示', '日付'],
      ['week', () => selectScopeFromModal('week'), '🗓️', '週表示', '日付'],
      ['month', () => selectScopeFromModal('month'), '🌙', '月表示', '日付'],
      ['photo', () => selectScopeFromModal('photo'), '📸', '写真', '日付'],
      ['pins', () => selectPinnedFromModal(), '🔖', 'しおり', '日付'],
      ['grid', () => selectNotebookViewFromModal('grid'), '🗂️', 'ノート', 'リンク'],
      ['card', () => selectNotebookViewFromModal('card'), '📖', 'カード', 'リンク'],
      ['graph', () => selectNotebookViewFromModal('graph'), '🎯', 'グラフ', 'リンク'],
      ['trash', () => setNotebookViewMode('trash'), '🗑️', 'ゴミ箱', 'リンク'],
    ];
    for (const [name, fn, icon, label, cal] of states) {
      await p.evaluate(`(${fn})()`); await sleep(250);
      const r = await p.evaluate(() => {
        const spans = [...document.querySelectorAll('.bottom-launcher-bar .bar-btn > span:last-child')].filter(s => s.offsetParent);
        return { icon: document.getElementById('btnViewScopeIcon').textContent, label: document.getElementById('btnViewScopeLabel').textContent, cal: document.getElementById('btnCalendarLinkLabel').textContent,
          cut: spans.filter(s => s.scrollWidth > s.parentElement.clientWidth - 1).map(s => s.textContent), sizes: spans.map(s => s.textContent + ':' + getComputedStyle(s).fontSize) };
      });
      check(r.icon === icon && r.label === label && r.cal === cal && r.cut.length === 0, `${width}px・${name}：「${icon} ${label}」「${cal}」、途切れるラベルなし` + (r.cut.length ? ' 切れ: ' + r.cut : ''));
      if (width === 390 && name === 'month') check(r.sizes.every(s => s.endsWith('10.5px')), '390px では文字を縮めずに収まる ' + r.sizes.join(' '));
    }
    // 収まらない長いラベルは縮めて全部表示
    const fit = await p.evaluate(() => { const el = document.getElementById('btnViewScopeLabel'); el.textContent = 'とても長いラベル'; fitBarLabels(); return { size: parseFloat(getComputedStyle(el).fontSize), over: el.scrollWidth > el.parentElement.clientWidth - 1 }; });
    check(fit.size < 10.5 && fit.size >= 8, `${width}px：長いラベルは文字を小さくして収める（${fit.size}px）`);
    const errs = p.errors.filter(e => !/404/.test(e));
    check(errs.length === 0, 'ページエラーなし ' + JSON.stringify(errs.slice(0, 3)));
    await p.ctx.close();
  }
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
