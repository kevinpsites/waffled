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
import { resolve } from 'node:path'
import { runMigrations } from '../src/migrate'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('migrate: DATABASE_URL is not set')
  process.exit(1)
}

// Resolve the migrations dir relative to this bundled file. esbuild emits CJS, so
// __dirname is the real on-disk location of dist/migrate.js (e.g. /app/dist) — the
// Dockerfile copies migrations to /app/migrations alongside it. (import.meta is
// empty in CJS output, which is why we don't lean on the module's ESM default.)
const migrationsDir = resolve(__dirname, '..', 'migrations')

runMigrations(databaseUrl, migrationsDir)
  .then(() => {
    console.log('migrate: schema up to date')
    process.exit(0)
  })
  .catch((err) => {
    console.error('migrate: failed', err)
    process.exit(1)
  })
