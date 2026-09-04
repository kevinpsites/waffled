// PowerSync client lifecycle. Lazily created and connected at app boot (real
// browser only) so the test/jsdom environment never loads the SQLite WASM. Every
// step is best-effort: if PowerSync can't init/connect, the kiosk simply keeps
// reading over REST (just without the live auto-refresh). onTablesChange lets the
// data hooks refetch the instant replicated rows change.
//
// The engine is supervised. A SyncHealthMonitor watches the status stream and,
// when the engine wedges — online and signed in but never reaching
// connected+synced — restarts it: soft (disconnect/reconnect) first, then hard
// (rebuild the client), then hard with the local replica wiped. A hard restart
// replaces the db instance, so long-lived watches subscribe to
// onPowerSyncRecreated to re-arm against the new one.
import type { PowerSyncDatabase, SyncStatus } from '@powersync/web'
import { currentIdentityScope, getAccessToken } from '../api/client'
import { SyncHealthMonitor } from './sync-health'
import {
  activePrincipalTransitionId,
  freezeLocalWrites,
  onRemotePrincipalTransition,
  originWideLockingAvailable,
  principalTransitionInProgress,
  registerPrincipalTransitionHandler,
  waitForPrincipalTransition,
  withPrincipalUseLock,
  withPrincipalTransitionLock,
  withSessionRefreshLock,
  waitForLocalWritesToDrain,
  type PrincipalTransitionRequest,
  type PrincipalTransitionResult,
} from './principal-transition'

// The engine — @powersync/web plus the wa-sqlite build it wraps — is ~540 kB
// minified, and this module is reachable from every screen (lib/api's event hooks
// import events-local, which imports this file). Imported statically that weight
// lands in the entry bundle, delaying first paint on a screen nobody has to have
// sync for. Nothing here needs the engine until something actually connects, so
// pull it in then: `import type` above is erased at build time, and the schema +
// connector ride along in the same lazily-loaded chunk.
//
// This is safe precisely because the module is already null-until-started —
// getPowerSyncDb() returns null while the client boots and every caller falls
// back to REST — so an extra network round-trip for the chunk is just a slightly
// longer version of a window that already exists.
async function loadEngine() {
  const [web, schema, connector] = await Promise.all([
    import('@powersync/web'),
    import('./schema'),
    import('./connector'),
  ])
  return { PowerSyncDatabase: web.PowerSyncDatabase, AppSchema: schema.AppSchema, WaffledConnector: connector.WaffledConnector }
}

let db: PowerSyncDatabase | null = null
let dbIdentityScope: string | null | undefined
let unlistenStatus: (() => void) | null = null
const recreateSubs = new Set<() => void>()
const REPLICA_OWNER_KEY = 'waffled.powersyncIdentityScope'
const EMPTY_REPLICA_OWNER = '__empty__'
const REST_ONLY_REPLICA_OWNER = '__rest_only__'

function encodedIdentityScope(scope: string | null): string {
  return scope ?? '__none__'
}

function storedReplicaOwner(): string | null {
  try {
    return localStorage.getItem(REPLICA_OWNER_KEY)
  } catch {
    return null
  }
}

function storeReplicaOwner(owner: string): boolean {
  try {
    localStorage.setItem(REPLICA_OWNER_KEY, owner)
    return true
  } catch {
    return false
  }
}

function notifyRecreated(): void {
  for (const cb of [...recreateSubs]) cb()
}

async function quarantinePowerSyncWithoutOriginLocks(): Promise<void> {
  const old = db
  db = null
  dbIdentityScope = undefined
  unlistenStatus?.()
  unlistenStatus = null
  monitor.stop()
  monitor.engineStopped()
  if (storedReplicaOwner() === null) storeReplicaOwner(REST_ONLY_REPLICA_OWNER)
  if (old) {
    notifyRecreated()
    // `close` releases this tab's handle without issuing an origin-global
    // disconnect that could interfere with a correctly isolated HTTPS tab.
    try { await old.close() } catch { /* remain REST-only */ }
  }
  watchConnectivity()
}

