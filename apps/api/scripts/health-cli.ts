// In-container health printer for `./waffled doctor`. Runs inside waffled-api (where
// DATABASE_URL + MEDIA_DIR are set), so it reaches the DB and media volume with no
// HTTP call or admin token. Prints JSON by default, or a colored human report with
// --pretty. Exits non-zero when degraded (1) or down (2) so the CLI can flag it.
import { buildHealthReport, type Status } from '../src/modules/health/health'
import { closePool } from '../src/platform/db'

const MARK: Record<Status, string> = {
  ok: '\x1b[32m✓\x1b[0m',
  degraded: '\x1b[33m⚠\x1b[0m',
  down: '\x1b[31m✗\x1b[0m',
}

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const HINT = '\x1b[36m' // cyan

function pretty(report: Awaited<ReturnType<typeof buildHealthReport>>): string {
  const lines: string[] = []
  lines.push(`Waffled health: ${MARK[report.status]} ${report.status.toUpperCase()}  (build ${report.version.sha})`)
  const nextSteps: string[] = []
  for (const [name, check] of Object.entries(report.checks)) {
    const extras = Object.entries(check)
      .filter(([k]) => k !== 'status' && k !== 'hint')
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('  ')
    lines.push(`  ${MARK[check.status]} ${name.padEnd(12)} ${extras}`)
    const hint = (check as { hint?: string }).hint
    if (hint) {
      lines.push(`    ${HINT}↳ ${hint}${RESET}`)
      nextSteps.push(`${name}: ${hint}`)
    }
  }
  if (nextSteps.length) {
    lines.push('')
    lines.push(`${DIM}What to do:${RESET}`)
    for (const s of nextSteps) lines.push(`  • ${s}`)
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  const report = await buildHealthReport()
  process.stdout.write(process.argv.includes('--pretty') ? pretty(report) + '\n' : JSON.stringify(report))
  await closePool().catch(() => {})
  process.exit(report.status === 'ok' ? 0 : report.status === 'degraded' ? 1 : 2)
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ status: 'down', error: err instanceof Error ? err.message : String(err) }))
  process.exit(2)
})
