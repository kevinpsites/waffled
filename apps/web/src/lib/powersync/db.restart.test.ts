import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fake @powersync/web. Instances are tracked by the constructor so the hard-restart
// tests can assert that a genuinely NEW client was built — the old one owns the
// wedged worker we are trying to replace.
// `failNext` lets a test make the NEXT boot throw at a chosen step (init/connect
// are per-instance fns, so prototype spies can't reach them).
const fakes = vi.hoisted(() => ({
  instances: [] as FakePowerSyncDatabase[],
  failNext: null as { step: 'init' | 'connect'; message: string } | null,
}))

function maybeFail(step: 'init' | 'connect') {
  if (fakes.failNext?.step !== step) return
  const { message } = fakes.failNext
  fakes.failNext = null
  throw new Error(message)
}

class FakePowerSyncDatabase {
  listeners: Array<{ statusChanged?: (s: unknown) => void }> = []
  watchCalls: Array<{ sql: string; options: { signal?: AbortSignal } }> = []
  onChangeCalls: Array<{ handler: { onChange: () => void }; options: unknown }> = []
  init = vi.fn(async () => maybeFail('init'))
  connect = vi.fn(async () => maybeFail('connect'))
  disconnect = vi.fn(async () => {})
  close = vi.fn(async () => {})
  disconnectAndClear = vi.fn(async () => {})
  getNextCrudTransaction = vi.fn(async (): Promise<unknown> => null)
  currentStatus = { connected: false, connecting: true, hasSynced: false, lastSyncedAt: undefined }
  getOptional = vi.fn(async () => null)
  registerListener(l: { statusChanged?: (s: unknown) => void }) {
    this.listeners.push(l)
    return () => {}
  }
  onChange(handler: { onChange: () => void }, options: unknown) {
    this.onChangeCalls.push({ handler, options })
    return () => {}
  }
  watch(sql: string, _params: unknown[], _handler: unknown, options: { signal?: AbortSignal }) {
    this.watchCalls.push({ sql, options })
  }
  constructor(_opts: unknown) {
    fakes.instances.push(this)
  }
}

vi.mock('@powersync/web', () => ({ PowerSyncDatabase: FakePowerSyncDatabase }))
vi.mock('./schema', () => ({ AppSchema: {} }))

// The engine emits SyncStatus objects; the wiring only reads these four fields.
const okStatus = { connected: true, connecting: false, hasSynced: true, lastSyncedAt: new Date(1_700_000_000_000) }

// vi.resetModules gives each test a fresh module graph — pull db AND the (also
// fresh, hence already-reset) sync-health store from that same graph.
let getSyncHealth: typeof import('./sync-health').getSyncHealth
let HEALTH_TICK_MS: number

async function freshDbModule() {
  vi.resetModules()
  const mod = await import('./db')
  ;({ getSyncHealth, HEALTH_TICK_MS } = await import('./sync-health'))
  return mod
}

beforeEach(() => {
  fakes.instances.length = 0
  fakes.failNext = null
  localStorage.clear()
  localStorage.setItem('waffled.session.v1', JSON.stringify({
    v: 1,
    scope: 'test-scope',
    accessToken: 'tok',
    refreshToken: 'refresh-tok',
  })) // signed in, so health isn't pinned at no-auth
  localStorage.setItem('waffled.powersyncIdentityScope', 'session:test-scope')
})

