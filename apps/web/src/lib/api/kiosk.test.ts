import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { kioskApi } from './kiosk'
import { getServerReachability, isUnansweredError, resetReachability } from './reachability'

// Pairing is the only screen a brand-new kiosk can reach, so a stopped server has
// to be visible from it like anywhere else.
describe('kiosk pairing when the server does not answer', () => {
  beforeEach(() => resetReachability())
  afterEach(() => {
    resetReachability()
    vi.restoreAllMocks()
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
