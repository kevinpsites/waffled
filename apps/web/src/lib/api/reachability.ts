// Is the Waffled server answering at all? Distinct from `navigator.onLine` (the
// DEVICE's link) — a stopped server on a healthy network leaves every screen empty
// with nothing to explain it. The fetch wrappers in ./client report each outcome
// here; the banner and the AuthGate read the result.
//
// Two outcomes only: the server ANSWERED (any status it chose, including 401/404/500
// — those are the app's own problems) or it DID NOT (fetch rejected, or a gateway
// answered 502/503/504 because the proxy is up and the api behind it is not).
import { useSyncExternalStore } from 'react'

export type Reachability = 'reachable' | 'unreachable'
export type Answer = 'answered' | 'no-answer'

/** Screens refetch on this (see useLiveRefresh) when the server comes back. */
export const SERVER_REACHABLE_EVENT = 'waffled:server-reachable'

/**
 * Every probe's own verdict, `{ answered: boolean }` — dispatched whether or not it
 * moved the state. A screen that is waiting out an outage inside the grace window
 * has no transition to listen for, but it does have this.
 */
export const SERVER_PROBE_EVENT = 'waffled:server-probe'

/** A lone non-answer this old, or two in a row, is an outage rather than a blip. */
export const UNREACHABLE_GRACE_MS = 3000
export const PROBE_FAST_MS = 5000
export const PROBE_SLOW_MS = 15_000
export const PROBE_BACKOFF_AFTER_MS = 60_000
export const PROBE_TIMEOUT_MS = 4000

// Not the api's own `/healthz`: Caddy answers that itself (`respond /healthz "ok"`)
// and only forwards `/api/*`, so it would report "reachable" with the api stopped —
// the exact case this store exists for. /api/auth/status is public and pre-session.
export const PROBE_PATH = '/api/auth/status'

interface Deps {
  now: () => number
  fetch: typeof fetch
}
const defaults: Deps = { now: () => Date.now(), fetch: (...a) => globalThis.fetch(...a) }
let deps: Deps = { ...defaults }

let state: Reachability = 'reachable'
let consecutiveNoAnswers = 0
let unreachableSince = 0
let graceTimer: ReturnType<typeof setTimeout> | undefined
let probeTimer: ReturnType<typeof setTimeout> | undefined
// Bumped by every reset. A probe that was in flight across one belongs to the store
// that asked for it, not the one that exists when it finally answers.
let generation = 0
const listeners = new Set<() => void>()

export function isGatewayStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504
}

// A gateway status is silence only when the body isn't ours. The api itself answers
// 502 in its JSON envelope when an upstream IT called failed (recipe ingest, Open
// Food Facts) — it is plainly alive when it does. A proxy's own gateway error is
// text/plain or empty.
export function isNoAnswer(status: number, contentType?: string | null): boolean {
  return isGatewayStatus(status) && !(contentType ?? '').toLowerCase().includes('application/json')
}

function notify(): void {
  for (const l of [...listeners]) l()
}

function clearTimers(): void {
  if (graceTimer !== undefined) clearTimeout(graceTimer)
  if (probeTimer !== undefined) clearTimeout(probeTimer)
  graceTimer = undefined
  probeTimer = undefined
}

function becomeUnreachable(): void {
  if (state === 'unreachable') return
  // A flip armed before the Wi-Fi dropped must not land during the offline window:
  // it would stamp `unreachableSince`, and the backoff would still be counting when
  // the link returns — up to 15s of outage strip over a server that never stopped.
  if (deviceOffline()) {
    consecutiveNoAnswers = 0
    return
  }
  state = 'unreachable'
  unreachableSince = deps.now()
  clearTimers()
  scheduleProbe()
  notify()
}

function becomeReachable(): void {
  consecutiveNoAnswers = 0
  if (state === 'reachable') {
    clearTimers()
    return
  }
  state = 'reachable'
  clearTimers()
  notify()
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SERVER_REACHABLE_EVENT))
}

function scheduleProbe(): void {
  if (probeTimer !== undefined) return
  const settledIn = state === 'unreachable' && deps.now() - unreachableSince >= PROBE_BACKOFF_AFTER_MS
  probeTimer = setTimeout(() => {
    probeTimer = undefined
    void probe()
  }, settledIn ? PROBE_SLOW_MS : PROBE_FAST_MS)
}

/**
 * Keep the probe loop running for a screen that depends on it (the AuthGate's
 * outage screen), at this store's cadence rather than a second one of its own.
 * Changes no state: an answered probe ends the loop by itself.
 */
