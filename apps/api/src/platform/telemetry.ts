// Soft OpenTelemetry accessor for the bundled app. The SDK is started ONLY by the
// dist/otel.js preload (and only when OTEL_EXPORTER_OTLP_ENDPOINT is set). This
// module reaches the GLOBAL meter/tracer the preload registers — they're shared
// because @opentelemetry/api is kept external (a single node_modules instance) in
// esbuild. When OTEL isn't installed/active, the API hands back no-op meter/tracer
// and these helpers cost almost nothing, so call sites use them unconditionally.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
import type { JobRecord } from './jobs'

let api: any
function otel(): any {
  if (api === undefined) {
    try {
      api = require('@opentelemetry/api')
    } catch {
      api = null
    }
  }
  return api
}

let meterCache: any
function meter(): any {
  if (meterCache === undefined) {
    const a = otel()
    meterCache = a ? a.metrics.getMeter('waffled-api') : null
  }
  return meterCache
}

let tracerCache: any
function tracer(): any {
  if (tracerCache === undefined) {
    const a = otel()
    tracerCache = a ? a.trace.getTracer('waffled-api') : null
  }
  return tracerCache
}

let jobDur: any
let jobErr: any
export function recordJobRun(rec: JobRecord): void {
  const m = meter()
  if (!m) return
  if (!jobDur) {
    jobDur = m.createHistogram('waffled.job.duration_ms')
    jobErr = m.createCounter('waffled.job.errors')
  }
  jobDur.record(rec.lastDurationMs ?? 0, { job: rec.name, ok: rec.lastError ? 'false' : 'true' })
  if (rec.lastError) jobErr.add(1, { job: rec.name })
}

let httpCounter: any
export function recordHttpRequest(attrs: { method?: string; status?: number }): void {
  const m = meter()
  if (!m) return
  if (!httpCounter) httpCounter = m.createCounter('waffled.http.requests')
  // Coarse labels only (method + status) to avoid path cardinality explosion.
  httpCounter.add(1, { method: attrs.method ?? 'UNKNOWN', status: String(attrs.status ?? 0) })
}

// Wrap a DB query in a span when a tracer is active; otherwise just run fn().
export async function traceDb<T>(sql: string, fn: () => Promise<T>): Promise<T> {
  const t = tracer()
  if (!t) return fn()
  const a = otel()
  return t.startActiveSpan('db.query', async (span: any) => {
    span.setAttribute('db.system', 'postgresql')
    span.setAttribute('db.statement', sql.slice(0, 200))
    try {
      return await fn()
    } catch (err) {
      if (a?.SpanStatusCode) span.setStatus({ code: a.SpanStatusCode.ERROR })
      throw err
    } finally {
      span.end()
    }
  })
}
