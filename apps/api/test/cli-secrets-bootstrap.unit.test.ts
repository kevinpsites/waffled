import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Every bundled entry runs inside the container with NODE_ENV=production and no secrets in its
// env, so each must load /data/secrets.json before config.ts asserts them at import time.
const API = resolve(__dirname, '..')
const TSX = join(API, 'node_modules', '.bin', 'tsx')

const ENTRIES: Array<{ entry: string; args: string[]; expect: RegExp }> = [
  { entry: 'src/start.ts', args: [], expect: /DATABASE_URL is not set/ },
  { entry: 'scripts/bin/admin.ts', args: ['help'], expect: /list-members/ },
  { entry: 'scripts/bin/seed-demo.ts', args: ['base'], expect: /demo seed is disabled/ },
  { entry: 'scripts/bin/health-cli.ts', args: [], expect: /"status":"down"/ },
  { entry: 'scripts/bin/migrate.ts', args: [], expect: /DATABASE_URL is not set/ },
]

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'waffled-cli-secrets-'))
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('CLI entries bootstrap secrets before config loads', () => {
  it.each(ENTRIES)('$entry', ({ entry, args, expect: pattern }) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DATA_DIR: dataDir }
    for (const k of ['LOCAL_JWT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'DATABASE_URL', 'WAFFLED_ALLOW_DEMO_SEED', 'VITEST'])
      delete env[k]
    // An unroutable port so the health check fails fast instead of finding a dev Postgres.
    if (entry.includes('health-cli')) env.DATABASE_URL = 'postgres://x:y@127.0.0.1:1/none'

    const run = spawnSync(TSX, [entry, ...args], { cwd: API, env, encoding: 'utf8', timeout: 60_000 })
    const output = `${run.stdout}\n${run.stderr}`

    expect(output).not.toMatch(/Invalid production secrets/)
    expect(output).toMatch(pattern)
    const file = join(dataDir, 'secrets.json')
    expect(existsSync(file)).toBe(true)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort()).toEqual(['LOCAL_JWT_SECRET', 'TOKEN_ENCRYPTION_KEY'])
  }, 90_000)
})
