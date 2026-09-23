// 過去の写真をまとめて縮小
const { serve, FakeServer, makeDevice, launchBrowser } = require('./harness');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function check(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }
(async () => {
  const srv = await serve(); const base = 'http://localhost:' + srv.address().port;
  const browser = await launchBrowser();
  const server = new FakeServer();
  const p = await makeDevice(browser, base, server, { name: 'P', viewport: { width: 390, height: 844 } });
  await sleep(1000);
  const setup = await p.evaluate(async () => {
    const mk = (seed, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); let s = seed; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < 1500; i++) { x.fillStyle = `hsl(${r() * 360},50%,${20 + r() * 60}%)`; x.fillRect(r() * w, r() * h, 10 + r() * w / 6, 10 + r() * h / 6); } return c.toDataURL('image/jpeg', 0.85); };
    const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const old = new Date(); old.setMonth(old.getMonth() - 5); const recent = new Date(); recent.setDate(recent.getDate() - 10);
    const big1 = mk(1, 1400, 1050), big2 = mk(2, 1050, 1400), small = mk(3, 800, 600), big3 = mk(4, 1400, 1050);
    journalData[key(old)] = [
      { id: 'lg_oldA', time: '09:00', text: 'oldA', category: 'ライフログ', images: [big1, big2, small] },
      { id: 'lg_oldB', time: '10:00', text: 'oldB', category: 'ライフログ', images: [big1] }];
    journalData[key(recent)] = [{ id: 'lg_recent', time: '09:00', text: 'recent', category: 'ライフログ', images: [big3] }];
    await saveJournalData();
    return { oldKey: key(old), recentKey: key(recent) };
  });
  await sleep(2500);
  const oldPaths = [...server.images.keys()];
  check(oldPaths.length === 4, '前提：クラウドに画像4件');

  // 調べる
  await p.evaluate(() => { openModal('settingsModal'); switchSettingsTab('data'); document.getElementById('bulkShrinkAge').value = '3'; document.getElementById('bulkShrinkPreset').value = 'saver'; });
  await p.evaluate(() => previewBulkShrink());
  const txt = await p.evaluate(() => document.getElementById('bulkShrinkResult').textContent.replace(/\s+/g, ' '));
  console.log('  ' + txt.slice(0, 220));
  check(/3 枚/.test(txt) && /800px 以下の写真 1 枚/.test(txt.replace('1000px', '')) === false || /1000px 以下の写真 1 枚/.test(txt), '3か月より前・節約：対象3枚（同じ写真の重複を含む）、小さい写真1枚はそのまま');
  check(/バックアップ/.test(txt) && await p.evaluate(() => !!document.querySelector('#bulkShrinkResult button[onclick="exportData()"]')), 'バックアップの書き出しを促すボタンがある');
  const est = await p.evaluate(async () => { const pl = await collectBulkShrinkTargets(3, 'saver'); return { before: pl.beforeBytes, after: pl.estAfter }; });

  // 実行
  await p.evaluate(() => runBulkShrink());
  const r = await p.evaluate(async (k) => {
    const dims = async ref => { const d = await getImageData(idbRefHash(ref)); return await new Promise(res => { const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight, Math.round(dataUrlBytes(d) / 1024)]); i.src = d; }); };
    const A = journalData[k.oldKey][0], B = journalData[k.oldKey][1], R = journalData[k.recentKey][0];
    return { A: await Promise.all(A.images.map(dims)), B: await Promise.all(B.images.map(dims)), R: await Promise.all(R.images.map(dims)), sameRef: A.images[0] === B.images[0], text: document.getElementById('bulkShrinkResult').textContent.replace(/\s+/g, ' ') };
  }, setup);
  console.log('  ' + JSON.stringify({ A: r.A, B: r.B, R: r.R }));
  check(r.A[0][0] === 1000 && r.A[1][1] === 1000 && r.B[0][0] === 1000, '古い写真は長い辺1000pxに縮小（縦長も）');
  check(r.A[2][0] === 800 && r.R[0][0] === 1400, '小さい写真と、最近の写真はそのまま');
  check(r.sameRef, '同じ写真を使う2つの記録は、同じ縮小後の画像を共有');
  const actualBefore = est.before, actualAfter = (r.A[0][2] + r.A[1][2]) * 1024;
  const ratio = (est.before - est.after) / (actualBefore - actualAfter);
  check(ratio > 0.6 && ratio < 1.5, `空く容量の見込みが実際と近い（見込み ${Math.round((est.before - est.after) / 1024)}KB / 実際 ${Math.round((actualBefore - actualAfter) / 1024)}KB）`);
  check(/✅ 3 枚/.test(r.text) || /✅ 2 枚/.test(r.text) || /縮小しました/.test(r.text), '完了の表示: ' + r.text.slice(0, 80));

  // 同期と、クラウド・端末の古い画像の削除
  await sleep(2500);
  const rowJ = JSON.stringify(server.db.journals.get(setup.oldKey).log_data);
  const newPaths = [...server.images.keys()].filter(k => !oldPaths.includes(k));
  check(newPaths.length === 2 && newPaths.every(k => rowJ.includes(k)), '縮小した写真はクラウドへ送信され、記録から参照される');
  for (const k of server.imageMeta.keys()) if (oldPaths.includes(k)) server.imageMeta.get(k).created_at = new Date(Date.now() - 10 * 86400000).toISOString();
  await p.evaluate(() => cleanupUnusedCloudImages()); await sleep(800);
  const remain = [...server.images.keys()];
  check(remain.length === 4 && !remain.includes(oldPaths.find(k => !JSON.stringify(server.db.journals.get(setup.recentKey).log_data).includes(k) && !rowJ.includes(k))), 'クラウドの不要な画像を削除すると、縮小前の画像2件が消える（残り4件）');
  await p.evaluate(() => garbageCollectImages()); await sleep(300);
  const localCount = await p.evaluate(async () => { const db = await initDB(); return new Promise(res => { const q = db.transaction('images').objectStore('images').getAllKeys(); q.onsuccess = () => res(q.result.length); }); });
  check(localCount === 4, '端末内の古い画像も掃除される（画像4件）: ' + localCount);

  // もう一度調べると対象なし
  await p.evaluate(() => previewBulkShrink());
  check(/より大きい写真はありません/.test(await p.evaluate(() => document.getElementById('bulkShrinkResult').textContent)), '2回目は対象なし');
  const errs = p.errors.filter(e => !/404/.test(e));
  check(errs.length === 0, 'ページエラーなし ' + JSON.stringify(errs.slice(0, 3)));
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
