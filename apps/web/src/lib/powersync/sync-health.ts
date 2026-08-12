// Sync-engine health: a watchdog plus a tiny status store.
//
// PowerSync can wedge silently. The failure we are defending against: after a
// large server-side delete batch the web client stopped opening sync streams —
// no error, no reconnect — and the empty local replica rendered as an empty
// calendar while REST had the real data all along.
//
// This module (a) tracks the engine's status stream, (b) flags a *stall* — online
// and signed in but not connected+synced for a sustained window — (c) restarts
// the engine on a ladder with doubling backoff, and (d) tells readers whether the
// local replica can be trusted, so the data hooks fall back to REST instead of
// painting an empty-but-wedged replica.
//
// Deliberately db-agnostic: `db.ts` injects the real restart hooks, so everything
// here is plain, synchronous, testable logic with no PowerSync import.
import { useSyncExternalStore } from 'react'

// 'starting' = engine boot in progress (WASM/OPFS init takes a few seconds, and
// people read that window as "sync is off"). 'failed' = the boot (or a hard
// restart) threw; the message rides along in lastError so the Live Sync card can
// say *why* instead of a crash masquerading as "off".
export type SyncHealthStatus = 'off' | 'starting' | 'failed' | 'no-auth' | 'offline' | 'connecting' | 'ok' | 'stalled'

export interface SyncHealthSnapshot {
  status: SyncHealthStatus
  /** Whether the engine ever completed a full sync (null = unknown / no engine). */
  hasSynced: boolean | null
  /** ms epoch of the last completed sync. */
  lastSyncedAt: number | null
  /** Watchdog restarts this session (surfaced in System Health). */
  restartCount: number
  lastRestartAt: number | null
  /** Set only while status is 'failed'. */
  lastError?: string | null
}

// Stall = not connected+synced for this long while online and signed in. Long
// enough that token refreshes and flaky-wifi reconnects never trip it; short
// enough that a family glancing at the kiosk rarely sees stale data for long.
export const STALL_AFTER_MS = 3 * 60_000
// Watchdog cadence. Each pass is pure bookkeeping, so it can be frequent.
export const HEALTH_TICK_MS = 30_000
// Restart pacing: the first retry fires as soon as the stall is detected, then
// 2m, 4m, 8m… capped — a persistent outage self-heals when service returns
// without hammering the server on the way.
export const RESTART_BACKOFF_BASE_MS = 2 * 60_000
export const RESTART_BACKOFF_MAX_MS = 16 * 60_000

const OFF: SyncHealthSnapshot = { status: 'off', hasSynced: null, lastSyncedAt: null, restartCount: 0, lastRestartAt: null }

// ── store ─────────────────────────────────────────────────────────────────────
let snapshot: SyncHealthSnapshot = OFF
const subscribers = new Set<() => void>()

export function getSyncHealth(): SyncHealthSnapshot {
  return snapshot
}

