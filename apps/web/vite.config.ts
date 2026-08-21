/// <reference types="vitest/config" />
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin, type ProxyOptions } from 'vite'
import { configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { buildId, stampServiceWorker } from './sw-stamp'

// Stamp the built sw.js with this build's identity. sw.js lives in public/ and is
// copied verbatim, so the rewrite happens on the emitted copy — the source stays a
// plain, readable, directly-testable file rather than a template.
//
// closeBundle rather than writeBundle: the public directory is copied during the
// write phase, and closeBundle is the hook that is guaranteed to run after it.
function stampServiceWorkerPlugin(): Plugin {
  let root = __dirname
  let outDir = 'dist'
  const assetFilenames: string[] = []
  return {
    name: 'waffled:stamp-service-worker',
    apply: 'build',
    configResolved(config) {
      // outDir is resolved against config.root, which is not required to be this
      // file's directory.
      root = config.root
      outDir = config.build.outDir
    },
    writeBundle(_options, bundle) {
      // Accumulate: a second Rollup output (a worker build, say) would otherwise
      // replace the app's file list wholesale and the stamp would quietly stop
      // tracking the app.
      assetFilenames.push(...Object.keys(bundle))
    },
    closeBundle() {
      const version = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version
      const swPath = resolve(root, outDir, 'sw.js')
      const id = buildId(version, assetFilenames)
      // stampServiceWorker throws if it can't find what it's replacing, which fails
      // the build. That is the point: silently shipping an unstamped worker would
      // turn offline updates off with no signal anywhere.
      writeFileSync(swPath, stampServiceWorker(readFileSync(swPath, 'utf8'), id))
      this.info(`service worker stamped ${id} from ${assetFilenames.length} files`)
    },
  }
}

// Proxy /api to the local api container so the SPA and api share an origin (no
// CORS), exactly like Caddy does in the stack. We forward the browser's host +
// proto so the api can build correct absolute URLs (OIDC redirect_uri, the
// "Back to Waffled" links) — otherwise it only sees its own :3000 address and SSO
// callbacks point at the wrong place.
const apiProxy: Record<string, ProxyOptions> = {
  '/api': {
    target: 'http://localhost:3000',
    changeOrigin: false,
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq, req) => {
        if (req.headers.host) proxyReq.setHeader('x-forwarded-host', req.headers.host)
        const encrypted = (req.socket as { encrypted?: boolean }).encrypted
        proxyReq.setHeader('x-forwarded-proto', encrypted ? 'https' : 'http')
      })
    },
  },
  // Uploaded media (/media/*) is served by Caddy off the shared waffled_media volume,
  // NOT by the api — so in dev we forward to the running stack's Caddy (:8080) the
  // same way it's served in production. Without this, the dev server returns
  // index.html for /media URLs and uploaded images render broken.
  '/media': {
    target: 'http://localhost:8080',
    changeOrigin: true,
  },
}

export default defineConfig({
  plugins: [react(), stampServiceWorkerPlugin()],
  // @powersync/web ships its own SQLite WASM + worker; pre-bundling breaks them,
  // so exclude it from Vite's dep optimizer (PowerSync's documented Vite setup).
  optimizeDeps: { exclude: ['@powersync/web'] },
  worker: { format: 'es' },
  build: {
    // Emit the chunk manifest so the service worker can precache every code-split
    // screen, not just what index.html happens to link. Written to the outDir root
    // (not Vite's default .vite/ subdirectory) because dotted paths are exactly the
    // sort of thing a static host declines to serve.
    manifest: 'asset-manifest.json',
    // Keep all CSS in one stylesheet even though the JS is split per screen.
    //
    // Splitting the screens splits their stylesheets too, and a stylesheet only
    // loads with the chunk importing it — but this codebase has 53 classes defined
    // in one screen's CSS and used from another (CookConfirm's 13 `cc-*` live in
    // pantry.css; Settings uses 10 pantry-*/pl-*; CookMode uses 7 re-timer-* from
    // recipe.css; `.cal-search` loads on none of its users at all). Each renders as
    // an unstyled browser default until the owning screen is opened first.
    //
    // One stylesheet costs ~28 kB gzipped on first load out of a ~373 kB saving, and
    // ends the entire class of bug — including for classes not yet written. The
    // per-screen split also wins least where it matters most: a kiosk runs for weeks
    // and opens every screen eventually, so it fetches all 12 sheets regardless.
    cssCodeSplit: false,
  },
  server: {
    port: 5175,
    proxy: apiProxy,
  },
  // `vite preview` mirrors the dev proxy so a production build can be exercised
  // against the local api (and the service worker's /api caching verified).
  preview: {
    port: 4173,
    proxy: apiProxy,
  },
  test: {
    // Browser smoke specs use Playwright's runner and must never be collected by Vitest.
    exclude: [...configDefaults.exclude, 'e2e/**'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Run test files sequentially (like apps/api). Vitest otherwise spawns a worker per
    // *host* core, ignoring the cgroup CPU limit — on a 2-core CI runner that oversubscribes
    // and starves jsdom renders ~60×, making interaction tests time out. Sequential keeps
    // each file at full speed and reliable. (Slightly slower wall-clock; worth it in CI.)
    fileParallelism: false,
    // Extra headroom for the heavier interaction tests on slow CI.
    testTimeout: 15000,
    // CI-only safety net: GitHub's shared 2-core runners occasionally stall a whole
    // file (GC / scheduler) despite the fixes above. Retry on CI so a transient load
    // stall doesn't red-X the build; keep 0 locally so real failures fail fast.
    retry: process.env.CI ? 2 : 0,
  },
})
