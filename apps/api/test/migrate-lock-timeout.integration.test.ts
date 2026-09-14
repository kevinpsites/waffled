// runMigrations under lock contention: a session holding a conflicting lock must make
// migrate fail fast with the blocker named, retry while the blocker clears, and never
// retry an ordinary SQL error. Each test gets its own database and a throwaway
// migrations dir of tiny .sql files.
import { describe, it, expect } from 'vitest'
import { Client } from 'pg'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PostgreSqlContainer } from './helpers/pg'
import { runMigrations } from '../src/migrate'

const TEST_TIMEOUT = 20_000

async function withDb<T>(
  migrations: Record<string, string>,
  fn: (url: string, dir: string) => Promise<T>
): Promise<T> {
  const pg = await new PostgreSqlContainer().start()
  const dir = await mkdtemp(join(tmpdir(), 'waffled-migrate-lock-'))
  try {
    for (const [name, sql] of Object.entries(migrations)) {
      await writeFile(join(dir, name), `-- Up Migration\n${sql}\n`)
    }
    return await fn(pg.getConnectionUri(), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await pg.stop()
  }
}

async function connect(url: string): Promise<Client> {
  const c = new Client({ connectionString: url })
  await c.connect()
  return c
}

async function appliedMigrations(url: string): Promise<string[]> {
  const c = await connect(url)
  try {
    const exists = await c.query(`select to_regclass('pgmigrations') is not null as ok`)
    if (!exists.rows[0].ok) return []
    const res = await c.query<{ name: string }>('select name from pgmigrations order by id')
    return res.rows.map((r) => r.name)
  } finally {
    await c.end()
  }
}

// Opens a transaction that holds ACCESS SHARE on `table`, which any ALTER TABLE waits on.
async function holdLock(url: string, table: string): Promise<{ pid: number; release(): Promise<void> }> {
  const c = await connect(url)
  await c.query(`create table if not exists ${table} (id int)`)
  const { rows } = await c.query<{ pid: number }>('select pg_backend_pid() as pid')
  await c.query('begin')
  await c.query(`lock table ${table} in access share mode`)
  let released = false
  return {
    pid: rows[0].pid,
    release: async () => {
      if (released) return
      released = true
      await c.query('rollback').catch(() => {})
      await c.end()
    },
  }
}

describe('runMigrations — lock_timeout', () => {
  it(
    'applies the lock timeout to the session every migration runs in',
    () =>
      withDb(
        {
          '001_probe.sql': `create table probe (v text); insert into probe select current_setting('lock_timeout');`,
          '002_probe_again.sql': `insert into probe select current_setting('lock_timeout');`,
        },
        async (url, dir) => {
          await runMigrations(url, dir, Infinity, true, { lockTimeoutMs: 300 })
          const c = await connect(url)
          try {
            const res = await c.query<{ v: string }>('select v from probe')
            expect(res.rows.map((r) => r.v)).toEqual(['300ms', '300ms'])
          } finally {
            await c.end()
          }
        }
      ),
    TEST_TIMEOUT
  )

  it(
    'fails within bounded time naming the blocking session when the lock never frees',
    () =>
      withDb({ '001_alter.sql': 'alter table contended add column extra int;' }, async (url, dir) => {
        const blocker = await holdLock(url, 'contended')
        const logs: string[] = []
        const started = Date.now()
        try {
          const err = await runMigrations(url, dir, Infinity, false, {
            lockTimeoutMs: 300,
            retries: 1,
            backoffMs: 50,
            log: (m) => logs.push(m),
          }).then(
            () => {
              throw new Error('expected runMigrations to reject')
            },
            (e: Error) => e
          )
          expect(Date.now() - started).toBeLessThan(10_000)
          expect(err.message).toMatch(/lock timeout/i)
          expect(err.message).toContain('contended')
          expect(err.message).toContain(`pid ${blocker.pid}`)
          expect(err.message).toMatch(/powersync/)
          expect(logs.some((m) => /retrying/i.test(m))).toBe(true)
        } finally {
          await blocker.release()
        }
        expect(await appliedMigrations(url)).not.toContain('001_alter')
      }),
    TEST_TIMEOUT
  )

  it(
    'retries and succeeds once the blocker releases (advisory lock on)',
    () =>
      withDb({ '001_alter.sql': 'alter table contended add column extra int;' }, async (url, dir) => {
        const blocker = await holdLock(url, 'contended')
        const releasing = new Promise<void>((resolve) =>
          setTimeout(() => void blocker.release().then(resolve), 900)
        )
        const logs: string[] = []
        try {
          await runMigrations(url, dir, Infinity, false, {
            lockTimeoutMs: 300,
            retries: 6,
            backoffMs: 100,
            log: (m) => logs.push(m),
          })
        } finally {
          await releasing
        }
        expect(logs.some((m) => /retrying/i.test(m))).toBe(true)
        expect(await appliedMigrations(url)).toContain('001_alter')
      }),
    TEST_TIMEOUT
  )

  it(
    'does not retry a non-lock SQL error',
    () =>
      withDb({ '001_broken.sql': 'select 1/0;' }, async (url, dir) => {
        const logs: string[] = []
        const started = Date.now()
        await expect(
          runMigrations(url, dir, Infinity, true, {
            lockTimeoutMs: 300,
            retries: 3,
            backoffMs: 5_000,
            log: (m) => logs.push(m),
          })
        ).rejects.toThrow(/division by zero/)
        expect(Date.now() - started).toBeLessThan(4_000)
        expect(logs).toEqual([])
      }),
    TEST_TIMEOUT
  )
})
