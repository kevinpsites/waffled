import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  SyncHealthMonitor,
  type SyncHealthMonitorDeps,
  type SyncHealthSnapshot,
  getSyncHealth,
  subscribeSyncHealth,
  publishSyncHealth,
  isReplicaTrusted,
  STALL_AFTER_MS,
  RESTART_BACKOFF_BASE_MS,
  RESTART_BACKOFF_MAX_MS,
  __resetSyncHealthForTests,
} from './sync-health'

// A monitor with a hand-cranked clock and spy restarts. Ticks are driven by hand —
// the setInterval wiring is trivial and covered by db.restart.test.ts.
function makeMonitor(over: Partial<SyncHealthMonitorDeps> = {}) {
  let now = 1_000_000
  const deps = {
    isOnline: vi.fn(() => true),
    isAuthenticated: vi.fn(() => true),
    softRestart: vi.fn(async () => {}),
    hardRestart: vi.fn(async () => {}),
    now: () => now,
    ...over,
  }
  const m = new SyncHealthMonitor(deps)
  return { m, deps, advance: (ms: number) => { now += ms } }
}

const CONNECTED = { connected: true, connecting: false, hasSynced: true, lastSyncedAt: 999_000 }
const DISCONNECTED = { connected: false, connecting: false, hasSynced: true, lastSyncedAt: 999_000 }

beforeEach(() => {
  __resetSyncHealthForTests()
})

