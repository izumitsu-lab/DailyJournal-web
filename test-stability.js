// iPhone での安定性（素早い切り替え・画像のメモリ）と「軽量化」ボタンの表示判定
const { serve, FakeServer, makeDevice, launchBrowser } = require('./harness');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function check(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }
const realErrors = p => p.errors.filter(e => !/404 \(Not Found\)/.test(e));
const helpers = () => {
  window.__mkImg = (color, w = 1400, h = 1050) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h); x.fillStyle = '#fff'; x.fillRect(10, 10, w / 3, h / 3); return c.toDataURL('image/jpeg', 0.85); };
  window.__loadedPx = () => { let px = 0; document.querySelectorAll('img').forEach(i => { if (i.complete && i.naturalWidth > 1 && !i.src.startsWith('data:image/gif')) px += i.naturalWidth * i.naturalHeight; }); return px; };
};
(async () => {
  const srv = await serve(); const base = 'http://localhost:' + srv.address().port;
  const browser = await launchBrowser();

  // ---------- 素早い切り替え・画像 ----------
  const sp = await makeDevice(browser, base, new FakeServer(), { name: 'SP', configure: false, viewport: { width: 390, height: 844 }, init: helpers });
  await sp.evaluate(async () => {
    for (let n = 0; n < 8; n++) notebookData.push({ id: 'nb_t' + n, title: 'N' + n, content: `<p>本文${n}</p><span class="nb-img-wrapper size-full" contenteditable="false"><img class="nb-embedded-img" src="${__mkImg('#' + (n * 111111 % 999999).toString().padStart(6, '0'))}"></span><p>a</p><img src="${__mkImg('#123456')}"><img src="${__mkImg('#654321')}">`, category: 'ライフログ', status: 'active', linkedNoteIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await saveNotebookData();
    const ds = getTodayKey(); journalData[ds] = [{ id: 'lg_t1', time: '09:00', text: 'p', category: 'ライフログ', images: [__mkImg('#a0a'), __mkImg('#0aa')] }]; await saveJournalData();
  });
  await sp.reload(); await sp.waitForFunction(() => document.body.classList.contains('ready')); await sleep(400);
  const contentBefore = await sp.evaluate(() => notebookData.map(n => n.content.length).join(','));

  // 連打の最後の選択が反映され、描き直しは1回
  const final = await sp.evaluate(async () => {
    let renders = 0; const o = window.renderNotebookCarousel, o2 = window.renderPhotoJournalCarousel, o3 = window.renderDayCarousel;
    window.renderNotebookCarousel = function () { renders++; return o.apply(this, arguments); };
    window.renderPhotoJournalCarousel = function () { renders++; return o2.apply(this, arguments); };
    window.renderDayCarousel = function () { renders++; return o3.apply(this, arguments); };
    const seq = ['photo', 'grid', 'day', 'card', 'photo', 'grid', 'week', 'photo', 'grid'];
    for (const v of seq) { if (['grid', 'card'].includes(v)) selectNotebookViewFromModal(v); else selectScopeFromModal(v); await new Promise(r => setTimeout(r, 25)); }
    await new Promise(r => setTimeout(r, 400));
    window.renderNotebookCarousel = o; window.renderPhotoJournalCarousel = o2; window.renderDayCarousel = o3;
    return { scope: calendarScope, mode: notebookViewMode, renders, title: (document.querySelector('#journalCarouselContainer .date-title') || {}).textContent, lastScope: lastJournalScope };
  });
  check(final.scope === 'notebooks' && final.mode === 'grid' && final.title === 'Gallery View', '連打後は最後に選んだ Gallery が表示される ' + JSON.stringify(final));
  check(final.renders === 1, '連打中の描き直しは最後の1回だけ (' + final.renders + ')');
  check(final.lastScope === 'photo', 'ジャーナル側の最後のビュー（写真）は記憶されている');

  await sleep(2500);
  const g = await sp.evaluate(() => { const l = [...document.querySelectorAll('img[data-nbthumb]')].filter(i => i.naturalWidth > 1); return { n: l.length, maxW: Math.max(0, ...l.map(i => i.naturalWidth)), full: document.querySelectorAll('.notebook-grid-preview img[src^="data:image/jpeg"]:not([data-nbthumb])').length, perCard: Math.max(...[...document.querySelectorAll('.notebook-grid-preview')].map(p => p.querySelectorAll('img').length)) }; });
  check(g.n > 0 && g.maxW <= 480 && g.full === 0, 'Gallery のプレビュー画像は縮小版（最大480px）で、原寸の画像は展開しない ' + JSON.stringify(g));
  check(g.perCard <= 2, 'プレビューの画像は1冊あたり2枚まで');

  // 画面から外れた画像は手放す
  await sp.evaluate(() => selectScopeFromModal('photo')); await sleep(800);
  const inPhoto = await sp.evaluate(() => __loadedPx());
  await sp.evaluate(() => selectScopeFromModal('day')); await sleep(800);
  const d = await sp.evaluate(() => ({ px: __loadedPx(), thumbW: Math.max(0, ...[...document.querySelectorAll('.log-photo-thumb')].map(i => i.naturalWidth)) }));
  check(inPhoto >= 1400 * 1050 && d.px < 1400 * 1050 && d.thumbW > 1 && d.thumbW <= 240, '写真ビューを離れると原寸画像を手放し、日表示は縮小版 ' + JSON.stringify({ inPhoto, ...d }));

  // カードビュー（編集画面）は原寸の画像のまま、本文データも変わらない
  await sp.evaluate(() => { currentNotebookIndex = 0; selectNotebookViewFromModal('card'); }); await sleep(800);
  const card = await sp.evaluate(() => { const v = document.querySelector('.notebook-content-view img'); return v ? v.naturalWidth : 0; });
  check(card === 1400, 'カードビューのノート本文は原寸の画像を表示 (' + card + ')');
  await sp.evaluate(async () => { await saveNotebookData(); });
  check(await sp.evaluate(() => notebookData.map(n => n.content.length).join(',')) === contentBefore, 'ノート本文のデータは変更されない');
  // 写真ビューの拡大表示
  await sp.evaluate(() => selectScopeFromModal('photo')); await sleep(800);
  await sp.evaluate(() => openLightboxFromImg(document.querySelector('.photo-stage-full-img'))); await sleep(300);
  check(await sp.evaluate(() => document.getElementById('lightboxImg').naturalWidth === 1400), '写真の拡大表示は原寸');
  await sp.evaluate(() => closeLightbox());
  check(realErrors(sp).length === 0, 'ページエラーなし ' + JSON.stringify(realErrors(sp).slice(0, 3)));

  // ---------- 「軽量化」ボタンの表示 ----------
  const visible = p => p.evaluate(() => getComputedStyle(document.getElementById('supabaseMigrateBox')).display !== 'none');
  const s1 = new FakeServer();
  const a = await makeDevice(browser, base, s1, { name: 'A', init: helpers });
  await sleep(1500);
  check(!(await visible(a)), '画像が直接入った行がなければ「軽量化」は表示しない');
  check(await a.evaluate(() => getComputedStyle(document.getElementById('supabaseCleanupBox')).display !== 'none'), '「不要な画像の削除」は表示する');

  // 以前のバージョンで画像が直接入った行（ジャーナル・ノート）
  const img = await a.evaluate(() => __mkImg('#e11', 60, 40));
  s1.db.journals.set('2025-01-05', { date_str: '2025-01-05', user_id: 'user-1', tombstones: {}, updated_at: new Date(Date.now() - 86400000 * 300).toISOString(), log_data: [{ id: 'lg_old', time: '10:00', text: 'old-inline', category: 'ライフログ', images: [img], updatedAt: '2025-01-05T01:00:00.000Z' }] });
  s1.db.notebooks.set('nb_old', { id: 'nb_old', user_id: 'user-1', title: 'old', content: `<p>x<img src="${img}"></p>`, category: 'ライフログ', status: 'active', linked_note_ids: [], created_at: '2025-01-05T01:00:00.000Z', edited_at: '2025-01-05T01:00:00.000Z', deleted: false, updated_at: new Date(Date.now() - 86400000 * 300).toISOString() });
  // 既存の端末（差分取得のカーソルが進んでいて古い行は取り直さない）でも、最初の1回の全件確認で見つける
  await a.evaluate(async () => { localStorage.removeItem('daily_journal_cloud_inline_user-1'); _inlineStateCache = { key: null, st: null }; await _scanInlineImagesOnce(); });
  check(await visible(a), '既存の端末：古い行に画像が直接入っていれば「軽量化」を表示');
  // 手動の「軽量化」：クラウドにしかない古い行も含めて Storage 参照に置き換える
  await a.evaluate(() => { window.confirm = () => true; return migrateEmbeddedImagesToStorage(); }); await sleep(1500);
  const rowJ = JSON.stringify(s1.db.journals.get('2025-01-05').log_data), rowN = s1.db.notebooks.get('nb_old').content;
  check(!rowJ.includes('data:image') && rowJ.includes('SBIMG:') && !rowN.includes('data:image') && rowN.includes('SBIMG:'), '軽量化の実行で、クラウドの行の画像が Storage 参照に置き換わる');
  check(!(await visible(a)), '軽量化の後は表示が消える');
  check(await a.evaluate(() => Object.values(journalData).flat().some(l => l.text === 'old-inline') && notebookData.some(n => n.id === 'nb_old')), '古い行の記録・ノートは端末にも取り込まれる');

  // 自動：同期で画像が直接入った行を受け取った端末は、その場で Storage 参照に置き換えて送り直す
  s1.db.journals.set('2025-02-02', { date_str: '2025-02-02', user_id: 'user-1', tombstones: {}, updated_at: new Date().toISOString(), log_data: [{ id: 'lg_old2', time: '10:00', text: 'old-inline2', category: 'ライフログ', images: [img], updatedAt: '2025-02-02T01:00:00.000Z' }] });
  const b = await makeDevice(browser, base, s1, { name: 'B', init: helpers });
  await sleep(2500);
  const rowJ2 = JSON.stringify(s1.db.journals.get('2025-02-02').log_data);
  check(!rowJ2.includes('data:image') && rowJ2.includes('SBIMG:'), '同期するだけで、画像が直接入った行は自動で Storage 参照に置き換わる');
  check(!(await visible(b)) && !(await visible(a)), '自動で直った後は、どの端末でも「軽量化」は表示されない');
  check(await b.evaluate(() => getPendingCount()) === 0, '未送信0');
  const errs = [a, b].flatMap(realErrors).filter(e => !/alert/.test(e));
  check(errs.length === 0, 'ページエラーなし ' + JSON.stringify(errs.slice(0, 3)));

  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
