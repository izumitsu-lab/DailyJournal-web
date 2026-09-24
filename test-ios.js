// iPhone 対策：閉じた画面を完全に隠す／ログイン後にパスワードを残さない／版の表示
const { serve, FakeServer, makeDevice, launchBrowser } = require('./harness');
const fs = require('fs'); const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function check(c, m) { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; }
(async () => {
  const srv = await serve(); const base = 'http://localhost:' + srv.address().port;
  const browser = await launchBrowser();
  const p = await makeDevice(browser, base, new FakeServer(), { name: 'P', viewport: { width: 390, height: 844 } });
  await sleep(800);

  // A. 閉じている画面はすべて visibility: hidden（ぼかしの層を作らない）
  const layers = () => p.evaluate(() => [...document.querySelectorAll('.modal-overlay, .lightbox-overlay')].map(el => ({ id: el.id, vis: getComputedStyle(el).visibility, active: el.classList.contains('active') })));
  const L0 = await layers();
  check(L0.length >= 14 && L0.every(l => l.vis === 'hidden'), `閉じている画面 ${L0.length} 枚はすべて非表示（ぼかしの層なし）`);
  await p.evaluate(() => openAddModal()); await sleep(250);
  const add = await p.evaluate(() => ({ vis: getComputedStyle(document.getElementById('addModal')).visibility, focus: document.activeElement && document.activeElement.id }));
  check(add.vis === 'visible' && add.focus === 'journalInputText', '開いた画面は表示され、入力欄にカーソルが入る');
  await p.evaluate(() => closeModal('addModal')); await sleep(100);
  const mid = await p.evaluate(() => { const s = getComputedStyle(document.getElementById('addModal')); return { vis: s.visibility, op: parseFloat(s.opacity) }; });
  await sleep(400);
  const after = await p.evaluate(() => getComputedStyle(document.getElementById('addModal')).visibility);
  check(mid.vis === 'visible' && after === 'hidden', '閉じるときはフェードアウトしてから非表示に（見た目の動きは変わらない）');
  // 連打してもすべて閉じれば非表示に戻る
  await p.evaluate(async () => { for (let i = 0; i < 12; i++) { openViewScopeModal(); selectScopeFromModal(['day', 'photo', 'week'][i % 3]); await new Promise(r => setTimeout(r, 30)); } });
  await sleep(700);
  check((await layers()).every(l => l.vis === 'hidden'), '表示ビューを連打した後も、閉じた画面はすべて非表示');
  // 写真の拡大表示
  await p.evaluate(() => openLightbox('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')); await sleep(100);
  const lb1 = await p.evaluate(() => getComputedStyle(document.getElementById('lightboxModal')).visibility);
  await p.evaluate(() => closeLightbox()); await sleep(400);
  check(lb1 === 'visible' && await p.evaluate(() => getComputedStyle(document.getElementById('lightboxModal')).visibility) === 'hidden', '写真の拡大表示も閉じると非表示');

  // タッチ端末ではぼかしを弱める
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const tp = await ctx.newPage(); await ctx.route('https://**', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
  await tp.goto(base + '/index.html'); await tp.waitForFunction(() => document.body.classList.contains('ready'));
  const blur = await tp.evaluate(() => { const s = getComputedStyle(document.getElementById('addModal')); return s.backdropFilter || s.webkitBackdropFilter; });
  check(/12px/.test(blur), 'iPhone などタッチ端末ではぼかしを 12px に ' + blur);
  const blurPc = await p.evaluate(() => { const s = getComputedStyle(document.getElementById('addModal')); return s.backdropFilter || s.webkitBackdropFilter; });
  check(/24px/.test(blurPc), 'マウスの端末は今までどおり 24px');
  await ctx.close();

  // B. ログイン後はパスワードを残さない
  const B = await p.evaluate(async () => {
    const form = document.getElementById('supabaseLoginForm');
    const r = { loggedInHidden: getComputedStyle(form).display === 'none', pw: document.getElementById('supabasePassword').value };
    await signOutSupabase(); await new Promise(r => setTimeout(r, 200));
    r.loggedOutShown = getComputedStyle(form).display !== 'none';
    document.getElementById('supabaseEmail').value = 't@example.com'; document.getElementById('supabasePassword').value = 'secret-pass';
    await signInSupabase(); await new Promise(r => setTimeout(r, 300));
    r.afterLoginPw = document.getElementById('supabasePassword').value;
    r.afterLoginHidden = getComputedStyle(form).display === 'none';
    return r;
  });
  check(B.loggedInHidden && B.pw === '', 'ログイン中はログイン欄を隠し、パスワード欄は空');
  check(B.loggedOutShown, 'ログアウトするとログイン欄が表示される');
  check(B.afterLoginPw === '' && B.afterLoginHidden, 'ログインすると、入力したパスワードは入力欄から消える');

  // C. 版の表示
  const ver = await p.evaluate(() => ({ app: APP_VERSION, html: window.APP_HTML_VERSION, label: document.getElementById('appVersionLabel').textContent }));
  check(ver.app === ver.html && ver.label.includes(ver.app) && !/古い/.test(ver.label), '設定画面に版を表示: ' + ver.label);
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const qs = [...html.matchAll(/(?:src|href)="(?:purify\.min|main|calendar|notebooks|ui|supabase-sync)\.js\?v=([^"]+)"|href="style\.css\?v=([^"]+)"/g)].map(m => m[1] || m[2]);
  check(qs.length === 7 && qs.every(v => v === ver.app), '読み込むファイルすべてに同じ版（?v=）が付いている');
  const mis = await p.evaluate(() => { window.APP_HTML_VERSION = 'old'; applyAppVersionLabel(); const t = document.getElementById('appVersionLabel').textContent; window.APP_HTML_VERSION = APP_VERSION; applyAppVersionLabel(); return t; });
  check(/古いファイル/.test(mis), '版が食い違うと「古いファイルが残っています」と表示');
  const errs = p.errors.filter(e => !/404/.test(e) && !/alert/.test(e));
  check(errs.length === 0, 'ページエラーなし ' + JSON.stringify(errs.slice(0, 3)));
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
