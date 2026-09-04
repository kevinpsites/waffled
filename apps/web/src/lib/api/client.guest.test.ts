import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  ApiSendError,
  apiDelete,
  apiGet,
  apiGetCached,
  apiSend,
  clearProfileSession,
  clearSession,
  currentIdentityScope,
  currentViewerPersonId,
  getAccessToken,
  getSessionRefreshToken,
  guestRequestAllowed,
  powerSyncMutationAllowed,
  setSession,
  setSessionFrom,
  setCurrentViewerMemberType,
  setCurrentViewerPersonId,
} from './client'
import { useHousehold } from './persons'
import {
  registerPrincipalTransitionHandler,
  withPrincipalTransitionLock,
} from '../powersync/principal-transition'

describe('guest client mutation policy', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    localStorage.clear()
    setCurrentViewerMemberType(null)
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    registerPrincipalTransitionHandler(async (request) => {
      request.beginIsolation()
      request.commitCredentials()
      return 'completed'
    })
  })

  afterEach(() => {
    setCurrentViewerMemberType(null)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('blocks shared-state writes before issuing a request', async () => {
    setCurrentViewerMemberType('guest')

    await expect(apiSend('POST', '/api/chores', { title: 'Nope' })).rejects.toMatchObject({
      name: 'ApiSendError',
      status: 403,
      body: { error: 'Forbidden', message: 'Guest access is read-only.' },
    } satisfies Partial<ApiSendError>)
    await expect(apiDelete('/api/photos/photo-1')).rejects.toMatchObject({ status: 403 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps reads and account-access recovery available', async () => {
    setCurrentViewerMemberType('guest')
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(apiGet<{ ok: boolean }>('/api/household')).resolves.toEqual({ ok: true })
    await expect(apiSend('POST', '/api/auth/switch', { householdId: 'h2' })).resolves.toEqual({ ok: true })
    await expect(apiSend('POST', '/api/auth/invites/invite-1/accept', {})).resolves.toEqual({ ok: true })
    await expect(apiSend('PATCH', '/api/account/password', { password: 'new password' })).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('matches the server exemption contract', () => {
    expect(guestRequestAllowed('GET', '/api/photos')).toBe(true)
    expect(guestRequestAllowed('POST', '/api/auth/switch')).toBe(true)
    expect(guestRequestAllowed('POST', '/api/auth/invites/abc/accept')).toBe(true)
    expect(guestRequestAllowed('PATCH', '/api/account/password')).toBe(true)
    expect(guestRequestAllowed('POST', '/api/chores')).toBe(false)
  })

  it('only queues PowerSync writes after a known write-capable role loads', () => {
    expect(powerSyncMutationAllowed(null)).toBe(false)
    expect(powerSyncMutationAllowed('guest')).toBe(false)
    expect(powerSyncMutationAllowed('house-sitter')).toBe(false)
    expect(powerSyncMutationAllowed('adult')).toBe(true)
    expect(powerSyncMutationAllowed('caregiver')).toBe(true)
    expect(powerSyncMutationAllowed('teen')).toBe(true)
    expect(powerSyncMutationAllowed('kid')).toBe(true)
  })

  it('restores the last server-verified role after a cold offline restart', async () => {
    await setSession('same-access-token', 'same-refresh-token')
    setCurrentViewerMemberType('adult')

    // A fresh module graph models closing/reopening the PWA while localStorage
    // survives and the server is unavailable, so /api/household cannot reload.
    vi.resetModules()
    const restarted = await import('./client')

    expect(restarted.powerSyncMutationAllowed()).toBe(true)
  })

  it('does not carry a persisted role into a replacement household session', async () => {
    await setSession('original-access-token', 'original-refresh-token')
    const originalScope = currentIdentityScope()
    setCurrentViewerMemberType('adult')
    setCurrentViewerPersonId('person-a')
    await setSession('different-access-token', 'different-refresh-token')

    expect(currentIdentityScope()).not.toBe(originalScope)
    expect(currentViewerPersonId()).toBeNull()

    vi.resetModules()
    const restarted = await import('./client')

    expect(restarted.powerSyncMutationAllowed()).toBe(false)
  })

  it('keeps one identity generation across an access-token refresh', async () => {
    await setSession('original-access-token', 'original-refresh-token')
    const originalScope = currentIdentityScope()
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accessToken: 'rotated-access-token',
        refreshToken: 'rotated-refresh-token',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))

    await expect(apiGet<{ ok: boolean }>('/api/household')).resolves.toEqual({ ok: true })

    expect(currentIdentityScope()).toBe(originalScope)
    expect(getAccessToken()).toBe('rotated-access-token')
    expect(getSessionRefreshToken()).toBe('rotated-refresh-token')
  })

  it('reuses a refresh rotation completed by another tab while waiting for the origin lock', async () => {
    await setSession('tab-a-access', 'tab-a-refresh')
    const transition = vi.fn()
    registerPrincipalTransitionHandler(transition)

    let releaseRefresh!: () => void
    let sawRefreshLock!: () => void
    const refreshLocked = new Promise<void>((resolve) => { sawRefreshLock = resolve })
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const request = vi.fn(async (
      name: string,
      options: LockOptions,
      callback: (lock: Lock) => unknown
    ) => {
      if (name === 'waffled:session-refresh') {
        sawRefreshLock()
        await refreshGate
      }
      return callback({ name, mode: options.mode ?? 'exclusive' } as Lock)
    })
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { locks: { request } }))
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))

    const pending = apiGet<{ ok: boolean }>('/api/household')
    await refreshLocked
    const original = JSON.parse(localStorage.getItem('waffled.session.v1')!) as {
      v: 1
      scope: string
      accessToken: string
      refreshToken: string
    }
    localStorage.setItem('waffled.session.v1', JSON.stringify({
      ...original,
      accessToken: 'tab-b-rotated-access',
      refreshToken: 'tab-b-rotated-refresh',
    }))
    releaseRefresh()

    await expect(pending).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every(([url]) => url === '/api/household')).toBe(true)
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer tab-b-rotated-access',
    })
    expect(transition).not.toHaveBeenCalled()
  })

  it('releases the refresh lease before scheduling terminal principal cleanup', async () => {
    await setSession('expired-access', 'invalid-refresh')
    let refreshLeaseHeld = false
    const request = vi.fn(async (
      name: string,
      options: LockOptions,
      callback: (lock: Lock) => unknown
    ) => {
      if (name === 'waffled:session-refresh') refreshLeaseHeld = true
      try {
        return await callback({ name, mode: options.mode ?? 'exclusive' } as Lock)
      } finally {
        if (name === 'waffled:session-refresh') refreshLeaseHeld = false
      }
    })
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { locks: { request } }))
    const transition = vi.fn(async (transitionRequest) =>
      withPrincipalTransitionLock(async () => {
        expect(refreshLeaseHeld).toBe(false)
        transitionRequest.beginIsolation()
        transitionRequest.commitCredentials()
        transitionRequest.finishIsolation()
        return 'completed' as const
      })
    )
    registerPrincipalTransitionHandler(transition)
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))

    await expect(apiGet('/api/household')).rejects.toThrow('/api/household -> 401')
    await vi.waitFor(() => expect(transition).toHaveBeenCalledOnce())
    expect(getAccessToken()).toBeUndefined()
  })

  it('ends a session when membership becomes inactive on the post-refresh retry', async () => {
    await setSession('expired-access', 'current-refresh')
    const transition = vi.fn(async (request) => {
      request.beginIsolation()
      request.commitCredentials()
      request.finishIsolation()
      return 'completed' as const
    })
    registerPrincipalTransitionHandler(transition)
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'membership_inactive' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }))

    await expect(apiGet('/api/household')).rejects.toThrow('/api/household -> 401')
    await vi.waitFor(() => expect(transition).toHaveBeenCalledOnce())
    expect(getAccessToken()).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('dispatches a request with one atomic credential snapshot', async () => {
    await setSession('account-a-access', 'account-a-refresh')
    let record = localStorage.getItem('waffled.session.v1')
    let swapped = false
    const reentrantStorage = {
      getItem: vi.fn((key: string) => {
        const value = key === 'waffled.session.v1' ? record : null
        if (!swapped && key === 'waffled.session.v1') {
          swapped = true
          record = JSON.stringify({
            v: 1,
            scope: 'account-b-scope',
            accessToken: 'account-b-access',
            refreshToken: 'account-b-refresh',
          })
        }
        return value
      }),
      setItem: vi.fn((key: string, value: string) => {
        if (key === 'waffled.session.v1') record = value
      }),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(() => null),
      get length() { return record ? 1 : 0 },
    }
    vi.stubGlobal('localStorage', reentrantStorage)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(apiSend<{ ok: boolean }>('POST', '/api/chores', { title: 'A task' }))
      .rejects.toThrow('Principal changed before /api/chores could be sent')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not request replacement credentials when a local preflight refuses the switch', async () => {
    await setSession('account-a-access', 'account-a-refresh')
    const prepare = vi.fn(async () => ({ accessToken: 'account-b-access', refreshToken: 'account-b-refresh' }))
    registerPrincipalTransitionHandler(async () => 'pending-uploads')

    await expect(setSessionFrom(prepare)).rejects.toMatchObject({
      name: 'PrincipalTransitionError',
      result: 'pending-uploads',
    })
    expect(prepare).not.toHaveBeenCalled()
    expect(getAccessToken()).toBe('account-a-access')
  })

  it.each([200, 401])('ignores a stale %i refresh after session replacement', async (status) => {
    await setSession('old-access-token', 'old-refresh-token')
    let finishRefresh: (response: Response) => void = () => {}
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRefresh = resolve }))

    const oldRequest = apiGet('/api/household')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await setSession('replacement-access-token', 'replacement-refresh-token')
    finishRefresh(new Response(
      status === 200 ? JSON.stringify({ accessToken: 'stale-access', refreshToken: 'stale-refresh' }) : null,
      status === 200 ? { status, headers: { 'content-type': 'application/json' } } : { status },
    ))

    await expect(oldRequest).rejects.toThrow('/api/household -> 401')
    expect(getAccessToken()).toBe('replacement-access-token')
    expect(getSessionRefreshToken()).toBe('replacement-refresh-token')
  })

  it('preserves the scoped offline session when refresh fails transiently', async () => {
    await setSession('current-access-token', 'current-refresh-token')
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockRejectedValueOnce(new TypeError('offline'))

    await expect(apiGet('/api/household')).rejects.toThrow('/api/household -> 401')
    expect(getAccessToken()).toBe('current-access-token')
    expect(getSessionRefreshToken()).toBe('current-refresh-token')
  })

  it('ends the old session without replaying an authoritative inactive-membership response', async () => {
    await setSession('expired-access-token', 'expired-refresh-token')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'membership_inactive',
      message: 'Household access has expired or was revoked.',
    }), { status: 401, headers: { 'content-type': 'application/json' } }))

    await expect(apiGet('/api/household')).rejects.toThrow('/api/household -> 401')
    expect(getAccessToken()).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses the atomic session record over interrupted legacy replacement writes', async () => {
    await setSession('account-a-access', 'account-a-refresh')
    localStorage.setItem('waffled.access', 'account-b-access')
    // Model a crash before the legacy refresh key could be replaced.
    localStorage.setItem('waffled.refresh', 'account-a-refresh')

    expect(getAccessToken()).toBe('account-a-access')
    expect(getSessionRefreshToken()).toBe('account-a-refresh')
  })

  it('does not revive legacy credentials when the atomic record is malformed', () => {
    localStorage.setItem('waffled.session.v1', '{broken')
    localStorage.setItem('waffled.access', 'stale-access')
    localStorage.setItem('waffled.refresh', 'stale-refresh')

    expect(getAccessToken()).toBeUndefined()
    expect(getSessionRefreshToken()).toBeUndefined()
    expect(currentIdentityScope()).toBeNull()
  })

  it('does not install a delayed household identity into its replacement session', async () => {
    await setSession('old-access-token', 'old-refresh-token')
    let finishHousehold: (response: Response) => void = () => {}
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishHousehold = resolve }))

    const { result } = renderHook(() => useHousehold())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await setSession('replacement-access-token', 'replacement-refresh-token')
    await act(async () => {
      finishHousehold(new Response(JSON.stringify({
        provisioned: true,
        household: { id: 'old-household' },
        person: { id: 'old-person', memberType: 'adult' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      await Promise.resolve()
    })

    expect(result.current.person).toBeNull()
    expect(result.current.household).toBeNull()
    expect(powerSyncMutationAllowed()).toBe(false)
  })

  it('does not carry a persisted role across a legacy dev-token change', async () => {
    localStorage.setItem('waffled.token', 'first-dev-token')
    setCurrentViewerMemberType('adult')
    localStorage.setItem('waffled.token', 'replacement-dev-token')

    vi.resetModules()
    const restarted = await import('./client')

    expect(restarted.powerSyncMutationAllowed()).toBe(false)
  })

  it.each([
    ['sign-out', clearSession],
    ['kiosk profile switch', clearProfileSession],
  ])('clears the persisted viewer identity on %s', async (_label, clear) => {
    await setSession('current-access-token', 'current-refresh-token')
    setCurrentViewerMemberType('adult')
    setCurrentViewerPersonId('person-a')
    await clear()

    expect(currentViewerPersonId()).toBeNull()
    vi.resetModules()
    const restarted = await import('./client')

    expect(restarted.powerSyncMutationAllowed()).toBe(false)
  })

  it('does not reuse a cached GET across replacement sessions', async () => {
    await setSession('first-access-token', 'first-refresh-token')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ household: 'first' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    await expect(apiGetCached('/api/calendar/heads-up?cache-boundary=1', 300_000))
      .resolves.toEqual({ household: 'first' })

    await setSession('second-access-token', 'second-refresh-token')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ household: 'second' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    await expect(apiGetCached('/api/calendar/heads-up?cache-boundary=1', 300_000))
      .resolves.toEqual({ household: 'second' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