describe('SyncHealthMonitor status', () => {
  it('starts off (PowerSync not running)', () => {
    makeMonitor()
    expect(getSyncHealth().status).toBe('off')
  })

  it('reports connecting after the engine starts, ok once connected+synced', async () => {
    const { m } = makeMonitor()
    m.engineStarted()
    await m.tick()
    expect(getSyncHealth().status).toBe('connecting')
    m.noteStatus(CONNECTED)
    expect(getSyncHealth().status).toBe('ok')
    expect(getSyncHealth().hasSynced).toBe(true)
    expect(getSyncHealth().lastSyncedAt).toBe(999_000)
  })

  it('treats a short disconnect as connecting, not a stall', async () => {
    const { m, advance } = makeMonitor()
    m.engineStarted()
    m.noteStatus(CONNECTED)
    m.noteStatus(DISCONNECTED)
    advance(STALL_AFTER_MS / 2)
    await m.tick()
    expect(getSyncHealth().status).toBe('connecting')
  })

  it('flags a stall once disconnected past the window while online + signed in', async () => {
    const { m, advance } = makeMonitor()
    m.engineStarted()
    m.noteStatus(CONNECTED)
    m.noteStatus(DISCONNECTED)
    advance(STALL_AFTER_MS + 1)
    await m.tick()
    expect(getSyncHealth().status).toBe('stalled')
  })

  // The 2026-07-20 shape exactly: the socket looks fine, the first sync never lands.
  it('flags a stall when connected but the first sync never completes', async () => {
    const { m, advance } = makeMonitor()
    m.engineStarted()
    m.noteStatus({ connected: true, connecting: false, hasSynced: false, lastSyncedAt: null })
    advance(STALL_AFTER_MS + 1)
    await m.tick()
    expect(getSyncHealth().status).toBe('stalled')
  })

  it('offline suppresses the stall and does not bank time toward it', async () => {
    let online = true
    const { m, advance, deps } = makeMonitor({ isOnline: () => online })
    m.engineStarted()
    m.noteStatus(CONNECTED)
    m.noteStatus(DISCONNECTED)
    online = false
    advance(STALL_AFTER_MS * 5)
    await m.tick()
    expect(getSyncHealth().status).toBe('offline')
    expect(deps.softRestart).not.toHaveBeenCalled()
    // Back online: the offline stretch must not count toward the stall window.
    online = true
    await m.tick()
    expect(getSyncHealth().status).toBe('connecting')
    advance(STALL_AFTER_MS + 1)
    await m.tick()
    expect(getSyncHealth().status).toBe('stalled')
  })

  it('signed-out suppresses the stall (nothing to sync without credentials)', async () => {
    const { m, advance, deps } = makeMonitor({ isAuthenticated: vi.fn(() => false) })
    m.engineStarted()
    m.noteStatus(DISCONNECTED)
    advance(STALL_AFTER_MS * 5)
    await m.tick()
    expect(getSyncHealth().status).toBe('no-auth')
    expect(deps.softRestart).not.toHaveBeenCalled()
  })

  it('engineStopped returns to off', () => {
    const { m } = makeMonitor()
    m.engineStarted()
    m.noteStatus(CONNECTED)
    m.engineStopped()
    expect(getSyncHealth().status).toBe('off')
  })

  it('start()/stop() drive ticks on an interval', async () => {
    vi.useFakeTimers()
    try {
      const { m, deps } = makeMonitor()
      m.engineStarted()
      m.start(1000)
      await vi.advanceTimersByTimeAsync(3000)
      m.stop()
      // Nothing to restart yet, but the ticks must have consulted the deps.
      const calls = () => vi.mocked(deps.isOnline).mock.calls.length
      expect(calls()).toBeGreaterThanOrEqual(3)
      const before = calls()
      await vi.advanceTimersByTimeAsync(5000)
      expect(calls()).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SyncHealthMonitor restart ladder', () => {
  async function stall(m: SyncHealthMonitor, advance: (ms: number) => void) {
    m.engineStarted()
    m.noteStatus(CONNECTED)
    m.noteStatus(DISCONNECTED)
    advance(STALL_AFTER_MS + 1)
    await m.tick()
  }

  it('soft-restarts once when the stall is first detected', async () => {
    const { m, deps, advance } = makeMonitor()
    await stall(m, advance)
    expect(deps.softRestart).toHaveBeenCalledTimes(1)
    expect(deps.hardRestart).not.toHaveBeenCalled()
    expect(getSyncHealth().restartCount).toBe(1)
    expect(getSyncHealth().lastRestartAt).not.toBeNull()
  })

  it('does not restart again before the backoff elapses', async () => {
    const { m, deps, advance } = makeMonitor()
    await stall(m, advance)
    advance(RESTART_BACKOFF_BASE_MS / 2)
    await m.tick()
    expect(deps.softRestart).toHaveBeenCalledTimes(1)
    expect(deps.hardRestart).not.toHaveBeenCalled()
  })

  it('escalates to a hard restart when the soft one did not take', async () => {
    const { m, deps, advance } = makeMonitor()
    await stall(m, advance)
    advance(RESTART_BACKOFF_BASE_MS + 1)
    await m.tick()
    expect(deps.hardRestart).toHaveBeenCalledTimes(1)
    expect(deps.hardRestart).toHaveBeenLastCalledWith({ clear: false })
    expect(getSyncHealth().restartCount).toBe(2)
  })

  // A wedged/corrupt replica survives a plain hard restart (same db file), so on
  // the third rung the watchdog asks for a wipe + full re-download — ONCE. If the
  // wipe didn't help, the replica wasn't the problem, and repeating it during a
  // long outage would destroy the offline copy over and over.
  it('escalates to a clearing hard restart on the third attempt, then stops clearing', async () => {
    const { m, deps, advance } = makeMonitor()
    m.engineStarted()
    advance(STALL_AFTER_MS + 1)
    await m.tick() // 1: soft
    advance(RESTART_BACKOFF_BASE_MS + 1)
    await m.tick() // 2: hard
    expect(deps.hardRestart).toHaveBeenLastCalledWith({ clear: false })
    advance(RESTART_BACKOFF_BASE_MS * 2 + 1)
    await m.tick() // 3: hard + clear
    expect(deps.hardRestart).toHaveBeenCalledTimes(2)
    expect(deps.hardRestart).toHaveBeenLastCalledWith({ clear: true })
    advance(RESTART_BACKOFF_BASE_MS * 4 + 1)
    await m.tick() // 4: back to a plain rebuild
    expect(deps.hardRestart).toHaveBeenLastCalledWith({ clear: false })
  })

  // The outage that motivated this: the service is down for an hour while the
  // browser still reports online with a valid token, so nothing pins the grace
  // window. With the destructive rung latched on, every ≤16 min wiped the replica
  // again — and once wiped, a genuinely offline stretch shows a blank calendar.
  it('wipes the replica at most once across a long sustained outage', async () => {
    const { m, deps, advance } = makeMonitor()
    m.engineStarted()
    advance(STALL_AFTER_MS + 1)
    await m.tick()
    for (let i = 0; i < 20; i++) {
      advance(RESTART_BACKOFF_MAX_MS + 1)
      await m.tick()
    }
    const clearing = vi.mocked(deps.hardRestart).mock.calls.filter(([o]) => o.clear)
    expect(clearing).toHaveLength(1)
    expect(vi.mocked(deps.hardRestart).mock.calls.length).toBeGreaterThan(10)
  })

  // A verified full recovery means the replica is healthy again, so a *later*
  // wedge is allowed to reach for the wipe once more.
  it('re-arms the clearing rung after a verified recovery', async () => {
    const { m, deps, advance } = makeMonitor()
    m.engineStarted()
    advance(STALL_AFTER_MS + 1)
    await m.tick() // soft
    advance(RESTART_BACKOFF_BASE_MS + 1)
    await m.tick() // hard
    advance(RESTART_BACKOFF_BASE_MS * 2 + 1)
    await m.tick() // hard + clear
    expect(deps.hardRestart).toHaveBeenLastCalledWith({ clear: true })
    m.noteStatus(CONNECTED) // fully synced again
    m.noteStatus(DISCONNECTED)
    advance(STALL_AFTER_MS + 1)
    await m.tick() // soft
    advance(RESTART_BACKOFF_BASE_MS + 1)
    await m.tick() // hard
    advance(RESTART_BACKOFF_BASE_MS * 2 + 1)
    await m.tick() // hard + clear again
    expect(deps.hardRestart).toHaveBeenLastCalledWith({ clear: true })
  })

  it('doubles the backoff between attempts and caps it', async () => {
    const { m, deps, advance } = makeMonitor()
    await stall(m, advance) // 1 (soft)
    advance(RESTART_BACKOFF_BASE_MS + 1)
    await m.tick() // 2 (hard)
    // Next backoff is base*2 — a tick after only base must not restart.
    advance(RESTART_BACKOFF_BASE_MS + 1)
    await m.tick()
    expect(deps.hardRestart).toHaveBeenCalledTimes(1)
    advance(RESTART_BACKOFF_BASE_MS + 1)
    await m.tick() // 3
    expect(deps.hardRestart).toHaveBeenCalledTimes(2)
    // The ladder never waits longer than the cap, however many attempts deep.
    for (let i = 0; i < 10; i++) {
      advance(RESTART_BACKOFF_MAX_MS + 1)
      await m.tick()
    }
    expect(deps.hardRestart).toHaveBeenCalledTimes(12)
  })

  it('recovery resets the ladder: the next stall starts soft again', async () => {
    const { m, deps, advance } = makeMonitor()
    await stall(m, advance)
    advance(RESTART_BACKOFF_BASE_MS + 1)
    await m.tick() // hard
    m.noteStatus(CONNECTED) // recovered
    expect(getSyncHealth().status).toBe('ok')
    m.noteStatus(DISCONNECTED)
    advance(STALL_AFTER_MS + 1)
    await m.tick()
    expect(deps.softRestart).toHaveBeenCalledTimes(2)
    expect(deps.hardRestart).toHaveBeenCalledTimes(1)
  })

  it('tolerates a throwing restart and still paces the next one by the backoff', async () => {
    const { m, deps, advance } = makeMonitor({
      softRestart: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    await stall(m, advance)
    expect(deps.softRestart).toHaveBeenCalledTimes(1)
    await m.tick() // immediately after — inside the backoff
    expect(deps.softRestart).toHaveBeenCalledTimes(1)
    expect(deps.hardRestart).not.toHaveBeenCalled()
  })

  it('never restarts while the engine is off or still starting', async () => {
    const { m, deps, advance } = makeMonitor()
    advance(STALL_AFTER_MS * 3)
    await m.tick()
    m.engineStarting()
    advance(STALL_AFTER_MS * 3)
    await m.tick()
    expect(deps.softRestart).not.toHaveBeenCalled()
    expect(deps.hardRestart).not.toHaveBeenCalled()
  })
})

// A boot or rebuild crash used to latch: tick() returned early for any phase but
// 'running', so nothing ever re-classified or retried. An OPFS lock held by
// another tab — a transient that clears on its own — left the engine dead until
// somebody found the Restart sync button.
describe('recovering from a failed engine', () => {
  it('retries a failed engine on the backoff ladder instead of latching', async () => {
    const { m, deps, advance } = makeMonitor()
    m.engineStarting()
    m.engineFailed(new Error('OPFS locked'))
    await m.tick()
    expect(deps.hardRestart).toHaveBeenCalledTimes(1)
    // Paced by the same backoff — no retry storm.
    advance(RESTART_BACKOFF_BASE_MS / 2)
    await m.tick()
    expect(deps.hardRestart).toHaveBeenCalledTimes(1)
    advance(RESTART_BACKOFF_BASE_MS + 1)
    await m.tick()
    expect(deps.hardRestart).toHaveBeenCalledTimes(2)
  })

  // A crash on boot is no evidence at all that the replica is bad — no engine ever
  // reached a connected state to judge it. Retrying must never escalate to a wipe.
  it('never wipes the replica while retrying a failed engine', async () => {
    const { m, deps, advance } = makeMonitor()
    m.engineFailed(new Error('OPFS locked'))
    for (let i = 0; i < 10; i++) {
      advance(RESTART_BACKOFF_MAX_MS + 1)
      await m.tick()
    }
    expect(vi.mocked(deps.hardRestart).mock.calls.length).toBeGreaterThan(5)
    expect(deps.softRestart).not.toHaveBeenCalled() // there is no client to soft-restart
    for (const [opts] of vi.mocked(deps.hardRestart).mock.calls) expect(opts.clear).toBe(false)
  })

  it('does not retry a failed engine while offline or signed out', async () => {
    let online = false
    const { m, deps, advance } = makeMonitor({ isOnline: () => online })
    m.engineFailed(new Error('OPFS locked'))
    advance(RESTART_BACKOFF_MAX_MS + 1)
    await m.tick()
    expect(deps.hardRestart).not.toHaveBeenCalled()
    expect(getSyncHealth().status).toBe('failed') // still honest about why
    online = true
    await m.tick()
    expect(deps.hardRestart).toHaveBeenCalledTimes(1)
  })

  it('a successful retry leaves the failed state behind', async () => {
    const { m, deps } = makeMonitor({ hardRestart: vi.fn(async () => {}) })
    m.engineFailed(new Error('OPFS locked'))
    await m.tick()
    expect(deps.hardRestart).toHaveBeenCalledTimes(1)
    m.engineStarting()
    m.engineStarted()
    m.noteStatus(CONNECTED)
    expect(getSyncHealth().status).toBe('ok')
    expect(getSyncHealth().lastError ?? null).toBeNull()
  })
})

describe('sync health store', () => {
  it('notifies subscribers on change and supports unsubscribe', () => {
    const cb = vi.fn()
    const off = subscribeSyncHealth(cb)
    publishSyncHealth({ status: 'ok', hasSynced: true, lastSyncedAt: 1, restartCount: 0, lastRestartAt: null })
    expect(cb).toHaveBeenCalledTimes(1)
    // Publishing an identical snapshot is a no-op (no render churn).
    publishSyncHealth({ status: 'ok', hasSynced: true, lastSyncedAt: 1, restartCount: 0, lastRestartAt: null })
    expect(cb).toHaveBeenCalledTimes(1)
    off()
    publishSyncHealth({ status: 'stalled', hasSynced: true, lastSyncedAt: 1, restartCount: 1, lastRestartAt: 2 })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(getSyncHealth().status).toBe('stalled')
  })

  it('keeps the same snapshot identity when nothing changed (useSyncExternalStore safety)', () => {
    publishSyncHealth({ status: 'ok', hasSynced: true, lastSyncedAt: 1, restartCount: 0, lastRestartAt: null })
    const first = getSyncHealth()
    publishSyncHealth({ status: 'ok', hasSynced: true, lastSyncedAt: 1, restartCount: 0, lastRestartAt: null })
    expect(getSyncHealth()).toBe(first)
  })
})

describe('isReplicaTrusted', () => {
  const base = { lastSyncedAt: 1, restartCount: 0, lastRestartAt: null }

  it('trusts a fully-synced replica that is ok, connecting, offline, or signed out', () => {
    for (const status of ['ok', 'connecting', 'offline', 'no-auth'] as const) {
      publishSyncHealth({ status, hasSynced: true, ...base })
      expect(isReplicaTrusted(), status).toBe(true)
    }
  })

  it('never trusts a stalled engine — REST must drive the UI', () => {
    publishSyncHealth({ status: 'stalled', hasSynced: true, ...base })
    expect(isReplicaTrusted()).toBe(false)
  })

  it('never trusts a replica that has not completed a first sync', () => {
    publishSyncHealth({ status: 'ok', hasSynced: false, ...base })
    expect(isReplicaTrusted()).toBe(false)
    publishSyncHealth({ status: 'connecting', hasSynced: null, ...base })
    expect(isReplicaTrusted()).toBe(false)
  })

  it('does not trust anything while PowerSync is off entirely', () => {
    expect(getSyncHealth().status).toBe('off')
    expect(isReplicaTrusted()).toBe(false)
  })

  it('never trusts a starting or failed engine', () => {
    const synced = { hasSynced: true as const, ...base }
    publishSyncHealth({ status: 'starting', ...synced })
    expect(isReplicaTrusted()).toBe(false)
    publishSyncHealth({ status: 'failed', ...synced, lastError: 'OPFS unavailable' })
    expect(isReplicaTrusted()).toBe(false)
  })
})

// Boot takes seconds (WASM + OPFS init) and a boot crash is silent — both used to
// read as "off" on the Live Sync card, which is why people thought sync was
// disabled. 'starting' and 'failed' make the difference legible.
describe('starting / failed states', () => {
  it('engineStarting publishes starting (not off) until the engine is up', async () => {
    const { m } = makeMonitor()
    m.engineStarting()
    expect(getSyncHealth().status).toBe('starting')
    await m.tick()
    expect(getSyncHealth().status).toBe('starting')
    m.engineStarted()
    await m.tick()
    expect(getSyncHealth().status).toBe('connecting')
  })

  it('engineFailed publishes failed with the error message, and it sticks', async () => {
    const { m } = makeMonitor()
    m.engineStarting()
    m.engineFailed(new Error('OPFS unavailable'))
    const snap: SyncHealthSnapshot = getSyncHealth()
    expect(snap.status).toBe('failed')
    expect(snap.lastError).toBe('OPFS unavailable')
    await m.tick()
    expect(getSyncHealth().status).toBe('failed')
  })

  it('stringifies a non-Error failure rather than dropping it', () => {
    const { m } = makeMonitor()
    m.engineFailed('worker refused to boot')
    expect(getSyncHealth().lastError).toBe('worker refused to boot')
  })

  it('a successful start after a failure clears the error', () => {
    const { m } = makeMonitor()
    m.engineFailed(new Error('boom'))
    m.engineStarting()
    m.engineStarted()
    expect(getSyncHealth().status).toBe('connecting')
    expect(getSyncHealth().lastError ?? null).toBeNull()
  })
})
