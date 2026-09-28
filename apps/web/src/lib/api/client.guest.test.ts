import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  acknowledgeCurrentIdentityScopeAfterGate,
  ApiSendError,
  apiDelete,
  apiGet,
  apiGetCached,
  apiSend,
  apiSendForIdentity,
  clearKioskDevice,
  clearProfileSession,
  clearSession,
  currentIdentityScope,
  currentKioskDeviceLease,
  currentViewerPersonId,
  deviceFetch,
  getAccessToken,
  getDeviceId,
  getSessionRefreshToken,
  guestRequestAllowed,
  powerSyncMutationAllowed,
  setSession,
  setSessionFrom,
  setKioskDevice,
  setCurrentViewerAccess,
  setCurrentViewerMemberType,
  setCurrentViewerPersonId,
} from './client'
import { authApi } from './auth'
import { kioskApi } from './kiosk'
import { useHousehold } from './persons'
import {
  registerPrincipalTransitionHandler,
  withLocalWriteLease,
  withSessionRefreshLock,
  withPrincipalTransitionLock,
} from '../powersync/principal-transition'

function serializedOriginLockRequest() {
  const tails = new Map<string, Promise<void>>()
  return vi.fn(<T>(
    name: string,
    options: LockOptions,
    callback: (lock: Lock) => T | PromiseLike<T>
  ): Promise<T> => {
    const previous = tails.get(name) ?? Promise.resolve()
    const run = previous.then(() => callback({
      name,
      mode: options.mode ?? 'exclusive',
    } as Lock)) as Promise<T>
    tails.set(name, run.then(() => undefined, () => undefined))
    return run
  })
}

