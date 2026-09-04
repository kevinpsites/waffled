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
const ORIGIN_KIOSK_DEVICE_LOCK = 'waffled:kiosk-device'
const TRANSITION_SIGNAL_KEY = 'waffled.principalTransition.v1'

interface TransitionSignal {
  id: string
  state: 'started' | 'finished'
  at: number
}

type LocalTransitionOutcome = 'finished' | 'failed'

// localStorage is the cross-tab advisory channel, but it can be unavailable or
// full. Keep the initiating tab gated from the synchronous start event through
// the exact matching completion even when persisting that advisory signal fails.
let localTransitionId: string | null = null
const localTransitionCompletions = new Map<string, {
  promise: Promise<LocalTransitionOutcome>
  resolve: (outcome: LocalTransitionOutcome) => void
}>()

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

export function originWideLockingAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.locks
}

export function withPrincipalTransitionLock<T>(operation: () => Promise<T>): Promise<T> {
  // An exclusive replica transition is destructive. A process-local fallback
  // cannot exclude writers in another tab, so browsers without Web Locks must
  // refuse the transition instead of pretending the privacy boundary exists.
  if (!originWideLockingAvailable()) {
    return Promise.reject(new Error('This browser cannot safely isolate the local replica.'))
  }
  return withNamedOriginLock(ORIGIN_WRITE_LOCK, 'exclusive', operation)
}

interface LocalPrincipalUseLease {
  accepting: boolean
  rootFinished: boolean
  active: number
  ready: Promise<void>
  resolveReady: () => void
  rejectReady: (error: unknown) => void
  drained: Promise<void>
  resolveDrained: () => void
}

// PowerSync may call fetchCredentials/uploadData from inside `connect()`. Both
// callbacks need the same shared principal lease as connect, but Web Locks are
// not re-entrant: a nested shared request can queue behind an exclusive waiter
// which itself waits for the outer shared lease. Coalesce same-tab shared work
// into one origin lease and keep that lease alive until every operation admitted
// beneath it has drained. Once the root and children drain, later callers request
// a fresh lock and therefore preserve the browser lock manager's fairness.
let localPrincipalUseLease: LocalPrincipalUseLease | null = null

function maybeDrainPrincipalUseLease(lease: LocalPrincipalUseLease): void {
  if (!lease.rootFinished || lease.active !== 0) return
  lease.resolveDrained()
}

async function runUnderPrincipalUseLease<T>(
  lease: LocalPrincipalUseLease,
  operation: () => Promise<T>
): Promise<T> {
  lease.active++
  try {
    await lease.ready
    return await operation()
  } finally {
    lease.active--
    maybeDrainPrincipalUseLease(lease)
  }
}

export async function withPrincipalUseLock<T>(operation: () => Promise<T>): Promise<T> {
  if (!originWideLockingAvailable()) return operation()
  const existing = localPrincipalUseLease
  if (existing?.accepting) return runUnderPrincipalUseLease(existing, operation)

  let resolveReady!: () => void
  let rejectReady!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  let resolveDrained!: () => void
  const drained = new Promise<void>((resolve) => { resolveDrained = resolve })
  const lease: LocalPrincipalUseLease = {
    accepting: true,
    rootFinished: false,
    active: 0,
    ready,
    resolveReady,
    rejectReady,
    drained,
    resolveDrained,
  }
  localPrincipalUseLease = lease

  const held = navigator.locks.request(ORIGIN_WRITE_LOCK, { mode: 'shared' }, async () => {
    lease.resolveReady()
    try {
      return await runUnderPrincipalUseLease(lease, operation)
    } finally {
      // Once the root has returned, the nested work it already admitted may
      // drain under this lease, but unrelated later readers must request a new
      // browser lock. Otherwise they can keep joining ahead of an exclusive
      // transition forever (including access-expiry teardown).
      lease.rootFinished = true
      lease.accepting = false
      maybeDrainPrincipalUseLease(lease)
      if (lease.active !== 0) await lease.drained
    }
  })
  return await held
    .catch((error) => {
      if (lease.accepting) {
        lease.accepting = false
        // Only joined operations consume `ready`; rejecting an otherwise unused
        // promise would create an unhandled rejection when lock acquisition is
        // the thing that failed.
        if (lease.active > 0) lease.rejectReady(error)
      }
      throw error
    })
    .finally(() => {
      lease.accepting = false
      if (localPrincipalUseLease === lease) localPrincipalUseLease = null
    })
}

// Refresh tokens rotate and are commonly single-use. Serialize that rotation
// across tabs independently from the replica lock. Principal transitions take
// the replica lock first and this lock second; never invert that order.
export function withSessionRefreshLock<T>(operation: () => Promise<T>): Promise<T> {
  if (!originWideLockingAvailable()) {
    return Promise.reject(new Error('This browser cannot safely rotate a shared session.'))
  }
  return withNamedOriginLock(ORIGIN_REFRESH_LOCK, 'exclusive', operation)
}

