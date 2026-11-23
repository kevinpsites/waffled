// Single-image entrypoint: secrets bootstrap -> migrate -> server. Everything after the
// bootstrap is imported dynamically (see platform/bootstrap-secrets.ts).
import { withSecrets } from './platform/bootstrap-secrets'

withSecrets('start', async () => {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is not set')

  const { parseLockTimeout, runMigrations } = await import('./migrate')
  const { resolve } = await import('node:path')
  // esbuild's CJS output leaves import.meta empty, so pass the migrations dir explicitly.
  await runMigrations(databaseUrl, resolve(__dirname, '..', 'migrations'), Infinity, undefined, {
    lockTimeoutMs: parseLockTimeout(process.env.MIGRATE_LOCK_TIMEOUT),
    log: (message) => console.warn(`migrate: ${message}`),
  })

  await import('./server')
})
