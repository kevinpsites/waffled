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
  count = Infinity
): Promise<void> {
  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count,
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
