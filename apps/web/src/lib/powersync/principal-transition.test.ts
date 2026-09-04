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
} from './principal-transition'

describe('principal transition seam', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    vi.useRealTimers()
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

  it('retires an abandoned start after the origin-wide lock is free', async () => {
    const request = vi.fn(async (
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock) => unknown
    ) => callback({ name: 'waffled:principal-replica', mode: 'shared' } as Lock))
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { locks: { request } }))

    expect(broadcastPrincipalTransitionStarted()).not.toBeNull()
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

  it('stays fail-closed when a browser without Web Locks cannot prove completion', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { locks: undefined }))
    expect(broadcastPrincipalTransitionStarted()).not.toBeNull()

    const outcome = waitForPrincipalTransition().then(
      () => 'resolved',
      () => 'rejected'
    )
    await vi.advanceTimersByTimeAsync(30_001)

    await expect(outcome).resolves.toBe('rejected')
    expect(principalTransitionInProgress()).toBe(true)
  })
})
