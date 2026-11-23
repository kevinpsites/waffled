// The single-image entrypoint (src/start.ts): secrets bootstrap -> migrate -> server.
// Spawned as a real process so the ordering and exit codes are what an operator sees.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'

const API = resolve(__dirname, '..')
const TSX = join(API, 'node_modules', '.bin', 'tsx')
const MIGRATION_COUNT = readdirSync(join(API, 'migrations')).filter((f) => f.endsWith('.sql')).length

let pg: StartedPostgreSqlContainer
let dataDir: string
let child: ChildProcess | undefined

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => done(port))
    })
  })
}

function startEntry(port: number): { exit: Promise<number | null>; output: () => string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env, NODE_ENV: 'production', DATA_DIR: dataDir, DATABASE_URL: pg.getConnectionUri(),
    PORT: String(port), HOST: '127.0.0.1',
  }
  for (const k of ['LOCAL_JWT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'VITEST', 'WAFFLED_TEST_SHARED_PG']) delete env[k]
  let out = ''
  child = spawn(TSX, ['src/start.ts'], { cwd: API, env })
  child.stdout?.on('data', (d) => (out += d))
  child.stderr?.on('data', (d) => (out += d))
  const exit = new Promise<number | null>((done) => child!.once('exit', (code) => done(code)))
  return { exit, output: () => out }
}

async function appliedMigrations(): Promise<number> {
  const c = new Client({ connectionString: pg.getConnectionUri() })
  await c.connect()
  try {
    return Number((await c.query('select count(*) from pgmigrations')).rows[0].count)
  } finally {
    await c.end()
  }
}

beforeEach(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  dataDir = mkdtempSync(join(tmpdir(), 'waffled-start-'))
})

afterEach(async () => {
  if (child && child.exitCode === null) {
    const gone = new Promise((done) => child!.once('exit', done))
    child.kill('SIGTERM')
    await gone
  }
  child = undefined
  rmSync(dataDir, { recursive: true, force: true })
  await pg.stop()
})

describe('start.ts', () => {
  it('applies every migration from apps/api/migrations before the server answers', async () => {
    const port = await freePort()
    const run = startEntry(port)
    const deadline = Date.now() + 90_000
    let healthy = false
    while (!healthy && Date.now() < deadline && child!.exitCode === null) {
      healthy = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false)
      if (!healthy) await new Promise((r) => setTimeout(r, 200))
    }
    expect(healthy, run.output()).toBe(true)
    // Checked at the first moment the server answers: migrations must already be complete.
    expect(await appliedMigrations()).toBe(MIGRATION_COUNT)
  }, 120_000)

  it('exits non-zero and never listens when a migration fails', async () => {
    const c = new Client({ connectionString: pg.getConnectionUri() })
    await c.connect()
    await c.query('create table households (conflict int)')
    await c.end()

    const port = await freePort()
    const run = startEntry(port)
    const code = await run.exit
    expect(code).not.toBe(0)
    expect(run.output()).toMatch(/start:/)
    expect(await fetch(`http://127.0.0.1:${port}/healthz`).then(() => true, () => false)).toBe(false)
  }, 120_000)
})
