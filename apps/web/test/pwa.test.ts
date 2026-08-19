import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), '../public/sw.js')

// Responses the worker's own fetches see. Keyed by path so a test can describe the
// build it is installing against: the shell HTML plus the chunk manifest Vite emits.
type Served = Record<string, string | undefined>

async function loadWorker(served: Served = {}) {
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
  const fetchMock = vi.fn(async (input: string) => {
    const path = typeof input === 'string' ? input : String(input)
    const body = served[path]
    if (body === undefined) return new Response('{}', { status: 404 })
    return new Response(body, { status: 200 })
  })
  runInNewContext(source, {
    self,
    caches: cacheStorage,
    fetch: fetchMock,
    URL,
    Response,
    Set,
  })
  return { listeners, cacheStorage, cacheFor, fetchMock }
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

  it('precaches code-split chunks that index.html never references', async () => {
    const { listeners, cacheFor } = await loadWorker({
      '/index.html': SHELL_HTML,
      '/asset-manifest.json': MANIFEST,
    })
    await install(listeners)

    const cached = cacheFor('waffled-dev-assets').add.mock.calls.map(([url]) => url)
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
    const { listeners, cacheFor } = await loadWorker({ '/index.html': SHELL_HTML })
    await install(listeners)

    const cached = cacheFor('waffled-dev-assets').add.mock.calls.map(([url]) => url)
    expect(cached).toContain('/assets/index-abc.js')
  })

  it('keeps the chunks it could fetch when one of them 404s', async () => {
    // addAll is all-or-nothing. A single stale entry would have discarded the whole
    // precache, which is the opposite of what a best-effort offline cache should do.
    const { listeners, cacheFor } = await loadWorker({
      '/index.html': SHELL_HTML,
      '/asset-manifest.json': MANIFEST,
    })
    const assets = cacheFor('waffled-dev-assets')
    assets.add.mockImplementation(async (url: string) => {
      if (url === '/assets/Meals-def.js') throw new Error('404')
    })
    await install(listeners)

    const cached = assets.add.mock.calls.map(([url]) => url)
    expect(cached).toContain('/assets/Settings-ghi.js')
  })
})