async function withFrozenLocalWrites<T>(operation: () => Promise<T>): Promise<T> {
  const unfreeze = freezeLocalWrites()
  try {
    await waitForLocalWritesToDrain()
    return await operation()
  } finally {
    unfreeze()
  }
}

const monitor = new SyncHealthMonitor({
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine,
  isAuthenticated: () => !!getAccessToken(),
  softRestart: () => restartPowerSyncSoft(),
  hardRestart: (opts) => restartPowerSyncHard(opts),
})

export function getPowerSyncDb(): PowerSyncDatabase | null {
  return originWideLockingAvailable() && dbIdentityScope === currentIdentityScope() ? db : null
}

// Build + connect a client and wire its status stream into the health store.
async function startClient(): Promise<void> {
  // WASM/OPFS init takes a few seconds — publish 'starting' so the Live Sync card
  // never reads "off" during a perfectly normal boot.
  monitor.engineStarting()
  const { PowerSyncDatabase, AppSchema, WaffledConnector } = await loadEngine()
  const instance = new PowerSyncDatabase({
    schema: AppSchema,
    database: { dbFilename: 'waffled.db' },
  })
  let identityScope: string | null | undefined
  let instanceUnlisten: (() => void) | null = null
  // Anything that throws from here on leaves a half-built client that still owns
  // the worker and the OPFS handle on waffled.db. Callers only null out `db`, so
  // without this the orphan is unreachable — the next hard restart sees no old
  // client, closes nothing, and opens a SECOND database on the same file.
  try {
    await instance.init()
    // The OPFS file outlives JavaScript and local auth state. Never publish an
    // existing replica unless its durable owner matches this exact identity
    // generation. A missing marker is an upgrade from the pre-owner format and
    // therefore requires the same one-time privacy purge.
    identityScope = currentIdentityScope()
    if (storedReplicaOwner() !== encodedIdentityScope(identityScope)) {
      await withFrozenLocalWrites(() => withPrincipalTransitionLock(async () => {
        if (currentIdentityScope() !== identityScope) {
          throw new Error('Identity changed before clearing the local replica')
        }
        await instance.disconnectAndClear()
        if (currentIdentityScope() !== identityScope) {
          throw new Error('Identity changed while clearing the local replica')
        }
        if (!storeReplicaOwner(encodedIdentityScope(identityScope))) {
          throw new Error('Could not persist the local replica owner')
        }
      }))
    }
    let connectAttempt: Promise<void> | null = null
    await withPrincipalUseLock(async () => {
      // A transition may have completed between initialization/purge and this
      // publication lease. Publish and *start* connect atomically, but never await
      // the SharedWorker RPC while holding the lease: the worker may ask another
      // tab for credentials, whose own shared request must be able to run after a
      // queued exclusive transition.
      if (currentIdentityScope() !== identityScope ||
          storedReplicaOwner() !== encodedIdentityScope(identityScope)) {
        throw new Error('Identity changed before publishing the local replica')
      }
      db = instance
      dbIdentityScope = identityScope
      instanceUnlisten = instance.registerListener({
        statusChanged: (s: SyncStatus) =>
          monitor.noteStatus({
            connected: s.connected,
            connecting: s.connecting,
            hasSynced: s.hasSynced,
            lastSyncedAt: s.lastSyncedAt ? s.lastSyncedAt.getTime() : null,
        }),
      })
      unlistenStatus = instanceUnlisten
      // connect() retries internally; fetchCredentials returning null just means
      // "not signed in yet" — it'll connect once a token is available.
      connectAttempt = instance.connect(new WaffledConnector())
    })
    if (!connectAttempt) throw new Error('PowerSync connect was not started')
    await connectAttempt

    let stillCurrent = false
    await withPrincipalUseLock(async () => {
      stillCurrent = db === instance && dbIdentityScope === identityScope &&
        currentIdentityScope() === identityScope &&
        storedReplicaOwner() === encodedIdentityScope(identityScope)
      if (!stillCurrent) return
      monitor.engineStarted()
      monitor.start()
      watchConnectivity()
    })
    if (!stillCurrent) {
      if (db === instance) {
        db = null
        dbIdentityScope = undefined
      }
      if (unlistenStatus === instanceUnlisten) unlistenStatus = null
      ;(instanceUnlisten as (() => void) | null)?.()
      try { await instance.close() } catch { /* a transition already owns teardown */ }
      return
    }
  } catch (err) {
    const staleAttempt = identityScope !== undefined && currentIdentityScope() !== identityScope
    if (db === instance) {
      db = null
      dbIdentityScope = undefined
    }
    if (unlistenStatus === instanceUnlisten) unlistenStatus = null
    ;(instanceUnlisten as (() => void) | null)?.()
    try {
      await instance.close()
    } catch {
      /* best effort: a client that couldn't boot may not close cleanly either */
    }
    if (staleAttempt) return
    throw err
  }
}

