// 写真の保存サイズの設定
const { serve, FakeServer, makeDevice, launchBrowser } = require('./harness');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function check(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }
(async () => {
  const srv = await serve(); const base = 'http://localhost:' + srv.address().port;
  const browser = await launchBrowser();
  const p = await makeDevice(browser, base, new FakeServer(), { name: 'P', configure: false, viewport: { width: 390, height: 844 } });
  const addWith = (preset) => p.evaluate(async (preset) => {
    if (preset) changePhotoQuality(preset);
    const c = document.createElement('canvas'); c.width = 4032; c.height = 3024; const x = c.getContext('2d');
    let s = 3; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 3000; i++) { x.fillStyle = `hsl(${r() * 360},50%,${20 + r() * 60}%)`; x.fillRect(r() * 4032, r() * 3024, 20 + r() * 200, 20 + r() * 200); }
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.95));
    const file = new File([blob], 'p.jpg', { type: 'image/jpeg' });
    openAddModal(); document.getElementById('journalInputText').value = 'q-' + preset;
    const dt = new DataTransfer(); dt.items.add(file);
    const inp = document.getElementById('addPhotoInput'); inp.files = dt.files;
    await handlePhotosSelected({ target: inp }, 'add');
    const d = currentAddPhotos[0];
    const dim = await new Promise(res => { const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight]); i.src = d; });
    await saveNewLog();
    return { dim, kb: Math.round((d.length - d.indexOf(',') - 1) * 3 / 4 / 1024) };
  }, preset);

  check(await p.evaluate(() => photoQuality === 'standard' && document.getElementById('photoQualitySelect').value === 'standard'), '初期設定は「標準」');
  const r = {};
  for (const k of ['high', 'standard', 'saver', 'minimum']) r[k] = await addWith(k);
  console.log(' ', JSON.stringify(r));
  check(r.high.dim[0] === 1400 && r.standard.dim[0] === 1200 && r.saver.dim[0] === 1000 && r.minimum.dim[0] === 800, '長い辺が設定どおり (1400/1200/1000/800)');
  check(r.high.kb > r.standard.kb && r.standard.kb > r.saver.kb && r.saver.kb > r.minimum.kb, '設定を下げるほど小さくなる');
  const info = await p.evaluate(() => document.getElementById('photoQualityLastInfo').textContent);
  check(info.includes(r.minimum.kb + 'KB') && info.includes('800×600') && info.includes('最小'), '設定画面に直前の写真の大きさを表示: ' + info);
  check(await p.evaluate(() => { openAddModal(); const v = document.getElementById('addPhotoQualitySelect').value; closeModal('addModal'); return v === 'minimum'; }), '投稿画面の画質は設定画面の値が既定');
  // 保存済みの写真は変わらない
  const before = await p.evaluate(() => Object.values(journalData).flat().filter(l => l.text.startsWith('q-')).map(l => l.text + ':' + l.images[0]).sort().join('|'));
  await p.evaluate(() => changePhotoQuality('high'));
  await p.reload(); await p.waitForFunction(() => document.body.classList.contains('ready'));
  check(await p.evaluate(() => photoQuality === 'high' && document.getElementById('photoQualitySelect').value === 'high'), '設定は再起動後も保持');
  check(await p.evaluate(() => Object.values(journalData).flat().filter(l => l.text.startsWith('q-')).map(l => l.text + ':' + l.images[0]).sort().join('|')) === before, '設定を変えても保存済みの写真は変わらない');
  check(p.errors.filter(e => !/404/.test(e)).length === 0, 'ページエラーなし ' + JSON.stringify(p.errors.slice(0, 3)));

  // ---------- 投稿画面での画質の選択 ----------
  await p.evaluate(() => {
    window.__file = async (seed = 5) => { const c = document.createElement('canvas'); c.width = 3000; c.height = 4000; const x = c.getContext('2d'); let s = seed; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < 2500; i++) { x.fillStyle = `hsl(${r() * 360},50%,${20 + r() * 60}%)`; x.fillRect(r() * 3000, r() * 4000, 30 + r() * 250, 30 + r() * 250); }
      return new File([await new Promise(res => c.toBlob(res, 'image/jpeg', 0.95))], 'p.jpg', { type: 'image/jpeg' }); };
    window.__pick = async (m, files) => { const dt = new DataTransfer(); files.forEach(f => dt.items.add(f)); const inp = document.getElementById(m + 'PhotoInput'); inp.files = dt.files; return handlePhotosSelected({ target: inp }, m); };
    window.__dims = (list) => Promise.all(list.map(d => new Promise(res => { if (!d.startsWith('data:')) return res('ref'); const i = new Image(); i.onload = () => res(i.naturalWidth + 'x' + i.naturalHeight); i.src = d; })));
    changePhotoQuality('standard');
  });
  // 先に画質を選んでから追加
  const r1 = await p.evaluate(async () => { openAddModal(); const sel = document.getElementById('addPhotoQualitySelect'); const def = sel.value; sel.value = 'minimum'; sel.dispatchEvent(new Event('change')); await __pick('add', [await __file(1)]); return { def, dims: await __dims(currentAddPhotos), changedCls: sel.classList.contains('is-changed') }; });
  check(r1.def === 'standard' && r1.dims[0] === '600x800' && r1.changedCls, '投稿画面で「最小」を選んでから追加すると 800px になる（既定と違う画質は色で分かる） ' + JSON.stringify(r1));
  // 追加した後で画質を変えると作り直される（保存ボタンをすぐ押しても待つ）
  const r2 = await p.evaluate(async () => {
    await __pick('add', [await __file(2)]);
    const before = await __dims(currentAddPhotos);
    changeModalPhotoQuality('add', 'high');
    document.getElementById('journalInputText').value = 'modal-quality';
    await saveNewLog();
    const log = Object.values(journalData).flat().find(l => l.text === 'modal-quality');
    const imgs = await Promise.all(log.images.map(ref => getImageData(idbRefHash(ref))));
    return { before, saved: await __dims(imgs) };
  });
  check(JSON.stringify(r2.before) === '["600x800","600x800"]' && JSON.stringify(r2.saved) === '["1050x1400","1050x1400"]', '写真を選んだ後に「高画質」へ変えると作り直され、保存にも反映 ' + JSON.stringify(r2));
  // プレビューに大きさを表示
  const r3 = await p.evaluate(async () => { openAddModal(); await __pick('add', [await __file(3)]); const cap = document.querySelector('#addPhotoPreviewsContainer .photo-preview-size').textContent; const kb = Math.round(dataUrlBytes(currentAddPhotos[0]) / 1024) + 'KB'; changeModalPhotoQuality('add', 'minimum'); await waitPhotoJobs('add'); const cap2 = document.querySelector('#addPhotoPreviewsContainer .photo-preview-size').textContent; closeModal('addModal'); return { cap, kb, cap2 }; });
  check(r3.cap === r3.kb && r3.cap2 !== r3.cap && /KB$/.test(r3.cap2), 'プレビューに1枚ごとの大きさを表示し、画質を変えると更新 ' + JSON.stringify(r3));
  // 開き直すと既定に戻る
  check(await p.evaluate(() => { openAddModal(); const v = document.getElementById('addPhotoQualitySelect').value; closeModal('addModal'); return v === 'standard'; }), '投稿画面を開き直すと既定の画質に戻る');
  // 編集画面：保存済みの写真は変わらず、新しく追加した写真だけに効く
  const r4 = await p.evaluate(async () => {
    const d = Object.keys(journalData).find(k => journalData[k].some(l => l.text === 'modal-quality'));
    const log = journalData[d].find(l => l.text === 'modal-quality');
    const old = [...log.images];
    openEditModal(d, log.id);
    const caps = [...document.querySelectorAll('#editPhotoPreviewsContainer .photo-preview-size')].map(e => e.textContent);
    await __pick('edit', [await __file(4)]);
    changeModalPhotoQuality('edit', 'saver');
    await saveEditedLog();
    const imgs = await Promise.all(log.images.map(ref => getImageData(idbRefHash(ref))));
    return { caps, keptOld: old.every((r, i) => log.images[i] === r), dims: await __dims(imgs) };
  });
  check(r4.caps.every(c => c === '保存済み') && r4.keptOld && r4.dims[2] === '750x1000', '編集画面：保存済みの写真は「保存済み」のまま変わらず、新しい写真だけ「節約」に ' + JSON.stringify(r4));
  check(p.errors.filter(e => !/404/.test(e)).length === 0, 'ページエラーなし（投稿画面） ' + JSON.stringify(p.errors.filter(e => !/404/.test(e)).slice(0, 3)));
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
