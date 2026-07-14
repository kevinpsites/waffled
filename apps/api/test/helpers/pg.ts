// Drop-in replacement for `@testcontainers/postgresql`'s `PostgreSqlContainer`.
//
// The whole suite used to boot one ephemeral Postgres *per test file* (~50 serial
// container starts — the dominant cost of the api job). Instead, `test/global-setup.ts`
// boots a SINGLE Postgres once for the entire run and hands its admin connection string
// to the workers via vitest's provide/inject. This shim keeps the exact surface the test
// files already use — `new PostgreSqlContainer('postgres:16').start()` → `getConnectionUri()`
// / `stop()` — but `.start()` carves a uniquely-named database out of that shared cluster,
// and `.stop()` drops it. So each file still gets a pristine, isolated database (migrations
// run into it independently), files no longer contend on Docker, and file parallelism can be
// turned back on. The only change a test file needs is swapping its import to this module.
import { inject } from 'vitest'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'

export type StartedPostgreSqlContainer = {
  getConnectionUri(): string
  stop(): Promise<void>
}

function uriForDb(baseUri: string, db: string): string {
  const u = new URL(baseUri)
  u.pathname = `/${db}`
  return u.toString()
}

export class PostgreSqlContainer {
  // The image arg is ignored — the shared container in global-setup owns the image.
  constructor(_image?: string) {}

  async start(): Promise<StartedPostgreSqlContainer> {
    const adminUri = inject('pgAdminUri')
    const dbName = `test_${randomUUID().replace(/-/g, '')}`

    const admin = new Client({ connectionString: adminUri })
    await admin.connect()
    try {
      await admin.query(`create database "${dbName}"`)
    } finally {
      await admin.end()
    }

    const uri = uriForDb(adminUri, dbName)
    return {
      getConnectionUri: () => uri,
      stop: async () => {
        const c = new Client({ connectionString: adminUri })
        await c.connect()
        try {
          // Kick any lingering sessions (a pool that wasn't fully drained) so the
          // drop can't fail with "database is being accessed by other users".
          await c.query(
            `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
            [dbName]
          )
          await c.query(`drop database if exists "${dbName}"`)
        } finally {
          await c.end()
        }
      },
    }
  }
}
