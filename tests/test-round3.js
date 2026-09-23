const { serve, FakeServer, makeDevice, launchBrowser } = require('./harness');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function check(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; }
const realErrors = p => p.errors.filter(e => !/404 \(Not Found\)/.test(e));
const helpers = () => {
  window.__mkImg = (color) => { const c = document.createElement('canvas'); c.width = 40; c.height = 30; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, 40, 30); return c.toDataURL('image/jpeg', 0.9); };
  window.__addLog = async (text, color) => { openAddModal(); document.getElementById('journalInputText').value = text; if (color) currentAddPhotos = [__mkImg(color)]; await saveNewLog(); };
  window.__texts = () => Object.values(journalData).flat().map(l => l.text).sort();
};

(async () => {
  const srv = await serve(); const base = 'http://localhost:' + srv.address().port;
  const browser = await launchBrowser();

  // ---------- (7) クラウドの不要画像の掃除 ----------
  const server = new FakeServer();
  const d1 = await makeDevice(browser, base, server, { name: 'D1', init: helpers });
  const d2 = await makeDevice(browser, base, server, { name: 'D2', init: helpers });
  await sleep(1000);
  await d1.evaluate(() => __addLog('keep', '#0a0'));
  await d1.evaluate(() => __addLog('drop', '#a00'));
  await d1.evaluate(async () => { notebookData.unshift({ id: 'nb_img', title: '画像ノート', content: '<p>x<img src="' + __mkImg('#00a') + '"></p>', category: 'ライフログ', status: 'active', linkedNoteIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); await saveNotebookData(); });
  await sleep(2500);
  check(server.images.size === 3, '前提：画像3件がクラウドにある');
  const pathOf = (text) => { for (const r of server.db.journals.values()) for (const l of r.log_data) if (l.text === text) return l.images[0].slice(6); };
  const keepPath = pathOf('keep'), dropPath = pathOf('drop');
  await d1.evaluate(async () => { for (const d of Object.keys(journalData)) { const l = journalData[d].find(x => x.text === 'drop'); if (l) { openEditModal(d, l.id); window.confirm = () => true; await deleteFromEditModal(); } } });
  await sleep(2000);
  // 既存の画像は10日前にアップロードされたことにする＋直近の不要画像を1件追加
  for (const k of server.imageMeta.keys()) server.imageMeta.get(k).created_at = new Date(Date.now() - 10 * 86400000).toISOString();
  server.images.set('user-1/img_' + 'f'.repeat(64) + '.jpeg', 'data:image/jpeg;base64,AAAA'); server.imageMeta.set('user-1/img_' + 'f'.repeat(64) + '.jpeg', { created_at: new Date().toISOString() });
  d1.lastDialog = null;
  await d1.evaluate(() => cleanupUnusedCloudImages());
  await sleep(500);
  check(!server.images.has(dropPath), '削除した記録の画像はクラウドから削除された');
  check(server.images.has(keepPath) && [...server.images.keys()].some(k => k.includes('img_') && !k.includes('f'.repeat(64)) && k !== keepPath && k !== dropPath), '記録・ノートで使用中の画像は残る');
  check(server.images.has('user-1/img_' + 'f'.repeat(64) + '.jpeg'), '直近アップロードの画像は猶予期間中なので残る');
  check(/1 件の不要な画像/.test(d1.lastDialog || ''), '結果が表示される: ' + d1.lastDialog);
  check(!!server.db.app_settings.get('user-1').images_cleaned_at, '掃除した時刻がサーバーに記録された');
  // D2は同じ画像を「アップロード済み」と記憶している → 掃除を知って再アップロードする
  await sleep(500);
  await d2.evaluate(() => __addLog('drop-again', '#a00'));
  await sleep(2500);
  check(pathOf('drop-again') === dropPath && server.images.has(dropPath), '他の端末は掃除を検知し、同じ画像（同じハッシュ）を再アップロードする');
  // 画像が欠けていても同期は止まらない
  server.db.journals.set('2026-01-01', { date_str: '2026-01-01', user_id: 'user-1', tombstones: {}, updated_at: new Date().toISOString(),
    log_data: [{ id: 'lg_missing', time: '09:00', text: 'missing-image', category: 'ライフログ', images: ['SBIMG:user-1/img_' + 'e'.repeat(64) + '.jpeg'], updatedAt: new Date().toISOString() }] });
  const d3 = await makeDevice(browser, base, server, { name: 'D3', init: helpers });
  await sleep(2500);
  const st = await d3.evaluate(() => ({ texts: __texts(), pending: getPendingCount(), status: document.getElementById('supabaseSyncStatus').textContent }));
  check(st.texts.includes('missing-image') && st.texts.includes('keep') && st.pending === 0 && !/エラー/.test(st.status), 'クラウドに画像がない記録があっても同期は完了する');
  await d3.evaluate(() => { activeDateKey = '2026-01-01'; if (!dateList.includes('2026-01-01')) { dateList.push('2026-01-01'); dateList.sort(); } calendarScope = 'day'; renderRightCards(); });
  check(await d3.evaluate(() => !!document.querySelector('img[data-missing]')), '欠けた画像は薄く表示される（壊れた画像アイコンやエラーにならない）');
  const errs1 = [d1, d2, d3].flatMap(realErrors);
  check(errs1.length === 0, 'ページエラーなし ' + JSON.stringify(errs1.slice(0, 3)));

  // ---------- (10) 複数タブ ----------
  const a = await makeDevice(browser, base, new FakeServer(), { name: 'TabA', configure: false, init: helpers });
  await a.evaluate(() => __addLog('A1'));
  const b = await a.ctx.newPage();
  b.errors = []; b.on('pageerror', e => b.errors.push('TabB ' + e.message));
  await b.goto(base + '/index.html');
  await b.waitForFunction(() => document.body.classList.contains('ready'));
  await sleep(200);
  check(await a.isVisible('#tabInactiveOverlay'), '後から開いたタブがあると、前のタブに案内が表示される');
  check(JSON.stringify(await b.evaluate(() => __texts())) === '["A1"]', '新しいタブは前のタブの保存内容を読み込む');
  await b.evaluate(() => __addLog('B1'));
  await a.evaluate(() => __addLog('A2-stale-tab'));
  const stored = await b.evaluate(async () => { const db = await initDB(); return new Promise(r => { const q = db.transaction('appData').objectStore('appData').get('journalData'); q.onsuccess = () => r(Object.values(q.result).flat().map(l => l.text).sort()); }); });
  check(JSON.stringify(stored) === '["A1","B1"]', '使われていないタブからの保存は書き込まれない（新しいタブの内容を上書きしない）');
  await Promise.all([a.waitForNavigation(), a.click('#tabInactiveOverlay button')]);
  await a.waitForFunction(() => document.body.classList.contains('ready'));
  await sleep(200);
  check(await b.isVisible('#tabInactiveOverlay') && !(await a.isVisible('#tabInactiveOverlay')), '「このタブで使う」で切り替えられる');
  check(JSON.stringify(await a.evaluate(() => __texts())) === '["A1","B1"]', '切り替えたタブは最新の内容を表示');
  const errs2 = [a, b].flatMap(realErrors);
  check(errs2.length === 0, 'ページエラーなし ' + JSON.stringify(errs2.slice(0, 3)));

  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
