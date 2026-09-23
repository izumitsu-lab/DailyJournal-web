// 画像の多いデータで、ビューの素早い切り替え時に「展開された画像のメモリ量」と「描画回数」を測る
const { serve, FakeServer, makeDevice, launchBrowser } = require('./harness');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const srv = await serve(); const base = 'http://localhost:' + srv.address().port;
  const browser = await launchBrowser();
  const p = await makeDevice(browser, base, new FakeServer(), { name: 'SP', configure: false, viewport: { width: 390, height: 844 } });
  // データ投入：ノート30冊×画像4枚、写真付き記録120件×2枚（1400x1050 JPEG）
  await p.evaluate(async () => {
    const mk = (seed) => { const c = document.createElement('canvas'); c.width = 1400; c.height = 1050; const x = c.getContext('2d');
      for (let i = 0; i < 60; i++) { x.fillStyle = `hsl(${(seed * 37 + i * 13) % 360},70%,${30 + i % 40}%)`; x.fillRect((i * 97 + seed * 31) % 1400, (i * 53 + seed * 17) % 1050, 300, 200); }
      return c.toDataURL('image/jpeg', 0.85); };
    let k = 0;
    for (let n = 0; n < 30; n++) {
      let html = `<p>ノート${n}</p>`;
      for (let j = 0; j < 4; j++) html += `<span class="nb-img-wrapper size-full" contenteditable="false"><img class="nb-embedded-img" src="${mk(k++)}"></span><p>本文</p>`;
      notebookData.push({ id: 'nb_b' + n, title: 'N' + n, content: html, category: 'ライフログ', status: 'active', linkedNoteIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    await saveNotebookData();
    const d0 = new Date();
    for (let i = 0; i < 120; i++) {
      const d = new Date(d0); d.setDate(d.getDate() - Math.floor(i / 2));
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      (journalData[ds] = journalData[ds] || []).push({ id: 'lg_b' + i, time: '10:' + String(i % 60).padStart(2, '0'), text: 'photo ' + i, category: 'ライフログ', images: [mk(k++), mk(k++)] });
    }
    await saveJournalData();
  });
  await p.reload(); await p.waitForFunction(() => document.body.classList.contains('ready')); await sleep(800);

  const measure = () => p.evaluate(() => {
    let px = 0, n = 0;
    document.querySelectorAll('img').forEach(i => { if (i.complete && i.naturalWidth > 1 && i.src.startsWith('data:image/') && !i.src.startsWith('data:image/gif')) { px += i.naturalWidth * i.naturalHeight * 4; n++; } });
    return { mb: Math.round(px / 1048576), imgs: n };
  });
  await p.evaluate(() => { window.__renders = 0; for (const f of ['renderDayCarousel', 'renderPhotoJournalCarousel', 'renderNotebookCarousel', 'renderWeekCarousel', 'renderMonthCarousel']) { const o = window[f]; window[f] = function () { window.__renders++; return o.apply(this, arguments); }; } });

  const views = [['scope', 'photo'], ['nb', 'grid'], ['scope', 'day'], ['nb', 'card'], ['scope', 'photo'], ['nb', 'grid']];
  const res = {};
  for (const [k, v] of views.slice(0, 3)) {
    await p.evaluate(([k, v]) => k === 'scope' ? selectScopeFromModal(v) : selectNotebookViewFromModal(v), [k, v]);
    await sleep(1500); res[v] = await measure();
    if (v === 'grid') { await sleep(2500); res.grid_after_4s = Object.assign(await measure(), await p.evaluate(() => { const a = [...document.querySelectorAll('img[data-nbthumb]')]; const l = a.filter(i => i.naturalWidth > 1); return { thumbsLoaded: l.length, maxW: Math.max(0, ...l.map(i => i.naturalWidth)) }; })); }
  }
  // 写真ビューで横に30枚スワイプ
  await p.evaluate(() => selectScopeFromModal('photo')); await sleep(800);
  for (let i = 0; i < 30; i++) { await p.evaluate(() => { const c = document.getElementById('journalCarouselContainer'); c.scrollLeft -= c.clientWidth; }); await sleep(120); }
  await sleep(600); res['photo_after_30_swipes'] = await measure();

  // 素早い切り替え：70ms間隔で24回
  await p.evaluate(() => { window.__renders = 0; window.__peak = 0; window.__peakTimer = setInterval(() => { let px = 0; document.querySelectorAll('img').forEach(i => { if (i.complete && i.naturalWidth > 1 && !i.src.startsWith('data:image/gif')) px += i.naturalWidth * i.naturalHeight * 4; }); window.__peak = Math.max(window.__peak, px); }, 30); });
  const t0 = Date.now();
  await p.evaluate(async (views) => { for (let i = 0; i < 24; i++) { const [k, v] = views[i % views.length]; k === 'scope' ? selectScopeFromModal(v) : selectNotebookViewFromModal(v); await new Promise(r => setTimeout(r, 40)); } }, views);
  await sleep(2000);
  const r = await p.evaluate(() => { clearInterval(window.__peakTimer); return { renders: window.__renders, peakMB: Math.round(window.__peak / 1048576) }; });
  res.rapid = Object.assign(r, { ms: Date.now() - t0 });
  res.errors = p.errors.filter(e => !/404/.test(e));
  console.log(JSON.stringify(res, null, 1));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(2); });
