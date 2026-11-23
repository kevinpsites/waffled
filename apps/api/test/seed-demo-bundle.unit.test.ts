import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The shipped dist/seed-demo.js inlines scripts/seed-demo.ts into the bin wrapper's bundle,
// so any self-invocation in the module would run main() a second time alongside the wrapper.
const API = resolve(__dirname, '..')
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'waffled-seed-bundle-'))
  await build({
    entryPoints: { 'seed-demo': join(API, 'scripts/bin/seed-demo.ts') },
    outdir: dir,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner', '@opentelemetry/*'],
    minify: true,
    logLevel: 'silent',
  })
}, 60_000)

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('bundled seed-demo', () => {
  // A behavioural check can't see this: the first main() to fail calls process.exit and
  // masks the second. With the gate on and a reachable DB, both would seed concurrently.
  it('has no self-invocation beside the bin wrapper', () => {
    const bundle = readFileSync(join(dir, 'seed-demo.js'), 'utf8')
    expect(bundle).not.toMatch(/require\.main\s*===?\s*module/)
  })
})
