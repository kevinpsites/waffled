// Waffled kiosk service worker (roadmap 7.1). Hand-rolled (no build plugin) so the
// kiosk survives brief network drops by serving the last-known app shell and
// hashed assets. Authenticated API responses always stay on the network path.
//
// Strategy:
//   • navigations      → network-first, fall back to the cached app shell
//   • hashed assets     → cache-first (Vite fingerprints them, so they're immutable)
//   • GET /api/*        → straight to network (never persisted by this worker)
//   • everything else   → straight to network
// API requests are never cached because their responses contain household data
// scoped by authorization headers, while Cache Storage keys requests by URL.

const VERSION = 'waffled-v1'
const SHELL = `${VERSION}-shell`
const ASSETS = `${VERSION}-assets`
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
  // This also removes the API cache created by older workers.
  const keep = new Set([SHELL, ASSETS])
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

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request))
    return
  }
  if (isAsset(url)) {
    event.respondWith(cacheFirst(request))
  }
})
