import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  broadcastPrincipalTransitionFinished,
  broadcastPrincipalTransitionStarted,
  freezeLocalWrites,
  principalTransitionInProgress,
  transitionPrincipal,
  waitForPrincipalTransition,
  waitForLocalWritesToDrain,
  withLocalWriteLease,
  withPrincipalUseLock,
  withPrincipalTransitionLock,
} from './principal-transition'

describe('principal transition seam', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('fails closed until the runtime database coordinator registers', async () => {
    const commitCredentials = vi.fn()
    await expect(transitionPrincipal({
      expectedIdentityScope: 'session:a',
      policy: 'discard-authorized',
      replacement: 'new-principal',
      beginIsolation: vi.fn(),
      finishIsolation: vi.fn(),
      commitCredentials,
    })).resolves.toBe('purge-failed')
    expect(commitCredentials).not.toHaveBeenCalled()
  })

  it('freezes new writes and drains an already admitted writer', async () => {
    let releaseWriter!: () => void
    const writer = withLocalWriteLease(async () => {
      await new Promise<void>((resolve) => { releaseWriter = resolve })
      return true
    })
    await vi.waitFor(() => expect(releaseWriter).toBeTypeOf('function'))

    const unfreeze = freezeLocalWrites()
    try {
      await expect(withLocalWriteLease(async () => true)).resolves.toBe(false)
      let drained = false
      const drain = waitForLocalWritesToDrain().then(() => { drained = true })
      await Promise.resolve()
      expect(drained).toBe(false)
      releaseWriter()
      await expect(writer).resolves.toBe(true)
      await drain
      expect(drained).toBe(true)
    } finally {
      unfreeze()
    }
  })

  it('keeps writes frozen until every overlapping isolation releases', async () => {
    const releaseFirst = freezeLocalWrites()
    const releaseSecond = freezeLocalWrites()

    releaseFirst()
    releaseFirst()
    await expect(withLocalWriteLease(async () => true)).resolves.toBe(false)

    releaseSecond()
    await expect(withLocalWriteLease(async () => true)).resolves.toBe(true)
  })

  it('coalesces nested principal readers into one origin lock lease', async () => {
    const request = vi.fn(async <T>(
      name: string,
      options: LockOptions,
      callback: (lock: Lock) => T | PromiseLike<T>
    ): Promise<T> => callback({ name, mode: options.mode ?? 'exclusive' } as Lock))
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })

    await withPrincipalUseLock(() => withPrincipalUseLock(async () => 'done'))

    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(
      'waffled:principal-replica',
      { mode: 'shared' },
      expect.any(Function)
    )
  })

  it('holds the outer reader until detached nested work drains', async () => {
    let releaseNested!: () => void
    let nestedStarted!: () => void
    const nestedGate = new Promise<void>((resolve) => { releaseNested = resolve })
    const started = new Promise<void>((resolve) => { nestedStarted = resolve })
    let browserLeaseReleased = false
    const request = vi.fn(async <T>(
      name: string,
      options: LockOptions,
      callback: (lock: Lock) => T | PromiseLike<T>
    ): Promise<T> => {
      try {
        return await callback({ name, mode: options.mode ?? 'exclusive' } as Lock)
      } finally {
        browserLeaseReleased = true
      }
    })
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })

    const outer = withPrincipalUseLock(async () => {
      void withPrincipalUseLock(async () => {
        nestedStarted()
        await nestedGate
      })
    })
    await started
    await Promise.resolve()
    expect(browserLeaseReleased).toBe(false)

    releaseNested()
    await outer
    expect(browserLeaseReleased).toBe(true)
    expect(request).toHaveBeenCalledOnce()
  })

  it('stops admitting unrelated readers once the root finishes while nested work drains', async () => {
    let releaseNested!: () => void
    let nestedStarted!: () => void
    let rootReturned!: () => void
    const nestedGate = new Promise<void>((resolve) => { releaseNested = resolve })
    const started = new Promise<void>((resolve) => { nestedStarted = resolve })
    const returned = new Promise<void>((resolve) => { rootReturned = resolve })
    const request = vi.fn(async <T>(
      name: string,
      options: LockOptions,
      callback: (lock: Lock) => T | PromiseLike<T>
    ): Promise<T> => callback({ name, mode: options.mode ?? 'exclusive' } as Lock))
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })

    const outer = withPrincipalUseLock(async () => {
      void withPrincipalUseLock(async () => {
        nestedStarted()
        await nestedGate
      })
      rootReturned()
    })
    await Promise.all([started, returned])
    // Let the root callback's finally close admission while its detached child
    // deliberately keeps the original shared browser lease alive.
    await new Promise((resolve) => setTimeout(resolve, 0))

    const later = withPrincipalUseLock(async () => 'later')
    expect(request).toHaveBeenCalledTimes(2)

    releaseNested()
    await expect(Promise.all([outer, later])).resolves.toEqual([undefined, 'later'])
  })

  it('retires an abandoned start after the origin-wide lock is free', async () => {
    const request = vi.fn(async (
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock) => unknown
    ) => callback({ name: 'waffled:principal-replica', mode: 'shared' } as Lock))
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })

    localStorage.setItem('waffled.principalTransition.v1', JSON.stringify({
      id: 'remote-abandoned',
      state: 'started',
      at: Date.now(),
    }))
    expect(principalTransitionInProgress()).toBe(true)
    await waitForPrincipalTransition()

    expect(principalTransitionInProgress()).toBe(false)
    await waitForPrincipalTransition()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not let an older finish clobber a newer transition start', () => {
    const first = broadcastPrincipalTransitionStarted()
    const second = broadcastPrincipalTransitionStarted()

    broadcastPrincipalTransitionFinished(first)
    expect(principalTransitionInProgress()).toBe(true)

    broadcastPrincipalTransitionFinished(second)
    expect(principalTransitionInProgress()).toBe(false)
  })

  it('keeps the initiating tab gated when persisting the start signal fails', async () => {
    const nativeSetItem = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'waffled.principalTransition.v1') throw new DOMException('quota', 'QuotaExceededError')
      return nativeSetItem(key, value)
    })

    const id = broadcastPrincipalTransitionStarted()
    expect(id).not.toBeNull()
    expect(localStorage.getItem('waffled.principalTransition.v1')).toBeNull()
    expect(principalTransitionInProgress()).toBe(true)

    let settled = false
    const waiter = waitForPrincipalTransition().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    broadcastPrincipalTransitionFinished(id)
    await waiter
    expect(settled).toBe(true)
    expect(principalTransitionInProgress()).toBe(false)
  })

  it('removes a stale start when persisting its matching finish fails', () => {
    const id = broadcastPrincipalTransitionStarted()
    const nativeSetItem = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'waffled.principalTransition.v1' && value.includes('"finished"')) {
        throw new DOMException('quota', 'QuotaExceededError')
      }
      return nativeSetItem(key, value)
    })

    broadcastPrincipalTransitionFinished(id)

    expect(localStorage.getItem('waffled.principalTransition.v1')).toBeNull()
    expect(principalTransitionInProgress()).toBe(false)
  })

  it('refuses an exclusive replica transition when Web Locks are unavailable', async () => {
    vi.stubGlobal('navigator', { onLine: true, locks: undefined })
    const operation = vi.fn(async () => true)

    await expect(withPrincipalTransitionLock(operation)).rejects.toThrow(
      'cannot safely isolate the local replica'
    )
    expect(operation).not.toHaveBeenCalled()
  })

  it('stays fail-closed when a browser without Web Locks cannot prove completion', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { onLine: true, locks: undefined })
    localStorage.setItem('waffled.principalTransition.v1', JSON.stringify({
      id: 'remote-no-lock',
      state: 'started',
      at: Date.now(),
    }))

    const outcome = waitForPrincipalTransition().then(
      () => 'resolved',
      () => 'rejected'
    )
    await vi.advanceTimersByTimeAsync(30_001)

    await expect(outcome).resolves.toBe('rejected')
    expect(principalTransitionInProgress()).toBe(true)
  })
})
