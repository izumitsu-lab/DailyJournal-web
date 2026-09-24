// しおり（お気に入りの記録）
const { serve, FakeServer, makeDevice, launchBrowser } = require('./harness');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function check(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }
const realErrors = p => p.errors.filter(e => !/404 \(Not Found\)/.test(e));
(async () => {
  const srv = await serve(); const base = 'http://localhost:' + srv.address().port;
  const browser = await launchBrowser();
  const server = new FakeServer();
  const d1 = await makeDevice(browser, base, server, { name: 'D1', viewport: { width: 390, height: 844 } });
  const d2 = await makeDevice(browser, base, server, { name: 'D2' });
  await sleep(1000);
  const k = await d1.evaluate(async () => {
    const key = n => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const c = document.createElement('canvas'); c.width = 40; c.height = 30; c.getContext('2d').fillRect(0, 0, 20, 20);
    journalData[key(0)] = [{ id: 'lg_t1', time: '08:00', text: 'today-a', category: 'ライフログ', images: [] }, { id: 'lg_t2', time: '12:00', text: 'today-b', category: '学生１', images: [] }];
    journalData[key(3)] = [{ id: 'lg_o1', time: '19:00', text: 'old-a', category: 'ライフログ', images: [c.toDataURL('image/jpeg')], backdated: true, writtenAt: new Date().toISOString() }];
    await saveJournalData(); dateList = generateDateKeys(); activeDateKey = key(0); calendarScope = 'day'; renderRightCards();
    return { today: key(0), old: key(3) };
  });
  await sleep(300);
  check(await d1.evaluate(() => document.querySelectorAll('.log-item .pin-btn').length === document.querySelectorAll('.log-item').length && !document.querySelector('.pin-btn.is-on')), 'どの記録にもしおりボタン（最初はどれも付いていない）');

  // 付ける（描き直さずにその場で切り替わる）
  const t = await d1.evaluate(async () => {
    const li = document.getElementById(`logItem_${activeDateKey}_lg_t1`); li.dataset.marker = 'x';
    await togglePin(activeDateKey, 'lg_t1');
    const li2 = document.getElementById(`logItem_${activeDateKey}_lg_t1`);
    return { same: li2.dataset.marker === 'x', cls: li2.className, on: li2.querySelector('.pin-btn').classList.contains('is-on'), fill: li2.querySelector('.pin-btn svg').getAttribute('fill'), data: journalData[activeDateKey][0].pinned };
  });
  check(t.data === true && /is-pinned/.test(t.cls) && t.on && t.fill === 'currentColor', 'タップでしおりが付き、金色のしおり＋生成りのカードに');
  check(t.same, '画面を描き直さずに切り替わる（スクロール位置が保たれる）');
  await sleep(400);
  const bg = await d1.evaluate(() => getComputedStyle(document.getElementById(`logItem_${activeDateKey}_lg_t1`)).backgroundColor);
  check(bg === 'rgb(251, 247, 238)', 'ライトテーマでは生成り色 ' + bg);
  await d1.evaluate(async (k) => { await togglePin(k.old, 'lg_o1'); }, k);
  await sleep(2000);
  const r2 = await d2.evaluate((k) => ({ a: (journalData[k.today] || []).find(l => l.id === 'lg_t1'), b: (journalData[k.old] || []).find(l => l.id === 'lg_o1') }), k);
  check(r2.a && r2.a.pinned === true && r2.b && r2.b.pinned === true && r2.b.backdated === true, '他の端末にも同期（後日記入の印もそのまま）');

  // しおり一覧
  await d1.evaluate(() => { openViewScopeModal(); selectPinnedFromModal(); }); await sleep(300);
  const L = await d1.evaluate(() => ({ title: document.querySelector('#journalCarouselContainer .date-title').textContent, items: [...document.querySelectorAll('#journalCarouselContainer .log-item')].map(li => li.querySelector('.log-content').textContent), badge: document.querySelector('#journalCarouselContainer .header-badge').textContent, label: document.getElementById('btnViewScopeLabel').textContent, both: !!document.querySelector('.log-item.is-pinned.is-backdated') }));
  check(/しおり/.test(L.title) && JSON.stringify(L.items) === '["today-a","old-a"]' && L.badge === '2 件', 'しおり一覧：しおりを挟んだ記録だけが新しい順に ' + JSON.stringify(L.items));
  check(L.label === 'しおり', '下部のボタンも「しおり」表示');
  check(L.both, 'しおりと後日記入は同じカードに両方表示');
  check(await d1.evaluate(() => { openViewScopeModal(); const r = document.getElementById('scopeItem_pins').classList.contains('selected') && !document.getElementById('scopeItem_day').classList.contains('selected'); closeModal('viewScopeModal'); return r; }), '表示ビューの選択画面で「しおり」にチェック');
  // カテゴリで絞り込み
  await d1.evaluate(async (k) => { await togglePin(k.today, 'lg_t2'); currentFilter = { mode: 'category', value: '学生１' }; renderRightCards(); }, k);
  check(await d1.evaluate(() => JSON.stringify([...document.querySelectorAll('#journalCarouselContainer .log-item .log-content')].map(e => e.textContent))) === '["today-b"]', 'カテゴリの絞り込みも効く');
  await d1.evaluate(() => { currentFilter = { mode: 'all', value: '' }; renderRightCards(); });
  // 一覧で外す → その場では残り（戻せる）、開き直すと消える
  await d1.evaluate(async (k) => { await togglePin(k.today, 'lg_t2'); }, k);
  const un = await d1.evaluate((k) => ({ still: !!document.getElementById(`logItem_${k.today}_lg_t2`), data: 'pinned' in journalData[k.today].find(l => l.id === 'lg_t2') }), k);
  check(un.still && !un.data, '一覧で外してもその場ではカードが残り（押し直せる）、データからは外れる');
  // 日付をタップするとその日へ
  await d1.evaluate((k) => jumpToDayFromTimeline(k.old), k); await sleep(300);
  check(await d1.evaluate((k) => !showPinnedList && calendarScope === 'day' && activeDateKey === k.old, k), '一覧の日付をタップするとその日の表示へ');
  // ノートから直接しおり一覧へ
  await d1.evaluate(() => { selectNotebookViewFromModal('grid'); }); await sleep(300);
  await d1.evaluate(() => selectPinnedFromModal()); await sleep(300);
  check(await d1.evaluate(() => calendarScope !== 'notebooks' && /しおり/.test(document.querySelector('#journalCarouselContainer .date-title').textContent)), 'ノートの画面からもしおり一覧を開ける');
  await d1.evaluate(() => closePinnedList()); await sleep(300);
  check(await d1.evaluate(() => !showPinnedList && /JOURNAL/.test(document.querySelector('#journalCarouselContainer .date-eyebrow').textContent)), '「閉じる」で元の表示へ');
  // 写真ビュー
  await d1.evaluate(() => selectScopeFromModal('photo')); await sleep(500);
  check(await d1.evaluate(() => { const b = document.querySelector('.journal-drawer-header .pin-btn'); return !!b && b.classList.contains('is-on') && document.querySelector('.journal-bottom-drawer').classList.contains('is-pinned'); }), '写真ビューにもしおり（生成りの欄）');
  const errs = [d1, d2].flatMap(realErrors);
  check(errs.length === 0, 'ページエラーなし ' + JSON.stringify(errs.slice(0, 3)));
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