/** useSyncExternalStore-compatible: `cb` takes no args; read via getSyncHealth. */
export function subscribeSyncHealth(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

// An unchanged snapshot keeps its identity — useSyncExternalStore compares by
// reference, so re-publishing the same values must not re-render every consumer.
export function publishSyncHealth(next: SyncHealthSnapshot): void {
  const prev = snapshot
  if (
    prev.status === next.status &&
    prev.hasSynced === next.hasSynced &&
    prev.lastSyncedAt === next.lastSyncedAt &&
    prev.restartCount === next.restartCount &&
    prev.lastRestartAt === next.lastRestartAt &&
    (prev.lastError ?? null) === (next.lastError ?? null)
  )
    return
  snapshot = next
  for (const cb of [...subscribers]) cb()
}

// Can an offline-first read treat the local replica as the source of truth? Only
// when it holds a complete sync AND the engine isn't wedged/booting/broken. When
// this is false the data hooks let REST drive, so a stalled or empty replica
// never blanks the UI.
export function isReplicaTrusted(): boolean {
  return (
    snapshot.hasSynced === true &&
    snapshot.status !== 'stalled' &&
    snapshot.status !== 'off' &&
    snapshot.status !== 'starting' &&
    snapshot.status !== 'failed'
  )
}

export function useSyncHealth(): SyncHealthSnapshot {
  return useSyncExternalStore(subscribeSyncHealth, getSyncHealth, getSyncHealth)
}

export function __resetSyncHealthForTests(): void {
  snapshot = OFF
  subscribers.clear()
}

// ── watchdog ──────────────────────────────────────────────────────────────────

/** The slice of PowerSync's SyncStatus the watchdog reasons about. */
export interface EngineStatus {
  connected: boolean
  connecting: boolean
  hasSynced: boolean | undefined
  lastSyncedAt: number | null
}

export interface SyncHealthMonitorDeps {
  isOnline(): boolean
  isAuthenticated(): boolean
  /** Disconnect + reconnect the existing client. */
  softRestart(): Promise<void>
  /** Tear down and rebuild the client; clear=true also wipes the local replica. */
  hardRestart(opts: { clear: boolean }): Promise<void>
  now?(): number
}

export class SyncHealthMonitor {
  private deps: Required<SyncHealthMonitorDeps>
  // Engine lifecycle: 'off' (never attempted / stopped) → 'starting' (boot in
  // flight) → 'running' (connect succeeded) or 'failed' (boot threw).
  private phase: 'off' | 'starting' | 'running' | 'failed' = 'off'
  private lastError: string | null = null
  private status: EngineStatus = { connected: false, connecting: false, hasSynced: undefined, lastSyncedAt: null }
  // Last instant the engine was verifiably healthy (connected + synced) — or,
  // while it *can't* be (offline / signed out / just started), the last moment we
  // knew that. The stall window is measured from here.
  private lastHealthyAt = 0
  private attempts = 0 // ladder position; resets on recovery
  // The destructive rung is a one-shot per stall episode. If wiping didn't fix it,
  // the replica was never the problem — and a service outage that outlasts the
  // backoff cap would otherwise wipe and re-download forever, leaving the device
  // with an empty local copy whenever it next goes genuinely offline.
  private cleared = false
  private restartCount = 0
  private lastRestartAt: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(deps: SyncHealthMonitorDeps) {
    this.deps = { now: () => Date.now(), ...deps }
  }

  engineStarting(): void {
    this.phase = 'starting'
    this.publish()
  }

  engineStarted(): void {
    this.phase = 'running'
    this.lastError = null
    this.lastHealthyAt = this.deps.now() // fresh grace window; ladder position kept on purpose
    this.publish()
  }

  engineFailed(err: unknown): void {
    this.phase = 'failed'
    this.lastError = err instanceof Error ? err.message : String(err)
    this.status = { connected: false, connecting: false, hasSynced: undefined, lastSyncedAt: null }
    this.publish()
  }

  engineStopped(): void {
    this.phase = 'off'
    this.status = { connected: false, connecting: false, hasSynced: undefined, lastSyncedAt: null }
    this.publish()
  }

  noteStatus(s: EngineStatus): void {
    this.status = s
    if (s.connected && s.hasSynced) {
      this.lastHealthyAt = this.deps.now()
      this.attempts = 0 // recovered — the next stall starts from the soft rung again
      // A verified full sync means the replica is healthy, so a *later* wedge may
      // reach for the wipe once more. (Deliberately not reset by engineStarted(),
      // which keeps ladder position on purpose — a restart loop must not re-arm it.)
      this.cleared = false
    }
    this.publish()
  }

  // One watchdog pass: classify, and when stalled, walk the restart ladder.
  // Restarts happen *only* here, never from a status event, so a flood of engine
  // events can't turn into a restart storm.
  async tick(): Promise<void> {
    const now = this.deps.now()
    if (this.phase !== 'running') {
      this.publish()
      return
    }
    // While syncing is impossible, keep the grace window pinned so a long offline
    // (or signed-out) stretch doesn't read as a stall the instant it ends.
    if (!this.deps.isOnline() || !this.deps.isAuthenticated()) {
      this.lastHealthyAt = now
      this.publish()
      return
    }
    if (this.classify(now) === 'stalled') await this.maybeRestart(now)
    this.publish()
  }

  start(tickMs: number = HEALTH_TICK_MS): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), tickMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private classify(now: number): SyncHealthStatus {
    if (this.phase === 'failed') return 'failed'
    if (this.phase === 'starting') return 'starting'
    if (this.phase !== 'running') return 'off'
    if (!this.deps.isOnline()) return 'offline'
    if (!this.deps.isAuthenticated()) return 'no-auth'
    if (this.status.connected && this.status.hasSynced) return 'ok'
    // Not verifiably healthy. Connected-but-never-synced counts too: a wedged
    // bootstrap looks exactly like the incident — socket up, replica empty.
    return now - this.lastHealthyAt > STALL_AFTER_MS ? 'stalled' : 'connecting'
  }

  private async maybeRestart(now: number): Promise<void> {
    if (this.attempts > 0) {
      const backoff = Math.min(RESTART_BACKOFF_BASE_MS * 2 ** (this.attempts - 1), RESTART_BACKOFF_MAX_MS)
      if (this.lastRestartAt !== null && now - this.lastRestartAt < backoff) return
    }
    const hard = this.attempts >= 1 // soft first; escalate when it didn't take
    // Two failed restarts (one soft, one hard) make the replica itself the
    // suspect — it survives a plain rebuild (same db file). Wipe it once; if that
    // didn't help it isn't the replica, so keep retrying non-destructively rather
    // than re-wiping every backoff period for as long as the outage lasts.
    const clear = this.attempts >= 2 && !this.cleared
    if (clear) this.cleared = true
    this.attempts++
    this.restartCount++
    this.lastRestartAt = now
    try {
      await (hard ? this.deps.hardRestart({ clear }) : this.deps.softRestart())
    } catch {
      /* the restart itself failed — the backoff paces the next attempt */
    }
  }

  private publish(): void {
    publishSyncHealth({
      status: this.classify(this.deps.now()),
      hasSynced: this.status.hasSynced ?? null,
      lastSyncedAt: this.status.lastSyncedAt,
      restartCount: this.restartCount,
      lastRestartAt: this.lastRestartAt,
      lastError: this.phase === 'failed' ? this.lastError : null,
    })
  }
}
