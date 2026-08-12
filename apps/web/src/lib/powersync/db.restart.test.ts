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

async function freshDbModule() {
  vi.resetModules()
  const mod = await import('./db')
  ;({ getSyncHealth } = await import('./sync-health'))
  return mod
}

beforeEach(() => {
  fakes.instances.length = 0
  fakes.failNext = null
  localStorage.setItem('waffled.access', 'tok') // signed in, so health isn't pinned at no-auth
})

describe('connectPowerSync', () => {
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