describe('connectPowerSync', () => {
  it('purges a pre-owner-format replica before publishing it on upgrade', async () => {
    localStorage.removeItem('waffled.powersyncIdentityScope')
    const db = await freshDbModule()
    await db.connectPowerSync()

    expect(fakes.instances[0].disconnectAndClear).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('waffled.powersyncIdentityScope')).toBe('session:test-scope')
    expect(db.getPowerSyncDb()).toBe(fakes.instances[0] as never)
  })

  it('creates and connects a single client (a second call is a no-op)', async () => {
    const db = await freshDbModule()
    await db.connectPowerSync()
    await db.connectPowerSync()
    expect(fakes.instances).toHaveLength(1)
    expect(fakes.instances[0].init).toHaveBeenCalledTimes(1)
    expect(fakes.instances[0].connect).toHaveBeenCalledTimes(1)
    expect(db.getPowerSyncDb()).toBe(fakes.instances[0] as never)
  })

  it('feeds engine status into the sync-health store', async () => {
    const db = await freshDbModule()
    await db.connectPowerSync()
    const listener = fakes.instances[0].listeners.find((l) => l.statusChanged)
    expect(listener).toBeTruthy()
    listener!.statusChanged!(okStatus)
    expect(getSyncHealth().status).toBe('ok')
    expect(getSyncHealth().lastSyncedAt).toBe(1_700_000_000_000)
  })

  // A swallowed boot crash used to be indistinguishable from "engine not running".
  it('publishes failed (with the message) when the engine cannot boot', async () => {
    const db = await freshDbModule()
    fakes.failNext = { step: 'init', message: 'OPFS unavailable' }
    await db.connectPowerSync()
    expect(db.getPowerSyncDb()).toBeNull()
    expect(getSyncHealth().status).toBe('failed')
    expect(getSyncHealth().lastError).toBe('OPFS unavailable')
  })

  // A half-built client still owns the worker and the OPFS handle on waffled.db.
  // Leaving it open while nulling the module's reference orphans it forever: the
  // next hard restart sees no old client, closes nothing, and opens a SECOND
  // PowerSyncDatabase on the same file — once per restart-ladder rung.
  it('closes the half-built client when connect() throws instead of orphaning it', async () => {
    const db = await freshDbModule()
    fakes.failNext = { step: 'connect', message: 'no socket' }
    await db.connectPowerSync()
    expect(db.getPowerSyncDb()).toBeNull()
    expect(fakes.instances[0].close).toHaveBeenCalledTimes(1)
  })

  // A boot crash used to leave no watchdog timer at all, so the retry the monitor
  // now knows how to do would never have been driven.
  it('still runs the watchdog after a boot failure so it can retry', async () => {
    vi.useFakeTimers()
    try {
      const db = await freshDbModule()
      fakes.failNext = { step: 'init', message: 'OPFS locked' }
      await db.connectPowerSync()
      expect(getSyncHealth().status).toBe('failed')
      await vi.advanceTimersByTimeAsync(HEALTH_TICK_MS + 1)
      // The tick drove a rebuild, and this time nothing is failing.
      expect(fakes.instances.length).toBeGreaterThan(1)
      expect(db.getPowerSyncDb()).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes the half-built client when init() throws', async () => {
    const db = await freshDbModule()
    fakes.failNext = { step: 'init', message: 'OPFS unavailable' }
    await db.connectPowerSync()
    expect(fakes.instances[0].close).toHaveBeenCalledTimes(1)
  })

  // The orphan's real cost: the retry must build exactly one replacement, on a
  // file no dead instance is still holding.
  it('a retry after a failed connect builds exactly one replacement client', async () => {
    const db = await freshDbModule()
    fakes.failNext = { step: 'connect', message: 'no socket' }
    await db.connectPowerSync()
    await db.restartPowerSyncHard()
    expect(fakes.instances).toHaveLength(2)
    expect(fakes.instances[0].close).toHaveBeenCalledTimes(1)
    expect(db.getPowerSyncDb()).toBe(fakes.instances[1] as never)
  })
})

