import { createHash } from 'node:crypto'

// Stamps a build identity into the service worker.
//
// A service worker only re-runs its install step — the step that precaches the
// app's files for offline use — when the browser sees that sw.js itself has
// changed, which it decides by comparing bytes. Our sw.js is a hand-written static
// file that a release never touches, so without this every deploy would hand a new
// set of hashed chunk filenames to a worker convinced nothing had changed. It would
// precache none of them, and any screen the family hadn't opened while online would
// be missing the next time the network dropped. Changing sw.js on every build is
// what makes the offline cache actually track the deployed app.
//
// The id also names the caches, so a new build's worker drops the previous build's
// entries on activate instead of accumulating a copy of every version ever shipped.

const VERSION_LINE = /const VERSION = '[^']*'/

/**
 * `waffled-<release version>-<hash of the built filenames>`.
 *
 * Both halves earn their place. The version is what a human reads off a kiosk when
 * working out what it is running, but on its own it is not enough: it stays put
 * between releases, so every `--build` off main would produce an identical sw.js and
 * reintroduce the bug. The hash is the half that is causally correct — it changes
 * exactly when the set of emitted files changes, and never otherwise.
 *
 * Deliberately not a git SHA: the web image builds from a Docker context containing
 * only apps/web, with no .git to ask.
 */
export function buildId(version: string, assetFilenames: string[]): string {
  if (assetFilenames.length === 0) {
    // Hashing nothing yields a constant, which is indistinguishable from a correct
    // stamp and would quietly freeze every kiosk's offline cache at whatever build
    // it first saw. If the plugin ever stops being handed the bundle, say so.
    throw new Error('sw-stamp: no built files to derive a build id from')
  }
  const hash = createHash('sha256')
    // Sorted because Rollup's emission order carries no meaning, and deduplicated
    // because the plugin accumulates across outputs and can be handed the same name
    // twice. Either would otherwise purge a perfectly good cache on a rebuild that
    // changed nothing.
    .update([...new Set(assetFilenames)].sort().join('\n'))
    .digest('hex')
    .slice(0, 8)
  return `waffled-${version}-${hash}`
}

/**
 * Replaces sw.js's `VERSION` constant with `id`. Throws rather than passing the
 * source through untouched: a quiet no-op here is invisible in every build log and
 * every test, and only shows up as a kiosk that can't open a screen in a kitchen
 * with the wifi down.
 */
export function stampServiceWorker(source: string, id: string): string {
  if (!VERSION_LINE.test(source)) {
    throw new Error(
      `sw-stamp: no \`const VERSION = '...'\` found in the service worker. It was renamed or ` +
        `removed — re-point VERSION_LINE at it, or every deploy will ship an unchanged sw.js ` +
        `and stop precaching new builds.`
    )
  }
  return source.replace(VERSION_LINE, `const VERSION = '${id}'`)
}