// The watchdog re-classifies on its own (slow) tick, but the kiosk's offline strip
// appears after ten seconds — so a stall that coincides with the network dropping
// would stack two banners until the next tick caught up. Reacting to the browser's
// own connectivity events keeps the two in step.
let connectivityWatched = false
function watchConnectivity(): void {
  if (connectivityWatched || typeof window === 'undefined') return
  connectivityWatched = true
  const kick = () => void monitor.tick()
  window.addEventListener('online', kick)
  window.addEventListener('offline', kick)
}

// Stand up the local DB and start streaming this household's rows. Safe to call
// more than once; only the first call does work. Never throws.
let lifecycleTail: Promise<void> = Promise.resolve()

function serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const run = lifecycleTail.then(operation, operation)
  lifecycleTail = run.then(() => {}, () => {})
  return run
}

async function connectPowerSyncUnlocked(opts: {
  ignoreTransitionSignal?: boolean
} = {}): Promise<void> {
  if (!originWideLockingAvailable()) {
    await quarantinePowerSyncWithoutOriginLocks()
    return
  }
  if (getPowerSyncDb()) return Promise.resolve()
  if (db) {
    // The origin's atomic session changed before this tab received the advisory
    // storage signal. Detach the stale handle synchronously; startClient below
    // will enforce the durable owner marker before publishing a replacement.
    const stale = db
    db = null
    dbIdentityScope = undefined
    unlistenStatus?.()
    unlistenStatus = null
    monitor.stop()
    monitor.engineStopped()
    notifyRecreated()
    // In SharedWorker mode disconnect() controls the origin-global connection.
    // This stale tab may be observing a replacement which another tab has
    // already connected, so only release this tab's handle here.
    try { await stale.close() } catch { /* a failed reopen remains REST-only */ }
  }
  if (!opts.ignoreTransitionSignal) {
    try {
      await waitForPrincipalTransition()
    } catch (error) {
      // No-Web-Locks browsers cannot safely distinguish a crashed marker from a
      // slow live clear. Remain REST-only/gated and surface the recovery state.
      monitor.engineFailed(error)
      monitor.start()
      watchConnectivity()
      return
    }
  }
  await startClient()
    .catch((err) => {
      console.warn('PowerSync unavailable; falling back to REST only', err)
      db = null
      dbIdentityScope = undefined
      // Surface the crash: a boot failure must not be indistinguishable from
      // "engine not running" on the Live Sync card.
      monitor.engineFailed(err)
      // A dead engine still needs a heartbeat. The watchdog retries the rebuild from
      // the failed phase, but startClient() never got far enough to arm the timer —
      // so without this a transient boot failure (an OPFS lock held by another tab)
      // would be permanent until somebody found the Restart sync button.
      monitor.start()
      watchConnectivity()
    })
}