describe('principal transitions', () => {
  it('refuses a lossless replacement while uploads are pending', async () => {
    const db = await freshDbModule()
    const client = await import('../api/client')
    await db.connectPowerSync()
    const old = fakes.instances[0]
    old.getNextCrudTransaction.mockResolvedValue({ crud: [{}] })

    await expect(client.setSession('new-access', 'new-refresh')).rejects.toMatchObject({
      name: 'PrincipalTransitionError',
      result: 'pending-uploads',
    })
    expect(client.getAccessToken()).toBe('tok')
    expect(old.disconnectAndClear).not.toHaveBeenCalled()
    expect(db.getPowerSyncDb()).toBe(old as never)
  })

  it('does not call the household-switch endpoint until the local queue preflight passes', async () => {
    const db = await freshDbModule()
    const client = await import('../api/client')
    await db.connectPowerSync()
    const old = fakes.instances[0]
    old.getNextCrudTransaction.mockResolvedValue({ crud: [{}] })
    const prepare = vi.fn(async () => ({ accessToken: 'new-access', refreshToken: 'new-refresh' }))

    await expect(client.setSessionFrom(prepare)).rejects.toMatchObject({
      name: 'PrincipalTransitionError',
      result: 'pending-uploads',
    })
    expect(prepare).not.toHaveBeenCalled()
    expect(old.disconnectAndClear).not.toHaveBeenCalled()
    expect(client.getAccessToken()).toBe('tok')
  })

  it('clears the old replica before requesting prepared switch credentials', async () => {
    const db = await freshDbModule()
    const client = await import('../api/client')
    await db.connectPowerSync()
    const old = fakes.instances[0]
    const prepare = vi.fn(async () => {
      expect(old.disconnectAndClear).toHaveBeenCalledTimes(1)
      expect(client.getAccessToken()).toBe('tok')
      return { accessToken: 'new-access', refreshToken: 'new-refresh' }
    })

    await client.setSessionFrom(prepare)

    expect(prepare).toHaveBeenCalledOnce()
    expect(client.getAccessToken()).toBe('new-access')
    expect(db.getPowerSyncDb()).toBe(fakes.instances[1] as never)
  })

  it('reconnects the unchanged principal if prepared switch credentials fail', async () => {
    const db = await freshDbModule()
    const client = await import('../api/client')
    await db.connectPowerSync()
    const old = fakes.instances[0]
    const prepare = vi.fn(async () => { throw new Error('switch unavailable') })

    await expect(client.setSessionFrom(prepare)).rejects.toThrow('switch unavailable')

    expect(old.disconnectAndClear).toHaveBeenCalledTimes(1)
    expect(client.getAccessToken()).toBe('tok')
    expect(fakes.instances).toHaveLength(2)
    expect(db.getPowerSyncDb()).toBe(fakes.instances[1] as never)
  })

  it('clears the old replica before an explicitly authorized replacement', async () => {
    const db = await freshDbModule()
    const client = await import('../api/client')
    await db.connectPowerSync()
    const old = fakes.instances[0]
    old.getNextCrudTransaction.mockResolvedValue({ crud: [{}] })

    await client.setSession('new-access', 'new-refresh', { discardPending: true })

    expect(old.disconnectAndClear).toHaveBeenCalledTimes(1)
    expect(old.close).toHaveBeenCalledTimes(1)
    expect(client.getAccessToken()).toBe('new-access')
    expect(client.currentIdentityScope()).not.toBe('session:test-scope')
    expect(localStorage.getItem('waffled.powersyncIdentityScope')).toBe(client.currentIdentityScope())
    expect(db.getPowerSyncDb()).toBe(fakes.instances[1] as never)
  })

  it('does not publish replacement credentials when an unknown on-disk replica cannot open', async () => {
    const db = await freshDbModule()
    const client = await import('../api/client')
    // Model a prior failed boot: an A-owned OPFS file exists but there is no live
    // handle available for the transition to inspect or clear.
    fakes.failNext = { step: 'init', message: 'OPFS locked' }
    await db.connectPowerSync()
    expect(db.getPowerSyncDb()).toBeNull()
    fakes.failNext = { step: 'init', message: 'still locked' }

    await expect(client.setSession('new-access', 'new-refresh', { discardPending: true }))
      .rejects.toMatchObject({ result: 'purge-failed' })
    expect(client.getAccessToken()).toBe('tok')
    expect(localStorage.getItem('waffled.powersyncIdentityScope')).toBe('session:test-scope')
  })

  it('quarantines a failed clear when signing out and never re-exposes the old handle', async () => {
    const db = await freshDbModule()
    const client = await import('../api/client')
    await db.connectPowerSync()
    const old = fakes.instances[0]
    old.disconnectAndClear = vi.fn(async () => { throw new Error('clear failed') })

    await expect(client.clearSession({ discardPending: true })).resolves.toBeUndefined()
    expect(client.getAccessToken()).toBeUndefined()
    expect(db.getPowerSyncDb()).toBeNull()
    expect(localStorage.getItem('waffled.powersyncIdentityScope')).toBe('session:test-scope')
    expect(old.close).toHaveBeenCalledTimes(1)
  })

  it('serializes a replacement behind an in-flight hard restart', async () => {
    const db = await freshDbModule()
    const client = await import('../api/client')
    await db.connectPowerSync()
    const old = fakes.instances[0]
    let releaseClose!: () => void
    old.close = vi.fn(() => new Promise<void>((resolve) => { releaseClose = resolve }))

    const restart = db.restartPowerSyncHard()
    const replace = client.setSession('new-access', 'new-refresh', { discardPending: true })
    await vi.waitFor(() => expect(old.close).toHaveBeenCalledTimes(1))
    expect(client.getAccessToken()).toBe('tok')
    releaseClose()
    await Promise.all([restart, replace])

    // Restart publishes instance 2 under A; the queued transition then clears it
    // and publishes instance 3 under B.
    expect(fakes.instances).toHaveLength(3)
    expect(fakes.instances[1].disconnectAndClear).toHaveBeenCalledTimes(1)
    expect(client.getAccessToken()).toBe('new-access')
    expect(db.getPowerSyncDb()).toBe(fakes.instances[2] as never)
  })
})

