// Composable per-route auth guards. lambda-api has no path-scoped middleware
// (only the one global gate in app.ts), so instead of re-deriving the tenant in
// every handler we wrap handlers in a guard that resolves auth, then calls the
// handler with the resolved Tenant. Thrown AuthErrors flow to the 4-arg error
// handler in app.ts unchanged — these wrappers add no try/catch.
//
// Routes that don't fit the common shape (public, device-token, dual self-or-admin,
// or conditional carve-outs that gate a capability only when acting on others) stay
// hand-written; carve-out routes use `tenantRoute` for the tenant part and call
// `requireCapability` inline. requireTenant/requireAdmin/requireCapability remain
// the underlying helpers.
import type { Request, Response } from 'lambda-api'
import { requireTenant, requireAdmin, type Tenant } from '../modules/households/households'
import { requireCapability, type Capability } from './permissions'

// A guarded handler receives the resolved tenant first (mirroring how routes used
// to open with `const tenant = await requireTenant(req)`), then the usual req/res.
// Return contract is lambda-api's: return a value (auto-JSON) or drive res.* yourself.
export type TenantHandler = (tenant: Tenant, req: Request, res: Response) => unknown | Promise<unknown>

// Stash the household id on the request so the request logger (observability) can
// attribute a line to a household once auth has resolved.
function attach(req: Request, tenant: Tenant): void {
  ;(req as Request & { tenantHouseholdId?: string }).tenantHouseholdId = tenant.householdId
}

// Any signed-in member of a household. (~85 routes.)
export function tenantRoute(handler: TenantHandler) {
  return async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    attach(req, tenant)
    return handler(tenant, req, res)
  }
}

// Admin-only mutations. (~30 routes.)
export function adminRoute(handler: TenantHandler) {
  return async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    attach(req, tenant)
    requireAdmin(tenant)
    return handler(tenant, req, res)
  }
}

// Gated by a specific capability (admin always passes). (~20 routes.) Curried so
// the capability is bound at registration: `capRoute('chore.manage', (tenant) => …)`.
export function capRoute(cap: Capability, handler: TenantHandler) {
  return async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    attach(req, tenant)
    await requireCapability(tenant, cap)
    return handler(tenant, req, res)
  }
}
