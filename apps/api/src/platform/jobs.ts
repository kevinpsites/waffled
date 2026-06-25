// In-memory run registry for the background schedulers (calendar sync, recurrence
// expansion, chore-proof cleanup). Records last-run timing/result/error + a run
// count + an in-flight flag, so /api/health and `./nook doctor` can answer "are the
// jobs running, and did the last run fail?" State is process-local (reset on
// restart) — that's fine; health is about "right now". `runJob` also subsumes the
// per-scheduler `running` overlap guard.

export interface JobRecord {
  name: string
  lastRunAt: string | null
  lastDurationMs: number | null
  lastError: string | null
  lastResult: unknown
  runCount: number
  running: boolean
}

const registry = new Map<string, JobRecord>()

function ensure(name: string): JobRecord {
  let rec = registry.get(name)
  if (!rec) {
    rec = { name, lastRunAt: null, lastDurationMs: null, lastError: null, lastResult: null, runCount: 0, running: false }
    registry.set(name, rec)
  }
  return rec
}

// Pre-register a job so it appears in health snapshots before its first run.
export function registerJob(name: string): void {
  ensure(name)
}

// Wrap a scheduler tick: skip if a prior run is still in flight (returns
// undefined), otherwise time it and record the outcome. Re-throws so the caller's
// own catch can log — the record is updated either way.
export async function runJob<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const rec = ensure(name)
  if (rec.running) return undefined
  rec.running = true
  const start = Date.now()
  try {
    const result = await fn()
    rec.lastResult = result
    rec.lastError = null
    return result
  } catch (err) {
    rec.lastError = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    rec.lastDurationMs = Date.now() - start
    rec.lastRunAt = new Date().toISOString()
    rec.runCount += 1
    rec.running = false
  }
}

export function jobSnapshots(): JobRecord[] {
  return [...registry.values()]
}
