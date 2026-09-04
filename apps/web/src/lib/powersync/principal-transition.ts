// Small dependency-free seam between auth and PowerSync. The API client cannot
// import db.ts directly (db.ts imports the API client for credentials), so the DB
// registers the transition handler when it boots.

export type PrincipalTransitionPolicy = 'require-no-pending' | 'discard-authorized'
export type PrincipalTransitionResult = 'completed' | 'pending-uploads' | 'purge-failed' | 'stale'

export interface PrincipalTransitionRequest {
  expectedIdentityScope: string | null
  // Some same-principal credential changes (notably refresh-token rotation) do
  // not change the identity scope. Terminal-session cleanup supplies this extra
  // guard so it cannot erase a newer rotation which won a cross-tab race.
  stillCurrent?: () => boolean
  // For server-mediated switches, obtain replacement credentials only after the
  // old replica has been proven empty and safely cleared. This prevents a local
  // pending-write refusal from mutating server-side account selection or minting
  // an unreachable replacement refresh token.
  prepareReplacement?: () => Promise<void>
  policy: PrincipalTransitionPolicy
  replacement: 'new-principal' | 'signed-out'
  // Called only after the transition has passed its pending-write preflight and
  // is about to detach the old replica. Keeping this separate from requesting a
  // transition avoids blanking the UI for a transition we refuse safely.
  beginIsolation: () => void
  // The database coordinator calls this while it still owns the origin-wide
  // exclusive transition lease. That makes started -> finished an ordered CAS,
  // rather than allowing an older transition to clobber a newer start.
  finishIsolation: () => void
  commitCredentials: () => void
}

type PrincipalTransitionHandler = (
  request: PrincipalTransitionRequest
) => Promise<PrincipalTransitionResult>

// Runtime startup registers the real database coordinator. Until then, fail
// closed: silently committing credentials would bypass the replica boundary and
// makes isolated unit tests unlike production.
let handler: PrincipalTransitionHandler = async () => 'purge-failed'

export function registerPrincipalTransitionHandler(next: PrincipalTransitionHandler): void {
  handler = next
}

export function transitionPrincipal(
  request: PrincipalTransitionRequest
): Promise<PrincipalTransitionResult> {
  return handler(request)
}

const ORIGIN_WRITE_LOCK = 'waffled:principal-replica'
const ORIGIN_REFRESH_LOCK = 'waffled:session-refresh'
const TRANSITION_SIGNAL_KEY = 'waffled.principalTransition.v1'

interface TransitionSignal {
  id: string
  state: 'started' | 'finished'
  at: number
}

function signalId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  } catch {
    /* older embedded browsers */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

// Web Locks span every same-origin tab. Local counters still provide a fast path
// and deterministic fallback in older browsers; the cross-tab lock prevents a
// second kiosk tab from starting a write between another tab's queue probe and
// destructive clear.
async function withNamedOriginLock<T>(
  name: string,
  mode: 'shared' | 'exclusive',
  operation: () => Promise<T>
): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) return operation()
  return navigator.locks.request(name, { mode }, operation)
}

export function withPrincipalTransitionLock<T>(operation: () => Promise<T>): Promise<T> {
  return withNamedOriginLock(ORIGIN_WRITE_LOCK, 'exclusive', operation)
}

export function withPrincipalUseLock<T>(operation: () => Promise<T>): Promise<T> {
  return withNamedOriginLock(ORIGIN_WRITE_LOCK, 'shared', operation)
}

// Refresh tokens rotate and are commonly single-use. Serialize that rotation
// across tabs independently from the replica lock. Principal transitions take
// the replica lock first and this lock second; never invert that order.
export function withSessionRefreshLock<T>(operation: () => Promise<T>): Promise<T> {
  return withNamedOriginLock(ORIGIN_REFRESH_LOCK, 'exclusive', operation)
}

function persistedTransitionSignal(): TransitionSignal | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(TRANSITION_SIGNAL_KEY)
    if (!raw) return null
    const signal = JSON.parse(raw) as Partial<TransitionSignal>
    if (typeof signal.id !== 'string' ||
        (signal.state !== 'started' && signal.state !== 'finished') ||
        typeof signal.at !== 'number') return null
    return signal as TransitionSignal
  } catch {
    return null
  }
}