let connecting: Promise<void> | null = null
export function connectPowerSync(): Promise<void> {
  if (originWideLockingAvailable() && getPowerSyncDb()) return Promise.resolve()
  if (connecting) return connecting
  let attempt: Promise<void>
  attempt = serializeLifecycle(connectPowerSyncUnlocked)
    .finally(() => {
      if (connecting === attempt) connecting = null
    })
  connecting = attempt
  return attempt
}

// Cheap engine kick: drop the sync connection and dial again on the same client.
// The first rung of the watchdog ladder. Never throws; a no-op with no client.
export function restartPowerSyncSoft(): Promise<void> {
  return serializeLifecycle(restartPowerSyncSoftUnlocked)
}

async function restartPowerSyncSoftUnlocked(): Promise<void> {
  if (!originWideLockingAvailable()) {
    await quarantinePowerSyncWithoutOriginLocks()
    return
  }
  const instance = getPowerSyncDb()
  if (!instance && db) {
    await connectPowerSyncUnlocked({ ignoreTransitionSignal: true })
    return
  }
  if (!instance) return
  try {
    const identityScope = currentIdentityScope()
    const { WaffledConnector } = await loadEngine()
    let disconnectedCurrent = false
    await withPrincipalUseLock(async () => {
      if (getPowerSyncDb() !== instance) return
      await instance.disconnect()
      disconnectedCurrent = getPowerSyncDb() === instance && currentIdentityScope() === identityScope
    })
    if (!disconnectedCurrent) return

    let connectAttempt: Promise<void> | null = null
    await withPrincipalUseLock(async () => {
      // A fair lock manager lets a queued exclusive transition win between the
      // disconnect and this second shared lease. Only initiate reconnect if this
      // exact instance/principal is still published once that waiter drains.
      if (getPowerSyncDb() !== instance || currentIdentityScope() !== identityScope) return
      connectAttempt = instance.connect(new WaffledConnector())
    })
    if (connectAttempt) await connectAttempt
  } catch (err) {
    console.warn('PowerSync soft restart failed', err)
  }
}

// Full rebuild: close the (possibly wedged) client and create a fresh one — also
// what the Settings "Restart sync" button calls. Never throws.
//
// Concurrent callers share one restart only when they asked for the SAME thing.
// Aliasing across a differing `clear` was wrong in both directions: "Reset local
// copy" during a watchdog rebuild would resolve without ever wiping, and — worse —
// "Restart sync" during the watchdog's top rung would wipe a replica the user
// never asked to wipe. A differing request queues behind the in-flight one instead.
let hardRestarting: { clear: boolean; promise: Promise<void> } | null = null
export function restartPowerSyncHard(opts: { clear?: boolean } = {}): Promise<void> {
  const clear = opts.clear ?? false
  const inFlight = hardRestarting
  if (inFlight && inFlight.clear === clear) return inFlight.promise
  let entry: { clear: boolean; promise: Promise<void> }
  const promise = serializeLifecycle(() => doHardRestart({ clear }))
    .finally(() => {
      if (hardRestarting === entry) hardRestarting = null
    })
  entry = { clear, promise }
  hardRestarting = entry
  return promise
}