describe('guest client mutation policy', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    localStorage.clear()
    setCurrentViewerMemberType(null)
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    const request = async <T>(
      name: string,
      options: LockOptions,
      callback: (lock: Lock) => T | PromiseLike<T>
    ): Promise<T> => callback({ name, mode: options.mode ?? 'exclusive' } as Lock)
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })
    registerPrincipalTransitionHandler(async (request) => {
      if (currentIdentityScope() !== request.expectedIdentityScope ||
          (request.stillCurrent && !request.stillCurrent())) return 'stale'
      request.beginIsolation()
      if (currentIdentityScope() !== request.expectedIdentityScope ||
          (request.stillCurrent && !request.stillCurrent())) {
        request.finishIsolation()
        return 'stale'
      }
      request.commitCredentials()
      request.finishIsolation()
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
    await expect(apiSend('PUT', '/api/account/profile', {
      name: 'Guest changed shared profile',
    })).rejects.toMatchObject({ status: 403 })
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
    await expect(apiSend('PUT', '/api/account/password', {
      currentPassword: 'old password', newPassword: 'new password',
    })).resolves.toEqual({ ok: true })
    await expect(apiSend('PUT', '/api/account/email', {
      email: 'guest-new@example.com', currentPassword: 'old password',
    })).resolves.toEqual({ ok: true })
    await expect(apiSend('POST', '/api/powersync/crud', { transactions: [] })).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('matches the server exemption contract', () => {
    expect(guestRequestAllowed('GET', '/api/photos')).toBe(true)
    expect(guestRequestAllowed('POST', '/api/auth/switch')).toBe(true)
    expect(guestRequestAllowed('PATCH', '/api/auth/switch')).toBe(false)
    expect(guestRequestAllowed('POST', '/api/auth/invites/abc/accept')).toBe(true)
    expect(guestRequestAllowed('PUT', '/api/auth/invites/abc/accept')).toBe(false)
    expect(guestRequestAllowed('PUT', '/api/account/password')).toBe(true)
    expect(guestRequestAllowed('PATCH', '/api/account/password')).toBe(false)
    expect(guestRequestAllowed('PUT', '/api/account/email')).toBe(true)
    expect(guestRequestAllowed('PUT', '/api/account/profile')).toBe(false)
    expect(guestRequestAllowed('POST', '/api/powersync/crud')).toBe(true)
    expect(guestRequestAllowed('PUT', '/api/powersync/crud')).toBe(false)
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
    await setSession('same-access-token', 'same-refresh-token', {
      viewerAccess: { memberType: 'adult', accessExpiresAt: null },
    })

    // A fresh module graph models closing/reopening the PWA while localStorage
    // survives and the server is unavailable, so /api/household cannot reload.
    vi.resetModules()
    const restarted = await import('./client')

    expect(restarted.powerSyncMutationAllowed()).toBe(true)
  })

  it('revokes cached temporary access at its deadline while offline', async () => {
    const expiresAtMs = Date.now() + 60_000
    await setSession('temporary-access-token', 'temporary-refresh-token', {
      viewerAccess: {
        memberType: 'caregiver',
        accessExpiresAt: new Date(expiresAtMs).toISOString(),
      },
    })
    expect(getAccessToken()).toBe('temporary-access-token')
    expect(powerSyncMutationAllowed()).toBe(true)

    vi.stubGlobal('navigator', {
      onLine: false,
      locks: {
        request: async <T>(
          name: string,
          options: LockOptions,
          callback: (lock: Lock) => T | PromiseLike<T>
        ): Promise<T> => callback({ name, mode: options.mode ?? 'exclusive' } as Lock),
      },
    })
    vi.spyOn(Date, 'now').mockReturnValue(expiresAtMs)

    expect(powerSyncMutationAllowed()).toBe(false)
    expect(getAccessToken()).toBeUndefined()
    await expect(apiGet('/api/household')).rejects.toThrow('Household access has expired')
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(getSessionRefreshToken()).toBeUndefined())
  })

  it('persists a login response deadline before the household screen loads', async () => {
    const expiresAtMs = Date.now() + 60_000
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      accessToken: 'caregiver-access',
      refreshToken: 'caregiver-refresh',
      expiresIn: 3600,
      memberType: 'caregiver',
      accessExpiresAt: new Date(expiresAtMs).toISOString(),
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await authApi.login('caregiver@example.com', 'password')
    expect(JSON.parse(localStorage.getItem('waffled.session.v1')!)).toMatchObject({
      accessToken: 'caregiver-access',
      refreshToken: 'caregiver-refresh',
      memberType: 'caregiver',
      accessExpiresAt: new Date(expiresAtMs).toISOString(),
    })
    expect(localStorage.getItem('waffled.currentViewerAccess.v1')).toBeNull()
    expect(powerSyncMutationAllowed()).toBe(true)
    vi.spyOn(Date, 'now').mockReturnValue(expiresAtMs)

    expect(getAccessToken()).toBeUndefined()
    expect(powerSyncMutationAllowed()).toBe(false)
    await vi.waitFor(() => expect(getSessionRefreshToken()).toBeUndefined())
  })

  it.each([
    ['caregiver with an omitted deadline', { memberType: 'caregiver' }],
    ['guest with an omitted deadline', { memberType: 'guest' }],
    ['caregiver with a malformed deadline', { memberType: 'caregiver', accessExpiresAt: 'not-a-date' }],
    ['guest with a malformed deadline', { memberType: 'guest', accessExpiresAt: 'tomorrow-ish' }],
  ])('rejects a %s session response before persisting credentials', async (_label, policy) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      accessToken: 'unsafe-temporary-access',
      refreshToken: 'unsafe-temporary-refresh',
      expiresIn: 3600,
      ...policy,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(authApi.login('temporary@example.com', 'password')).rejects.toThrow(/deadline/)
    expect(getAccessToken()).toBeUndefined()
    expect(getSessionRefreshToken()).toBeUndefined()
    expect(localStorage.getItem('waffled.session.v1')).toBeNull()
  })

  it('accepts an explicitly indefinite guest deadline and commits it with the tokens', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      accessToken: 'indefinite-guest-access',
      refreshToken: 'indefinite-guest-refresh',
      expiresIn: 3600,
      memberType: 'guest',
      accessExpiresAt: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await authApi.login('guest@example.com', 'password')

    expect(getAccessToken()).toBe('indefinite-guest-access')
    expect(powerSyncMutationAllowed()).toBe(false)
    expect(JSON.parse(localStorage.getItem('waffled.session.v1')!)).toMatchObject({
      memberType: 'guest',
      accessExpiresAt: null,
    })
  })

  it('cannot authenticate a temporary session when its atomic persistence fails', async () => {
    const values = new Map<string, string>([
      ['waffled.session.v1', JSON.stringify({ v: 1, signedOut: true })],
    ])
    const storage: Storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        if (key === 'waffled.session.v1' && !JSON.parse(value).signedOut) {
          throw new DOMException('Storage full', 'QuotaExceededError')
        }
        values.set(key, value)
      }),
      removeItem: vi.fn((key: string) => { values.delete(key) }),
      clear: vi.fn(() => values.clear()),
      key: vi.fn((index: number) => [...values.keys()][index] ?? null),
      get length() { return values.size },
    }
    vi.stubGlobal('localStorage', storage)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      accessToken: 'caregiver-access',
      refreshToken: 'caregiver-refresh',
      expiresIn: 3600,
      memberType: 'caregiver',
      accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(authApi.login('caregiver@example.com', 'password')).rejects.toThrow('Storage full')
    vi.resetModules()
    const restarted = await import('./client')

    expect(restarted.getAccessToken()).toBeUndefined()
    expect(restarted.getSessionRefreshToken()).toBeUndefined()
    expect(JSON.parse(values.get('waffled.session.v1')!)).toEqual({ v: 1, signedOut: true })
  })

  it('routes a failed live policy commit through terminal replica cleanup', async () => {
    await setSession('adult-access', 'adult-refresh', {
      viewerAccess: { memberType: 'adult', accessExpiresAt: null },
    })
    const transition = vi.fn(async (request) => {
      expect(currentIdentityScope()).toBe(request.expectedIdentityScope)
      request.beginIsolation()
      request.commitCredentials()
      request.finishIsolation()
      return 'completed' as const
    })
    registerPrincipalTransitionHandler(transition)
    const nativeSetItem = localStorage.setItem.bind(localStorage)
    let failedPolicyWrite = false
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'waffled.session.v1' &&
          JSON.parse(value).memberType === 'caregiver' && !failedPolicyWrite) {
        failedPolicyWrite = true
        throw new DOMException('Storage full', 'QuotaExceededError')
      }
      nativeSetItem(key, value)
    })

    await expect(setCurrentViewerAccess(
      'caregiver',
      new Date(Date.now() + 60_000).toISOString()
    )).rejects.toThrow('Storage full')

    await vi.waitFor(() => expect(transition).toHaveBeenCalledOnce())
    expect(JSON.parse(localStorage.getItem('waffled.session.v1')!)).toEqual({ v: 1, signedOut: true })
    expect(getAccessToken()).toBeUndefined()
  })

  it('rejects a credential-only legacy temporary session after a cold reload', async () => {
    localStorage.setItem('waffled.session.v1', JSON.stringify({
      v: 1,
      scope: 'legacy-temporary-scope',
      accessToken: 'legacy-caregiver-access',
      refreshToken: 'legacy-caregiver-refresh',
    }))
    localStorage.setItem('waffled.currentMemberType', 'caregiver')
    localStorage.setItem('waffled.currentMemberTypeScope', 'session:legacy-temporary-scope')

    vi.resetModules()
    const restarted = await import('./client')

    expect(restarted.getAccessToken()).toBeUndefined()
    expect(restarted.getSessionRefreshToken()).toBeUndefined()
    expect(JSON.parse(localStorage.getItem('waffled.session.v1')!)).toEqual({ v: 1, signedOut: true })
  })

  it('atomically migrates a credential-only legacy session with a proven permanent role', async () => {
    localStorage.setItem('waffled.session.v1', JSON.stringify({
      v: 1,
      scope: 'legacy-adult-scope',
      accessToken: 'legacy-adult-access',
      refreshToken: 'legacy-adult-refresh',
    }))
    localStorage.setItem('waffled.currentViewerAccess.v1', JSON.stringify({
      v: 1,
      scope: 'session:legacy-adult-scope',
      memberType: 'adult',
      accessExpiresAt: null,
    }))

    vi.resetModules()
    const restarted = await import('./client')

    expect(restarted.getAccessToken()).toBe('legacy-adult-access')
    expect(restarted.powerSyncMutationAllowed()).toBe(true)
    expect(JSON.parse(localStorage.getItem('waffled.session.v1')!)).toMatchObject({
      scope: 'legacy-adult-scope',
      memberType: 'adult',
      accessExpiresAt: null,
    })
    expect(localStorage.getItem('waffled.currentViewerAccess.v1')).toBeNull()
  })

  it('does not let a queued legacy-session migration overwrite or adopt a remote replacement', async () => {
    localStorage.setItem('waffled.session.v1', JSON.stringify({
      v: 1,
      scope: 'legacy-adult-scope',
      accessToken: 'legacy-adult-access',
      refreshToken: 'legacy-adult-refresh',
    }))
    localStorage.setItem('waffled.currentViewerAccess.v1', JSON.stringify({
      v: 1,
      scope: 'session:legacy-adult-scope',
      memberType: 'adult',
      accessExpiresAt: null,
    }))

    let releaseMigration!: () => void
    let migrationQueued!: () => void
    let migrationFinished!: () => void
    const gate = new Promise<void>((resolve) => { releaseMigration = resolve })
    const queued = new Promise<void>((resolve) => { migrationQueued = resolve })
    const finished = new Promise<void>((resolve) => { migrationFinished = resolve })
    let heldMigration = false
    const request = vi.fn(async <T>(
      name: string,
      options: LockOptions,
      callback: (lock: Lock) => T | PromiseLike<T>
    ): Promise<T> => {
      if (name === 'waffled:principal-replica' && !heldMigration) {
        heldMigration = true
        migrationQueued()
        await gate
      }
      try {
        return await callback({ name, mode: options.mode ?? 'exclusive' } as Lock)
      } finally {
        if (heldMigration && name === 'waffled:principal-replica') migrationFinished()
      }
    })
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })

    vi.resetModules()
    const restarted = await import('./client')
    await queued
    const replacement = {
      v: 1,
      scope: 'replacement-scope',
      accessToken: 'replacement-access',
      refreshToken: 'replacement-refresh',
      memberType: 'guest',
      accessExpiresAt: null,
    }
    localStorage.setItem('waffled.session.v1', JSON.stringify(replacement))
    releaseMigration()
    await finished

    expect(JSON.parse(localStorage.getItem('waffled.session.v1')!)).toEqual(replacement)
    // This module graph was mounted for the legacy principal. The replacement is
    // preserved durably, but cannot be used until remote isolation reloads it.
    expect(restarted.getAccessToken()).toBeUndefined()
    expect(restarted.powerSyncMutationAllowed()).toBe(false)
  })

  it('uses the replacement session policy instead of carrying the prior role', async () => {
    await setSession('original-access-token', 'original-refresh-token', {
      viewerAccess: { memberType: 'adult', accessExpiresAt: null },
    })
    const originalScope = currentIdentityScope()
    setCurrentViewerPersonId('person-a')
    await setSession('different-access-token', 'different-refresh-token', {
      viewerAccess: { memberType: 'guest', accessExpiresAt: null },
    })

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

  it('keeps mutations closed until a live policy update is durably merged', async () => {
    await setSession('guest-access', 'guest-refresh', {
      viewerAccess: { memberType: 'guest', accessExpiresAt: null },
    })
    let releasePrincipal!: () => void
    const principalGate = new Promise<void>((resolve) => { releasePrincipal = resolve })
    const request = vi.fn(<T>(
      name: string,
      options: LockOptions,
      callback: (lock: Lock) => T | PromiseLike<T>
    ): Promise<T> => {
      const run = () => callback({ name, mode: options.mode ?? 'exclusive' } as Lock)
      return name === 'waffled:principal-replica'
        ? principalGate.then(run)
        : Promise.resolve(run())
    })
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })

    const policyUpdate = setCurrentViewerAccess('adult', null)
    expect(powerSyncMutationAllowed()).toBe(false)
    await expect(apiSend('POST', '/api/chores', { title: 'Wait' })).rejects.toMatchObject({
      status: 503,
      body: { error: 'access_policy_pending' },
    })
    expect(fetchMock).not.toHaveBeenCalled()

    releasePrincipal()
    await policyUpdate
    expect(powerSyncMutationAllowed()).toBe(true)
  })

  it('freezes and drains an admitted local writer before publishing a guest demotion', async () => {
    await setSession('adult-access', 'adult-refresh', {
      viewerAccess: { memberType: 'adult', accessExpiresAt: null },
    })
    let releaseWriter!: () => void
    let writerStarted!: () => void
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve })
    const started = new Promise<void>((resolve) => { writerStarted = resolve })
    const writer = withLocalWriteLease(async () => {
      writerStarted()
      await writerGate
      return true
    })
    await started

    const demote = setCurrentViewerAccess('guest', null, { preventAuthorityExtension: true })
    await Promise.resolve()

    // The new role closes optimistic admission synchronously, but its durable
    // publication waits until an already admitted multi-statement write drains.
    expect(JSON.parse(localStorage.getItem('waffled.session.v1')!)).toMatchObject({
      memberType: 'adult',
    })
    await expect(withLocalWriteLease(async () => true)).resolves.toBe(false)

    releaseWriter()
    await expect(writer).resolves.toBe(true)
    await expect(demote).resolves.toBeUndefined()
    expect(JSON.parse(localStorage.getItem('waffled.session.v1')!)).toMatchObject({
      memberType: 'guest',
    })
    expect(powerSyncMutationAllowed()).toBe(false)
  })

  it('merges a live policy update into credentials rotated while it waited for the refresh lock', async () => {
    await setSession('access-r1', 'refresh-r1', {
      viewerAccess: { memberType: 'adult', accessExpiresAt: null },
    })
    const tails = new Map<string, Promise<void>>()
    const request = vi.fn(<T>(
      name: string,
      options: LockOptions,
      callback: (lock: Lock) => T | PromiseLike<T>
    ): Promise<T> => {
      const previous = tails.get(name) ?? Promise.resolve()
      const run = previous.then(() => callback({ name, mode: options.mode ?? 'exclusive' } as Lock)) as Promise<T>
      tails.set(name, run.then(() => undefined, () => undefined))
      return run
    })
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })
    let finishRefresh!: (response: Response) => void
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRefresh = resolve }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))

    const requestAcrossRefresh = apiGet<{ ok: boolean }>('/api/household')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const accessExpiresAt = new Date(Date.now() + 60_000).toISOString()
    const policyUpdate = setCurrentViewerAccess('caregiver', accessExpiresAt)
    await vi.waitFor(() => expect(request.mock.calls.filter(([name]) =>
      name === 'waffled:session-refresh'
    )).toHaveLength(2))

    finishRefresh(new Response(JSON.stringify({
      accessToken: 'access-r2',
      refreshToken: 'refresh-r2',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(Promise.all([requestAcrossRefresh, policyUpdate])).resolves.toEqual([
      { ok: true },
      undefined,
    ])

    expect(JSON.parse(localStorage.getItem('waffled.session.v1')!)).toMatchObject({
      accessToken: 'access-r2',
      refreshToken: 'refresh-r2',
      memberType: 'caregiver',
      accessExpiresAt,
    })
  })

  it('finishes expiry cleanup when an in-flight refresh rotates the token at the deadline', async () => {
    const expiresAt = new Date(Date.now() + 150).toISOString()
    await setSession('expiring-access-r1', 'expiring-refresh-r1', {
      viewerAccess: { memberType: 'caregiver', accessExpiresAt: expiresAt },
    })

    // Serialize each Web Lock name. Refresh holds its lock while the token endpoint
    // is deferred; deadline cleanup takes principal first, then queues for refresh.
    const tails = new Map<string, Promise<void>>()
    const lockNames: string[] = []
    const request = vi.fn(<T>(
      name: string,
      options: LockOptions,
      callback: (lock: Lock) => T | PromiseLike<T>
    ): Promise<T> => {
      lockNames.push(name)
      const previous = tails.get(name) ?? Promise.resolve()
      const run = previous.then(() => callback({ name, mode: options.mode ?? 'exclusive' } as Lock)) as Promise<T>
      tails.set(name, run.then(() => undefined, () => undefined))
      return run
    })
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })
    registerPrincipalTransitionHandler((transition) =>
      withPrincipalTransitionLock(() => withSessionRefreshLock(async () => {
        const stillCurrent = () => currentIdentityScope() === transition.expectedIdentityScope &&
          (!transition.stillCurrent || transition.stillCurrent())
        if (!stillCurrent()) return 'stale' as const
        transition.beginIsolation()
        if (!stillCurrent()) {
          transition.finishIsolation()
          return 'stale' as const
        }
        transition.commitCredentials()
        transition.finishIsolation()
        return 'completed' as const
      }))
    )

    let finishRefresh!: (response: Response) => void
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRefresh = resolve }))
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))

    const oldRequest = apiGet('/api/household').then(
      () => null,
      (error: unknown) => error,
    )
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => {
      expect(lockNames.filter((name) => name === 'waffled:session-refresh').length).toBeGreaterThanOrEqual(2)
    }, { timeout: 2000 })

    finishRefresh(new Response(JSON.stringify({
      accessToken: 'expiring-access-r2',
      refreshToken: 'expiring-refresh-r2',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    // No getter/API call is needed to re-arm cleanup after r1 became stale.
    await vi.waitFor(() => {
      expect(JSON.parse(localStorage.getItem('waffled.session.v1')!)).toEqual({ v: 1, signedOut: true })
    }, { timeout: 2000 })
    expect(await oldRequest).toBeInstanceOf(Error)
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
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })
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
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })
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
            memberType: 'adult',
            accessExpiresAt: null,
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

  it('does not let a delayed login response replace the session which won meanwhile', async () => {
    let finishLogin!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishLogin = resolve }))

    const delayedLogin = authApi.login('old@example.com', 'password')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await setSession('winner-access', 'winner-refresh')
    finishLogin(new Response(JSON.stringify({
      accessToken: 'stale-access',
      refreshToken: 'stale-refresh',
      expiresIn: 3600,
      memberType: 'adult',
      accessExpiresAt: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(delayedLogin).rejects.toMatchObject({ result: 'stale' })
    expect(getAccessToken()).toBe('winner-access')
    expect(getSessionRefreshToken()).toBe('winner-refresh')
  })

  it('does not let a continued REST batch send later mutations under a replacement principal', async () => {
    await setSession('account-a-access', 'account-a-refresh')
    const accountAScope = currentIdentityScope()
    let finishFirst!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishFirst = resolve }))

    const first = apiSendForIdentity(accountAScope, 'POST', '/api/meals/plan', { date: '2026-09-01' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await setSession('account-b-access', 'account-b-refresh')
    finishFirst(new Response(JSON.stringify({ entry: { id: 'a-entry' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    // The response belongs to A, so once B wins it must not be delivered to the
    // caller either. This is stricter than merely blocking the next batch write:
    // an old response cannot drive any unbound continuation or update B's UI.
    await expect(first).rejects.toThrow('Principal changed while /api/meals/plan was in flight')

    await expect(apiSendForIdentity(accountAScope, 'POST', '/api/meals/plan', {
      date: '2026-09-02',
    })).rejects.toThrow('Principal changed before /api/meals/plan could be sent')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('captures the refresh token to revoke only after a concurrent rotation drains', async () => {
    await setSession('account-access', 'refresh-r1')
    let releaseRefreshLock!: () => void
    let sawRefreshLock!: () => void
    const refreshLockReached = new Promise<void>((resolve) => { sawRefreshLock = resolve })
    const refreshGate = new Promise<void>((resolve) => { releaseRefreshLock = resolve })
    const requestLock = vi.fn(async (
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
    vi.stubGlobal('navigator', { onLine: true, locks: { request: requestLock } })
    registerPrincipalTransitionHandler((transition) =>
      withPrincipalTransitionLock(() => withSessionRefreshLock(async () => {
        transition.beginIsolation()
        transition.commitCredentials()
        transition.finishIsolation()
        return 'completed' as const
      }))
    )
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    const logout = authApi.logout({ discardPending: true })
    await refreshLockReached
    const rotated = JSON.parse(localStorage.getItem('waffled.session.v1')!) as Record<string, unknown>
    localStorage.setItem('waffled.session.v1', JSON.stringify({
      ...rotated,
      accessToken: 'rotated-access',
      refreshToken: 'refresh-r2',
    }))
    releaseRefreshLock()
    await logout

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ refreshToken: 'refresh-r2' })
    expect(getAccessToken()).toBeUndefined()
  })

  it('does not store or reuse a device-token response after unpair and re-pair', async () => {
    await setKioskDevice('secret-a', 'device-a')
    let finishOldRefresh!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOldRefresh = resolve }))

    const oldRequest = deviceFetch('/api/kiosk/profiles', {})
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await clearKioskDevice()
    await setKioskDevice('secret-b', 'device-b')
    finishOldRefresh(new Response(JSON.stringify({ accessToken: 'old-device-token' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(oldRequest).rejects.toThrow('kiosk device changed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getDeviceId()).toBe('device-b')

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'new-device-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ profiles: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    await expect(deviceFetch('/api/kiosk/profiles', {})).resolves.toBeInstanceOf(Response)
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer new-device-token',
    })
  })

  it('does not bind an unversioned legacy bearer to a migrated replacement device', async () => {
    // Model an interrupted legacy A -> B replacement: B's complete device tuple
    // won, but the last split deviceAccess write still contains A's bearer.
    localStorage.setItem('waffled.kiosk.mode', '1')
    localStorage.setItem('waffled.kiosk.deviceId', 'device-b')
    localStorage.setItem('waffled.kiosk.deviceSecret', 'secret-b')
    localStorage.setItem('waffled.kiosk.deviceGeneration', 'generation-b')
    localStorage.setItem('waffled.kiosk.deviceAccess', 'legacy-device-a.bearer.token')
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'fresh-device-b-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ profiles: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))

    await expect(deviceFetch('/api/kiosk/profiles', {})).resolves.toBeInstanceOf(Response)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/kiosk/device/token')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ deviceSecret: 'secret-b' }),
    })
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('authorization')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/kiosk/profiles')
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer fresh-device-b-token',
    })
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('legacy-device-a.bearer.token')
    expect(JSON.parse(localStorage.getItem('waffled.kiosk.deviceAccess')!)).toEqual({
      v: 1,
      generation: 'generation-b',
      token: 'fresh-device-b-token',
    })
  })

  it('does not let a queued legacy-device migration overwrite a replacement pairing', async () => {
    localStorage.setItem('waffled.kiosk.mode', '1')
    localStorage.setItem('waffled.kiosk.deviceId', 'device-a')
    localStorage.setItem('waffled.kiosk.deviceSecret', 'secret-a')
    localStorage.setItem('waffled.kiosk.deviceGeneration', 'generation-a')

    let releaseMigration!: () => void
    let migrationQueued!: () => void
    let migrationFinished!: () => void
    const gate = new Promise<void>((resolve) => { releaseMigration = resolve })
    const queued = new Promise<void>((resolve) => { migrationQueued = resolve })
    const finished = new Promise<void>((resolve) => { migrationFinished = resolve })
    let heldMigration = false
    const request = vi.fn(async <T>(
      name: string,
      options: LockOptions,
      callback: (lock: Lock) => T | PromiseLike<T>
    ): Promise<T> => {
      if (name === 'waffled:kiosk-device' && !heldMigration) {
        heldMigration = true
        migrationQueued()
        await gate
      }
      try {
        return await callback({ name, mode: options.mode ?? 'exclusive' } as Lock)
      } finally {
        if (heldMigration && name === 'waffled:kiosk-device') migrationFinished()
      }
    })
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })

    vi.resetModules()
    const restarted = await import('./client')
    expect(restarted.getDeviceId()).toBe('device-a')
    await queued
    const replacement = {
      v: 1,
      state: 'paired',
      deviceId: 'device-b',
      deviceSecret: 'secret-b',
      generation: 'generation-b',
    }
    localStorage.setItem('waffled.kiosk.device.v1', JSON.stringify(replacement))
    releaseMigration()
    await finished

    expect(JSON.parse(localStorage.getItem('waffled.kiosk.device.v1')!)).toEqual(replacement)
    expect(restarted.getDeviceId()).toBe('device-b')
  })

  it('refuses to pair or unpair a shared kiosk device without Web Locks', async () => {
    await setKioskDevice('secret-a', 'device-a')
    vi.stubGlobal('navigator', { onLine: true, locks: undefined })

    await expect(kioskApi.pair('123456')).rejects.toThrow(
      'cannot safely change the shared kiosk device'
    )
    await expect(setKioskDevice('secret-b', 'device-b')).rejects.toThrow(
      'cannot safely change the shared kiosk device'
    )
    await expect(clearKioskDevice()).rejects.toThrow(
      'cannot safely change the shared kiosk device'
    )

    expect(getDeviceId()).toBe('device-a')
    expect(JSON.parse(localStorage.getItem('waffled.kiosk.device.v1')!)).toMatchObject({
      state: 'paired',
      deviceId: 'device-a',
      deviceSecret: 'secret-a',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not report a committed pair as failed when stale-token cleanup throws', async () => {
    await setKioskDevice('secret-a', 'device-a')
    localStorage.setItem('waffled.kiosk.deviceAccess', JSON.stringify({
      v: 1,
      generation: currentKioskDeviceLease()!.generation,
      token: 'device-a-token',
    }))
    const nativeRemoveItem = localStorage.removeItem.bind(localStorage)
    vi.spyOn(localStorage, 'removeItem').mockImplementation((key) => {
      if (key === 'waffled.kiosk.deviceAccess') {
        throw new DOMException('cleanup unavailable', 'QuotaExceededError')
      }
      nativeRemoveItem(key)
    })

    await expect(setKioskDevice('secret-b', 'device-b')).resolves.toBeUndefined()

    expect(currentKioskDeviceLease()).toMatchObject({
      deviceId: 'device-b',
      deviceSecret: 'secret-b',
    })
    // The surviving bearer is scoped to A's generation and therefore cannot be
    // reused for B; the next request must exchange B's secret first.
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'device-b-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deviceLabel: 'B', profiles: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    await expect(kioskApi.profiles()).resolves.toEqual({ deviceLabel: 'B', profiles: [] })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/kiosk/device/token')
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ deviceSecret: 'secret-b' }))
  })

  it('does not deliver a device response parsed after the kiosk is re-paired', async () => {
    await setKioskDevice('secret-a', 'device-a')
    let finishProfiles!: (value: { deviceLabel: string; profiles: [] }) => void
    const delayedProfiles = new Promise<{ deviceLabel: string; profiles: [] }>((resolve) => {
      finishProfiles = resolve
    })
    const profilesResponse = new Response(null, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    vi.spyOn(profilesResponse, 'json').mockImplementation(() => delayedProfiles)
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'device-a-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(profilesResponse)

    const profiles = kioskApi.profiles()
    await vi.waitFor(() => expect(profilesResponse.json).toHaveBeenCalledOnce())
    await setKioskDevice('secret-b', 'device-b')
    finishProfiles({ deviceLabel: 'Private A', profiles: [] })

    await expect(profiles).rejects.toThrow('kiosk device changed')
    expect(getDeviceId()).toBe('device-b')
  })

  it('does not let queued old-device cleanup erase a replacement pairing', async () => {
    await setKioskDevice('secret-a', 'device-a')
    let deviceTail: Promise<unknown> = Promise.resolve()
    const request = vi.fn(<T>(
      name: string,
      options: LockOptions,
      callback: (lock: Lock) => T | PromiseLike<T>
    ): Promise<T> => {
      if (name !== 'waffled:kiosk-device') {
        return Promise.resolve(callback({ name, mode: options.mode ?? 'exclusive' } as Lock))
      }
      const run = deviceTail.then(() => callback({ name, mode: 'exclusive' } as Lock)) as Promise<T>
      deviceTail = run.then(() => undefined, () => undefined)
      return run
    })
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })
    let releaseClear!: () => void
    let clearQueued!: () => void
    const gate = new Promise<void>((resolve) => { releaseClear = resolve })
    const queued = new Promise<void>((resolve) => { clearQueued = resolve })
    registerPrincipalTransitionHandler(async (transition) => {
      clearQueued()
      await gate
      if (transition.stillCurrent && !transition.stillCurrent()) return 'stale'
      transition.beginIsolation()
      transition.commitCredentials()
      transition.finishIsolation()
      return 'completed'
    })

    const clear = clearKioskDevice()
    await queued
    const replace = setKioskDevice('secret-b', 'device-b')
    releaseClear()

    await expect(clear).resolves.toBeUndefined()
    await replace
    expect(getDeviceId()).toBe('device-b')
    expect(JSON.parse(localStorage.getItem('waffled.kiosk.device.v1')!)).toMatchObject({
      v: 1,
      state: 'paired',
      deviceId: 'device-b',
      deviceSecret: 'secret-b',
    })
    expect(localStorage.getItem('waffled.kiosk.deviceId')).toBeNull()
    expect(localStorage.getItem('waffled.kiosk.deviceSecret')).toBeNull()
  })

  it('rejects a stale pairing response after another device has won', async () => {
    const expectedUnpaired = null
    await setKioskDevice('secret-b', 'device-b', { expectedLease: expectedUnpaired })

    await expect(setKioskDevice('stale-secret-a', 'stale-device-a', {
      expectedLease: expectedUnpaired,
    })).rejects.toThrow('kiosk device changed')
    expect(getDeviceId()).toBe('device-b')
  })

  it('does not let concurrent public pairs consume a second code or orphan a device', async () => {
    localStorage.setItem('waffled.kiosk.device.v1', JSON.stringify({
      v: 1,
      state: 'unpaired',
    }))
    const request = serializedOriginLockRequest()
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })
    let finishFirst!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishFirst = resolve }))

    const first = kioskApi.pair('111111')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const second = kioskApi.pair('222222')
    await vi.waitFor(() => expect(request.mock.calls.filter(([name]) =>
      name === 'waffled:kiosk-device'
    )).toHaveLength(2))
    expect(fetchMock).toHaveBeenCalledOnce()

    finishFirst(new Response(JSON.stringify({
      deviceSecret: 'first-secret',
      deviceId: 'first-device',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(first).resolves.toBeUndefined()
    await expect(second).rejects.toThrow('kiosk device changed')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(currentKioskDeviceLease()).toMatchObject({
      deviceId: 'first-device',
      deviceSecret: 'first-secret',
    })
  })

  it('does not let concurrent promotions create a second unreachable device', async () => {
    await setSession('admin-access', 'admin-refresh', {
      viewerAccess: { memberType: 'adult', accessExpiresAt: null },
    })
    localStorage.setItem('waffled.kiosk.device.v1', JSON.stringify({
      v: 1,
      state: 'unpaired',
    }))
    const request = serializedOriginLockRequest()
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })
    let finishFirst!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishFirst = resolve }))

    const first = kioskApi.promote()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const second = kioskApi.promote()
    await vi.waitFor(() => expect(request.mock.calls.filter(([name]) =>
      name === 'waffled:kiosk-device'
    )).toHaveLength(2))
    expect(fetchMock).toHaveBeenCalledOnce()

    finishFirst(new Response(JSON.stringify({
      deviceSecret: 'promoted-secret',
      deviceId: 'promoted-device',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(first).resolves.toBe('promoted-device')
    await expect(second).rejects.toThrow('active account or kiosk device changed')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(currentKioskDeviceLease()).toMatchObject({
      deviceId: 'promoted-device',
      deviceSecret: 'promoted-secret',
    })
  })

  it('rejects a delayed public pair response after the session identity changes', async () => {
    await setSession('account-a-access', 'account-a-refresh', {
      viewerAccess: { memberType: 'adult', accessExpiresAt: null },
    })
    let finishPair!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishPair = resolve }))

    const pair = kioskApi.pair('123456')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await setSession('account-b-access', 'account-b-refresh', {
      discardPending: true,
      viewerAccess: { memberType: 'adult', accessExpiresAt: null },
    })
    finishPair(new Response(JSON.stringify({
      deviceSecret: 'stale-device-secret',
      deviceId: 'stale-device-id',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(pair).rejects.toThrow('active account changed')
    expect(getDeviceId()).toBeUndefined()
    expect(getAccessToken()).toBe('account-b-access')
  })

  it('rejects a delayed public pair response after the kiosk generation changes', async () => {
    let finishPair!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishPair = resolve }))

    const stalePair = kioskApi.pair('123456')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await setKioskDevice('winner-secret', 'winner-device')
    finishPair(new Response(JSON.stringify({
      deviceSecret: 'stale-secret',
      deviceId: 'stale-device',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(stalePair).rejects.toThrow('kiosk device changed')
    expect(getDeviceId()).toBe('winner-device')
  })

  it('holds the kiosk generation through profile claim commit so a racing pair is rejected', async () => {
    await setKioskDevice('secret-a', 'device-a')
    const tails = new Map<string, Promise<void>>()
    const request = vi.fn(<T>(
      name: string,
      options: LockOptions,
      callback: (lock: Lock) => T | PromiseLike<T>
    ): Promise<T> => {
      const previous = tails.get(name) ?? Promise.resolve()
      const run = previous.then(() => callback({ name, mode: options.mode ?? 'exclusive' } as Lock)) as Promise<T>
      tails.set(name, run.then(() => undefined, () => undefined))
      return run
    })
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })

    let releaseClaimCommit!: () => void
    let claimChecked!: () => void
    const claimGate = new Promise<void>((resolve) => { releaseClaimCommit = resolve })
    const checked = new Promise<void>((resolve) => { claimChecked = resolve })
    registerPrincipalTransitionHandler(async (transition) => {
      if (currentIdentityScope() !== transition.expectedIdentityScope ||
          (transition.stillCurrent && !transition.stillCurrent())) return 'stale'
      transition.beginIsolation()
      // Model the former check -> commit window. A device replacement must not
      // enter this interval even though the principal coordinator is suspended.
      claimChecked()
      await claimGate
      transition.commitCredentials()
      transition.finishIsolation()
      return 'completed'
    })
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'device-a-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accessToken: 'profile-a-access',
        refreshToken: 'profile-a-refresh',
        person: { memberType: 'adult' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        deviceSecret: 'secret-b',
        deviceId: 'device-b',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const claim = kioskApi.claim('person-a')
    await checked
    const pair = kioskApi.pair('654321')
    await vi.waitFor(() => expect(request.mock.calls.filter(([name]) =>
      name === 'waffled:kiosk-device'
    )).toHaveLength(2))

    expect(getDeviceId()).toBe('device-a')
    releaseClaimCommit()
    await expect(claim).resolves.toBeUndefined()
    await expect(pair).rejects.toThrow('active account changed')
    expect(getDeviceId()).toBe('device-a')
    expect(getAccessToken()).toBe('profile-a-access')
  })

  it('reports an unpair tombstone failure, keeps the device recoverable, and succeeds on retry', async () => {
    await setKioskDevice('device-secret', 'device-id')
    await setSession('profile-access', 'profile-refresh', {
      viewerAccess: { memberType: 'adult', accessExpiresAt: null },
    })
    localStorage.setItem('waffled.kiosk.deviceAccess', JSON.stringify({
      v: 1,
      generation: currentKioskDeviceLease()!.generation,
      token: 'device-bearer',
    }))
    localStorage.setItem('waffled.kiosk.deviceSecret', 'legacy-secret')
    const originalSetItem = localStorage.setItem.bind(localStorage)
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'waffled.kiosk.device.v1' && JSON.parse(value).state === 'unpaired') {
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      }
      return originalSetItem(key, value)
    })
    const transitionFailed = vi.fn()
    window.addEventListener('waffled:principal-transition-failed', transitionFailed)

    await expect(clearKioskDevice()).rejects.toThrow('quota exceeded')

    expect(transitionFailed).toHaveBeenCalledOnce()
    expect(getAccessToken()).toBeUndefined()
    expect(getDeviceId()).toBe('device-id')
    expect(localStorage.getItem('waffled.kiosk.deviceAccess')).toContain('device-bearer')
    expect(localStorage.getItem('waffled.kiosk.deviceSecret')).toBe('legacy-secret')
    expect(JSON.parse(localStorage.getItem('waffled.kiosk.device.v1')!)).toMatchObject({
      state: 'paired',
      deviceId: 'device-id',
      deviceSecret: 'device-secret',
    })

    setItem.mockRestore()
    await expect(clearKioskDevice()).resolves.toBeUndefined()
    expect(getDeviceId()).toBeUndefined()
    expect(localStorage.getItem('waffled.kiosk.deviceAccess')).toBeNull()
    expect(localStorage.getItem('waffled.kiosk.deviceSecret')).toBeNull()
    window.removeEventListener('waffled:principal-transition-failed', transitionFailed)
  })

  it('does not report a committed unpair as failed when stale-bearer cleanup throws', async () => {
    await setKioskDevice('device-secret', 'device-id')
    await setSession('profile-access', 'profile-refresh', {
      viewerAccess: { memberType: 'adult', accessExpiresAt: null },
    })
    localStorage.setItem('waffled.kiosk.deviceAccess', JSON.stringify({
      v: 1,
      generation: currentKioskDeviceLease()!.generation,
      token: 'stale-device-bearer',
    }))
    localStorage.setItem('waffled.token', 'stale-development-bearer')
    const nativeRemoveItem = localStorage.removeItem.bind(localStorage)
    vi.spyOn(localStorage, 'removeItem').mockImplementation((key) => {
      if (key === 'waffled.kiosk.deviceAccess' || key === 'waffled.token') {
        throw new DOMException('cleanup unavailable', 'QuotaExceededError')
      }
      nativeRemoveItem(key)
    })
    const transitionFailed = vi.fn()
    window.addEventListener('waffled:principal-transition-failed', transitionFailed)

    await expect(clearKioskDevice()).resolves.toBeUndefined()

    expect(transitionFailed).not.toHaveBeenCalled()
    expect(getDeviceId()).toBeUndefined()
    expect(getAccessToken()).toBeUndefined()
    expect(JSON.parse(localStorage.getItem('waffled.kiosk.device.v1')!)).toEqual({
      v: 1,
      state: 'unpaired',
    })
    // Cleanup can be retried later, but neither surviving value is authoritative.
    expect(localStorage.getItem('waffled.kiosk.deviceAccess')).toContain('stale-device-bearer')
    expect(localStorage.getItem('waffled.token')).toBe('stale-development-bearer')
    window.removeEventListener('waffled:principal-transition-failed', transitionFailed)
  })

  it('does not install a delayed profile claim after the kiosk is re-paired', async () => {
    await setKioskDevice('secret-a', 'device-a')
    let finishClaim!: (response: Response) => void
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'device-a-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishClaim = resolve }))

    const claim = kioskApi.claim('person-a')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await clearKioskDevice()
    await setKioskDevice('secret-b', 'device-b')
    finishClaim(new Response(JSON.stringify({
      accessToken: 'stale-profile-access',
      refreshToken: 'stale-profile-refresh',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(claim).rejects.toThrow('kiosk device changed')
    expect(getAccessToken()).toBeUndefined()
    expect(getDeviceId()).toBe('device-b')
  })

  it('accepts a permanent kiosk profile response which omits an expiry', async () => {
    await setKioskDevice('device-secret', 'device-id')
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'device-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accessToken: 'adult-access',
        refreshToken: 'adult-refresh',
        person: { memberType: 'adult' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(kioskApi.claim('adult-person')).resolves.toBeUndefined()

    expect(JSON.parse(localStorage.getItem('waffled.session.v1')!)).toMatchObject({
      accessToken: 'adult-access',
      refreshToken: 'adult-refresh',
      memberType: 'adult',
      accessExpiresAt: null,
    })
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

    // Regardless of how the stale refresh finishes, the request belongs to the
    // replaced principal. Surface cancellation instead of leaking its old 401
    // into the replacement session's continuation.
    await expect(oldRequest).rejects.toThrow('Principal changed while /api/household was in flight')
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

  it('requires re-login instead of combining interleaved legacy split tokens', async () => {
    const values = new Map<string, string>([
      ['waffled.access', 'account-a-access'],
      ['waffled.refresh', 'account-a-refresh'],
    ])
    let interleaved = false
    const storage = {
      getItem: vi.fn((key: string) => {
        const value = values.get(key) ?? null
        if (!interleaved && key === 'waffled.access') {
          interleaved = true
          values.set('waffled.access', 'account-b-access')
          values.set('waffled.refresh', 'account-b-refresh')
        }
        return value
      }),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
      clear: vi.fn(() => values.clear()),
      key: vi.fn(() => null),
      get length() { return values.size },
    }
    vi.stubGlobal('localStorage', storage)

    expect(getAccessToken()).toBeUndefined()
    expect(getSessionRefreshToken()).toBeUndefined()
    await vi.waitFor(() => {
      expect(JSON.parse(values.get('waffled.session.v1')!)).toEqual({ v: 1, signedOut: true })
      expect(values.has('waffled.access')).toBe(false)
      expect(values.has('waffled.refresh')).toBe(false)
    })
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

  it('does not publish an older same-session household response after a newer request', async () => {
    await setSession('adult-access', 'adult-refresh', {
      viewerAccess: { memberType: 'adult', accessExpiresAt: null },
    })
    let finishFirst!: (response: Response) => void
    let finishSecond!: (response: Response) => void
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishFirst = resolve }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishSecond = resolve }))

    const { result } = renderHook(() => useHousehold())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    act(() => window.dispatchEvent(new Event('waffled:household-changed')))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    finishSecond(new Response(JSON.stringify({
      provisioned: true,
      household: { id: 'household', name: 'Home' },
      person: { id: 'viewer', name: 'Viewer', memberType: 'guest', accessExpiresAt: null },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await waitFor(() => expect(result.current.person?.memberType).toBe('guest'))
    expect(powerSyncMutationAllowed()).toBe(false)

    await act(async () => {
      finishFirst(new Response(JSON.stringify({
        provisioned: true,
        household: { id: 'household', name: 'Stale Home' },
        person: { id: 'viewer', name: 'Viewer', memberType: 'adult', accessExpiresAt: null },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(result.current.person?.memberType).toBe('guest')
    expect(result.current.household?.name).toBe('Home')
    expect(powerSyncMutationAllowed()).toBe(false)
    expect(JSON.parse(localStorage.getItem('waffled.session.v1')!)).toMatchObject({
      memberType: 'guest',
      accessExpiresAt: null,
    })
  })

  it('publishes a live restrictive policy after a newer household hook unmounts', async () => {
    await setSession('adult-access', 'adult-refresh', {
      viewerAccess: { memberType: 'adult', accessExpiresAt: null },
    })
    let finishOlder!: (response: Response) => void
    let finishNewer!: (response: Response) => void
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOlder = resolve }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishNewer = resolve }))

    const older = renderHook(() => useHousehold())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const newer = renderHook(() => useHousehold())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    newer.unmount()

    await act(async () => {
      finishNewer(new Response(JSON.stringify({
        provisioned: true,
        household: { id: 'household', name: 'Cancelled Home' },
        person: { id: 'viewer', name: 'Viewer', memberType: 'adult', accessExpiresAt: null },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      await Promise.resolve()
    })
    const shorterExpiry = '2099-06-16T05:00:00.000Z'
    await act(async () => {
      finishOlder(new Response(JSON.stringify({
        provisioned: true,
        household: { id: 'household', name: 'Live Home' },
        person: {
          id: 'viewer', name: 'Viewer', memberType: 'guest', accessExpiresAt: shorterExpiry,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      await Promise.resolve()
    })

    await waitFor(() => expect(powerSyncMutationAllowed()).toBe(false))
    expect(older.result.current.person?.memberType).toBe('guest')
    expect(JSON.parse(localStorage.getItem('waffled.session.v1')!)).toMatchObject({
      memberType: 'guest',
      accessExpiresAt: shorterExpiry,
    })
  })

  it('does not let a household response extend policy tightened by another tab', async () => {
    await setSession('adult-access', 'adult-refresh', {
      viewerAccess: { memberType: 'adult', accessExpiresAt: null },
    })
    let finishHousehold!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      finishHousehold = resolve
    }))

    renderHook(() => useHousehold())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const tightened = {
      ...JSON.parse(localStorage.getItem('waffled.session.v1')!),
      memberType: 'guest',
      accessExpiresAt: null,
    }
    localStorage.setItem('waffled.session.v1', JSON.stringify(tightened))
    finishHousehold(new Response(JSON.stringify({
      provisioned: true,
      household: { id: 'household', name: 'Home' },
      person: { id: 'viewer', name: 'Viewer', memberType: 'adult', accessExpiresAt: null },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await waitFor(() => expect(powerSyncMutationAllowed()).toBe(false))
    expect(JSON.parse(localStorage.getItem('waffled.session.v1')!)).toEqual(tightened)
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

  it('does not deliver a response body parsed after the principal changes', async () => {
    await setSession('first-access-token', 'first-refresh-token')
    let finishBody!: (value: { household: string }) => void
    const delayedBody = new Promise<{ household: string }>((resolve) => { finishBody = resolve })
    const response = new Response(null, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    vi.spyOn(response, 'json').mockImplementation(() => delayedBody)
    fetchMock.mockResolvedValueOnce(response)

    const read = apiGet<{ household: string }>('/api/household')
    await vi.waitFor(() => expect(response.json).toHaveBeenCalledOnce())
    await setSession('second-access-token', 'second-refresh-token')
    finishBody({ household: 'private-first-household' })

    await expect(read).rejects.toThrow('Principal changed while reading /api/household')
  })

  it('blocks a remotely committed session until this tab has gated its mounted principal', async () => {
    await setSession('first-access-token', 'first-refresh-token')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ household: 'first' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const path = '/api/calendar/heads-up?remote-cache-boundary=1'
    await expect(apiGetCached(path, 300_000)).resolves.toEqual({ household: 'first' })

    // Model another tab's atomic commit before this tab's asynchronous storage
    // listener gets a chance to clear module-local caches/reload.
    localStorage.setItem('waffled.session.v1', JSON.stringify({
      v: 1,
      scope: 'remote-principal-b',
      accessToken: 'second-access-token',
      refreshToken: 'second-refresh-token',
      memberType: 'adult',
      accessExpiresAt: null,
    }))
    // The transition-start advisory can fail to persist while this atomic
    // replacement still succeeds. Until the asynchronous storage listener hides
    // and reloads A's mounted tree, neither reads nor stale A controls may use B.
    expect(getAccessToken()).toBeUndefined()
    expect(powerSyncMutationAllowed()).toBe(false)
    await expect(apiGetCached(path, 300_000)).rejects.toThrow(
      'Principal changed before /api/calendar/heads-up?remote-cache-boundary=1 could be sent'
    )
    await expect(apiSend('POST', '/api/grocery/items', { name: 'A stale click' })).rejects.toThrow(
      'Principal changed before /api/grocery/items could be sent'
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // AuthGate performs this only after committing its loading gate and removing
    // A's component tree. The replacement then becomes the sole usable session.
    expect(acknowledgeCurrentIdentityScopeAfterGate('session:remote-principal-b')).toBe(true)
    expect(getAccessToken()).toBe('second-access-token')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ household: 'second' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    await expect(apiGetCached(path, 300_000)).resolves.toEqual({ household: 'second' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({ authorization: 'Bearer second-access-token' }),
    })
  })
})
