import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { authApi } from './auth'
import { onSignedOut, setSession } from './client'
import { isUnansweredError, resetReachability } from './reachability'

// Login and setup are the screens most likely to be the first thing a stopped
// server meets, so their failures have to carry the same verdict the rest do.
describe('auth calls that never reach the api', () => {
  beforeEach(() => resetReachability())
  afterEach(() => {
    resetReachability()
    vi.restoreAllMocks()
  })

  it('tags a login that only the proxy answered', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      headers: { get: () => 'text/plain' },
      json: async () => {
        throw new Error('not json')
      },
    })) as unknown as typeof fetch

    const err = await authApi.login('a@b.co', 'pw').catch((e: unknown) => e)

    expect(isUnansweredError(err)).toBe(true)
  })

  it('leaves a login the api itself refused untagged', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: { get: () => 'application/json' },
      json: async () => ({ message: 'Wrong email or password.' }),
    })) as unknown as typeof fetch

    const err = await authApi.login('a@b.co', 'pw').catch((e: unknown) => e)

    expect(isUnansweredError(err)).toBe(false)
    expect((err as Error).message).toBe('Wrong email or password.')
  })
})

// Signing out ends the account's authority on this device, so its local replica and
// unsent writes are wiped. On a kiosk, "sign out" is a profile switch inside one
// household, which keeps them.
describe('authApi.logout', () => {
  beforeEach(() => {
    localStorage.clear()
    setSession('access-tok', 'refresh-tok')
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 204 })) as unknown as typeof fetch
  })

  it('asks for the local data to be wiped', async () => {
    const cb = vi.fn()
    const off = onSignedOut(cb)
    await authApi.logout()
    expect(cb).toHaveBeenCalledTimes(1)
    off()
  })

  it('keeps the household data when a kiosk profile signs out', async () => {
    localStorage.setItem('waffled.kiosk.mode', '1')
    const cb = vi.fn()
    const off = onSignedOut(cb)
    await authApi.logout()
    expect(cb).not.toHaveBeenCalled()
    off()
  })
})
