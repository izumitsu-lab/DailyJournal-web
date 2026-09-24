(function(){
  function call(op){
    if (!navigator.onLine) return Promise.resolve({ data: null, error: { message: 'TypeError: Failed to fetch' } });
    return window.__sb(JSON.stringify(op)).then(r => JSON.parse(r));
  }
  class QB {
    constructor(t){ this.op = { table: t, kind: 'select', filters: [], order: null, range: null, limit: null, single: false }; }
    select(c){ this.op.cols = c; return this; }
    eq(c,v){ this.op.filters.push(['eq',c,v]); return this; }
    in(c,v){ this.op.filters.push(['in',c,v]); return this; }
    gte(c,v){ this.op.filters.push(['gte',c,v]); return this; }
    order(c,o){ this.op.order = [c, !(o && o.ascending === false)]; return this; }
    range(a,b){ this.op.range = [a,b]; return this; }
    limit(n){ this.op.limit = n; return this; }
    maybeSingle(){ this.op.single = true; return this; }
    upsert(p){ this.op.kind = 'upsert'; this.op.payload = Array.isArray(p) ? p : [p]; return this; }
    update(p){ this.op.kind = 'update'; this.op.payload = p; return this; }
    then(res, rej){ return call(this.op).then(res, rej); }
  }
  window.supabase = { createClient(){ return {
    from: t => new QB(t),
    auth: {
      // ログイン状態は端末（ページ）ごとに保持する。ログアウトするとセッションがなくなる
      getSession: async () => ({ data: { session: sessionStorage.getItem('__fakeSignedOut') ? null : { user: { id: 'user-1', email: 't@example.com' } } } }),
      signOut: async () => { sessionStorage.setItem('__fakeSignedOut', '1'); return {}; },
      signInWithPassword: async () => { sessionStorage.removeItem('__fakeSignedOut'); return {}; },
      signUp: async () => { sessionStorage.removeItem('__fakeSignedOut'); return {}; }
    },
    storage: { from: () => ({
      upload: async (path, blob) => { const d = await new Promise(r => { const fr = new FileReader(); fr.onloadend = () => r(fr.result); fr.readAsDataURL(blob); }); return call({ kind: 'upload', path, data: d }); },
      createSignedUrl: async (path) => call({ kind: 'sign', path }),
      list: async (folder, opts) => call({ kind: 'list', folder, opts: opts || {} }),
      remove: async (paths) => call({ kind: 'remove', paths })
    }) },
    channel: () => { const ch = { on(ev, f, cb){ (window.__rtHandlers = window.__rtHandlers || {})[f.table] = cb; return ch; }, subscribe(){ return ch; } }; return ch; },
    removeChannel(){}
  }; } };
  window.__rt = (table, row) => { if (!navigator.onLine) return; const h = (window.__rtHandlers || {})[table]; if (h) h({ new: row }); };
})();
