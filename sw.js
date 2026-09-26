// ==========================================
// sw.js（オフラインでも起動できるようにする Service Worker）
// ==========================================
// ・アプリのファイル（HTML・CSS・JS）と、外部ライブラリ（Supabase・JSZip・Sortable）を端末にしまっておく
// ・画面（index.html）は、まずネットから最新を取りにいき、つながらない・遅いときは、しまってある版で起動する
// ・CSS・JS は、しまってある版をすぐ使い、裏で新しい版を取りにいく（次に開いたときに反映）
// ・Supabase との通信（記録・画像・ログイン）は一切しまわない（常に直接やりとりする）
//
// 版を上げるときは、index.html の ?v= と main.js の APP_VERSION と一緒に、下の VERSION もそろえる。
const VERSION = '2026.09.26-6';
const APP_CACHE = 'dj-app-' + VERSION;
const CDN_CACHE = 'dj-cdn-v1';

const APP_FILES = [
    './',
    './index.html',
    `./style.css?v=${VERSION}`,
    `./purify.min.js?v=${VERSION}`,
    `./main.js?v=${VERSION}`,
    `./calendar.js?v=${VERSION}`,
    `./notebooks.js?v=${VERSION}`,
    `./ui.js?v=${VERSION}`,
    `./tags.js?v=${VERSION}`,
    `./templates.js?v=${VERSION}`,
    `./supabase-sync.js?v=${VERSION}`,
    './favicon-32.png',
    './apple-touch-icon.png'
];
const CDN_FILES = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.0/Sortable.min.js'
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];
const NAV_TIMEOUT_MS = 3500; // 画面の取得がこれより遅いときは、しまってある版で起動する

// 1つ取れなくても、ほかはしまう（1つの失敗で全体が入らないのを防ぐ）
async function addEach(cacheName, urls) {
    const cache = await caches.open(cacheName);
    await Promise.all(urls.map(async (u) => {
        try {
            const res = await fetch(u, { cache: 'no-cache' });
            if (res && (res.ok || res.type === 'opaque')) await cache.put(u, res);
        } catch (e) { /* オフラインなど。次に使うときにしまう */ }
    }));
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        await addEach(APP_CACHE, APP_FILES);
        // 外部ライブラリは、まだしまっていないものだけ取りにいく
        const cdn = await caches.open(CDN_CACHE);
        const missing = [];
        for (const u of CDN_FILES) if (!(await cdn.match(u))) missing.push(u);
        await addEach(CDN_CACHE, missing);
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // 古い版のアプリファイルを片付ける（外部ライブラリのしまい場所は残す）
        for (const key of await caches.keys()) {
            if (key.startsWith('dj-app-') && key !== APP_CACHE) await caches.delete(key);
        }
        await self.clients.claim();
    })());
});

// ネットから取り、うまくいったらしまう
async function fetchAndStore(request, cacheName) {
    const res = await fetch(request);
    if (res && (res.ok || res.type === 'opaque')) {
        const cache = await caches.open(cacheName);
        cache.put(request, res.clone()).catch(() => {});
    }
    return res;
}

// 画面：ネット優先。つながらない・遅いときは、しまってある版
async function handleNavigation(request) {
    const cache = await caches.open(APP_CACHE);
    const network = fetch(request).then(res => {
        if (res && res.ok) cache.put('./index.html', res.clone()).catch(() => {});
        return res;
    });
    const cached = await cache.match('./index.html') || await caches.match(request, { ignoreSearch: true });
    if (!cached) return network; // まだしまっていない（初回）
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), NAV_TIMEOUT_MS));
    try {
        const res = await Promise.race([network, timeout]);
        if (res && res.ok) return res;
    } catch (e) { /* オフライン */ }
    return cached;
}

// CSS・JS・外部ライブラリ：しまってある版をすぐ返し、裏で新しい版に入れ替える
async function staleWhileRevalidate(request, cacheName, event) {
    const cached = await caches.match(request);
    const update = fetchAndStore(request, cacheName).catch(() => null);
    if (cached) {
        event.waitUntil(update);
        return cached;
    }
    const res = await update;
    return res || Response.error();
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    if (url.origin === self.location.origin) {
        if (req.mode === 'navigate') { event.respondWith(handleNavigation(req)); return; }
        event.respondWith(staleWhileRevalidate(req, APP_CACHE, event));
        return;
    }
    if (CDN_HOSTS.includes(url.hostname)) {
        // <script> からの通信は中身が見えない形（opaque）になり、しまうと容量を大きく数えられるので、
        // 中身の見える形（CORS）で取り直してしまう
        const corsReq = new Request(req.url, { mode: 'cors', credentials: 'omit' });
        event.respondWith(staleWhileRevalidate(corsReq, CDN_CACHE, event));
        return;
    }
    // Supabase など、それ以外の通信は何もしない（ブラウザがそのまま通信する）
});
