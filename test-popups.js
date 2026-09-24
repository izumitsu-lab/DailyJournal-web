// スマホのカレンダー・リンクのポップアップ
const { serve, FakeServer, makeDevice, launchBrowser } = require('./harness');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function check(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }
(async () => {
  const srv = await serve(); const base = 'http://localhost:' + srv.address().port;
  const browser = await launchBrowser();
  const p = await makeDevice(browser, base, new FakeServer(), { name: 'SP', configure: false, viewport: { width: 390, height: 844 } });
  const k = await p.evaluate(async () => {
    const key = n => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const cv = document.createElement('canvas'); cv.width = 40; cv.height = 30; cv.getContext('2d').fillRect(0, 0, 20, 20);
    journalData[key(3)] = [{ id: 'lg_a', time: '09:00', text: 'three-days-ago', category: 'ライフログ', images: [cv.toDataURL('image/jpeg')] }];
    journalData[key(30)] = [{ id: 'lg_b', time: '09:00', text: 'old-photo', category: 'ライフログ', images: [cv.toDataURL('image/png')] }];
    const nb = (id, t, c, links) => ({ id, title: t, content: c, category: 'ライフログ', status: 'active', linkedNoteIds: links, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    notebookData.push(nb('nb_1', '親ノート', '<p>x</p>', ['nb_2', 'nb_3']), nb('nb_2', '子ノートA', '<p>本文A <b>太字</b></p>', ['nb_1']), nb('nb_3', '子ノートB', '<p>本文B</p>', ['nb_1']));
    await saveJournalData(); await saveNotebookData(); dateList = generateDateKeys(); renderRightCards();
    return { d3: key(3), today: key(0) };
  });

  // カレンダー
  await p.evaluate(() => handleCalendarLinkButtonClick()); await sleep(500);
  const box = await p.evaluate(() => { const r = document.querySelector('#fullscreenCalendarModal .ios-popup').getBoundingClientRect(); return { w: r.width, h: r.height, top: r.top, vis: getComputedStyle(document.getElementById('fullscreenCalendarModal')).visibility }; });
  check(box.vis === 'visible' && box.w < 390 && box.h < 844 * 0.9 && box.top > 20, '画面いっぱいではなく、浮いたカードとして表示 ' + JSON.stringify(box));
  const title0 = await p.evaluate(() => document.getElementById('fsMiniCalTitle').textContent);
  await p.click('#fullscreenCalendarModal .ios-round-btn[aria-label="前の月"]'); await sleep(150);
  const title1 = await p.evaluate(() => document.getElementById('fsMiniCalTitle').textContent);
  await p.click('#fullscreenCalendarModal .ios-round-btn[aria-label="次の月"]'); await sleep(150);
  check(title1 !== title0 && await p.evaluate(() => document.getElementById('fsMiniCalTitle').textContent) === title0, '‹ › で月を移動');
  check(await p.evaluate((k) => { const c = [...document.querySelectorAll('#fsMiniCalGrid .mini-cal-day')].find(b => b.textContent === String(parseInt(k.d3.slice(8), 10))); return c && c.classList.contains('has-log'); }, k) || k.d3.slice(0, 7) !== k.today.slice(0, 7), '記録のある日に点');
  await p.click('#fsBtnScopeWeek'); await sleep(400);
  check(await p.evaluate(() => calendarScope === 'week' && !document.getElementById('fullscreenCalendarModal').classList.contains('active')), '「週」を選ぶと週表示にして閉じる');
  await p.evaluate(() => { calendarScope = 'day'; renderRightCards(); handleCalendarLinkButtonClick(); }); await sleep(400);
  // 日付をタップ：流れるスクロールなしで、その日にすぐ切り替わる
  await p.evaluate(() => { window.__smooth = 0; const c = document.getElementById('journalCarouselContainer'); const o = c.scrollTo.bind(c); c.scrollTo = (a) => { if (a && a.behavior === 'smooth') window.__smooth++; return o(a); }; });
  for (const [scope, back] of [['day', 20], ['week', 20], ['month', 40], ['photo', 3]]) {
    const r = await p.evaluate(async ([scope, back]) => {
      calendarScope = scope; renderRightCards(); await new Promise(r => setTimeout(r, 200));
      const d = new Date(); d.setDate(d.getDate() - back); const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      handleCalendarLinkButtonClick(); await new Promise(r => setTimeout(r, 350));
      window.__smooth = 0;
      jumpToDateFromPopup(dk);
      const c = document.getElementById('journalCarouselContainer');
      const key = scope === 'day' ? dk : scope === 'week' ? getWeekRangeFromDate(dk).monStr : scope === 'month' ? dk.slice(0, 7) : null;
      const panel = key ? c.querySelector(`[data-key="${key}"]`) : c.querySelector(`.card-carousel-panel[data-date="${dk}"]`);
      const immediate = panel ? Math.abs(c.scrollLeft - Math.min(panel.offsetLeft - c.offsetLeft, c.scrollWidth - c.clientWidth)) < 2 : false;
      await new Promise(r => setTimeout(r, 400));
      return { immediate, smooth: window.__smooth, active: activeDateKey === dk, closed: !document.getElementById('fullscreenCalendarModal').classList.contains('active'), opacity: getComputedStyle(c).opacity };
    }, [scope, back]);
    check(r.immediate && r.smooth === 0 && r.active && r.closed && r.opacity === '1', `${scope}：日付をタップすると、流れるスクロールなしでその日へ ` + JSON.stringify(r));
  }
  await p.evaluate(() => { calendarScope = 'day'; renderRightCards(); });
  await p.evaluate(() => handleCalendarLinkButtonClick()); await sleep(300);
  await p.fill('#fsJournalSearchInput', 'three'); await sleep(300);
  check(await p.evaluate(() => /three/.test(document.querySelector('#journalCarouselContainer .date-title').textContent)), '検索欄で記録を絞り込める');
  await p.click('#fsJournalSearchClearBtn'); await sleep(200);
  await p.evaluate(() => { window.__smooth = 0; }); await p.click('#fullscreenCalendarModal .ios-text-btn'); await sleep(500);
  check(await p.evaluate((k) => activeDateKey === k.today && !document.getElementById('fullscreenCalendarModal').classList.contains('active') && window.__smooth === 0, k), '「今日に戻る」も流れるスクロールなし');
  await p.evaluate(() => handleCalendarLinkButtonClick()); await sleep(400);
  await p.mouse.click(195, 12); await sleep(400);
  check(await p.evaluate(() => !document.getElementById('fullscreenCalendarModal').classList.contains('active')), 'カードの外をタップすると閉じる');

  // リンク
  await p.evaluate(() => { calendarScope = 'notebooks'; notebookViewMode = 'card'; currentNotebookIndex = getFilteredNotebooks().findIndex(n => n.id === 'nb_1'); renderRightCards(); updateJumpButtonLabel(); handleCalendarLinkButtonClick(); }); await sleep(500);
  const L = await p.evaluate(() => ({ vis: getComputedStyle(document.getElementById('fullscreenLinkModal')).visibility, rows: [...document.querySelectorAll('#fsLinkedCardsContainer .ios-link-card .notebook-grid-title')].map(e => e.textContent), count: document.getElementById('fsLinkedCountBadge').textContent, sub: document.getElementById('fsLinkedSubtitle').textContent, preview: document.querySelector('#fsLinkedCardsContainer .notebook-grid-preview').innerHTML, cards: [...document.querySelectorAll('#fsLinkedCardsContainer .ios-link-card')].map(c => { const r = c.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom), Math.round(r.width), Math.round(r.height)]; }), w: document.querySelector('#fullscreenLinkModal .ios-popup').getBoundingClientRect().width }));
  check(L.vis === 'visible' && L.w < 390 && JSON.stringify(L.rows) === '["子ノートA","子ノートB"]' && L.count === '2' && /親ノート/.test(L.sub), 'リンクはカードの中にリスト表示 ' + JSON.stringify(L.rows));
  check(/<b>太字<\/b>/.test(L.preview), 'カードに本文の中身（書式つき）が見える');
  check(L.cards.length === 2 && L.cards[1][0] > L.cards[0][1] && Math.abs(L.cards[0][2] - L.cards[1][2]) < 2 && L.cards[0][3] > 200, 'ギャラリーと同じ四角いカードが縦に並ぶ ' + JSON.stringify(L.cards));
  await p.evaluate(() => document.querySelectorAll('#fsLinkedCardsContainer .ios-card-unlink')[1].click()); await sleep(500);
  check(await p.evaluate(() => document.querySelectorAll('#fsLinkedCardsContainer .ios-link-card').length === 1 && document.getElementById('fsLinkedCountBadge').textContent === '1' && !notebookData.find(n => n.id === 'nb_1').linkedNoteIds.includes('nb_3')), '「解除」でリンクが外れ、一覧も更新');
  await p.evaluate(() => document.querySelector('#fsLinkedCardsContainer .ios-link-card').click()); await sleep(600);
  check(await p.evaluate(() => !document.getElementById('fullscreenLinkModal').classList.contains('active') && getFilteredNotebooks()[currentNotebookIndex].id === 'nb_2'), '行をタップするとそのノートを開いて閉じる');
  await p.evaluate(async () => { const n = notebookData.find(x => x.id === 'nb_2'); n.linkedNoteIds = []; notebookData.find(x => x.id === 'nb_1').linkedNoteIds = []; await saveNotebookData(); handleCalendarLinkButtonClick(); }); await sleep(400);
  check(await p.evaluate(() => /リンクされたノートはありません/.test(document.getElementById('fsLinkedCardsContainer').textContent)), 'リンクがないときの表示');
  await p.click('#fsLinkAddBtn'); await sleep(400);
  check(await p.evaluate(() => document.getElementById('linkNotebookModal').classList.contains('active') && !document.getElementById('fullscreenLinkModal').classList.contains('active')), '「＋ リンク」でリンク追加の画面へ');
  const errs = p.errors.filter(e => !/404/.test(e));
  check(errs.length === 0, 'ページエラーなし ' + JSON.stringify(errs.slice(0, 3)));
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
