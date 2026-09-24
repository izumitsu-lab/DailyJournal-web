// スマホの見た目：ノートのタイトルの幅、追記・編集画面の見出し
const { serve, FakeServer, makeDevice, launchBrowser } = require('./harness');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function check(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }
(async () => {
  const srv = await serve(); const base = 'http://localhost:' + srv.address().port;
  const browser = await launchBrowser();
  for (const width of [390, 320, 1280]) {
    const p = await makeDevice(browser, base, new FakeServer(), { name: 'W' + width, configure: false, viewport: { width, height: 800 } });
    const r = await p.evaluate(async () => {
      notebookData.push({ id: 'nb_t', title: '研究計画と来年度の予算申請についてのメモ', content: '<p>本文</p>', category: 'ライフログ', status: 'active', linkedNoteIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await saveNotebookData(); calendarScope = 'notebooks'; notebookViewMode = 'card'; currentNotebookIndex = getFilteredNotebooks().findIndex(n => n.id === 'nb_t'); renderRightCards();
      await new Promise(r => setTimeout(r, 400));
      const t = document.getElementById('nb_title_view_nb_t'), card = t.closest('.main-display'), act = card.querySelector('.nb-card-header > .header-actions');
      const tr = t.getBoundingClientRect(), ar = act.getBoundingClientRect(), hr = card.querySelector('.nb-card-header').getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(t).fontSize) * 1.35;
      return { lines: Math.round(tr.height / lh), titleW: tr.width, headerW: hr.width, overlap: tr.top < ar.bottom - 1 && tr.right > ar.left };
    });
    check(r.titleW > r.headerW * 0.95 && !r.overlap, `${width}px：ノートのタイトルが横幅いっぱいを使い、ボタンと重ならない（${Math.round(r.titleW)}/${Math.round(r.headerW)}px）`);
    if (width === 390) check(r.lines <= 2, `390px：全角19文字のタイトルが ${r.lines} 行（以前は3行）`);
    if (width === 1280) check(r.lines === 1, 'PC：1行');
    if (width < 1000) {
      for (const m of ['add', 'edit']) {
        const h = await p.evaluate(async (m) => {
          const d = new Date(); d.setDate(d.getDate() - 2); const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          if (m === 'add') { openAddModal(); document.getElementById('addSlotDate').value = k; changeAddSlot(); }
          else { journalData[k] = [{ id: 'lg_h', time: '19:30', text: 'x', category: 'ライフログ', images: [] }]; await saveJournalData(); openEditModal(k, 'lg_h'); }
          await new Promise(r => setTimeout(r, 300));
          const hd = document.querySelector(`#${m}Modal .modal-header`); const res = { h: hd.getBoundingClientRect().height, today: m === 'add' ? null : null };
          closeModal(m + 'Modal'); return res;
        }, m);
        check(h.h < 34, `${width}px：${m === 'add' ? '追記' : '編集'}画面の見出しが1行（高さ ${Math.round(h.h)}px）`);
      }
      check(await p.evaluate(() => { openAddModal(); const t = document.getElementById('modalTargetDateBadge').textContent; closeModal('addModal'); return t === '今日'; }), `${width}px：今日のバッジは「今日」だけ`);
    }
    const errs = p.errors.filter(e => !/404/.test(e));
    check(errs.length === 0, 'ページエラーなし ' + JSON.stringify(errs.slice(0, 3)));
    await p.ctx.close();
  }
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
