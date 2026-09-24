// 後日記入（過去の日への書き足し・日時の変更）
const { serve, FakeServer, makeDevice, launchBrowser } = require('./harness');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function check(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }
const realErrors = p => p.errors.filter(e => !/404 \(Not Found\)/.test(e));
(async () => {
  const srv = await serve(); const base = 'http://localhost:' + srv.address().port;
  const browser = await launchBrowser();
  const server = new FakeServer();
  const d1 = await makeDevice(browser, base, server, { name: 'D1', viewport: { width: 390, height: 844 } });
  const d2 = await makeDevice(browser, base, server, { name: 'D2' });
  await sleep(1000);
  const keys = await d1.evaluate(() => { const k = n => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }; return { today: k(0), d2: k(2), d5: k(5), tomorrow: k(-1) }; });

  // 1. 普通の追記：印なし・記入日時あり
  const n = await d1.evaluate(async () => { openAddModal(); document.getElementById('journalInputText').value = 'normal-now'; await saveNewLog(); return Object.values(journalData).flat().find(l => l.text === 'normal-now'); });
  check(!n.backdated && n.writtenAt && Math.abs(Date.parse(n.writtenAt) - Date.now()) < 60000, '普通の追記は印なし、実際の記入日時を記録');

  // 2. 過去の日に書き足す
  const a = await d1.evaluate(async (k) => {
    openAddModal();
    document.getElementById('addSlotDate').value = k.d2; document.getElementById('addSlotTime').value = '19:30'; changeAddSlot();
    const hint = document.getElementById('addSlotHint').textContent; const badge = document.getElementById('modalTargetDateBadge').textContent;
    document.getElementById('journalInputText').value = 'late-add'; await saveNewLog();
    const log = (journalData[k.d2] || []).find(l => l.text === 'late-add');
    return { hint, badge, log, active: activeDateKey };
  }, keys);
  check(/後日記入/.test(a.hint) && !/今日/.test(a.badge), '日付を選ぶと「後日記入として保存されます」と表示');
  check(a.log && a.log.time === '19:30' && a.log.backdated === true && Math.abs(Date.parse(a.log.writtenAt) - Date.now()) < 60000, '選んだ日・時刻に入り、後日記入の印と実際の記入日時が付く');
  await sleep(300);
  check(await d1.evaluate(() => activeDateKey) === keys.d2, '保存後はその日を表示');
  const card = await d1.evaluate(() => { const li = [...document.querySelectorAll('.log-item')].find(e => e.textContent.includes('late-add')); return li ? { cls: li.className, mark: (li.querySelector('.late-mark') || {}).textContent, corner: getComputedStyle(li, '::after').content } : null; });
  check(card && /is-backdated/.test(card.cls) && card.mark === '✎ 後日記入' && card.corner !== 'none', 'カードに角の折り返しと「✎ 後日記入」');
  const normalCard = await d1.evaluate(() => { const li = [...document.querySelectorAll('.log-item')].find(e => e.textContent.includes('normal-now')); return !li || (!li.querySelector('.late-mark') && !/is-backdated/.test(li.className)); });
  check(normalCard, '普通の記録には印なし');
  const tip = await d1.evaluate(() => { const b = [...document.querySelectorAll('.late-mark')][0]; b.click(); const t = document.querySelector('.late-tip'); return t ? t.textContent : null; });
  check(tip && /に記入（2日後）/.test(tip), 'マークをタップすると実際の記入日時を表示: ' + tip);
  await d1.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  check(await d1.evaluate(() => !document.querySelector('.late-tip')), 'ほかをタップすると消える');

  // 3. 未来の日時は選べない
  const f = await d1.evaluate((k) => { openAddModal(); document.getElementById('addSlotDate').value = k.tomorrow; document.getElementById('addSlotTime').value = '23:59'; changeAddSlot(); const r = { date: document.getElementById('addSlotDate').value, late: _addSlot }; closeModal('addModal'); return r; }, keys);
  check(f.date === keys.today && f.late === null, '未来の日付を選ぶと「いま」に戻る');

  // 4. 以前からの記録（記入日時なし）の時刻を変える
  await d1.evaluate(async (k) => { journalData[k.d5] = [{ id: 'lg_legacy1', time: '08:00', text: 'legacy', category: 'ライフログ', images: [] }]; await saveJournalData(); }, keys);
  const e = await d1.evaluate(async (k) => {
    openEditModal(k.d5, 'lg_legacy1');
    const hint0 = document.getElementById('editSlotHint').style.display;
    document.getElementById('editSlotTime').value = '07:15'; changeEditSlot();
    const hint1 = document.getElementById('editSlotHint').textContent;
    await saveEditedLog();
    return { hint0, hint1, log: journalData[k.d5].find(l => l.id === 'lg_legacy1') };
  }, keys);
  check(e.hint0 === 'none' && /外せません/.test(e.hint1), '編集で日時を変えると「印が付きます（外せません）」と表示');
  check(e.log.time === '07:15' && e.log.backdated === true && e.log.writtenAt === await d1.evaluate((k) => slotToIso(k.d5, '08:00'), keys), '時刻の変更で印が付き、元の日時が「実際の記入日時」として残る');

  // 5. 元の時刻に戻しても印は外れない
  const back = await d1.evaluate(async (k) => { openEditModal(k.d5, 'lg_legacy1'); const h = document.getElementById('editSlotHint').textContent; document.getElementById('editSlotTime').value = '08:00'; changeEditSlot(); await saveEditedLog(); return { h, log: journalData[k.d5].find(l => l.id === 'lg_legacy1') }; }, keys);
  check(back.log.time === '08:00' && back.log.backdated === true && /後日記入の記録です/.test(back.h), '元の時刻に戻しても印は外れない');

  // 6. 日付を移動（他の端末で重複しない）
  await sleep(2000);
  check(await d2.evaluate((k) => (journalData[k.d5] || []).some(l => l.id === 'lg_legacy1' && l.backdated), keys), '他の端末にも印つきで届く');
  await d1.evaluate(async (k) => { openEditModal(k.d5, 'lg_legacy1'); document.getElementById('editSlotDate').value = k.d2; changeEditSlot(); await saveEditedLog(); }, keys);
  await sleep(2500);
  const mv = await d2.evaluate((k) => ({ old: (journalData[k.d5] || []).filter(l => l.id === 'lg_legacy1').length, nw: (journalData[k.d2] || []).filter(l => l.id === 'lg_legacy1').length }), keys);
  const mv1 = await d1.evaluate((k) => ({ old: (journalData[k.d5] || []).length, nw: (journalData[k.d2] || []).filter(l => l.id === 'lg_legacy1').length, active: activeDateKey }), keys);
  check(mv1.old === 0 && mv1.nw === 1 && mv1.active === keys.d2, '日付を変えると記録はその日へ移動し、表示も移る');
  check(mv.old === 0 && mv.nw === 1, '他の端末でも移動先だけにあり、元の日に重複しない');
  await d2.evaluate(() => forceSyncNow()); await sleep(500);
  check(await d2.evaluate((k) => !(journalData[k.d5] || []).some(l => l.id === 'lg_legacy1'), keys), '全件同期しても元の日に復活しない');

  // 7. カレンダー：後日記入だけの日は白抜き
  const cal = await d1.evaluate((k) => { calendarScope = 'day'; activeDateKey = k.d2; renderMiniCalendar(); const cells = [...document.querySelectorAll('#miniCalGrid .mini-cal-day')]; const c = cells.find(b => b.textContent === String(parseInt(k.d2.slice(8), 10))); const t = cells.find(b => b.textContent === String(parseInt(k.today.slice(8), 10))); return { late: c && c.className, today: t && t.className }; }, keys);
  check(/late-only/.test(cal.late || 'late-only') && !/late-only/.test(cal.today || ''), 'カレンダー：後日記入だけの日は点が白抜き（その場で書いた日は通常） ' + JSON.stringify(cal));

  // 8. 写真ビューにも印
  await d1.evaluate(async (k) => { const c = document.createElement('canvas'); c.width = 50; c.height = 40; c.getContext('2d').fillRect(0, 0, 20, 20); const log = journalData[k.d2].find(l => l.text === 'late-add'); log.images = [c.toDataURL('image/jpeg')]; await saveJournalData(); selectScopeFromModal('photo'); }, keys);
  await sleep(600);
  check(await d1.evaluate(() => !!document.querySelector('.journal-drawer-header .late-mark')), '写真ビューにも「✎ 後日記入」');
  const errs = [d1, d2].flatMap(realErrors);
  check(errs.length === 0, 'ページエラーなし ' + JSON.stringify(errs.slice(0, 3)));
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
