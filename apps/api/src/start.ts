// Single-image entrypoint. Config validates production secrets at import time, so
// everything that pulls it in (migrate, server) must be imported after the secrets are set.
import { loadOrCreateSecrets } from './platform/secrets'

async function main(): Promise<void> {
  loadOrCreateSecrets(process.env.DATA_DIR ?? '/data', process.env)

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
}

main().catch((err) => {
  console.error(`start: ${(err as Error).message}`)
  process.exit(1)
})
