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

// Replaced at build time with `waffled-<release version>-<hash of the built files>`
// (see sw-stamp.ts). That is what makes the browser notice a new deploy at all: it
// re-runs install — and so the precache below — only when sw.js's own bytes change,
// and nothing else in this file moves from one release to the next. It also scopes
// the cache names per build, so activate drops the previous build's copies instead
// of hoarding every version ever shipped. The literal below is the dev value; there
// is no service worker in dev, so it only ever shows up in tests.
const VERSION = 'waffled-dev'
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
// The build writes /asset-manifest.json listing the JS and CSS chunks, so read that
// and fall back to scraping the HTML if it is missing (an older build, or a host that
// won't serve it).
//
// The .wasm files are deliberately skipped. The manifest lists four wa-sqlite builds —
// sync/async paired with two threading models, ~7 MB together — and a browser loads
// exactly one pairing, so precaching all four would have every display download ~7 MB
// it will never ask for, on every single deploy. They are still cached the first time
// the engine loads one, because /assets/* goes through cacheFirst below.
async function manifestAssets() {
  try {
    const res = await fetch('/asset-manifest.json', { cache: 'no-cache' })
    if (!res.ok) return []
    const manifest = await res.json()
    const urls = new Set()
    for (const entry of Object.values(manifest)) {
      if (entry && typeof entry.file === 'string' && !entry.file.endsWith('.wasm')) {
        urls.add(`/${entry.file}`)
      }
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
  // A reverse proxy mid-restart answers 502 with a *Response*, not a rejection. Cached
  // as the shell, that error page becomes indistinguishable from the app to every later
  // offline navigation — the kiosk would serve "502 Bad Gateway" out of its own cache
  // from then on, with the server long since healthy.
  if (!res.ok) throw new Error(`sw: refusing to cache a ${res.status} as the app shell`)
  await shellCache.put(SHELL_URL, res.clone())
  await shellCache.put('/', res.clone())
  const html = await res.text()
  const urls = new Set([...htmlAssets(html), ...(await manifestAssets())])
  if (urls.size) {
    const assetCache = await caches.open(ASSETS)
    // addAll is all-or-nothing; one missing chunk among ~30 would discard the lot, so
    // cache them individually and keep whatever succeeds.
    await Promise.all([...urls].map((url) => cacheAsset(assetCache, url).catch(() => {})))
  }
}

// Fetch one asset and store it only if what came back is actually that asset.
//
// A missing chunk does not 404 in production: Caddy serves the SPA with
// `try_files {path} /index.html`, so a stale manifest entry comes back as 200 with
// the HTML page in it. cache.add() would happily store that under a .js URL, and
// because /assets/* is cache-first and never revalidated, the screen would fail its
// module load on MIME type from then on — offline *and* online — until someone
// cleared the display's storage by hand. Better to cache nothing for it and let the
// network serve it later.
async function cacheAsset(cache, url) {
  const res = await fetch(url)
  if (!res.ok) return
  const type = res.headers.get('content-type') || ''
  const expected = url.endsWith('.js') ? 'javascript' : url.endsWith('.css') ? 'css' : ''
  if (expected && !type.includes(expected)) return
  await cache.put(url, res)
}

// Let a failed precache fail the install, rather than swallowing it. Cache names carry
// the build stamp, so `activate` deletes the *previous* build's shell and assets — if a
// worker were allowed to install with nothing cached and then claim control, it would
// delete the only working offline copy the display had and replace it with an empty
// one. Rejecting means the browser discards the half-built worker, leaves the old one
// serving, and retries on the next navigation. The individual asset fetches inside
// precache() stay best-effort; it is losing the *shell* that is unrecoverable.
self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()))
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
