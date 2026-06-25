// Tiny dependency-free structured logger. One JSON line per event by default
// (LOG_FORMAT=json) so `docker logs` / any aggregator can parse it; LOG_FORMAT=pretty
// gives a readable single line for local dev. Level threshold via LOG_LEVEL
// (debug|info|warn|error, default info). `.child(bindings)` returns a logger that
// stamps every line with those fields (e.g. requestId, householdId).
type Level = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

type Fields = Record<string, unknown>

export interface Logger {
  debug(msg: string, fields?: Fields): void
  info(msg: string, fields?: Fields): void
  warn(msg: string, fields?: Fields): void
  error(msg: string, fields?: Fields): void
  child(bindings: Fields): Logger
}

function threshold(): number {
  const lvl = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level
  return ORDER[lvl] ?? ORDER.info
}

function pretty(level: Level, msg: string, fields: Fields): string {
  const extras = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ')
  return `${level.toUpperCase().padEnd(5)} ${msg}${extras ? ' ' + extras : ''}`
}

// Errors don't JSON.stringify usefully — pull message/stack out.
function normalize(fields: Fields): Fields {
  const out: Fields = {}
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? { message: v.message, stack: v.stack } : v
  }
  return out
}

function emit(level: Level, msg: string, bindings: Fields, fields?: Fields): void {
  if (ORDER[level] < threshold()) return
  const merged = normalize({ ...bindings, ...(fields ?? {}) })
  const line =
    (process.env.LOG_FORMAT ?? 'json') === 'pretty'
      ? pretty(level, msg, merged)
      : JSON.stringify({ ts: new Date().toISOString(), level, msg, ...merged })
  // warn/error → stderr, the rest → stdout.
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
}

export function createLogger(bindings: Fields = {}): Logger {
  return {
    debug: (msg, fields) => emit('debug', msg, bindings, fields),
    info: (msg, fields) => emit('info', msg, bindings, fields),
    warn: (msg, fields) => emit('warn', msg, bindings, fields),
    error: (msg, fields) => emit('error', msg, bindings, fields),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  }
}

// The root logger — import and use directly, or `.child()` for request scope.
export const log: Logger = createLogger()
