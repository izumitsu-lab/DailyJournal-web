const { chromium } = require('playwright');
const { serve, FakeServer, makeDevice, launchBrowser } = require('./harness');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function check(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; }
const realErrors = p => p.errors.filter(e => !/404 \(Not Found\)/.test(e));
const mkNote = (id, title, content = '<p>本文</p>') => ({ id, title, content, category: 'ライフログ', status: 'active', linkedNoteIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

(async () => {
  const srv = await serve(); const base = 'http://localhost:' + srv.address().port;
  const browser = await launchBrowser();

  // ---------- 小さな不具合 ----------
  const a = await makeDevice(browser, base, new FakeServer(), { name: 'A', configure: false });
  // (1) 既存の空ノートはキャンセルしても消えない／＋で作った新規はキャンセルで消える
  await a.evaluate(async (n) => { notebookData.unshift(n); await saveNotebookData(); selectNotebookViewFromModal('card'); }, mkNote('nb_empty', '', ''));
  await sleep(400);
  await a.evaluate(async () => { currentNotebookIndex = getFilteredNotebooks().findIndex(n => n.id === 'nb_empty'); enableNotebookEdit('nb_empty'); await cancelNotebookEdit('nb_empty'); });
  check(await a.evaluate(() => notebookData.some(n => n.id === 'nb_empty')), '既存の空ノートはキャンセルで消えない');
  const before = await a.evaluate(() => notebookData.length);
  await a.evaluate(() => openAddNotebookModal()); await sleep(500);
  const newId = await a.evaluate(() => currentActiveEditorNotebookId);
  await a.evaluate((id) => cancelNotebookEdit(id), newId);
  check(await a.evaluate((b) => notebookData.length === b, before), '＋で作った新規ノートはキャンセルで消える');
  // (2) 月表示：空カードスキップ＋記録なし
  await a.evaluate(() => { hideEmptyCards = true; journalData = {}; calendarScope = 'month'; renderRightCards(); });
  check(await a.evaluate(() => document.querySelectorAll('#journalCarouselContainer .card-carousel-panel').length === 1 && typeof window.wToR === 'undefined'), '月表示：記録がなくても1枚表示、暗黙のグローバル変数なし');
  await a.evaluate(() => { hideEmptyCards = false; calendarScope = 'day'; renderRightCards(); });
  // (3) Ctrl/Cmd 判定
  const ctrlOk = await a.evaluate(() => { let called = false; const orig = window.undoNotebookEdit; window.undoNotebookEdit = () => { called = true; };
    const ev = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, metaKey: true, cancelable: true }); handleNotebookKeyDown(ev, 'x'); window.undoNotebookEdit = orig; return called; });
  check(ctrlOk, 'Ctrl/Cmd+Z がイベント引数から判定される');
  // (4) 削除したタイプが復活しない
  await a.evaluate(() => { window.confirm = () => true; deleteType('研究管理'); });
  await a.reload(); await a.waitForFunction(() => document.body.classList.contains('ready'));
  check(await a.evaluate(() => !appTypes.includes('研究管理')), '削除したタイプ「研究管理」が再起動後も復活しない');
  // (6) バックアップ書き出し（Blob・画像込み）
  await a.evaluate(async () => { const c = document.createElement('canvas'); c.width = 30; c.height = 30; c.getContext('2d').fillRect(0, 0, 9, 9);
    openAddModal(); document.getElementById('journalInputText').value = 'photo'; currentAddPhotos = [c.toDataURL('image/jpeg')]; await saveNewLog(); });
  const [dl] = await Promise.all([a.waitForEvent('download'), a.evaluate(() => exportData())]);
  const json = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  const logs = Object.values(json.journalData).flat();
  check(dl.url().startsWith('blob:') && logs.some(l => l.text === 'photo' && l.images[0].startsWith('data:image/jpeg')), 'バックアップはBlobで書き出され、画像はBase64で含まれる');
  check(realErrors(a).length === 0, 'ページエラーなし ' + JSON.stringify(realErrors(a).slice(0, 3)));

  // ---------- (13) カードビューの描画削減 ----------
  const c = await makeDevice(browser, base, new FakeServer(), { name: 'C', configure: false });
  await c.evaluate(async (notes) => { notes.forEach(n => notebookData.push(n)); await saveNotebookData(); currentNotebookIndex = 0; selectNotebookViewFromModal('card'); },
    Array.from({ length: 20 }, (_, i) => mkNote('nb_c' + i, 'N' + i, '<p>本文' + i + '</p>')));
  await sleep(500);
  const cnt = await c.evaluate(() => document.querySelectorAll('.notebook-content-view').length);
  check(cnt <= 5, `20冊中、本文を描画したのは ${cnt} 冊（表示中の前後のみ）`);
  await c.evaluate(() => { const sc = document.getElementById('connectedCenterScroller'); sc.scrollLeft = sc.clientWidth * 10; });
  await sleep(400);
  check(await c.evaluate(() => { const id = getFilteredNotebooks()[10].id; return !!document.getElementById('nb_content_view_' + id); }), 'スクロール先のノート本文が描画される');
  check(realErrors(c).length === 0, 'ページエラーなし ' + JSON.stringify(realErrors(c).slice(0, 3)));

  // ---------- (5) 編集中の競合 ----------
  const server = new FakeServer();
  const d1 = await makeDevice(browser, base, server, { name: 'D1' });
  const d2 = await makeDevice(browser, base, server, { name: 'D2' });
  await sleep(1000);
  await d1.evaluate(async (n) => { notebookData.unshift(n); await saveNotebookData(); }, mkNote('nb_x', '共有ノート', '<p>元の本文</p>'));
  await sleep(1800);
  check(await d2.evaluate(() => notebookData.some(n => n.id === 'nb_x')), '前提：D2にノートが届いている');
  // D1が編集開始し、途中で自動保存（自分のエコーで競合扱いしない）
  await d1.evaluate(() => { calendarScope = 'notebooks'; notebookViewMode = 'card'; currentNotebookIndex = getFilteredNotebooks().findIndex(n => n.id === 'nb_x'); renderRightCards(); });
  await sleep(300);
  await d1.evaluate(async () => { enableNotebookEdit('nb_x'); document.getElementById('nb_content_view_nb_x').innerHTML = '<p>D1が編集中</p>'; await saveNotebookContentDirect('nb_x'); });
  await sleep(1800);
  check(await d1.evaluate(() => !notebookData.some(n => /他の端末の版/.test(n.title))), '自分の自動保存のエコーでは競合コピーを作らない');
  // D2が同じノートを更新
  await d2.evaluate(async () => { const n = notebookData.find(x => x.id === 'nb_x'); n.content = '<p>D2の変更</p>'; await saveNotebookData(); });
  await sleep(2000);
  const st = await d1.evaluate(() => ({ editor: document.getElementById('nb_content_view_nb_x').innerHTML, copy: notebookData.find(n => /他の端末の版/.test(n.title)), toast: (document.getElementById('appToastBox') || {}).textContent || '' }));
  check(st.editor.includes('D1が編集中'), 'D1の編集画面は上書きされない');
  check(st.copy && st.copy.content.includes('D2の変更'), 'D2の版は「（他の端末の版）」として別ノートに保存される');
  check(st.toast.includes('他の端末で更新'), 'D1にお知らせが表示される');
  await d1.evaluate(() => saveNotebookEdit('nb_x'));
  await sleep(2200);
  const srvNote = server.db.notebooks.get('nb_x');
  check(srvNote.content.includes('D1が編集中'), 'D1の保存がサーバーに反映');
  check(await d2.evaluate(() => { const n = notebookData.find(x => x.id === 'nb_x'); return n.content.includes('D1が編集中') && notebookData.some(x => /他の端末の版/.test(x.title) && x.content.includes('D2の変更')); }), 'D2にもD1の版と競合コピーの両方が届く（どちらの変更も失われない）');
  // 編集中に他端末で削除 → キャンセルで削除を受け入れる
  await d1.evaluate(() => { calendarScope = 'notebooks'; notebookViewMode = 'card'; currentNotebookIndex = getFilteredNotebooks().findIndex(n => n.id === 'nb_x'); renderRightCards(); });
  await sleep(300);
  await d1.evaluate(() => enableNotebookEdit('nb_x'));
  await d2.evaluate(async () => { notebookData = notebookData.filter(n => n.id !== 'nb_x'); await saveNotebookData(); });
  await sleep(2000);
  check(await d1.evaluate(() => notebookData.some(n => n.id === 'nb_x')), '編集中は削除を即座に反映しない');
  await d1.evaluate(() => cancelNotebookEdit('nb_x'));
  await sleep(1800);
  check(await d1.evaluate(() => !notebookData.some(n => n.id === 'nb_x')) && server.db.notebooks.get('nb_x').deleted === true, 'キャンセルすると削除を受け入れ、復活しない');
  await d1.evaluate(() => forceSyncNow()); await sleep(300);
  check(await d1.evaluate(() => !notebookData.some(n => n.id === 'nb_x')), '全件同期後も復活しない');
  const errs = [d1, d2].flatMap(realErrors);
  check(errs.length === 0, 'ページエラーなし ' + JSON.stringify(errs.slice(0, 3)));

  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
