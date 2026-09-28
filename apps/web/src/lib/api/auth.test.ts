import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { authApi } from './auth'
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
