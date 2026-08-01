import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiSendError,
  apiDelete,
  apiGet,
  apiSend,
  guestRequestAllowed,
  setCurrentViewerMemberType,
} from './client'

describe('guest client mutation policy', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    localStorage.clear()
    setCurrentViewerMemberType(null)
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    setCurrentViewerMemberType(null)
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
})
