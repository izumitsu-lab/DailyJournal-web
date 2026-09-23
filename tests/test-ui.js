const { chromium } = require('playwright');
const { serve, FakeServer, makeDevice, launchBrowser } = require('./harness');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function check(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; }
const realErrors = p => p.errors.filter(e => !/404 \(Not Found\)/.test(e));

(async () => {
  const srv = await serve(); const base = 'http://localhost:' + srv.address().port;
  const browser = await launchBrowser();
  const server = new FakeServer();

  // ---------- XSS ----------
  const evil = '<p>ok</p><img src="x" onerror="window.__xss=1"><div onclick="window.__xss=2">c</div><script>window.__xss=3<\/script><a href="javascript:window.__xss=4">l</a>'
    + '<span class="nb-img-wrapper size-half" contenteditable="false"><img class="nb-embedded-img" src="data:image/png;base64,iVBORw0KGgo="><div class="nb-img-controls" onclick="event.stopPropagation()"><button type="button" class="nb-img-btn" onclick="setNotebookImageSize(this, \'size-full\', \'nb_evil\')">1/1</button><button onclick="setNotebookImageSize(this, \'size-full\', \'x\');window.__xss=5">bad</button></div></span>';
  server.db.notebooks.set('nb_evil', { id: 'nb_evil', user_id: 'user-1', title: 'evil', content: evil, category: 'ライフログ', status: 'active', linked_note_ids: [], created_at: new Date().toISOString(), edited_at: new Date().toISOString(), deleted: false, updated_at: new Date().toISOString() });
  server.db.journals.set('2026-09-01', { date_str: '2026-09-01', user_id: 'user-1', tombstones: {}, updated_at: new Date().toISOString(),
    log_data: [{ id: "x');window.__xss=6;('", time: '10:00', text: '<img src=x onerror="window.__xss=7">', category: 'ライフログ', images: ['x" onerror="window.__xss=8'] }] });
  const d = await makeDevice(browser, base, server, { name: 'XSS' });
  await sleep(1500);
  const storedAtIngest = await d.evaluate(() => notebookData.find(n => n.id === 'nb_evil').content);
  await d.evaluate(() => { calendarScope = 'notebooks'; notebookViewMode = 'grid'; renderRightCards(); });
  await sleep(300);
  await d.evaluate(() => { notebookViewMode = 'card'; renderRightCards(); });
  await sleep(300);
  await d.evaluate(() => { calendarScope = 'day'; activeDateKey = '2026-09-01'; if (!dateList.includes('2026-09-01')) { dateList.push('2026-09-01'); dateList.sort(); } renderRightCards(); });
  await sleep(300);
  await d.evaluate(() => { calendarScope = 'photo'; renderRightCards(); });
  await sleep(300);
  // クリック系の攻撃が仕込まれた要素をクリック
  await d.evaluate(() => { calendarScope = 'notebooks'; notebookViewMode = 'card'; renderRightCards(); });
  await sleep(200);
  await d.evaluate(() => document.querySelectorAll('.notebook-content-view div, .notebook-content-view a, .notebook-content-view button').forEach(el => { try { el.click(); } catch (e) {} }));
  await sleep(200);
  check(await d.evaluate(() => window.__xss === undefined), 'クラウド経由の悪意あるHTML・ID・画像値でスクリプトが実行されない (__xss=' + await d.evaluate(() => window.__xss) + ')');
  const stored = await d.evaluate(() => notebookData.find(n => n.id === 'nb_evil').content);
  check(!/onerror|<script|javascript:|__xss=5/.test(stored), '取り込み時にノート本文がサニタイズされた');
  check(storedAtIngest.includes("onclick=\"setNotebookImageSize(this, 'size-full', 'nb_evil')\"") && storedAtIngest.includes('contenteditable="false"') && !/onerror|__xss/.test(storedAtIngest), 'アプリ自身の画像サイズ切替ハンドラは保持');
  check(await d.evaluate(() => Object.values(journalData).flat().every(l => /^[A-Za-z0-9_-]+$/.test(l.id) && l.images.length === 0)), '不正なIDは付け直し、不正な画像値は破棄');

  // ペースト
  await d.evaluate(() => { calendarScope = 'notebooks'; notebookViewMode = 'card'; currentNotebookIndex = 0; renderRightCards(); });
  await sleep(300);
  const nid = await d.evaluate(() => getFilteredNotebooks()[0].id);
  await d.evaluate((id) => enableNotebookEdit(id, 'content'), nid);
  await d.evaluate((id) => {
    const area = document.getElementById('nb_content_view_' + id); area.focus();
    const r = document.createRange(); r.selectNodeContents(area); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    const dt = new DataTransfer();
    dt.setData('text/html', '<table><tr><td>a<img src=x onerror="window.__xss=9"></td></tr></table><blockquote onmouseover="window.__xss=10">q</blockquote>');
    dt.setData('text/plain', 'a');
    area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, nid);
  await sleep(400);
  check(await d.evaluate(() => window.__xss === undefined), 'ペーストしたHTMLのイベントハンドラが実行されない');
  check(await d.evaluate((id) => { const a = document.getElementById('nb_content_view_' + id); return !!a.querySelector('table') && !a.innerHTML.includes('onerror') && !a.innerHTML.includes('onmouseover'); }, nid), 'ペーストの表は残り、ハンドラは除去');
  await d.evaluate((id) => saveNotebookEdit(id), nid);

  // タイプ名に記号を含めても設定画面が壊れない
  await d.evaluate(() => { addNewType(`a'b"c<i>x`); openModal('settingsModal'); switchSettingsTab('types'); });
  const idx = await d.evaluate(() => appTypes.indexOf(`a'b"c<i>x`));
  await d.click(`#typeActions_${idx} .edit-btn`);
  await d.fill(`#renameInput_${idx}`, `a'b"c<i>y`);
  await d.click(`#typeActions_${idx} .edit-btn`);
  check(await d.evaluate(() => appTypes.includes(`a'b"c<i>y`) && !appTypes.includes(`a'b"c<i>x`)), '記号入りタイプ名のリネームが正しく動作');
  await d.evaluate(() => closeModal('settingsModal'));
  check(realErrors(d).length === 0, 'XSSテスト中のページエラーなし ' + JSON.stringify(realErrors(d).slice(0, 4)));

  // ---------- サイドバー / CSS ----------
  const pc = await makeDevice(browser, base, new FakeServer(), { name: 'PC', configure: false });
  check(await pc.isVisible('#calendarSidebar'), 'PC: 左サイドバーが表示');
  await pc.click('#calendarSidebar .sidebar-close-btn');
  check(!(await pc.isVisible('#calendarSidebar')) && await pc.isVisible('#pcLeftSidebarReopen'), 'PC: 閉じると再表示タブが出る');
  await pc.click('#pcLeftSidebarReopen');
  check(await pc.isVisible('#calendarSidebar') && !(await pc.isVisible('#pcLeftSidebarReopen')), 'PC: タブから左サイドバーを再表示できる');
  await pc.evaluate(async () => { notebookData.unshift({ id: 'nb_a', title: 'A', content: '<p>a</p>', category: 'ライフログ', status: 'active', linkedNoteIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); await saveNotebookData(); selectNotebookViewFromModal('card'); });
  await sleep(400);
  check(await pc.isVisible('.connected-right-sidebar'), 'PC: カードビューで右サイドバー表示');
  await pc.click('.connected-side-close-btn');
  check(!(await pc.isVisible('.connected-right-sidebar')) && await pc.isVisible('#pcRightSidebarReopen'), 'PC: 右サイドバーを閉じると再表示タブが出る');
  await pc.click('#pcRightSidebarReopen');
  check(await pc.isVisible('.connected-right-sidebar'), 'PC: タブから右サイドバーを再表示できる');
  await pc.evaluate(() => selectNotebookViewFromModal('grid')); await sleep(300);
  await pc.click('#calendarSidebar .sidebar-close-btn');
  await pc.evaluate(() => selectNotebookViewFromModal('card')); await sleep(300);
  check(await pc.isVisible('#pcLeftSidebarReopen'), 'PC: ノートのカードビューでも左の再表示タブが出る');
  check(realErrors(pc).length === 0, 'PCテスト中のページエラーなし ' + JSON.stringify(realErrors(pc).slice(0, 4)));

  const sp = await makeDevice(browser, base, new FakeServer(), { name: 'SP', configure: false, viewport: { width: 390, height: 844 } });
  const pad = await sp.evaluate(() => getComputedStyle(document.body).paddingLeft);
  check(pad === '10px', 'スマホ: モバイル用CSSが適用 (body padding-left=' + pad + ', 修正前は16px)');
  check(!(await sp.isVisible('#pcLeftSidebarReopen')), 'スマホ: 再表示タブは出ない');
  

  // ---------- 旧形式データの移行 ----------
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await ctx.route('https://**', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
  await pg.goto(base + '/purify.min.js');
  await pg.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 20; c.height = 20; c.getContext('2d').fillRect(0, 0, 10, 10);
    const img = c.toDataURL('image/png');
    await new Promise((res, rej) => {
      const r = indexedDB.open('DailyJournalDB', 1);
      r.onupgradeneeded = e => e.target.result.createObjectStore('appData');
      r.onsuccess = () => { const db = r.result; const tx = db.transaction('appData', 'readwrite'); const s = tx.objectStore('appData');
        s.put({ '2026-09-20': [{ time: '10:00', text: 'old1', category: 'ライフログ', image: img }, { time: '11:00', text: 'old2', category: 'ライフログ', images: [img] }] }, 'journalData');
        s.put([{ id: 'nb_1', title: 'T', content: '<p>x<img src="' + img + '"></p>', category: 'ライフログ', status: 'active', linkedNoteIds: [] }], 'notebookData');
        tx.oncomplete = () => { db.close(); res(); }; tx.onerror = rej; };
      r.onerror = rej;
    });
  });
  await pg.goto(base + '/index.html');
  await pg.waitForFunction(() => document.body.classList.contains('ready'));
  const mig = await pg.evaluate(async () => {
    const db = await initDB();
    const get = (s, k) => new Promise(r => { const q = db.transaction(s).objectStore(s).get(k); q.onsuccess = () => r(q.result); });
    const keys = await new Promise(r => { const q = db.transaction('images').objectStore('images').getAllKeys(); q.onsuccess = () => r(q.result); });
    const j = await get('appData', 'journalData'); const n = await get('appData', 'notebookData');
    return { v: db.version, keys: keys.length, jInline: JSON.stringify(j).includes('data:image'), nInline: JSON.stringify(n).includes('data:image'),
      ids: j['2026-09-20'].map(l => l.id), memImgs: journalData['2026-09-20'].map(l => l.images[0].slice(0, 7)), noteImg: notebookData[0].content.includes('data:image/png') };
  });
  check(mig.v === 2 && mig.keys === 1 && !mig.jInline && !mig.nInline, '旧データ: 画像が別ストアへ移り(重複は1件に集約)、本体は参照のみ');
  check(mig.ids.every(id => id.startsWith('lg_')) && mig.memImgs.every(s => s === 'idbimg:') && mig.noteImg, '旧データ: 記録にIDが付き、画像は表示用に復元');
  await pg.reload(); await pg.waitForFunction(() => document.body.classList.contains('ready'));
  check(await pg.evaluate(() => JSON.stringify(journalData['2026-09-20'].map(l => l.id))) === JSON.stringify(mig.ids), '再読み込み後もIDが安定');
  check(errs.length === 0, '移行中のページエラーなし ' + JSON.stringify(errs));

  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