async function doHardRestart({ clear = false }: { clear?: boolean } = {}): Promise<void> {
  if (!originWideLockingAvailable()) {
    await quarantinePowerSyncWithoutOriginLocks()
    return
  }
  const identityScope = currentIdentityScope()
  let detached = false
  const detach = async (): Promise<boolean> => {
    // A cross-tab principal replacement which won while this restart was queued
    // owns the teardown. Do not detach or rebuild its newly-current replica.
    if (currentIdentityScope() !== identityScope) return false
    const old = db
    db = null
    dbIdentityScope = undefined
    unlistenStatus?.()
    unlistenStatus = null
    detached = true
    if (old) {
      if (clear) {
        // The top rung, for a replica that survives plain rebuilds (same db file).
        // Wiping and re-downloading is cheap — but never while local writes are
        // still waiting to upload: family data beats the replica, every time.
        // This probe runs inside the exclusive origin lease, after existing
        // writers/uploaders drain, so no operation can arrive between it and clear.
        // "Couldn't read the queue" is NOT "the queue is empty".
        let queueKnownEmpty = false
        try {
          queueKnownEmpty = (await old.getNextCrudTransaction()) == null
        } catch {
          /* wedged client, unreadable queue — assume writes are pending, don't wipe */
        }
        if (queueKnownEmpty) {
          try {
            await old.disconnectAndClear()
          } catch {
            /* clearing failed — the close + rebuild below still runs */
          }
        }
      }
      try {
        await old.close()
      } catch {
        /* a wedged client may refuse to close cleanly — replace it anyway */
      }
    }
    return true
  }

  try {
    const didDetach = await withFrozenLocalWrites(() =>
      clear ? withPrincipalTransitionLock(detach) : withPrincipalUseLock(detach)
    )
    if (!didDetach) return
  } catch (err) {
    // In particular, a browser without Web Locks must keep the existing replica
    // intact rather than running a destructive reset without origin exclusion.
    console.warn('PowerSync restart isolation failed', err)
    if (!detached) return
  }
  try {
    await startClient()
    // Long-lived watches hang off the dead client — tell them to re-arm.
    notifyRecreated()
  } catch (err) {
    console.warn('PowerSync restart failed; falling back to REST only', err)
    db = null
    dbIdentityScope = undefined
    monitor.engineFailed(err)
    // Idempotent — but a rebuild that failed on the very first boot attempt has no
    // timer of its own, and the watchdog is the thing that will try again.
    monitor.start()
    watchConnectivity()
  }
}

// Auth owns the credentials while this module owns the local household replica.
// Serialize their boundary: freeze/finish local writers, refuse an ordinary exit
// with queued uploads, clear the old database, and only then publish replacement
// credentials. Expiration/revocation passes discard-authorized because those
// credentials can no longer drain their queue.
let principalTransitionTail: Promise<void> = Promise.resolve()

function runPrincipalTransition(
  request: PrincipalTransitionRequest
): Promise<PrincipalTransitionResult> {
  const run = principalTransitionTail.then(() =>
    serializeLifecycle(() => performPrincipalTransition(request))
  )
  principalTransitionTail = run.then(() => {}, () => {})
  return run
}

