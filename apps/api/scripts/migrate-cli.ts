// In-container migration runner. The lean runtime image carries no node_modules,
// so the `node-pg-migrate` CLI isn't available there — this entry is bundled to
// dist/migrate.js (esbuild) and run by the compose `migrate` one-shot service:
//
//   node dist/migrate.js
//
// It applies every pending migration against DATABASE_URL, then exits 0 (so a
// `service_completed_successfully` dependency lets the api + powersync start only
// after the schema — and the PowerSync publication — exist). Idempotent: already
// applied migrations are skipped, so it's safe to run on every `compose up`.
//
// MIGRATE_LOCK_TIMEOUT (ms, or e.g. 30s / 2min; 0 waits forever) bounds each lock
// wait — see src/migrate.ts.
import { resolve } from 'node:path'
import { parseLockTimeout, runMigrations } from '../src/migrate'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('migrate: DATABASE_URL is not set')
  process.exit(1)
}

let lockTimeoutMs: number
try {
  lockTimeoutMs = parseLockTimeout(process.env.MIGRATE_LOCK_TIMEOUT)
} catch (err) {
  console.error(`migrate: ${(err as Error).message}`)
  process.exit(1)
}

// Resolve the migrations dir relative to this bundled file. esbuild emits CJS, so
// __dirname is the real on-disk location of dist/migrate.js (e.g. /app/dist) — the
// Dockerfile copies migrations to /app/migrations alongside it. (import.meta is
// empty in CJS output, which is why we don't lean on the module's ESM default.)
const migrationsDir = resolve(__dirname, '..', 'migrations')

runMigrations(databaseUrl, migrationsDir, Infinity, undefined, {
  lockTimeoutMs,
  log: (message) => console.warn(`migrate: ${message}`),
})
  .then(() => {
    console.log('migrate: schema up to date')
    process.exit(0)
  })
  .catch((err) => {
    console.error('migrate: failed', err)
    process.exit(1)
  })
