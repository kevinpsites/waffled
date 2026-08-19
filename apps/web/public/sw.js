// Waffled kiosk service worker (roadmap 7.1). Hand-rolled (no build plugin) so the
// kiosk survives brief network drops by serving the last-known app shell and
// hashed assets. Authenticated API responses always stay on the network path.
//
// Strategy:
//   • navigations      → network-first, fall back to the cached app shell
//   • hashed assets     → cache-first (Vite fingerprints them, so they're immutable),
//                        all of them precached from the build's asset manifest
//   • GET /api/*        → straight to network (never persisted by this worker)
//   • everything else   → straight to network
// API requests are never cached because their responses contain household data
// scoped by authorization headers, while Cache Storage keys requests by URL.

const VERSION = 'waffled-v1'
const SHELL = `${VERSION}-shell`
const ASSETS = `${VERSION}-assets`
const SHELL_URL = '/index.html'

// Precache the shell AND every hashed asset at install time — otherwise an offline
// reload would get the cached shell but fail to load the (never-cached) JS/CSS the
// first load fetched before the SW took control.
//
// Two sources, because index.html alone is no longer enough. The screens are
// code-split, so a screen's chunk is referenced only by the JS that imports it and
// never appears in the HTML — parsing index.html would precache the entry and leave
// a kiosk that went offline before anyone opened Meals unable to open Meals at all.
// The build writes /asset-manifest.json listing every chunk, so read that and fall
// back to scraping the HTML if it is missing (an older build, or a host that won't
// serve it). Both paths are best-effort: a failed precache leaves a working online
// app, which is the same trade the rest of this worker makes.
async function manifestAssets() {
  try {
    const res = await fetch('/asset-manifest.json', { cache: 'no-cache' })
    if (!res.ok) return []
    const manifest = await res.json()
    const urls = new Set()
    for (const entry of Object.values(manifest)) {
      if (entry && typeof entry.file === 'string') urls.add(`/${entry.file}`)
      for (const css of entry?.css ?? []) urls.add(`/${css}`)
    }
    return [...urls]
  } catch {
    return []
  }
}

function htmlAssets(html) {
  const urls = new Set()
  const re = /(?:href|src)="(\/[^"]+\.(?:js|css|woff2?|svg|png|webp))"/g
  let m
  while ((m = re.exec(html))) urls.add(m[1])
  return [...urls]
}

async function precache() {
  const shellCache = await caches.open(SHELL)
  const res = await fetch('/index.html', { cache: 'no-cache' })
  await shellCache.put(SHELL_URL, res.clone())
  await shellCache.put('/', res.clone())
  const html = await res.text()
  const urls = new Set([...htmlAssets(html), ...(await manifestAssets())])
  if (urls.size) {
    const assetCache = await caches.open(ASSETS)
    // addAll is all-or-nothing; one 404 among ~30 chunks would discard the lot, so
    // cache them individually and keep whatever succeeds.
    await Promise.all(
      [...urls].map((url) => assetCache.add(url).catch(() => {}))
    )
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