// The watchdog only re-classifies on its 30s tick, but the kiosk's offline strip
// appears after 10s — so a stall that coincides with the network dropping used to
// stack two banners for ~20s. Reacting to the browser's own events closes that gap.
describe('connectivity events', () => {
  function setOnline(value: boolean) {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value })
  }

  it('re-classifies immediately when the browser goes offline and comes back', async () => {
    const db = await freshDbModule()
    await db.connectPowerSync()
    expect(getSyncHealth().status).toBe('connecting')

    setOnline(false)
    window.dispatchEvent(new Event('offline'))
    await Promise.resolve()
    expect(getSyncHealth().status).toBe('offline')

    setOnline(true)
    window.dispatchEvent(new Event('online'))
    await Promise.resolve()
    expect(getSyncHealth().status).toBe('connecting')
  })
})

describe('restartPowerSyncSoft', () => {
  it('disconnects and reconnects the same client', async () => {
    const db = await freshDbModule()
    await db.connectPowerSync()
    await db.restartPowerSyncSoft()
    expect(fakes.instances).toHaveLength(1)
    expect(fakes.instances[0].disconnect).toHaveBeenCalledTimes(1)
    expect(fakes.instances[0].connect).toHaveBeenCalledTimes(2)
  })

  it('is a safe no-op when PowerSync never came up', async () => {
    const db = await freshDbModule()
    await expect(db.restartPowerSyncSoft()).resolves.toBeUndefined()
  })

  it('never reconnects a raw handle after the atomic session scope changed', async () => {
    const db = await freshDbModule()
    await db.connectPowerSync()
    const old = fakes.instances[0]
    localStorage.setItem('waffled.session.v1', JSON.stringify({
      v: 1,
      scope: 'replacement-scope',
      accessToken: 'replacement-token',
      refreshToken: 'replacement-refresh',
    }))

    expect(db.getPowerSyncDb()).toBeNull()
    await db.restartPowerSyncSoft()

    expect(old.disconnect).toHaveBeenCalledTimes(1)
    expect(old.close).toHaveBeenCalledTimes(1)
    expect(old.connect).toHaveBeenCalledTimes(1)
    expect(fakes.instances).toHaveLength(2)
    expect(fakes.instances[1].disconnectAndClear).toHaveBeenCalledTimes(1)
    expect(db.getPowerSyncDb()).toBe(fakes.instances[1] as never)
  })
})