export function principalTransitionInProgress(): boolean {
  const signal = persistedTransitionSignal()
  return signal?.state === 'started'
}

export function activePrincipalTransitionId(): string | null {
  const signal = persistedTransitionSignal()
  return signal?.state === 'started' ? signal.id : null
}

export function waitForPrincipalTransition(): Promise<void> {
  const observed = persistedTransitionSignal()
  if (observed?.state !== 'started' || typeof window === 'undefined') return Promise.resolve()
  const retireIfAbandoned = () => {
    const current = persistedTransitionSignal()
    if (current?.state === 'started' && current.id === observed.id) {
      broadcastPrincipalTransitionFinished(observed.id)
    }
  }
  // The originating tab holds this exclusively for the whole privacy boundary.
  // Acquiring a shared lease proves it finished or the browser released its lock
  // after a crash. Retire an abandoned marker so startup cannot reload forever.
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(ORIGIN_WRITE_LOCK, { mode: 'shared' }, () => {
      retireIfAbandoned()
    })
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const finish = () => {
      window.removeEventListener('storage', onStorage)
      clearTimeout(timer)
      resolve()
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === TRANSITION_SIGNAL_KEY && !principalTransitionInProgress()) finish()
    }
    window.addEventListener('storage', onStorage)
    // Without Web Locks, elapsed time cannot distinguish a crashed origin from a
    // legitimately slow clear. Stay fail-closed instead of exposing the prior
    // principal while destructive cleanup may still be running.
    timer = setTimeout(() => {
      window.removeEventListener('storage', onStorage)
      reject(new Error('Timed out waiting for the principal transition to finish safely.'))
    }, 30_000)
  })
}

export function broadcastPrincipalTransitionStarted(): string | null {
  if (typeof localStorage === 'undefined') return null
  const id = signalId()
  const signal: TransitionSignal = { id, state: 'started', at: Date.now() }
  try {
    localStorage.setItem(TRANSITION_SIGNAL_KEY, JSON.stringify(signal))
    return id
  } catch {
    return null
  }
}

export function broadcastPrincipalTransitionFinished(id: string | null): void {
  if (!id || typeof localStorage === 'undefined') return
  const signal: TransitionSignal = { id, state: 'finished', at: Date.now() }
  try {
    const current = persistedTransitionSignal()
    if (current?.state === 'started' && current.id === id) {
      localStorage.setItem(TRANSITION_SIGNAL_KEY, JSON.stringify(signal))
    }
  } catch { /* best effort */ }
}

export function onRemotePrincipalTransition(
  listener: (signal: TransitionSignal) => void
): () => void {
  if (typeof window === 'undefined') return () => {}
  const onStorage = (event: StorageEvent) => {
    if (event.key !== TRANSITION_SIGNAL_KEY || !event.newValue) return
    try {
      const signal = JSON.parse(event.newValue) as Partial<TransitionSignal>
      if (typeof signal.id === 'string' &&
          (signal.state === 'started' || signal.state === 'finished') &&
          typeof signal.at === 'number') {
        listener(signal as TransitionSignal)
      }
    } catch {
      /* malformed cross-tab signal */
    }
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}

// Local event writes span several awaits and SQL statements. A transition first
// freezes admission, then waits for every writer which already acquired a lease.
// That closes the check-empty -> new-write -> destructive-clear race.
let writesFrozen = false
let activeWriters = 0
let drainWaiters: Array<() => void> = []

export async function withLocalWriteLease(operation: () => Promise<boolean>): Promise<boolean> {
  return withNamedOriginLock(ORIGIN_WRITE_LOCK, 'shared', async () => {
    if (writesFrozen) return false
    activeWriters++
    try {
      return await operation()
    } finally {
      activeWriters--
      if (activeWriters === 0) {
        const waiters = drainWaiters
        drainWaiters = []
        for (const resume of waiters) resume()
      }
    }
  })
}

export function freezeLocalWrites(): () => void {
  writesFrozen = true
  return () => { writesFrozen = false }
}

export function waitForLocalWritesToDrain(): Promise<void> {
  if (activeWriters === 0) return Promise.resolve()
  return new Promise((resolve) => drainWaiters.push(resolve))
}
