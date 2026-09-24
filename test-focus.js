// 集中モード（PC）と、設定アイコンの同期状態の点
const { serve, FakeServer, makeDevice, launchBrowser } = require('./harness');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function check(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }
(async () => {
  const srv = await serve(); const base = 'http://localhost:' + srv.address().port;
  const browser = await launchBrowser();
  const pc = await makeDevice(browser, base, new FakeServer(), { name: 'PC', viewport: { width: 1280, height: 800 } });
  await sleep(800);
  check(await pc.evaluate(() => !document.getElementById('btnSyncPull') && getComputedStyle(document.getElementById('btnFocus')).display !== 'none' && document.getElementById('btnFocusLabel').textContent === '集中'), 'PC：「更新」の代わりに「🧘 集中」ボタン');
  const w0 = await pc.evaluate(() => getActiveCarouselPanel().querySelector('.main-display').getBoundingClientRect().width);
  check(await pc.isVisible('#calendarSidebar'), '前提：左サイドバーが表示されている');
  await pc.click('#btnFocus'); await sleep(300);
  const f = await pc.evaluate(() => { const m = getActiveCarouselPanel().querySelector('.main-display').getBoundingClientRect(); return { w: m.width, center: Math.abs((m.left + m.right) / 2 - innerWidth / 2), label: document.getElementById('btnFocusLabel').textContent, on: document.getElementById('btnFocus').classList.contains('is-on') }; });
  check(!(await pc.isVisible('#calendarSidebar')) && !(await pc.isVisible('#pcLeftSidebarReopen')), '集中モード：左サイドバーも再表示タブも隠れる');
  check(f.w <= 861 && f.center < 20 && f.label === '戻す' && f.on, `記録は中央に（幅 ${Math.round(f.w)}px、元は ${Math.round(w0)}px）、ボタンは「戻す」`);
  // 表示を切り替えても集中モードのまま
  await pc.evaluate(async () => { notebookData.push({ id: 'nb_f', title: 'F', content: '<p>x</p>', category: 'ライフログ', status: 'active', linkedNoteIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); await saveNotebookData(); selectNotebookViewFromModal('card'); });
  await sleep(500);
  check(!(await pc.isVisible('.connected-right-sidebar')) && !(await pc.isVisible('#pcRightSidebarReopen')) && !(await pc.isVisible('#calendarSidebar')), 'ノートのカードビューでも左右とも隠れたまま');
  // Esc で戻る
  await pc.keyboard.press('Escape'); await sleep(300);
  check(await pc.isVisible('#calendarSidebar') && await pc.isVisible('.connected-right-sidebar') && await pc.evaluate(() => !document.body.classList.contains('focus-mode') && document.getElementById('btnFocusLabel').textContent === '集中'), 'Esc で元に戻り、左右のサイドバーも元どおり');
  // 右だけ閉じていた状態は、集中モードの後も閉じたまま
  await pc.evaluate(() => toggleRightSidebar(false)); await sleep(200);
  await pc.click('#btnFocus'); await sleep(200); await pc.click('#btnFocus'); await sleep(300);
  check(await pc.isVisible('#calendarSidebar') && !(await pc.isVisible('.connected-right-sidebar')), '集中モードの前の開け閉めの状態に戻る');
  // モーダルが開いているときの Esc はモーダル優先
  await pc.click('#btnFocus'); await sleep(200);
  await pc.evaluate(() => openModal('settingsModal'));
  await pc.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  check(await pc.evaluate(() => document.body.classList.contains('focus-mode')), '画面（モーダル）が開いているときの Esc では集中モードは終わらない');
  await pc.evaluate(() => closeModal('settingsModal'));
  await pc.evaluate(() => setFocusMode(false));

  // 同期状態の点
  const dot = () => pc.evaluate(() => { const d = document.getElementById('syncAlertDot'); return { warn: d.classList.contains('warn'), error: d.classList.contains('error'), shown: getComputedStyle(d).display !== 'none', title: document.getElementById('btnSettings').title }; });
  let d = await dot();
  check(!d.shown && d.title === '設定', '同期に問題がなければ点なし');
  await pc.evaluate(() => { _lastSyncError = new Error('x'); updateSyncStatusUI(); });
  d = await dot();
  check(d.shown && d.error && /同期エラー/.test(d.title), '同期エラーのときは赤い点（マウスを乗せると内容）: ' + d.title);
  await pc.evaluate(() => { _lastSyncError = null; updateSyncStatusUI(); });
  check(!(await dot()).shown, 'エラーが解消すると点は消える');
  await pc.ctx.setOffline(true);
  await pc.evaluate(async () => { window.dispatchEvent(new Event('offline')); openAddModal(); document.getElementById('journalInputText').value = 'offline'; await saveNewLog(); });
  await sleep(300);
  d = await dot();
  check(d.shown && d.warn, 'オフラインで未送信があるときはオレンジの点');
  await pc.ctx.setOffline(false); await pc.evaluate(() => window.dispatchEvent(new Event('online'))); await sleep(1500);
  check(!(await dot()).shown, 'オンラインに戻って送信されると点は消える');
  const errs = pc.errors.filter(e => !/404/.test(e));
  check(errs.length === 0, 'ページエラーなし ' + JSON.stringify(errs.slice(0, 3)));

  // スマホ：集中ボタンは出ない、点は出る
  const sp = await makeDevice(browser, base, new FakeServer(), { name: 'SP', viewport: { width: 390, height: 844 } });
  await sleep(600);
  check(await sp.evaluate(() => getComputedStyle(document.getElementById('btnFocus')).display === 'none' && getComputedStyle(document.getElementById('btnCalendarLink')).display !== 'none'), 'スマホ：集中ボタンは出ず、「日付」ボタンのまま');
  await sp.evaluate(() => { _lastSyncError = new Error('x'); updateSyncStatusUI(); });
  check(await sp.evaluate(() => document.getElementById('syncAlertDot').classList.contains('error')), 'スマホでも設定アイコンに点が付く');
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
