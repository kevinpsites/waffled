import { describe, it, expect, beforeEach, vi } from 'vitest'
import { apiGet, setSession, getAccessToken, isKioskMode } from './client'

// A session the server can no longer honour has to END, not sit there failing.
//
// The 401 path already does this (refresh once, and sign out if that fails). The gap is
// 403: the household a valid token names can be gone — a restored database, a deleted
// household, a rebuilt demo stack — and no amount of refreshing brings it back, because
// the refresh mints another token for the same missing household. The client stayed
// "signed in" to nothing, and the only repair was clearing site data by hand.
//
// The discriminator has to be narrow: an ordinary permission denial is also a 403, and
// signing somebody out because they lack `chore.manage` would be a far worse bug than
// the one being fixed. So it keys on the server's stable `NoHousehold` code.

const json = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, json: async () => body, clone() { return this } }) as unknown as Response

describe('a session whose household is gone', () => {
  beforeEach(() => {
    localStorage.clear()
    setSession('access-tok', 'refresh-tok')
  })

  it('signs out when the server says the household is gone', async () => {
    globalThis.fetch = vi.fn(async () =>
      json(403, { error: 'NoHousehold', message: 'No household for this account; create one first' })
    ) as unknown as typeof fetch

    await expect(apiGet('/api/persons')).rejects.toThrow()
    expect(getAccessToken()).toBeUndefined()
  })

  it('tells the AuthGate, so the login screen actually appears', async () => {
    const seen: string[] = []
    window.addEventListener('waffled:auth-changed', () => seen.push('changed'))
    globalThis.fetch = vi.fn(async () => json(403, { error: 'NoHousehold', message: 'gone' })) as unknown as typeof fetch

    await expect(apiGet('/api/persons')).rejects.toThrow()
    expect(seen.length).toBeGreaterThan(0)
  })

  // THE REGRESSION THIS MUST NOT CAUSE. A kid without `chore.manage` gets a 403 all day
  // long; that is the app working, not a dead session.
  it('leaves an ordinary permission denial signed in', async () => {
    globalThis.fetch = vi.fn(async () =>
      json(403, { error: 'AuthError', message: 'You do not have permission to do this' })
    ) as unknown as typeof fetch

    await expect(apiGet('/api/chores')).rejects.toThrow()
    expect(getAccessToken()).toBe('access-tok')
  })

  it('leaves a disabled module signed in', async () => {
    globalThis.fetch = vi.fn(async () =>
      json(403, { error: 'AuthError', message: 'The chores module is not enabled' })
    ) as unknown as typeof fetch

    await expect(apiGet('/api/chores')).rejects.toThrow()
    expect(getAccessToken()).toBe('access-tok')
  })

  // A 403 body that isn't JSON at all (a proxy's HTML error page) must not throw inside
  // the error path and must not sign anybody out.
  it('survives a 403 with an unreadable body', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 403,
      json: async () => { throw new Error('not json') },
      clone() { return this },
    })) as unknown as typeof fetch

    await expect(apiGet('/api/persons')).rejects.toThrow()
    expect(getAccessToken()).toBe('access-tok')
  })

  // On a paired tablet the session belongs to the claimed PROFILE, so the device stays
  // paired and the picker comes back — the same rule the 401 path follows.
  it('drops a kiosk browser to the profile picker, still paired', async () => {
    localStorage.setItem('waffled.kiosk.mode', '1')
    localStorage.setItem('waffled.kiosk.deviceSecret', 'device-secret')
    globalThis.fetch = vi.fn(async () => json(403, { error: 'NoHousehold', message: 'gone' })) as unknown as typeof fetch

    await expect(apiGet('/api/persons')).rejects.toThrow()
    expect(getAccessToken()).toBeUndefined()
    expect(isKioskMode()).toBe(true)
    expect(localStorage.getItem('waffled.kiosk.deviceSecret')).toBe('device-secret')
  })
})