async function performPrincipalTransition(
  request: PrincipalTransitionRequest
): Promise<PrincipalTransitionResult> {
  const requestIsCurrent = () => {
    if (currentIdentityScope() !== request.expectedIdentityScope) return false
    try {
      return request.stillCurrent?.() ?? true
    } catch {
      return false
    }
  }
  if (!requestIsCurrent()) return 'stale'

  let initialOwner = storedReplicaOwner()
  // Authentication can complete before the asynchronous boot path reaches
  // connectPowerSync(). In a no-lock runtime PowerSync cannot be opened safely,
  // so establish the same durable REST-only proof here rather than rejecting an
  // otherwise valid first login merely because startup lost that race.
  if (!originWideLockingAvailable() && !db && initialOwner == null &&
      storeReplicaOwner(REST_ONLY_REPLICA_OWNER)) {
    initialOwner = REST_ONLY_REPLICA_OWNER
  }
  const provenRestOnly = !db && (
    initialOwner === REST_ONLY_REPLICA_OWNER ||
    initialOwner === EMPTY_REPLICA_OWNER ||
    initialOwner === encodedIdentityScope(null)
  )
  if (!originWideLockingAvailable()) {
    // A plain-HTTP browser cannot run PowerSync, but still needs login/profile
    // switching. Only bypass replica isolation when a durable marker proves no
    // principal-owned replica was ever published. Known owners remain fail-closed.
    if (!provenRestOnly) return 'purge-failed'
    if (!requestIsCurrent()) return 'stale'
    request.beginIsolation()
    try {
      await request.prepareReplacement?.()
    } catch (error) {
      request.finishIsolation()
      throw error
    }
    if (!requestIsCurrent()) {
      request.finishIsolation()
      return 'stale'
    }
    request.commitCredentials()
    request.finishIsolation()
    return 'completed'
  }

  const unfreeze = freezeLocalWrites()
  try {
    await waitForLocalWritesToDrain()
    if (!requestIsCurrent()) return 'stale'

    // A missing live handle is unknown—not proof the persistent queue/file is
    // empty. Lossless exits must inspect it, and a new principal must clear it
    // before B credentials can be published. The sole safe no-handle exception
    // is a signed-out browser whose durable marker already proves an empty/no-
    // principal replica.
    const owner = storedReplicaOwner()
    const knownSignedOutReplica = request.expectedIdentityScope == null &&
      (owner === encodedIdentityScope(null) || owner === EMPTY_REPLICA_OWNER)
    const mustOpenReplica = request.policy === 'require-no-pending' ||
      (request.replacement === 'new-principal' && !knownSignedOutReplica)
    if (!db && mustOpenReplica) {
      await connectPowerSyncUnlocked()
      if (!db) return 'purge-failed'
    }
    let detached = false
    let result: PrincipalTransitionResult = 'purge-failed'
    let transitionError: unknown
    try {
      result = await withPrincipalTransitionLock(async (): Promise<PrincipalTransitionResult> => {
        // Cross-tab writers and sync uploads which began before the exclusive
        // lock have drained. Re-check the queue inside it so nothing can slip
        // between the preflight and destructive clear.
        if (!requestIsCurrent()) return 'stale'
        const old = db
        if (old && request.policy === 'require-no-pending') {
          try {
            if ((await old.getNextCrudTransaction()) != null) return 'pending-uploads'
          } catch {
            return 'purge-failed'
          }
        }

        const isolateAndPurge = async () => {
          request.beginIsolation()
          db = null
          dbIdentityScope = undefined
          detached = true
          unlistenStatus?.()
          unlistenStatus = null
          monitor.stop()
          monitor.engineStopped()
          notifyRecreated()

          let purged = true
          let clearedReplica = false
          if (old) {
            try {
              await old.disconnectAndClear()
              clearedReplica = true
              // Mark the on-disk file empty before credentials move. If a crash
              // lands here, startup clears it again before publishing any owner.
              storeReplicaOwner(EMPTY_REPLICA_OWNER)
            } catch {
              purged = false
            }
            try {
              await old.close()
            } catch {
              // A successful clear is the privacy boundary; an already-detached
              // worker which refuses to close is never published again.
            }
          }
          return { purged, clearedReplica }
        }

        const finalize = ({ purged, clearedReplica }: {
          purged: boolean
          clearedReplica: boolean
        }): PrincipalTransitionResult => {
          if (!purged) {
            if (request.replacement === 'signed-out') {
              // With no replacement credentials, the old owner marker safely
              // quarantines an unreadable file for cleanup on the next startup.
              if (!requestIsCurrent()) {
                request.finishIsolation()
                return 'stale'
              }
              request.commitCredentials()
              request.finishIsolation()
              return 'completed'
            }
            request.finishIsolation()
            return 'purge-failed'
          }
          if (!requestIsCurrent()) {
            request.finishIsolation()
            return 'stale'
          }
          request.commitCredentials()
          if (clearedReplica) storeReplicaOwner(encodedIdentityScope(currentIdentityScope()))
          request.finishIsolation()
          return 'completed'
        }

        if (request.prepareReplacement) {
          // A household switch must not touch server-side selection or mint a B
          // token until A's queue is empty and A's local replica is gone. Keep
          // the principal lease across the request so no new writer can appear.
          const purge = await isolateAndPurge()
          if (!purge.purged) return finalize(purge)
          try {
            await request.prepareReplacement()
          } catch (error) {
            request.finishIsolation()
            throw error
          }
          // API refreshes use this same order: principal first, refresh second.
          return withSessionRefreshLock(async () => finalize(purge))
        }

        // Terminal-session cleanup must exclude a concurrent same-scope refresh
        // before it clears queued data. Never acquire these locks in reverse.
        return withSessionRefreshLock(async () => {
          if (!requestIsCurrent()) return 'stale'
          return finalize(await isolateAndPurge())
        })
      })
    } catch (error) {
      transitionError = error
    }

    // The origin-wide exclusive lock is released before a new connector starts;
    // connector callbacks may acquire the shared lock themselves. Rebuild either
    // the successful replacement or the unchanged principal after a failed clear.
    if (detached && getAccessToken()) {
      await connectPowerSyncUnlocked({ ignoreTransitionSignal: true })
    }
    if (detached) notifyRecreated()
    if (transitionError) throw transitionError
    return result
  } finally {
    unfreeze()
  }
}