describe('restartPowerSyncHard', () => {
  it('closes the old client and builds + connects a fresh one', async () => {
    const db = await freshDbModule()
    await db.connectPowerSync()
    const old = fakes.instances[0]
    await db.restartPowerSyncHard()
    expect(old.close).toHaveBeenCalledTimes(1)
    expect(fakes.instances).toHaveLength(2)
    expect(fakes.instances[1].connect).toHaveBeenCalledTimes(1)
    expect(db.getPowerSyncDb()).toBe(fakes.instances[1] as never)
  })

  it('re-wires status events from the new client into the health store', async () => {
    const db = await freshDbModule()
    await db.connectPowerSync()
    await db.restartPowerSyncHard()
    const listener = fakes.instances[1].listeners.find((l) => l.statusChanged)
    expect(listener).toBeTruthy()
    listener!.statusChanged!(okStatus)
    expect(getSyncHealth().status).toBe('ok')
  })

  it('shares one restart between concurrent callers', async () => {
    const db = await freshDbModule()
    await db.connectPowerSync()
    await Promise.all([db.restartPowerSyncHard(), db.restartPowerSyncHard()])
    expect(fakes.instances).toHaveLength(2)
  })

  // Sharing is only correct between callers that asked for the SAME thing. The
  // single-flight guard used to alias on the promise alone, so a request with a
  // different `clear` silently got the in-flight behaviour instead of its own.
  describe('concurrent callers that disagree about clear', () => {
    // Hold a restart open inside close() so a second request lands mid-flight.
    function hangClose(instance: FakePowerSyncDatabase) {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      instance.close = vi.fn(() => gate)
      return release
    }

    // "Reset local copy" during a watchdog rebuild used to resolve as if it had
    // wiped, re-enabling the button while the replica was untouched.
    it('does not alias a clearing request onto an in-flight plain restart', async () => {
      const db = await freshDbModule()
      await db.connectPowerSync()
      const release = hangClose(fakes.instances[0])
      const plain = db.restartPowerSyncHard()
      const clearing = db.restartPowerSyncHard({ clear: true })
      expect(clearing).not.toBe(plain)
      release()
      await Promise.all([plain, clearing])
      expect(fakes.instances).toHaveLength(3)
      expect(fakes.instances[1].disconnectAndClear).toHaveBeenCalledTimes(1)
    })

    // The dangerous direction: "Restart sync" must never inherit a wipe the user
    // did not ask for from the watchdog's top rung.
    it('does not let an in-flight clearing restart absorb a plain restart', async () => {
      const db = await freshDbModule()
      await db.connectPowerSync()
      const release = hangClose(fakes.instances[0])
      const clearing = db.restartPowerSyncHard({ clear: true })
      const plain = db.restartPowerSyncHard()
      expect(plain).not.toBe(clearing)
      release()
      await Promise.all([clearing, plain])
      expect(fakes.instances).toHaveLength(3)
      expect(fakes.instances[1].disconnectAndClear).not.toHaveBeenCalled()
    })
  })

  it('notifies onPowerSyncRecreated subscribers (and disposers stop that)', async () => {
    const db = await freshDbModule()
    await db.connectPowerSync()
    const cb = vi.fn()
    const off = db.onPowerSyncRecreated(cb)
    await db.restartPowerSyncHard()
    expect(cb).toHaveBeenCalledTimes(1)
    off()
    await db.restartPowerSyncHard()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('re-arms onTablesChange subscriptions on the new client', async () => {
    const db = await freshDbModule()
    await db.connectPowerSync()
    const dispose = db.onTablesChange(['events'], () => {})
    expect(fakes.instances[0].onChangeCalls).toHaveLength(1)
    await db.restartPowerSyncHard()
    expect(fakes.instances[1].onChangeCalls).toHaveLength(1)
    dispose()
    await db.restartPowerSyncHard()
    expect(fakes.instances[2].onChangeCalls).toHaveLength(0)
  })

  it('surfaces a failed rebuild instead of leaving a phantom client', async () => {
    const db = await freshDbModule()
    await db.connectPowerSync()
    fakes.failNext = { step: 'connect', message: 'worker gone' }
    await db.restartPowerSyncHard()
    expect(db.getPowerSyncDb()).toBeNull()
    expect(getSyncHealth().status).toBe('failed')
    expect(getSyncHealth().lastError).toBe('worker gone')
  })
})

// A wedged or corrupt local replica survives every plain hard restart (same
// dbFilename), so the watchdog's top rung asks for a wipe + full re-download —
// unless local writes are still queued for upload. Family data beats the replica.
describe('restartPowerSyncHard({ clear: true })', () => {
  it('wipes the old replica via disconnectAndClear before rebuilding', async () => {
    const db = await freshDbModule()
    await db.connectPowerSync()
    const old = fakes.instances[0]
    await db.restartPowerSyncHard({ clear: true })
    expect(old.disconnectAndClear).toHaveBeenCalledTimes(1)
    expect(fakes.instances).toHaveLength(2)
    expect(fakes.instances[1].connect).toHaveBeenCalledTimes(1)
  })

  it('skips the wipe when local writes are still queued (plain hard restart instead)', async () => {
    const db = await freshDbModule()
    await db.connectPowerSync()
    const old = fakes.instances[0]
    old.getNextCrudTransaction = vi.fn(async () => ({ crud: [{}] }))
    await db.restartPowerSyncHard({ clear: true })
    expect(old.disconnectAndClear).not.toHaveBeenCalled()
    expect(old.close).toHaveBeenCalledTimes(1)
    expect(fakes.instances).toHaveLength(2)
  })

  // The clearing rung only ever runs against an already-wedged client — which is
  // exactly the client whose queue probe is most likely to throw. "Couldn't read
  // the queue" must never be read as "the queue is empty", or the one case the
  // guarantee exists for is the one case that destroys unsent family data.
  it('rebuilds WITHOUT wiping when a wedged client cannot report its queue', async () => {
    const db = await freshDbModule()
    await db.connectPowerSync()
    const old = fakes.instances[0]
    old.getNextCrudTransaction = vi.fn(async () => {
      throw new Error('wedged')
    })
    await db.restartPowerSyncHard({ clear: true })
    expect(old.disconnectAndClear).not.toHaveBeenCalled()
    expect(old.close).toHaveBeenCalledTimes(1)
    expect(fakes.instances).toHaveLength(2)
  })

  it('a plain hard restart never clears', async () => {
    const db = await freshDbModule()
    await db.connectPowerSync()
    const old = fakes.instances[0]
    await db.restartPowerSyncHard()
    expect(old.disconnectAndClear).not.toHaveBeenCalled()
  })
})

// Long-lived watches hang off the client instance, so a hard restart silently
// kills them unless they re-arm — which would make the watchdog's own escalation
// the thing that freezes the calendar.
describe('watchAgendaRows across a hard restart', () => {
  it('re-arms the agenda watch on the new client until disposed', async () => {
    const db = await freshDbModule()
    const { watchAgendaRows } = await import('./events-local')
    await db.connectPowerSync()
    const dispose = watchAgendaRows(() => {})
    expect(fakes.instances[0].watchCalls).toHaveLength(1)
    await db.restartPowerSyncHard()
    expect(fakes.instances[1].watchCalls).toHaveLength(1)
    dispose()
    await db.restartPowerSyncHard()
    expect(fakes.instances[2].watchCalls).toHaveLength(0)
  })

  it('aborts the old watch when it re-arms', async () => {
    const db = await freshDbModule()
    const { watchAgendaRows } = await import('./events-local')
    await db.connectPowerSync()
    watchAgendaRows(() => {})
    const firstSignal = fakes.instances[0].watchCalls[0].options.signal
    await db.restartPowerSyncHard()
    expect(firstSignal?.aborted).toBe(true)
    expect(fakes.instances[1].watchCalls[0].options.signal?.aborted).toBe(false)
  })
})
