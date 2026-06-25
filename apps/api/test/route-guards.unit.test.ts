// Unit tests for the composable auth-guard wrappers. The underlying helpers
// (requireTenant/requireAdmin/requireCapability) are mocked — we only assert the
// wrappers resolve auth, pass the tenant through, stash householdId, and let
// thrown AuthErrors propagate (so the app.ts error handler maps them).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/modules/households/households', () => ({
  requireTenant: vi.fn(),
  requireAdmin: vi.fn(),
}))
vi.mock('../src/platform/permissions', () => ({
  requireCapability: vi.fn(),
}))

import { tenantRoute, adminRoute, capRoute } from '../src/platform/route-guards'
import { requireTenant, requireAdmin } from '../src/modules/households/households'
import { requireCapability } from '../src/platform/permissions'

const TENANT = { sub: 's', personId: 'p', householdId: 'h1', isAdmin: true, memberType: 'adult' }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const req = () => ({ principal: { sub: 's' } }) as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const res = {} as any

class FakeAuthError extends Error {
  statusCode: number
  constructor(message: string, status: number) {
    super(message)
    this.statusCode = status
  }
}

beforeEach(() => {
  vi.mocked(requireTenant).mockReset()
  vi.mocked(requireAdmin).mockReset()
  vi.mocked(requireCapability).mockReset()
})

describe('tenantRoute', () => {
  it('resolves the tenant, passes it to the handler, and stashes householdId', async () => {
    vi.mocked(requireTenant).mockResolvedValue(TENANT)
    const handler = vi.fn().mockResolvedValue({ ok: true })
    const r = req()
    const out = await tenantRoute(handler)(r, res)
    expect(handler).toHaveBeenCalledWith(TENANT, r, res)
    expect(out).toEqual({ ok: true })
    expect(r.tenantHouseholdId).toBe('h1')
  })

  it('propagates an AuthError from requireTenant without calling the handler', async () => {
    vi.mocked(requireTenant).mockRejectedValue(new FakeAuthError('no household', 403))
    const handler = vi.fn()
    await expect(tenantRoute(handler)(req(), res)).rejects.toMatchObject({ statusCode: 403 })
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('adminRoute', () => {
  it('runs the handler for an admin', async () => {
    vi.mocked(requireTenant).mockResolvedValue(TENANT)
    vi.mocked(requireAdmin).mockReturnValue(undefined)
    const handler = vi.fn().mockResolvedValue('ok')
    expect(await adminRoute(handler)(req(), res)).toBe('ok')
  })

  it('propagates the 403 from requireAdmin and skips the handler', async () => {
    vi.mocked(requireTenant).mockResolvedValue({ ...TENANT, isAdmin: false })
    vi.mocked(requireAdmin).mockImplementation(() => {
      throw new FakeAuthError('Admin privileges required', 403)
    })
    const handler = vi.fn()
    await expect(adminRoute(handler)(req(), res)).rejects.toMatchObject({ statusCode: 403 })
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('capRoute', () => {
  it('checks the bound capability then runs the handler', async () => {
    vi.mocked(requireTenant).mockResolvedValue(TENANT)
    vi.mocked(requireCapability).mockResolvedValue(undefined)
    const handler = vi.fn().mockResolvedValue('done')
    expect(await capRoute('chore.manage', handler)(req(), res)).toBe('done')
    expect(requireCapability).toHaveBeenCalledWith(TENANT, 'chore.manage')
  })

  it('propagates a capability 403 and skips the handler', async () => {
    vi.mocked(requireTenant).mockResolvedValue({ ...TENANT, isAdmin: false })
    vi.mocked(requireCapability).mockRejectedValue(new FakeAuthError('nope', 403))
    const handler = vi.fn()
    await expect(capRoute('reward.manage', handler)(req(), res)).rejects.toMatchObject({ statusCode: 403 })
    expect(handler).not.toHaveBeenCalled()
  })
})
