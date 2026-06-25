// In-container health printer for `./nook doctor`. Runs inside nook-api (where
// DATABASE_URL + MEDIA_DIR are set), prints the full health report as JSON to
// stdout, and exits non-zero when degraded (1) or down (2) — so the CLI wrapper
// can pretty-print and flag it without needing an HTTP call or an admin token.
import { buildHealthReport } from '../src/modules/health/health'
import { closePool } from '../src/platform/db'

async function main(): Promise<void> {
  const report = await buildHealthReport()
  process.stdout.write(JSON.stringify(report))
  await closePool().catch(() => {})
  process.exit(report.status === 'ok' ? 0 : report.status === 'degraded' ? 1 : 2)
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ status: 'down', error: err instanceof Error ? err.message : String(err) }))
  process.exit(2)
})