registerPrincipalTransitionHandler(runPrincipalTransition)

// A principal transition in another same-origin tab must immediately hide this
// tab and release its OPFS handle. The initiating tab holds the origin-wide
// exclusive writer lock while it probes/clears, then publishes the finished
// signal only after credentials and replica ownership agree.
let remoteWriteUnfreeze: (() => void) | null = null
let remoteDetach: Promise<void> | null = null
let remoteTransitionId: string | null = null

function beginRemoteIsolation(id: string | null = null): void {
  if (id) remoteTransitionId = id
  if (!remoteWriteUnfreeze) remoteWriteUnfreeze = freezeLocalWrites()
  window.dispatchEvent(new Event('waffled:principal-transition-started'))
  if (remoteDetach) return
  remoteDetach = serializeLifecycle(async () => {
    await waitForLocalWritesToDrain()
    const old = db
    db = null
    dbIdentityScope = undefined
    unlistenStatus?.()
    unlistenStatus = null
    monitor.stop()
    monitor.engineStopped()
    notifyRecreated()
    if (old) {
      // In SharedWorker/multi-tab mode disconnect() controls the origin-global
      // connection manager. A delayed tab must not disconnect the replacement
      // principal which the initiating tab may already have connected. close()
      // releases only this tab's handle there, and still disconnects first in
      // single-tab implementations.
      try { await old.close() } catch { /* transitioning tab will fail closed if OPFS stays locked */ }
    }
  })
}

function finishRemoteIsolation(expectedId: string | null = null): void {
  if (expectedId && remoteTransitionId !== expectedId) return
  const finishingId = expectedId ?? remoteTransitionId
  const detached = remoteDetach ?? Promise.resolve()
  void detached.finally(() => {
    // A newer started signal supersedes this completion. Keep the UI gated and
    // writes frozen until that exact transition finishes.
    if (finishingId !== remoteTransitionId) return
    remoteDetach = null
    remoteTransitionId = null
    remoteWriteUnfreeze?.()
    remoteWriteUnfreeze = null
    // Reload resets every module-level cache and in-flight REST closure. If reload
    // is unavailable (tests/embedded shells), the auth gate still re-resolves and
    // PowerSync reconnects through the durable owner check.
    try {
      window.location.reload()
    } catch {
      window.dispatchEvent(new Event('waffled:auth-changed'))
      void connectPowerSync()
    }
  })
}

onRemotePrincipalTransition((signal) => {
  if (signal.state === 'started') {
    beginRemoteIsolation(signal.id)
    // If the originating tab crashes, acquiring the shared lock proves its
    // exclusive transition ended and retires the abandoned marker. Browsers
    // without Web Locks reject after the safety timeout and remain gated.
    void waitForPrincipalTransition()
      .then(() => finishRemoteIsolation(signal.id))
      .catch(() => window.dispatchEvent(new Event('waffled:principal-transition-failed')))
  } else {
    finishRemoteIsolation(signal.id)
  }
})

