import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { kioskApi } from './kiosk'
import { getServerReachability, isUnansweredError, resetReachability } from './reachability'

// Pairing is the only screen a brand-new kiosk can reach, so a stopped server has
// to be visible from it like anywhere else.
describe('kiosk pairing when the server does not answer', () => {
  beforeEach(() => {
    resetReachability()
    const request = async <T>(name: string, options: LockOptions, callback: (lock: Lock) => T | PromiseLike<T>): Promise<T> =>
      callback({ name, mode: options.mode ?? 'exclusive' } as Lock)
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })
  })
  afterEach(() => {
    resetReachability()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('reports the failure to the reachability store', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch

    const err = await kioskApi.pair('ABC123').catch((e: unknown) => e)

    expect(isUnansweredError(err)).toBe(true)
    await kioskApi.pair('ABC123').catch(() => {})
    expect(getServerReachability()).toBe('unreachable')
  })
})
