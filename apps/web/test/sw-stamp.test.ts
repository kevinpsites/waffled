import { describe, expect, it } from 'vitest'
import { buildId, stampServiceWorker } from '../sw-stamp'

// The browser decides whether to re-run a service worker's install step — and so
// whether to precache the new build's files — by byte-comparing sw.js against the
// copy it already has. sw.js is a static file that no release touches, so without
// this stamping a deploy ships thirty freshly-named chunks to a worker that has no
// idea anything changed, and never precaches them. Screens nobody opened while
// online are then missing the next time the network drops.
describe('service worker build stamp', () => {
  const SOURCE = "const VERSION = 'waffled-dev'\nconst SHELL = `${VERSION}-shell`\n"

  it('replaces the version constant with the build id', () => {
    const out = stampServiceWorker(SOURCE, 'waffled-0.13.0-deadbeef')
    expect(out).toContain("const VERSION = 'waffled-0.13.0-deadbeef'")
    expect(out).not.toContain('waffled-dev')
    // The cache names derive from it, so they move with the build too.
    expect(out).toContain('const SHELL = `${VERSION}-shell`')
  })

  it('throws when the constant it targets has been renamed', () => {
    // A silent miss would leave every deploy shipping an unchanged sw.js — exactly
    // the bug this exists to prevent, and invisible until someone is offline in a
    // kitchen. Fail the build instead.
    expect(() => stampServiceWorker('const CACHE_VERSION = "x"', 'waffled-1.0.0-abc')).toThrow(
      /VERSION/
    )
  })

  it('changes the id when the built files change, and only then', () => {
    const a = buildId('0.13.0', ['assets/index-aaa.js', 'assets/Today-bbb.js'])
    const b = buildId('0.13.0', ['assets/index-aaa.js', 'assets/Today-ccc.js'])
    expect(a).not.toEqual(b)

    // Rollup's emission order is not meaningful; the same build twice must not look
    // like two different builds, or every rebuild would purge a healthy cache.
    const reordered = buildId('0.13.0', ['assets/Today-bbb.js', 'assets/index-aaa.js'])
    expect(reordered).toEqual(a)
  })

  it('is unmoved by the same file being listed twice', () => {
    // The plugin accumulates filenames across Rollup outputs, so a flow where one
    // plugin instance sees two builds (vite build --watch) hands the same names in
    // again. Counting them twice would move the stamp for byte-identical output and
    // purge every display's cache on a rebuild that changed nothing — the opposite
    // of what the hash is for.
    const files = ['assets/index-aaa.js', 'assets/Today-bbb.js']
    expect(buildId('0.13.0', [...files, ...files])).toEqual(buildId('0.13.0', files))
  })

  it('carries the release version so a kiosk can be identified from its cache names', () => {
    // The version alone can't be the whole id — it stays 0.13.0 across every rebuild
    // between releases, including `docker compose up --build` off main — but it is
    // the part a human reads when working out what a display is actually running.
    expect(buildId('0.13.0', ['assets/index-aaa.js'])).toMatch(/^waffled-0\.13\.0-[0-9a-f]{8}$/)
  })

  it('refuses to derive an id from nothing', () => {
    // Hashing an empty list returns a perfectly valid-looking constant. If the build
    // plugin ever stopped being handed the bundle, every release would ship the same
    // sw.js again and offline updates would silently stop — the original bug, wearing
    // the fix as a disguise.
    expect(() => buildId('0.13.0', [])).toThrow(/no built files/)
  })
})