// Pairing state is shared by every tab but independent of the claimed profile's
// replica/session. Serialize whole-device replacement and unpair so an older
// cleanup can never erase or splice together a newer pairing.
export function withKioskDeviceLock<T>(operation: () => Promise<T>): Promise<T> {
  // Pair/unpair is an origin-wide device-principal replacement. A process-local
  // fallback cannot stop another tab's delayed response or revocation cleanup
  // from overwriting the winning generation, so fail closed just like session
  // refresh and replica transitions do.
  if (!originWideLockingAvailable()) {
    return Promise.reject(new Error('This browser cannot safely change the shared kiosk device.'))
  }
  return withNamedOriginLock(ORIGIN_KIOSK_DEVICE_LOCK, 'exclusive', operation)
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
  if (localTransitionId) return true
  const signal = persistedTransitionSignal()
  return signal?.state === 'started'
}

export function activePrincipalTransitionId(): string | null {
  if (localTransitionId) return localTransitionId
  const signal = persistedTransitionSignal()
  return signal?.state === 'started' ? signal.id : null
}

export function waitForPrincipalTransition(): Promise<void> {
  const localId = localTransitionId
  if (localId) {
    const completion = localTransitionCompletions.get(localId)
    if (completion) {
      return completion.promise.then((outcome) => {
        if (outcome === 'failed') throw new Error('The principal transition failed.')
      })
    }
  }
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
  const id = signalId()
  let resolve!: (outcome: LocalTransitionOutcome) => void
  const promise = new Promise<LocalTransitionOutcome>((done) => { resolve = done })
  localTransitionCompletions.set(id, { promise, resolve })
  localTransitionId = id
  const signal: TransitionSignal = { id, state: 'started', at: Date.now() }
  if (typeof localStorage === 'undefined') return id
  try {
    localStorage.setItem(TRANSITION_SIGNAL_KEY, JSON.stringify(signal))
  } catch {
    /* the in-memory completion still gates this initiating tab */
  }
  return id
}

export function broadcastPrincipalTransitionFinished(id: string | null): void {
  completeLocalPrincipalTransition(id, 'finished')
  persistPrincipalTransitionFinished(id)
}

export function broadcastPrincipalTransitionFailed(id: string | null): void {
  completeLocalPrincipalTransition(id, 'failed')
  // Other tabs reload through the durable replica-owner check after either
  // outcome. The initiating tab separately receives the failed completion.
  persistPrincipalTransitionFinished(id)
}

function completeLocalPrincipalTransition(
  id: string | null,
  outcome: LocalTransitionOutcome
): void {
  if (!id) return
  const completion = localTransitionCompletions.get(id)
  completion?.resolve(outcome)
  localTransitionCompletions.delete(id)
  if (localTransitionId === id) localTransitionId = null
}

function persistPrincipalTransitionFinished(id: string | null): void {
  if (!id || typeof localStorage === 'undefined') return
  const signal: TransitionSignal = { id, state: 'finished', at: Date.now() }
  const stillMatchesStart = () => {
    const current = persistedTransitionSignal()
    return current?.state === 'started' && current.id === id
  }
  try {
    if (!stillMatchesStart()) return
    localStorage.setItem(TRANSITION_SIGNAL_KEY, JSON.stringify(signal))
    if (!stillMatchesStart()) return
  } catch {
    /* fall through to removing the stale start marker */
  }
  // Some storage implementations can accept the start but reject a later write
  // (quota/private-mode changes, for example). Leaving `started` behind would
  // make every reload gate and reload again forever. Removal is an equivalent
  // completion signal and must still use the matching id so an older finish can
  // never erase a newer transition.
  try {
    if (stillMatchesStart()) localStorage.removeItem(TRANSITION_SIGNAL_KEY)
  } catch { /* the current tab remains safely gated by its in-memory outcome */ }
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
let writeFreezeDepth = 0
let activeWriters = 0
let drainWaiters: Array<() => void> = []

export async function withLocalWriteLease(operation: () => Promise<boolean>): Promise<boolean> {
  return withNamedOriginLock(ORIGIN_WRITE_LOCK, 'shared', async () => {
    if (writeFreezeDepth > 0) return false
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
  writeFreezeDepth++
  let released = false
  return () => {
    if (released) return
    released = true
    writeFreezeDepth--
  }
}

export function waitForLocalWritesToDrain(): Promise<void> {
  if (activeWriters === 0) return Promise.resolve()
  return new Promise((resolve) => drainWaiters.push(resolve))
}
