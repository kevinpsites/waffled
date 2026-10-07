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
import { getAccessToken } from '../api/client'
import { SyncHealthMonitor } from './sync-health'

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
let unlistenStatus: (() => void) | null = null
const recreateSubs = new Set<() => void>()

const monitor = new SyncHealthMonitor({
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine,
  isAuthenticated: () => !!getAccessToken(),
  softRestart: () => restartPowerSyncSoft(),
  hardRestart: (opts) => restartPowerSyncHard(opts),
})

export function getPowerSyncDb(): PowerSyncDatabase | null {
  return db
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
  // Anything that throws from here on leaves a half-built client that still owns
  // the worker and the OPFS handle on waffled.db. Callers only null out `db`, so
  // without this the orphan is unreachable — the next hard restart sees no old
  // client, closes nothing, and opens a SECOND database on the same file.
  try {
    await instance.init()
    db = instance
    unlistenStatus = instance.registerListener({
      statusChanged: (s: SyncStatus) =>
        monitor.noteStatus({
          connected: s.connected,
          connecting: s.connecting,
          hasSynced: s.hasSynced,
          lastSyncedAt: s.lastSyncedAt ? s.lastSyncedAt.getTime() : null,
        }),
    })
    // connect() retries internally; fetchCredentials returning null just means
    // "not signed in yet" — it'll connect once a token is available.
    await instance.connect(new WaffledConnector())
  } catch (err) {
    unlistenStatus?.()
    unlistenStatus = null
    db = null
    try {
      await instance.close()
    } catch {
      /* best effort: a client that couldn't boot may not close cleanly either */
    }
    throw err
  }
  monitor.engineStarted()
  monitor.start()
  watchConnectivity()
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
export async function connectPowerSync(): Promise<void> {
  if (db) return
  try {
    await startClient()
  } catch (err) {
    console.warn('PowerSync unavailable; falling back to REST only', err)
    db = null
    // Surface the crash: a boot failure must not be indistinguishable from
    // "engine not running" on the Live Sync card.
    monitor.engineFailed(err)
    // A dead engine still needs a heartbeat. The watchdog retries the rebuild from
    // the failed phase, but startClient() never got far enough to arm the timer —
    // so without this a transient boot failure (an OPFS lock held by another tab)
    // would be permanent until somebody found the Restart sync button.
    monitor.start()
    watchConnectivity()
  }
}

// Cheap engine kick: drop the sync connection and dial again on the same client.
// The first rung of the watchdog ladder. Never throws; a no-op with no client.
export async function restartPowerSyncSoft(): Promise<void> {
  const instance = db
  if (!instance) return
  try {
    const { WaffledConnector } = await loadEngine()
    await instance.disconnect()
    await instance.connect(new WaffledConnector())
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
  const promise = (inFlight ? inFlight.promise.catch(() => {}) : Promise.resolve())
    .then(() => doHardRestart({ clear }))
    .finally(() => {
      if (hardRestarting === entry) hardRestarting = null
    })
  entry = { clear, promise }
  hardRestarting = entry
  return promise
}

async function doHardRestart({ clear = false }: { clear?: boolean } = {}): Promise<void> {
  const old = db
  db = null
  unlistenStatus?.()
  unlistenStatus = null
  if (old) {
    if (clear) {
      // The top rung, for a replica that survives plain rebuilds (same db file).
      // Wiping and re-downloading is cheap — but never while local writes are
      // still waiting to upload: family data beats the replica, every time.
      //
      // "Couldn't read the queue" is NOT "the queue is empty". This rung only ever
      // runs against an already-wedged client, which is precisely the one whose
      // probe throws — so a failed probe must skip the wipe, or the guarantee
      // evaporates in the exact case it exists for.
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
  try {
    await startClient()
    // Long-lived watches hang off the dead client — tell them to re-arm.
    for (const cb of [...recreateSubs]) cb()
  } catch (err) {
    console.warn('PowerSync restart failed; falling back to REST only', err)
    db = null
    monitor.engineFailed(err)
    // Idempotent — but a rebuild that failed on the very first boot attempt has no
    // timer of its own, and the watchdog is the thing that will try again.
    monitor.start()
    watchConnectivity()
  }
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
    disposeInner = () => {}
    if (!db) return
    try {
      disposeInner = db.onChange(
        {
          onChange: () => {
            cb()
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
