// Programmatic migration runner — used by tests and importable elsewhere.
// The CLI path (`npm run migrate` → node-pg-migrate) is what runs against the
// live stack; this wrapper points the same migrations at an arbitrary database
// (e.g. a Testcontainers Postgres).
import { runner } from 'node-pg-migrate'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Default location of the .sql migrations, relative to this module. This branch
// only runs under tsx/vitest (real ESM, so import.meta.url is valid). The bundled
// CJS CLI (dist/migrate.js) passes an explicit dir instead, because esbuild's CJS
// output leaves import.meta empty — see scripts/migrate-cli.ts.
function defaultMigrationsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
}

// `count` limits how many *pending* migrations to apply (default: all). Tests use
// it to migrate up to just before a new migration, seed legacy-shaped data, then
// run the remaining migration(s) to exercise a backfill.
export async function runMigrations(
  databaseUrl: string,
  migrationsDir = defaultMigrationsDir(),
  count = Infinity,
  // node-pg-migrate takes a *cluster-wide* advisory lock (a fixed lock id) while it
  // migrates, so two migrate runs against the same Postgres instance serialize even
  // when they target different databases. That lock guards the live stack (the compose
  // migrate one-shot could race a restart), so it stays ON by default. But the test
  // harness gives every file its own freshly-created, single-writer database, so the
  // lock only throttles parallelism there with nothing to protect — the shared-Postgres
  // vitest run opts out via WAFFLED_TEST_SHARED_PG so migrations run truly concurrently.
  noLock = process.env.WAFFLED_TEST_SHARED_PG === '1'
): Promise<void> {
  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count,
    noLock,
    // Tolerate out-of-order application. Feature branches are developed in parallel,
    // so a DB can legitimately have a later-sorted migration applied while an earlier
    // one is still pending (e.g. two branches each add a migration, then one deploys
    // first). Strict ordering wedges that DB with "Not run migration X is preceding
    // already run migration Y"; with checkOrder off, the pending ones just run. The
    // CI duplicate-number guard + the CLAUDE.md rule keep numbering collisions out in
    // the first place — this is the safety net for a DB that already diverged.
    checkOrder: false,
    log: () => {}, // quiet; the CLI is the verbose path
  })
}
