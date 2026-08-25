import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), '../public/sw.js')

// Responses the worker's own fetches see. Keyed by path so a test can describe the
// build it is installing against: the shell HTML plus the chunk manifest Vite emits.
// A plain string is served with the content type its extension implies; the object
// form lets a test serve the *wrong* type deliberately, which is what a SPA fallback
// does when a chunk is missing.
type ServedValue = string | { body: string; type: string }
type Served = Record<string, ServedValue | undefined>

function contentTypeFor(path: string): string {
  if (path.endsWith('.js')) return 'text/javascript'
  if (path.endsWith('.css')) return 'text/css'
  if (path.endsWith('.json')) return 'application/json'
  return 'text/html'
}

// `networkDown` makes every fetch reject, the way a dropped wifi link does.
// `shellStatus` serves the shell with a non-OK status — a rolling restart of the
// reverse proxy answering 502 while the container comes back, which is a *response*
// and not a rejection, so it slips past a plain try/catch.
type WorkerOptions = { networkDown?: boolean; shellStatus?: number }

async function loadWorker(served: Served = {}, options: WorkerOptions = {}) {
  const source = await readFile(workerPath, 'utf8')
  const listeners = new Map<string, (event: unknown) => void>()
  // One cache object per name, so a test can assert what landed in the assets cache
  // specifically rather than in whichever cache was opened last.
  const caches_ = new Map<string, { add: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; match: ReturnType<typeof vi.fn> }>()
  const cacheFor = (name: string) => {
    let c = caches_.get(name)
    if (!c) {
      c = { add: vi.fn(async () => undefined), put: vi.fn(), match: vi.fn(async () => undefined) }
      caches_.set(name, c)
    }
    return c
  }
  const cacheStorage = {
    open: vi.fn(async (name: string) => cacheFor(name)),
    // The dev-value cache names, plus leftovers from an older worker: the API cache
    // that a previous version of this file used to write, and a previous build's
    // assets (the version stamp scopes cache names per build).
    keys: vi.fn(async () => [
      'waffled-dev-shell',
      'waffled-dev-assets',
      'waffled-dev-api',
      'waffled-0.12.0-abc12345-assets',
    ]),
    delete: vi.fn(async () => true),
    match: vi.fn(async () => undefined),
  }
  const self = {
    location: { origin: 'https://waffled.test' },
    clients: { claim: vi.fn() },
    skipWaiting: vi.fn(),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener)
    },
  }
  // The install path fetches string URLs; the fetch handler passes the Request through
  // to fetch(request). Stringifying the latter yielded "[object Object]", which served
  // a 404 for every request the handler made — so a test could assert that nothing was
  // written to the cache and pass because the fetch never resolved, not because the
  // worker declined it. Resolve both shapes to a path.
  const fetchMock = vi.fn(async (input: string | { url: string }) => {
    if (options.networkDown) throw new TypeError('Failed to fetch')
    const raw = typeof input === 'string' ? input : input.url
    const path = raw.startsWith('http') ? new URL(raw).pathname : raw
    const entry = served[path]
    if (entry === undefined) return new Response('{}', { status: 404 })
    const body = typeof entry === 'string' ? entry : entry.body
    const type = typeof entry === 'string' ? contentTypeFor(path) : entry.type
    const status = path === '/index.html' && options.shellStatus ? options.shellStatus : 200
    return new Response(body, { status, headers: { 'content-type': type } })
  })
  runInNewContext(source, {
    self,
    caches: cacheStorage,
    fetch: fetchMock,
    URL,
    Response,
    Set,
  })
  return { listeners, cacheStorage, cacheFor, fetchMock, self }
}

// Drive the install handler to completion, the way the browser does.
async function install(listeners: Map<string, (event: unknown) => void>) {
  let done: Promise<unknown> | undefined
  listeners.get('install')?.({
    waitUntil: (promise: Promise<unknown>) => {
      done = promise
    },
  })
  await done
}

