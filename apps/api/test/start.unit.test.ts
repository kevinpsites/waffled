import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const API = resolve(__dirname, '..')

describe('start.ts without a database', () => {
  it('exits 1 with a start: message when migrations cannot run', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'waffled-start-unit-'))
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env, NODE_ENV: 'production', DATA_DIR: dataDir,
        DATABASE_URL: 'postgres://x:y@127.0.0.1:1/none',
      }
      for (const k of ['LOCAL_JWT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'VITEST']) delete env[k]
      const run = spawnSync(join(API, 'node_modules', '.bin', 'tsx'), ['src/start.ts'], {
        cwd: API, env, encoding: 'utf8', timeout: 60_000,
      })
      expect(run.status).toBe(1)
      expect(run.stderr).toMatch(/^start: .*ECONNREFUSED/m)
      expect(run.stdout).not.toMatch(/listening/)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 90_000)

  it('the image puts migrations where dist/start.js resolves them (../migrations)', () => {
    const dockerfile = readFileSync(resolve(API, '..', '..', 'Dockerfile'), 'utf8')
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '))
    expect(runtime).toMatch(/^WORKDIR \/app$/m)
    expect(runtime).toMatch(/^COPY --from=api \/app\/dist \.\/dist$/m)
    expect(runtime).toMatch(/^COPY --from=api \/app\/migrations \.\/migrations$/m)
    expect(runtime).toMatch(/^CMD \["node", "dist\/start\.js"\]$/m)
  })
})