export function ensureProbing(): void {
  scheduleProbe()
}

// A probe that never comes back is silence, not a pause: a hung connection would
// otherwise leave Retry spinning with no next probe scheduled. The abort tears the
// socket down; the race is what makes the deadline hold even when it doesn't.
// (Deliberately our own timer rather than AbortSignal.timeout, which fake timers in
// the specs cannot drive.)
async function fetchWithDeadline(): Promise<Response> {
  const control = new AbortController()
  let expire!: (reason: Error) => void
  const timedOut = new Promise<never>((_resolve, reject) => {
    expire = reject
  })
  const timer = setTimeout(() => {
    control.abort()
    expire(new Error('probe timed out'))
  }, PROBE_TIMEOUT_MS)
  try {
    return await Promise.race([
      deps.fetch(PROBE_PATH, { method: 'GET', cache: 'no-store', signal: control.signal }),
      timedOut,
    ])
  } finally {
    clearTimeout(timer)
  }
}

// A probe is just another request: it answers or it doesn't, and it feeds the same
// state machine. Returns this probe's own verdict, which a caller may need before the
// debounced state has caught up (see the AuthGate's Retry).
async function probe(): Promise<Answer> {
  const gen = generation
  let answered = false
  try {
    const res = await fetchWithDeadline()
    answered = !isNoAnswer(res.status, res.headers?.get('content-type'))
  } catch {
    answered = false
  }
  if (gen !== generation) return answered ? 'answered' : 'no-answer'
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SERVER_PROBE_EVENT, { detail: { answered } }))
  }
  if (answered) {
    becomeReachable()
    return 'answered'
  }
  // reportNetworkFailure is the no-op it should be once the outage is admitted; the
  // reschedule is what keeps the loop alive when it hasn't been (a screen probing
  // through the grace window, or a device the store refuses to blame the server for).
  reportNetworkFailure()
  scheduleProbe()
  return 'no-answer'
}

/** Record that the server answered with `status`; returns how that was classified. */
export function reportStatus(status: number, contentType?: string | null): Answer {
  if (!isNoAnswer(status, contentType)) {
    becomeReachable()
    return 'answered'
  }
  return reportNetworkFailure()
}

/** The device's own link is down — nothing a request fails at is the server's fault. */
function deviceOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/** Record that a request never got an answer (fetch rejected, or a gateway status). */
export function reportNetworkFailure(): Answer {
  if (deviceOffline()) return 'no-answer'
  if (state === 'unreachable') return 'no-answer'
  consecutiveNoAnswers += 1
  if (consecutiveNoAnswers >= 2) {
    becomeUnreachable()
  } else if (graceTimer === undefined) {
    graceTimer = setTimeout(() => {
      graceTimer = undefined
      becomeUnreachable()
    }, UNREACHABLE_GRACE_MS)
  }
  return 'no-answer'
}

export function getServerReachability(): Reachability {
  return state
}

export function subscribeServerReachability(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The Retry button: probe now rather than waiting out the current interval. */
export function probeServerNow(): Promise<Answer> {
  if (probeTimer !== undefined) {
    clearTimeout(probeTimer)
    probeTimer = undefined
  }
  return probe()
}

// The link is back: ask straight away rather than sitting out a backoff step that
// was counting through a window in which nothing could have answered anyway.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (state !== 'unreachable') return
    unreachableSince = deps.now()
    void probeServerNow()
  })
}

export function useServerReachability(): Reachability {
  return useSyncExternalStore(subscribeServerReachability, getServerReachability, () => 'reachable' as const)
}

// The debounced store deliberately stays `reachable` through the first non-answer, so
// a caller that must react to ITS OWN failed call (the AuthGate, which would otherwise
// render a login form nobody can use) needs the per-call verdict. Tagging the thrown
// error carries it without changing any existing error's shape or message.
const UNANSWERED = Symbol.for('waffled.unanswered')

export function markUnanswered<T>(err: T): T {
  if (err && typeof err === 'object') (err as Record<symbol, unknown>)[UNANSWERED] = true
  return err
}

export function isUnansweredError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as Record<symbol, unknown>)[UNANSWERED] === true
}

/** Test seam: the store owns a clock and a fetch. */
export function configureReachability(overrides: Partial<Deps>): void {
  deps = { ...deps, ...overrides }
}

export function resetReachability(): void {
  generation += 1
  clearTimers()
  deps = { ...defaults }
  state = 'reachable'
  consecutiveNoAnswers = 0
  unreachableSince = 0
}
