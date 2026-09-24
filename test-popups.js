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
    journalData[key(3)] = [{ id: 'lg_a', time: '09:00', text: 'three-days-ago', category: 'ライフログ', images: [] }];
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
  if (k.d3.slice(0, 7) === k.today.slice(0, 7)) {
    await p.evaluate((k) => [...document.querySelectorAll('#fsMiniCalGrid .mini-cal-day')].find(b => b.textContent === String(parseInt(k.d3.slice(8), 10))).click(), k); await sleep(500);
    check(await p.evaluate((k) => activeDateKey === k.d3 && !document.getElementById('fullscreenCalendarModal').classList.contains('active'), k), '日付をタップするとその日へ移動して閉じる');
  }
  await p.evaluate(() => handleCalendarLinkButtonClick()); await sleep(300);
  await p.fill('#fsJournalSearchInput', 'three'); await sleep(300);
  check(await p.evaluate(() => /three/.test(document.querySelector('#journalCarouselContainer .date-title').textContent)), '検索欄で記録を絞り込める');
  await p.click('#fsJournalSearchClearBtn'); await sleep(200);
  await p.click('#fullscreenCalendarModal .ios-text-btn'); await sleep(500);
  check(await p.evaluate((k) => activeDateKey === k.today && !document.getElementById('fullscreenCalendarModal').classList.contains('active'), k), '「今日に戻る」');
  await p.evaluate(() => handleCalendarLinkButtonClick()); await sleep(400);
  await p.mouse.click(195, 12); await sleep(400);
  check(await p.evaluate(() => !document.getElementById('fullscreenCalendarModal').classList.contains('active')), 'カードの外をタップすると閉じる');

  // リンク
  await p.evaluate(() => { calendarScope = 'notebooks'; notebookViewMode = 'card'; currentNotebookIndex = getFilteredNotebooks().findIndex(n => n.id === 'nb_1'); renderRightCards(); updateJumpButtonLabel(); handleCalendarLinkButtonClick(); }); await sleep(500);
  const L = await p.evaluate(() => ({ vis: getComputedStyle(document.getElementById('fullscreenLinkModal')).visibility, rows: [...document.querySelectorAll('#fsLinkedCardsContainer .ios-link-row .ios-link-title')].map(e => e.textContent), count: document.getElementById('fsLinkedCountBadge').textContent, sub: document.getElementById('fsLinkedSubtitle').textContent, preview: document.querySelector('.ios-link-preview').textContent, w: document.querySelector('#fullscreenLinkModal .ios-popup').getBoundingClientRect().width }));
  check(L.vis === 'visible' && L.w < 390 && JSON.stringify(L.rows) === '["子ノートA","子ノートB"]' && L.count === '2' && /親ノート/.test(L.sub), 'リンクはカードの中にリスト表示 ' + JSON.stringify(L.rows));
  check(L.preview.trim() === '本文A 太字', 'プレビューは文字だけ（HTMLタグなし）');
  await p.evaluate(() => document.querySelectorAll('#fsLinkedCardsContainer .ios-link-unlink')[1].click()); await sleep(500);
  check(await p.evaluate(() => document.querySelectorAll('#fsLinkedCardsContainer .ios-link-row').length === 1 && document.getElementById('fsLinkedCountBadge').textContent === '1' && !notebookData.find(n => n.id === 'nb_1').linkedNoteIds.includes('nb_3')), '「解除」でリンクが外れ、一覧も更新');
  await p.evaluate(() => document.querySelector('#fsLinkedCardsContainer .ios-link-row').click()); await sleep(600);
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