describe('service worker request privacy', () => {
  it('does not intercept or cache authenticated API reads', async () => {
    const { listeners } = await loadWorker()
    const respondWith = vi.fn()

    listeners.get('fetch')?.({
      request: {
        method: 'GET',
        mode: 'cors',
        url: 'https://waffled.test/api/household',
        headers: { authorization: 'Bearer private-session' },
      },
      respondWith,
    })

    expect(respondWith).not.toHaveBeenCalled()
  })

  it('deletes an API cache left by an older worker', async () => {
    const { listeners, cacheStorage } = await loadWorker()
    let activation: Promise<unknown> | undefined

    listeners.get('activate')?.({
      waitUntil: (promise: Promise<unknown>) => {
        activation = promise
      },
    })
    await activation

    expect(cacheStorage.delete).toHaveBeenCalledWith('waffled-dev-api')
    // ...without taking this build's own caches down with it.
    expect(cacheStorage.delete).not.toHaveBeenCalledWith('waffled-dev-shell')
    expect(cacheStorage.delete).not.toHaveBeenCalledWith('waffled-dev-assets')
  })

  it(`drops the previous build's cached assets`, async () => {
    // Cache names carry the build stamp, so without this every release a display
    // survives would leave its files behind forever.
    const { listeners, cacheStorage } = await loadWorker()
    let activation: Promise<unknown> | undefined

    listeners.get('activate')?.({
      waitUntil: (promise: Promise<unknown>) => {
        activation = promise
      },
    })
    await activation

    expect(cacheStorage.delete).toHaveBeenCalledWith('waffled-0.12.0-abc12345-assets')
  })
})

// Screens are code-split, so a screen's chunk is named only inside the JS that
// imports it — it never appears in index.html. Scraping the HTML would therefore
// precache the entry bundle and silently skip every route the family hasn't opened
// yet, and the kiosk would go offline able to show Today and nothing else. The
// build's asset manifest is the only complete list, so the worker must read it.
describe('service worker offline precache', () => {
  const SHELL_HTML = '<html><head><script type="module" src="/assets/index-abc.js"></script></head></html>'
  const MANIFEST = JSON.stringify({
    'src/main.tsx': { file: 'assets/index-abc.js', css: ['assets/index-abc.css'] },
    'src/kiosk/Meals.tsx': { file: 'assets/Meals-def.js' },
    'src/kiosk/Settings.tsx': { file: 'assets/Settings-ghi.js', css: ['assets/settings-ghi.css'] },
  })
  // A whole build on the wire, so the tests exercise the real fetch path rather than
  // a stubbed cache write.
  const BUILD: Served = {
    '/index.html': SHELL_HTML,
    '/asset-manifest.json': MANIFEST,
    '/assets/index-abc.js': 'export default 1',
    '/assets/index-abc.css': '.a{}',
    '/assets/Meals-def.js': 'export default 2',
    '/assets/Settings-ghi.js': 'export default 3',
    '/assets/settings-ghi.css': '.b{}',
  }
  const cachedUrls = (cache: { put: { mock: { calls: unknown[][] } } }) =>
    cache.put.mock.calls.map(([url]) => String(url))

  it('precaches code-split chunks that index.html never references', async () => {
    const { listeners, cacheFor } = await loadWorker(BUILD)
    await install(listeners)

    const cached = cachedUrls(cacheFor('waffled-dev-assets'))
    // The entry is in the HTML; these two are reachable only through the manifest.
    expect(cached).toContain('/assets/index-abc.js')
    expect(cached).toContain('/assets/Meals-def.js')
    expect(cached).toContain('/assets/Settings-ghi.js')
    // Per-screen stylesheets split out alongside their screen and need the same care.
    expect(cached).toContain('/assets/settings-ghi.css')
  })

  it('still precaches the shell when the manifest is missing', async () => {
    // An older build, or a host that declines to serve the manifest. Losing the
    // extra chunks is a degraded offline experience; losing the entry bundle would
    // be a blank screen, so the HTML scrape has to keep working on its own.
    const { listeners, cacheFor } = await loadWorker({
      '/index.html': SHELL_HTML,
      '/assets/index-abc.js': 'export default 1',
    })
    await install(listeners)

    expect(cachedUrls(cacheFor('waffled-dev-assets'))).toContain('/assets/index-abc.js')
  })

  it('keeps the chunks it could fetch when one of them is missing', async () => {
    // addAll is all-or-nothing. A single stale entry would have discarded the whole
    // precache, which is the opposite of what a best-effort offline cache should do.
    const withoutMeals = { ...BUILD, '/assets/Meals-def.js': undefined }
    const { listeners, cacheFor } = await loadWorker(withoutMeals)
    await install(listeners)

    const cached = cachedUrls(cacheFor('waffled-dev-assets'))
    expect(cached).toContain('/assets/Settings-ghi.js')
    expect(cached).not.toContain('/assets/Meals-def.js')
  })

  it('refuses to cache the SPA fallback page as a chunk', async () => {
    // A missing chunk does not 404 in production: infra/compose/caddy/Caddyfile
    // serves the SPA with `try_files {path} /index.html`, so a stale manifest entry
    // comes back as 200 + text/html. Cached under a .js URL that is exactly as
    // permanent as a real chunk — cacheFirst never revalidates — the screen fails
    // its module load on MIME type every time, offline or on, until someone clears
    // the display's storage by hand.
    const { listeners, cacheFor } = await loadWorker({
      ...BUILD,
      '/assets/Meals-def.js': { body: SHELL_HTML, type: 'text/html' },
    })
    await install(listeners)

    const cached = cachedUrls(cacheFor('waffled-dev-assets'))
    expect(cached).toContain('/assets/Settings-ghi.js')
    expect(cached).not.toContain('/assets/Meals-def.js')
  })

  it('leaves the alternative SQLite wasm builds out of the precache', async () => {
    // The manifest lists four wa-sqlite builds — sync/async × two threading models,
    // about 7 MB in total — and any given browser loads exactly one pairing. They
    // are in the manifest only because they have a `file` key, and precaching all
    // four means every display downloads ~7 MB it will never ask for on every
    // deploy. They still land in the cache the first time the engine actually loads
    // one, because /assets/* goes through cacheFirst.
    const { listeners, cacheFor, fetchMock } = await loadWorker({
      '/index.html': SHELL_HTML,
      '/assets/index-abc.js': 'export default 1',
      '/assets/wa-sqlite-xyz.wasm': 'wasm bytes',
      '/assets/wa-sqlite-async-xyz.wasm': 'wasm bytes',
      '/asset-manifest.json': JSON.stringify({
        'src/main.tsx': { file: 'assets/index-abc.js' },
        'wa-sqlite.wasm': { file: 'assets/wa-sqlite-xyz.wasm' },
        'wa-sqlite-async.wasm': { file: 'assets/wa-sqlite-async-xyz.wasm' },
      }),
    })
    await install(listeners)

    // Not merely uncached — never even requested, which is the 7 MB that matters.
    const fetched = fetchMock.mock.calls.map(([url]) => String(url))
    expect(fetched).not.toContain('/assets/wa-sqlite-xyz.wasm')

    const cached = cachedUrls(cacheFor('waffled-dev-assets'))
    expect(cached).toContain('/assets/index-abc.js')
    expect(cached).not.toContain('/assets/wa-sqlite-xyz.wasm')
    expect(cached).not.toContain('/assets/wa-sqlite-async-xyz.wasm')
  })
})

