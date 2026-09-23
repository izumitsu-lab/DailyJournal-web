const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const APP = path.join(__dirname, '..');
const NM = path.join(__dirname, 'node_modules');

function serve() {
  return new Promise(r => {
    const srv = http.createServer((req, res) => {
      const p = path.join(APP, decodeURIComponent(req.url.split('?')[0]));
      if (!p.startsWith(APP) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      const ext = path.extname(p);
      res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    }).listen(0, () => r(srv));
  });
}

// PostgREST が timestamptz を返す形式を再現（"…+00:00"、小数部の末尾0は省略）
function pgTs(v) {
  if (!v) return v; const t = Date.parse(v); if (isNaN(t)) return v;
  let iso = new Date(t).toISOString().replace('Z', '');
  iso = iso.replace(/\.?0+$/, '').replace(/\.$/, '');
  return iso + '+00:00';
}
function pgRow(r) { const o = JSON.parse(JSON.stringify(r)); for (const c of ['updated_at', 'created_at', 'edited_at']) if (o[c]) o[c] = pgTs(o[c]); return o; }
class FakeServer {
  constructor(){ this.db = { journals: new Map(), notebooks: new Map(), app_settings: new Map() }; this.images = new Map(); this.imageMeta = new Map(); this.pages = []; this.last = 0; this.schemaOutdated = false; this.log = []; }
  now(){ let t = Date.now(); if (t <= this.last) t = this.last + 1; this.last = t; return new Date(t).toISOString().replace('Z', '+00:00'); }
  key(t, r){ return t === 'journals' ? r.date_str : t === 'notebooks' ? r.id : r.user_id; }
  handle(op, fromPage){
    this.log.push(op.kind + ':' + (op.table || op.path));
    if (op.kind === 'upload') { if (this.images.has(op.path)) return { data: null, error: { message: 'The resource already exists', statusCode: '409' } }; this.images.set(op.path, op.data); this.imageMeta.set(op.path, { created_at: new Date().toISOString() }); return { data: { path: op.path }, error: null }; }
    if (op.kind === 'list') {
      const pre = op.folder + '/';
      const all = [...this.images.keys()].filter(k => k.startsWith(pre)).sort().map(k => ({ id: 'obj-' + k, name: k.slice(pre.length), created_at: (this.imageMeta.get(k) || {}).created_at, updated_at: (this.imageMeta.get(k) || {}).created_at, metadata: { size: this.images.get(k).length } }));
      const off = op.opts.offset || 0, lim = op.opts.limit || 100;
      return { data: all.slice(off, off + lim), error: null };
    }
    if (op.kind === 'remove') { for (const p of op.paths) { this.images.delete(p); this.imageMeta.delete(p); } this.log.push('removed:' + op.paths.length); return { data: [], error: null }; }
    if (op.kind === 'sign') { const d = this.images.get(op.path); return d ? { data: { signedUrl: d }, error: null } : { data: null, error: { message: 'Object not found' } }; }
    const t = op.table; const store = this.db[t];
    if (this.schemaOutdated && op.kind === 'select' && /tombstones|deleted/.test(op.cols || '')) return { data: null, error: { message: 'column journals.tombstones does not exist', code: '42703' } };
    if (op.kind === 'upsert') {
      const rows = [];
      for (const p of op.payload) {
        const k = this.key(t, p); const ex = store.get(k) || {};
        const def = t === 'journals' ? { tombstones: {} } : t === 'notebooks' ? { deleted: false, edited_at: null } : {};
        const row = Object.assign({}, def, ex, JSON.parse(JSON.stringify(p)), { updated_at: this.now() });
        store.set(k, row); rows.push(row);
      }
      setTimeout(() => { for (const pg of this.pages) for (const row of rows) pg.evaluate(([tt, rr]) => window.__rt && window.__rt(tt, rr), [t, pgRow(row)]).catch(() => {}); }, 30);
      return { data: null, error: null };
    }
    if (op.kind === 'update') {
      const rows = [];
      for (const r of store.values()) {
        if (op.filters.every(([f, c, v]) => f === 'eq' ? r[c] === v : true)) { Object.assign(r, JSON.parse(JSON.stringify(op.payload)), { updated_at: this.now() }); rows.push(r); }
      }
      setTimeout(() => { for (const pg of this.pages) for (const row of rows) pg.evaluate(([tt, rr]) => window.__rt && window.__rt(tt, rr), [t, pgRow(row)]).catch(() => {}); }, 30);
      return { data: null, error: null };
    }
    let rows = [...store.values()];
    for (const [f, c, v] of op.filters) {
      if (f === 'eq') rows = rows.filter(r => r[c] === v);
      if (f === 'in') rows = rows.filter(r => v.includes(r[c]));
      if (f === 'gte') rows = rows.filter(r => Date.parse(r[c]) >= Date.parse(v));
    }
    if (op.order) rows.sort((a, b) => (a[op.order[0]] < b[op.order[0]] ? -1 : 1) * (op.order[1] ? 1 : -1));
    if (op.range) rows = rows.slice(op.range[0], op.range[1] + 1);
    if (op.limit) rows = rows.slice(0, op.limit);
    rows = rows.map(pgRow);
    return { data: op.single ? (rows[0] || null) : rows, error: null };
  }
}

async function makeDevice(browser, base, server, { name, viewport = { width: 1280, height: 800 }, configure = true, init } = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.exposeBinding('__sb', (src, op) => JSON.stringify(server.handle(JSON.parse(op))));
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(__dirname, 'fake-supabase.js'), 'utf8') }));
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/**', r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(NM, 'jszip/dist/jszip.min.js'), 'utf8') }));
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/Sortable/**', r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(NM, 'sortablejs/Sortable.min.js'), 'utf8') }));
  if (configure) await ctx.addInitScript(() => { if (!localStorage.getItem('daily_journal_supabase_url')) { localStorage.setItem('daily_journal_supabase_url', 'https://fake.supabase.co'); localStorage.setItem('daily_journal_supabase_key', 'anon'); } });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(name + ' pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(name + ' console.error: ' + m.text()); });
  page.on('dialog', d => { page.lastDialog = d.message(); d.accept(); });
  server.pages.push(page);
  await page.goto(base + '/index.html');
  await page.waitForFunction(() => document.body.classList.contains('ready'));
  page.ctx = ctx;
  return page;
}

// CHROMIUM_PATH を指定すると、その Chromium を使う（未指定なら Playwright 標準のブラウザ）
function launchBrowser() {
  return chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
}

module.exports = { serve, FakeServer, makeDevice, launchBrowser };