if (typeof window !== 'undefined') {
  // The atomic session record is the fail-safe signal. Even if the advisory
  // transition broadcast was dropped (for example, storage quota failure), a
  // remote tab gates and drops its old handle before it can use the new session.
  window.addEventListener('storage', (event) => {
    if (event.key === 'waffled.session.v1') {
      const metadataFromRecord = (raw: string | null): {
        scope: string
        policy: string
      } => {
        if (!raw) return { scope: '__missing__', policy: '__missing__' }
        try {
          const value = JSON.parse(raw) as Record<string, unknown>
          if (value.signedOut === true) return { scope: '__signed-out__', policy: '__signed-out__' }
          const scope = typeof value.scope === 'string' && value.scope
            ? `session:${value.scope}`
            : '__invalid__'
          // A refresh rotates only credentials. Role/deadline changes within the
          // same scope must wake AuthGate so client.ts reloads the authoritative
          // policy, re-arms a shortened deadline, or tears down expired access.
          const policy = JSON.stringify([
            Object.prototype.hasOwnProperty.call(value, 'memberType'),
            value.memberType,
            Object.prototype.hasOwnProperty.call(value, 'accessExpiresAt'),
            value.accessExpiresAt,
          ])
          return { scope, policy }
        } catch {
          return { scope: '__invalid__', policy: '__invalid__' }
        }
      }
      const oldRecord = metadataFromRecord(event.oldValue)
      const newRecord = metadataFromRecord(event.newValue)
      // Access/refresh rotation rewrites the record but preserves its scope; it
      // is not a principal boundary and must not reload every other kiosk tab.
      if (oldRecord.scope === newRecord.scope) {
        if (oldRecord.policy !== newRecord.policy) {
          window.dispatchEvent(new Event('waffled:auth-changed'))
        }
        return
      }
    } else if (event.key !== 'waffled.token' || event.oldValue === event.newValue) {
      return
    }
    beginRemoteIsolation()
    // A normal transition's durable start signal will deliver the matching
    // finish. If that advisory write failed, the session record itself remains
    // sufficient: detach and reload through the owner check immediately.
    if (!principalTransitionInProgress()) finishRemoteIsolation()
  })
}

// A tab opened while another tab is already transitioning receives no historical
// storage event, so honor the durable start marker during module initialization.
if (principalTransitionInProgress()) {
  const transitionId = activePrincipalTransitionId()
  beginRemoteIsolation(transitionId)
  void waitForPrincipalTransition()
    .then(() => finishRemoteIsolation(transitionId))
    .catch(() => window.dispatchEvent(new Event('waffled:principal-transition-failed')))
}

// Fires after a hard restart has replaced the client. Subscribers re-arm their
// watches/listeners against getPowerSyncDb()'s new instance.
export function onPowerSyncRecreated(cb: () => void): () => void {
  recreateSubs.add(cb)
  return () => {
    recreateSubs.delete(cb)
  }
}

// Subscribe to changes on the given tables; returns a disposer. A no-op (with a
// no-op disposer) when PowerSync isn't running, so callers need no guards.
// Survives a hard restart by re-registering on the replacement client.
export function onTablesChange(tables: string[], cb: () => void): () => void {
  let disposeInner: () => void = () => {}
  const arm = () => {
    disposeInner()
    disposeInner = () => {}
    const instance = db
    const identityScope = currentIdentityScope()
    if (!instance) return
    try {
      disposeInner = instance.onChange(
        {
          onChange: () => {
            if (db === instance && currentIdentityScope() === identityScope) cb()
          },
        },
        { tables }
      )
    } catch {
      /* keep the no-op disposer */
    }
  }
  arm()
  const offRecreate = onPowerSyncRecreated(arm)
  return () => {
    offRecreate()
    disposeInner()
  }
}
