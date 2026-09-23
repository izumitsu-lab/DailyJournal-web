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
  check(await p.evaluate(() => [...document.querySelectorAll('.photo-size-notice')].every(e => e.textContent === '自動縮小・最小')), '追加画面の表示も設定に合わせる');
  // 保存済みの写真は変わらない
  const before = await p.evaluate(() => Object.values(journalData).flat().filter(l => l.text.startsWith('q-')).map(l => l.text + ':' + l.images[0]).sort().join('|'));
  await p.evaluate(() => changePhotoQuality('high'));
  await p.reload(); await p.waitForFunction(() => document.body.classList.contains('ready'));
  check(await p.evaluate(() => photoQuality === 'high' && document.getElementById('photoQualitySelect').value === 'high'), '設定は再起動後も保持');
  check(await p.evaluate(() => Object.values(journalData).flat().filter(l => l.text.startsWith('q-')).map(l => l.text + ':' + l.images[0]).sort().join('|')) === before, '設定を変えても保存済みの写真は変わらない');
  check(p.errors.filter(e => !/404/.test(e)).length === 0, 'ページエラーなし ' + JSON.stringify(p.errors.slice(0, 3)));
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