// A worker that installs despite a failed precache is worse than no new worker at
// all: cache names carry the build stamp, so `activate` deletes the *previous*
// build's shell and assets. Install broken, activate anyway, and the display is left
// with empty caches and its working copy deleted — no offline app at all, which is
// strictly worse than the build it was running a moment ago.
// Found by driving a real browser offline against the production build: every
// screen's JS and CSS failed to load even though all 65 files were sitting in the
// cache and `caches.match(url)` found them.
//
// Vite tags its entry with `<script type="module" crossorigin>`, so the browser's
// real request carries an `Origin` header. The precache stores the response from a
// plain `fetch(url)`, which has none. When the origin server labels the response
// `Vary: Origin` — Vite's preview server does; so does any proxy configured for
// CORS — those two requests no longer match, `cacheFirst` falls through to the
// network, and offline that throws. The kiosk shows a blank screen with a full
// cache. Fingerprinted assets can't legitimately vary: the URL is the whole key.
describe('service worker cache matching', () => {
  async function assetFetch(listeners: Map<string, (event: unknown) => void>, url: string) {
    let responded: Promise<unknown> | undefined
    listeners.get('fetch')?.({
      request: { method: 'GET', mode: 'cors', url, headers: {} },
      respondWith: (promise: Promise<unknown>) => {
        responded = promise
      },
    })
    await responded?.catch(() => undefined)
  }

  it('ignores Vary when looking an asset up in the cache', async () => {
    const { listeners, cacheStorage } = await loadWorker()

    await assetFetch(listeners, 'https://waffled.test/assets/index-abc.js')

    expect(cacheStorage.match).toHaveBeenCalledWith(expect.anything(), { ignoreVary: true })
  })

  it('ignores Vary when falling back to the cached shell', async () => {
    // Same failure, worse outcome: the shell is what stands between a dropped
    // network and a blank display.
    const { listeners, cacheStorage } = await loadWorker({}, { networkDown: true })
    let responded: Promise<unknown> | undefined
    listeners.get('fetch')?.({
      request: { method: 'GET', mode: 'navigate', url: 'https://waffled.test/', headers: {} },
      respondWith: (promise: Promise<unknown>) => {
        responded = promise
      },
    })
    await responded?.catch(() => undefined)

    expect(cacheStorage.match).toHaveBeenCalledWith('/index.html', { ignoreVary: true })
  })
})

