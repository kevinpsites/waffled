// Programmatic migration runner — used by tests and importable elsewhere.
// The CLI path (`npm run migrate` → node-pg-migrate) is what runs against the
// live stack; this wrapper points the same migrations at an arbitrary database
// (e.g. a Testcontainers Postgres).
import { runner } from 'node-pg-migrate'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

export async function runMigrations(databaseUrl: string): Promise<void> {
  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: Infinity,
    log: () => {}, // quiet; the CLI is the verbose path
  })
}
