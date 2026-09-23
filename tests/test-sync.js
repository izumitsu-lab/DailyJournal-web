const { chromium } = require('playwright');
const { serve, FakeServer, makeDevice, launchBrowser } = require('./harness');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function check(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; }

const helpers = () => {
  window.__mkImg = (color) => { const c = document.createElement('canvas'); c.width = 40; c.height = 30; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, 40, 30); return c.toDataURL('image/jpeg', 0.9); };
  window.__addLog = async (text, color) => {
    openAddModal(); document.getElementById('journalInputText').value = text;
    if (color) currentAddPhotos = [__mkImg(color)];
    await saveNewLog();
  };
  window.__texts = () => Object.values(journalData).flat().map(l => l.text).sort();
  window.__deleteLogByText = async (text) => {
    for (const d of Object.keys(journalData)) { const l = journalData[d].find(x => x.text === text); if (l) { openEditModal(d, l.id); await deleteFromEditModal(); return true; } }
    return false;
  };
  window.__editLogByText = async (text, newText) => {
    for (const d of Object.keys(journalData)) { const l = journalData[d].find(x => x.text === text); if (l) { openEditModal(d, l.id); document.getElementById('editInputText').value = newText; await saveEditedLog(); return true; } }
    return false;
  };
};

(async () => {
  const srv = await serve(); const base = 'http://localhost:' + srv.address().port;
  const browser = await launchBrowser();
  const server = new FakeServer();
  const d1 = await makeDevice(browser, base, server, { name: 'D1', init: helpers });
  const d2 = await makeDevice(browser, base, server, { name: 'D2', init: helpers });
  await sleep(800);
  await d1.evaluate(() => syncNow(true)); await d2.evaluate(() => syncNow(true));

  const serverTexts = () => [...server.db.journals.values()].flatMap(r => r.log_data.filter(l => !(r.tombstones[l.id] >= (l.updatedAt || ''))).map(l => l.text)).sort();

  // 1. 追記と画像の同期
  await d1.evaluate(() => __addLog('L1-D1', '#f00'));
  await sleep(2000);
  const row = [...server.db.journals.values()][0];
  check(row && row.log_data.some(l => l.text === 'L1-D1' && l.images[0].startsWith('SBIMG:user-1/img_')), 'D1の追記がサーバーに届き、画像はStorage参照になっている');
  check(server.images.size === 1, 'Storageに画像が1件アップロードされた');
  check(JSON.stringify(await d2.evaluate(() => __texts())) === '["L1-D1"]', 'D2にリアルタイムで反映された');
  check(await d2.evaluate(() => Object.values(journalData).flat()[0].images[0].startsWith('idbimg:')), 'D2側では画像は端末の画像ストアに保存され、メモリ上は参照のみ');
  await d2.evaluate(() => { calendarScope = 'day'; activeDateKey = getTodayKey(); renderRightCards(); });
  await d2.waitForFunction(() => { const i = document.querySelector('.log-photo-thumb[data-idbimg]'); return i && i.src.startsWith('data:image/jpeg'); }, null, { timeout: 5000 }).then(() => check(true, 'D2: 画面に表示された画像は遅延読み込みされる')).catch(() => check(false, 'D2: 画面に表示された画像は遅延読み込みされる'));

  // 1b. 画像付き記録は、後の別の保存で「変更あり」と誤検知されない
  const u1 = await d1.evaluate(() => Object.values(journalData).flat().find(l => l.text === 'L1-D1').updatedAt);
  await d1.evaluate(async () => { await saveJournalData(); });
  const u2 = await d1.evaluate(() => Object.values(journalData).flat().find(l => l.text === 'L1-D1').updatedAt);
  check(u1 === u2, '無関係な保存で画像付き記録の更新時刻が変わらない');
  await d1.reload(); await d1.waitForFunction(() => document.body.classList.contains('ready')); await sleep(1500);
  await d1.evaluate(async () => { await saveJournalData(); });
  check(await d1.evaluate(() => Object.values(journalData).flat().find(l => l.text === 'L1-D1').updatedAt) === u1 && await d1.evaluate(() => getPendingCount()) === 0, '再読み込み後も誤検知なし・未送信0');

  // 2. オフライン中の編集が、復帰時にクラウドの古い版で消されない＋削除が伝わる
  await d2.ctx.setOffline(true);
  await d2.evaluate(() => __addLog('L2-D2-offline'));
  await d1.evaluate(() => __addLog('L3-D1'));
  await d1.evaluate(() => __deleteLogByText('L1-D1'));
  await sleep(1800);
  check(JSON.stringify(serverTexts()) === '["L3-D1"]', 'サーバーは L1 削除・L3 追加の状態');
  await d2.ctx.setOffline(false);
  await sleep(2500);
  check(JSON.stringify(await d2.evaluate(() => __texts())) === '["L2-D2-offline","L3-D1"]', 'D2: オフライン記録が残り、L1削除とL3が反映');
  check(JSON.stringify(serverTexts()) === '["L2-D2-offline","L3-D1"]', 'サーバー: 両端末の記録がマージされた');
  await sleep(500);
  check(JSON.stringify(await d1.evaluate(() => __texts())) === '["L2-D2-offline","L3-D1"]', 'D1: D2のオフライン記録を受信');

  // 3. 全件同期・再読み込みでも削除した記録が復活しない
  await d2.reload(); await d2.waitForFunction(() => document.body.classList.contains('ready')); await sleep(1200);
  await d2.evaluate(() => forceSyncNow()); await sleep(500);
  check(JSON.stringify(await d2.evaluate(() => __texts())) === '["L2-D2-offline","L3-D1"]', '再読み込み＋全件同期後も L1 は復活しない');
  check(await d2.evaluate(() => getPendingCount()) === 0, '同期後の未送信件数は0');

  // 4. 同じ記録を両端末がオフラインで編集 → 後から編集した方が残る（記録は重複しない）
  await d1.ctx.setOffline(true); await d2.ctx.setOffline(true);
  await d1.evaluate(() => __editLogByText('L3-D1', 'L3-edit-by-D1'));
  await sleep(50);
  await d2.evaluate(() => __editLogByText('L3-D1', 'L3-edit-by-D2'));
  await d1.ctx.setOffline(false); await sleep(1500);
  await d2.ctx.setOffline(false); await sleep(2500);
  check(JSON.stringify(serverTexts()) === '["L2-D2-offline","L3-edit-by-D2"]', '同一記録の競合は新しい編集が勝ち、重複しない');
  check(JSON.stringify(await d1.evaluate(() => __texts())) === '["L2-D2-offline","L3-edit-by-D2"]', 'D1も同じ結果に収束');

  // 5. ノートの作成・完全削除の同期（Trash を空にしても復活しない）
  await d1.evaluate(async () => { notebookData.unshift({ id: 'nb_test1', title: 'ノートA', content: '<p>本文</p>', category: 'ライフログ', status: 'active', linkedNoteIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); await saveNotebookData(); });
  await sleep(2000);
  check(await d2.evaluate(() => notebookData.some(n => n.id === 'nb_test1' && n.title === 'ノートA')), 'D2にノートが届いた');
  await d2.evaluate(async () => { notebookData.find(n => n.id === 'nb_test1').status = 'trash'; await saveNotebookData(); });
  await sleep(1500);
  await d1.evaluate(async () => { notebookData = notebookData.filter(n => n.id !== 'nb_test1'); await saveNotebookData(); });
  await sleep(2000);
  check(server.db.notebooks.get('nb_test1').deleted === true, 'サーバー上で削除の印が付いた');
  check(await d2.evaluate(() => !notebookData.some(n => n.id === 'nb_test1')), 'D2からも削除された');
  await d2.evaluate(() => forceSyncNow()); await sleep(300);
  check(await d2.evaluate(() => !notebookData.some(n => n.id === 'nb_test1')), '全件同期後もノートは復活しない');

  // 6. 設定（タイプ追加）の同期、起動直後の既定値で上書きしない
  await d1.evaluate(() => { addNewType('研究B'); });
  await sleep(2000);
  check(await d2.evaluate(() => appTypes.includes('研究B')), '設定がD2に同期された');
  const d3 = await makeDevice(browser, base, server, { name: 'D3-new', init: helpers });
  await sleep(2500);
  check(await d3.evaluate(() => appTypes.includes('研究B') && __texts().length === 2), '新しい端末: クラウドの設定と記録を取得（既定値で上書きしない）');
  check((server.db.app_settings.get('user-1').settings_data.appTypes || []).includes('研究B'), 'サーバーの設定は保持されている');

  // 7. 画像ストア分離：IndexedDBには参照のみ保存
  const idb = await d2.evaluate(async () => {
    const db = await initDB();
    const get = (s, k) => new Promise(r => { const q = db.transaction(s).objectStore(s).get(k); q.onsuccess = () => r(q.result); });
    const keys = await new Promise(r => { const q = db.transaction('images').objectStore('images').getAllKeys(); q.onsuccess = () => r(q.result); });
    const j = await get('appData', 'journalData');
    return { version: db.version, imgCount: keys.length, hasInline: JSON.stringify(j).includes('data:image') };
  });
  check(idb.version === 2 && !idb.hasInline, 'IndexedDB v2: journalData に Base64 を含まない');

  // 8. サーバー未更新（v2 SQL 未実行）なら同期を止め、データを送らない
  server.schemaOutdated = true;
  const d4 = await makeDevice(browser, base, server, { name: 'D4-outdated', init: helpers });
  await sleep(1500);
  const before = server.log.filter(x => x.startsWith('upsert')).length;
  await d4.evaluate(() => __addLog('L4-should-wait'));
  await sleep(1800);
  check(server.log.filter(x => x.startsWith('upsert')).length === before, 'スキーマ未更新時は書き込まない');
  check((await d4.evaluate(() => document.getElementById('supabaseSyncStatus').textContent)).includes('サーバー側の更新'), '状態表示でSQL実行を案内');
  check(await d4.evaluate(() => __texts().includes('L4-should-wait')), '入力は本体に保存されている');

  const errs = [d1, d2, d3, d4].flatMap(p => p.errors);
  check(errs.filter(e => !/404 \(Not Found\)/.test(e)).length === 0, 'ページエラーなし ' + JSON.stringify(errs.slice(0, 5)));
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
