// Nook kiosk service worker (roadmap 7.1). Hand-rolled (no build plugin) so the
// kiosk survives backend blips and brief network drops by serving the last-known
// app shell, hashed assets, and the most recent successful /api GET responses.
//
// Strategy:
//   • navigations      → network-first, fall back to the cached app shell
//   • hashed assets     → cache-first (Vite fingerprints them, so they're immutable)
//   • GET /api/*        → stale-while-revalidate; on network failure, last-known wins
//   • everything else   → straight to network
// Non-GET /api requests (mutations) are never cached — they pass through and fail
// loudly when offline, which is the correct behavior.

const VERSION = 'nook-v2'
const SHELL = `${VERSION}-shell`
const ASSETS = `${VERSION}-assets`
const API = `${VERSION}-api`
const SHELL_URL = '/index.html'

// Precache the shell AND its hashed assets at install time. We don't have a
// build manifest (no PWA plugin), so we fetch index.html and parse out the
// /assets/* URLs ourselves — otherwise an offline reload would get the cached
// shell but fail to load the (never-cached) JS/CSS the first load fetched
// before the SW took control.
async function precache() {
  const shellCache = await caches.open(SHELL)
  const res = await fetch('/index.html', { cache: 'no-cache' })
  await shellCache.put(SHELL_URL, res.clone())
  await shellCache.put('/', res.clone())
  const html = await res.text()
  const urls = new Set()
  const re = /(?:href|src)="(\/[^"]+\.(?:js|css|woff2?|svg|png|webp))"/g
  let m
  while ((m = re.exec(html))) urls.add(m[1])
  if (urls.size) {
    const assetCache = await caches.open(ASSETS)
    await assetCache.addAll([...urls]).catch(() => {})
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().catch(() => {}).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL, ASSETS, API])
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  )
})

function isAsset(url) {
  return url.pathname.startsWith('/assets/') || /\.(?:js|css|woff2?|png|jpe?g|svg|webp|ico)$/.test(url.pathname)
}

async function networkFirstShell(request) {
  try {
    const res = await fetch(request)
    const cache = await caches.open(SHELL)
    cache.put(SHELL_URL, res.clone())
    return res
  } catch {
    const cached = (await caches.match(SHELL_URL)) || (await caches.match('/'))
    return cached || Response.error()
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached
  const res = await fetch(request)
  if (res.ok) (await caches.open(ASSETS)).put(request, res.clone())
  return res
}

// Return cache immediately when present, refresh in the background; if the
// network fails and we have a cached copy, that's the "last-known state".
async function staleWhileRevalidate(request) {
  const cache = await caches.open(API)
  const cached = await cache.match(request)
  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone())
      return res
    })
    .catch(() => null)
  if (cached) {
    network.catch(() => {})
    return cached
  }
  const res = await network
  return res || new Response(JSON.stringify({ offline: true }), { status: 503, headers: { 'content-type': 'application/json' } })
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request))
    return
  }
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(staleWhileRevalidate(request))
    return
  }
  if (isAsset(url)) {
    event.respondWith(cacheFirst(request))
  }
})
