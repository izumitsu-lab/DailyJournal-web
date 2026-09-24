// Mac サイドバーの表示一覧・検索の絞り込みボタン・写真の既定サイズ
const { serve, FakeServer, makeDevice, launchBrowser } = require('./harness');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function check(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }
const realErrors = p => p.errors.filter(e => !/404 \(Not Found\)/.test(e));
(async () => {
  const srv = await serve(); const base = 'http://localhost:' + srv.address().port;
  const browser = await launchBrowser();
  const server = new FakeServer();
  const p = await makeDevice(browser, base, server, { name: 'Mac', configure: false });
  await sleep(600);
  await p.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 20; c.height = 20; const img = c.toDataURL('image/jpeg');
    journalData[getTodayKey()] = [{ id: 'a', time: '08:00', text: 'a', category: 'ライフログ', images: [img, img], pinned: true }, { id: 'b', time: '09:00', text: 'b', category: 'ライフログ', images: [img] }];
    await saveJournalData(); dateList = generateDateKeys(); renderRightCards();
  });
  await sleep(300);
  const nav = await p.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.sidebar-scope-list .sidebar-scope-item'));
    const list = document.querySelector('.sidebar-scope-list').getBoundingClientRect();
    const jump = document.getElementById('calJumpCurrentBtn').getBoundingClientRect();
    const cal = document.getElementById('miniCalContainer').getBoundingClientRect();
    const day = document.querySelector('#miniCalGrid .mini-cal-day'); const cs = day ? getComputedStyle(day) : {};
    return { names: items.map(i => i.textContent.trim()), listW: Math.round(list.width), jumpW: Math.round(jump.width), belowCal: list.top >= cal.bottom, tops: items.map(i => Math.round(i.getBoundingClientRect().top)), sel: items.filter(i => i.classList.contains('selected')).map(i => i.id), icons: document.querySelectorAll('.sidebar-scope-list svg, .sidebar-scope-list .view-scope-icon-box').length, bar: getComputedStyle(items[0], '::before').width, calFont: cs.fontSize + ' ' + cs.fontWeight };
  });
  check(nav.names.join() === 'DAILY,WEEKLY,MONTHLY,PHOTO,BOOKMARKS' && nav.icons === 0, '文字だけ（DAILY / WEEKLY / MONTHLY / PHOTO / BOOKMARKS）');
  check(nav.belowCal && nav.tops.every((t, i) => i === 0 || t > nav.tops[i - 1]), 'カレンダーの下に縦一列');
  check(Math.abs(nav.listW - nav.jumpW) <= 1, `幅は「今日に戻る」と同じ (${nav.listW} / ${nav.jumpW})`);
  check(nav.sel.join() === 'btnScopeDay' && nav.bar === '3px', 'DAILY が選択中（薄い青と左の細い線）');
  await p.click('#btnScopeWeek'); await sleep(500);
  check(await p.evaluate(() => calendarScope === 'week' && document.getElementById('btnScopeWeek').classList.contains('selected') && !document.getElementById('btnScopeDay').classList.contains('selected')), 'WEEKLY に切り替え');
  await p.click('#btnScopePins'); await sleep(500);
  await sleep(200); const pc = await p.evaluate(() => ({ on: showPinnedList, sel: document.getElementById('btnScopePins').classList.contains('selected'), week: document.getElementById('btnScopeWeek').classList.contains('selected'), color: getComputedStyle(document.getElementById('btnScopePins')).color }));
  check(pc.on && pc.sel && !pc.week && pc.color === 'rgb(217, 165, 76)', 'BOOKMARKS を選ぶと金色で選択表示 ' + pc.color);
  await p.click('#btnScopeDay'); await sleep(500);
  check(await p.evaluate(() => !showPinnedList && calendarScope === 'day'), 'DAILY に戻る');
  await p.screenshot({ path: '/home/claude/audit/nav-mac.png', clip: { x: 0, y: 0, width: 260, height: 620 } });

  // 検索の絞り込みボタン
  await p.evaluate(() => { openSearchModal(); });
  await sleep(300);
  const chip = await p.evaluate(() => {
    const cs = ['searchRefine_photo', 'searchRefine_pin', 'searchRefine_periodWrap'].map(id => document.getElementById(id));
    return { hs: cs.map(c => Math.round(c.getBoundingClientRect().height)), tops: cs.map(c => Math.round(c.getBoundingClientRect().top)), svgs: cs.map(c => !!c.querySelector('svg')), rowW: Math.round(document.querySelector('.search-refine-row').getBoundingClientRect().width), tabsW: Math.round(document.querySelector('.search-filter-tabs').getBoundingClientRect().width), label: document.getElementById('searchRefinePeriodLabel').textContent };
  });
  check(chip.hs.every(h => h === chip.hs[0]) && chip.tops.every(t => t === chip.tops[0]) && chip.svgs.every(Boolean), '3つのボタンが同じ高さで1行、アイコン付き');
  check(chip.rowW === chip.tabsW, 'タブと同じ横幅');
  check(chip.label === '期間', '期間ボタンの初期表示');
  await p.click('#searchRefine_photo'); await sleep(400);
  const on = await p.evaluate(() => ({ bg: getComputedStyle(document.getElementById('searchRefine_photo')).backgroundColor, pressed: document.getElementById('searchRefine_photo').getAttribute('aria-pressed') }));
  check(on.pressed === 'true' && /rgb\(0, 122, 255\)|rgb\(41, 151, 255\)/.test(on.bg), '選ぶと青く塗りつぶされる ' + on.bg);

  // 写真の既定サイズ
  const q = await p.evaluate(() => ({ q: photoQuality, sel: document.getElementById('photoQualitySelect').value }));
  check(q.q === 'minimum' && q.sel === 'minimum', '写真の保存サイズの既定は「最小」');
  await p.screenshot({ path: '/home/claude/audit/search-mac.png', clip: { x: 340, y: 60, width: 600, height: 330 } });
  check(realErrors(p).length === 0, 'エラーなし ' + JSON.stringify(realErrors(p).slice(0, 3)));

  // 以前「標準」だった端末も一度だけ「最小」に。その後に選び直した値は保たれる
  const p2 = await makeDevice(browser, base, server, { name: 'Old', configure: false, init: () => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('daily_journal_photo_quality', 'standard'); sessionStorage.setItem('seeded', '1'); } } });
  check(await p2.evaluate(() => photoQuality) === 'minimum', '以前の端末（標準）も最小に切り替わる');
  await p2.evaluate(() => changePhotoQuality('high'));
  await p2.reload(); await p2.waitForFunction(() => document.body.classList.contains('ready'));
  check(await p2.evaluate(() => photoQuality) === 'high', '切り替え後に選び直した設定（高画質）は再起動しても保たれる');
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
})();
