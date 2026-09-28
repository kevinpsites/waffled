import { describe, expect, it, vi } from 'vitest'
import type { Request } from 'lambda-api'
import { resolveRequestTenant, type Tenant } from '../src/modules/households/households'

const tenant: Tenant = {
  sub: 'account-1',
  personId: 'person-1',
  householdId: 'household-1',
  isAdmin: false,
  memberType: 'guest',
}

describe('request-scoped tenant resolution', () => {
  it('coalesces repeated resolution for the same request', async () => {
    const req = { principal: { sub: 'account-1' } } as unknown as Request
    const resolver = vi.fn(async () => tenant)

    await expect(resolveRequestTenant(req, resolver)).resolves.toBe(tenant)
    await expect(resolveRequestTenant(req, resolver)).resolves.toBe(tenant)

    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('caches an unresolved tenant instead of querying again', async () => {
    const req = { principal: { sub: 'unprovisioned' } } as unknown as Request
    const resolver = vi.fn(async () => null)

    await expect(resolveRequestTenant(req, resolver)).resolves.toBeNull()
    await expect(resolveRequestTenant(req, resolver)).resolves.toBeNull()

    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('keeps an API-key tenant authoritative without invoking the resolver', async () => {
    const req = { apiKeyTenant: tenant, principal: { sub: 'different-subject' } } as unknown as Request
    const resolver = vi.fn(async () => null)

    await expect(resolveRequestTenant(req, resolver)).resolves.toBe(tenant)
    expect(resolver).not.toHaveBeenCalled()
  })
})