describe('service worker install safety', () => {
  const SHELL_HTML = '<html><head><script type="module" src="/assets/index-abc.js"></script></head></html>'

  it('refuses to install when the shell cannot be fetched', async () => {
    // Rejecting is the point: the browser discards the half-built worker, keeps the
    // old one serving, and retries on the next navigation.
    const { listeners } = await loadWorker({}, { networkDown: true })

    await expect(install(listeners)).rejects.toThrow()
  })

  it('does not take over from a working worker when its precache failed', async () => {
    const { listeners, self } = await loadWorker({}, { networkDown: true })

    await expect(install(listeners)).rejects.toThrow()
    // skipWaiting is what hands control — and therefore the activate sweep — to a
    // worker with nothing cached.
    expect(self.skipWaiting).not.toHaveBeenCalled()
  })

  it('refuses to cache a proxy error page as the app shell', async () => {
    // A 502 from a reverse proxy mid-restart is a Response, not a rejection. Cached
    // as the shell it would be indistinguishable from the app to every later offline
    // navigation: the kiosk would serve "502 Bad Gateway" from its own cache, from
    // then on, with the server perfectly healthy.
    const { listeners, cacheFor } = await loadWorker(
      { '/index.html': '<html><body>502 Bad Gateway</body></html>' },
      { shellStatus: 502 }
    )

    await expect(install(listeners)).rejects.toThrow()
    expect(cacheFor('waffled-dev-shell').put).not.toHaveBeenCalled()
  })
})

// Vite fingerprints everything it emits, so /assets/* can be cache-first forever: a
// changed file gets a new URL. Files copied from public/ keep their names — /logo.png,
// the favicons, the touch icon — so cache-first pins whatever the display saw first
// and never looks again. The build stamp doesn't save it either: the stamp only moves
// when the build does, so editing an icon and rebuilding off an unbumped version
// leaves every display showing the old one indefinitely.
//
// They're served stale-while-revalidate instead: the cached copy answers immediately
// (so an offline display still has its branding), and the worker refreshes it in the
// background, so a changed icon self-heals on the next load with a network.
describe('service worker unhashed assets', () => {
  function assetEvent(listeners: Map<string, (event: unknown) => void>, url: string) {
    let responded: Promise<Response> | undefined
    const background: Promise<unknown>[] = []
    listeners.get('fetch')?.({
      request: { method: 'GET', mode: 'no-cors', url, headers: {} },
      respondWith: (promise: Promise<Response>) => {
        responded = promise
      },
      waitUntil: (promise: Promise<unknown>) => {
        background.push(promise)
      },
    })
    return { responded, background }
  }

  it('answers from cache instantly and refreshes an unhashed icon in the background', async () => {
    const { listeners, cacheFor } = await loadWorker({ '/logo.png': { body: 'new-logo', type: 'image/png' } })
    const assets = cacheFor('waffled-dev-assets')
    assets.match = vi.fn(async () => new Response('old-logo', { headers: { 'content-type': 'image/png' } }))

    const { responded, background } = assetEvent(listeners, 'https://waffled.test/logo.png')
    // The display is not made to wait on the network for a file it already has.
    expect(await (await responded)?.text()).toBe('old-logo')

    await Promise.all(background)
    const stored = assets.put.mock.calls.map(([, res]: [unknown, Response]) => res)
    expect(stored.length).toBe(1)
    expect(await stored[0].text()).toBe('new-logo')
  })

  it('keeps fingerprinted assets on cache-first, with no revalidation fetch', async () => {
    // The whole point of a content hash: re-checking it every load would be pure waste
    // on a display that opens the same screens all day.
    const { listeners, cacheStorage, fetchMock } = await loadWorker()
    cacheStorage.match = vi.fn(async () => new Response('cached chunk', { headers: { 'content-type': 'text/javascript' } }))

    const { responded } = assetEvent(listeners, 'https://waffled.test/assets/index-abc.js')
    await responded

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not overwrite a cached icon with the SPA fallback page', async () => {
    // Caddy answers a missing path with 200 + index.html. Revalidating into the cache
    // without checking would replace the icon with an HTML document, and every later
    // load would serve that.
    const { listeners, cacheFor } = await loadWorker({
      '/logo.png': { body: '<html>the app shell</html>', type: 'text/html' },
    })
    const assets = cacheFor('waffled-dev-assets')
    assets.match = vi.fn(async () => new Response('old-logo', { headers: { 'content-type': 'image/png' } }))

    const { responded, background } = assetEvent(listeners, 'https://waffled.test/logo.png')
    await responded
    await Promise.all(background)

    expect(assets.put).not.toHaveBeenCalled()
  })
})
