// Permissions admin surface — read/edit the per-role capability matrix that lives
// in households.settings.permissions. Admin-only; non-admins are governed by it,
// they don't configure it. The matrix only matters for non-admin members (admins
// always have every capability).
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from '../../platform/db'
import { requireTenant, requireAdmin } from '../households/households'
import {
  getPermissions,
  CAPABILITIES,
  ROLES,
  type MemberRole,
  type Capability,
} from '../../platform/permissions'

type Api = ReturnType<typeof createAPI>

async function householdSettings(householdId: string): Promise<unknown> {
  const { rows } = await query<{ settings: unknown }>(`select settings from households where id = $1`, [householdId])
  return rows[0]?.settings
}

export function registerPermissionRoutes(api: Api): void {
  api.get('/api/permissions', async (req: Request) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    return {
      permissions: getPermissions(await householdSettings(tenant.householdId)),
      capabilities: CAPABILITIES,
      roles: ROLES,
    }
  })

  api.put('/api/permissions', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const body = (req.body ?? {}) as { permissions?: unknown }
    if (typeof body.permissions !== 'object' || body.permissions === null) {
      return res.status(400).json({ error: 'BadRequest', message: 'permissions object is required' })
    }
    // Sanitize: keep only known roles/capabilities + boolean values, then merge over
    // current settings so getPermissions returns a complete matrix on read.
    const incoming = body.permissions as Record<string, unknown>
    const clean: Record<string, Record<string, boolean>> = {}
    for (const role of ROLES) {
      const row = incoming[role]
      if (typeof row !== 'object' || row === null) continue
      const r = row as Record<string, unknown>
      const cells: Record<string, boolean> = {}
      for (const cap of CAPABILITIES) {
        if (typeof r[cap] === 'boolean') cells[cap as Capability] = r[cap] as boolean
      }
      if (Object.keys(cells).length) clean[role as MemberRole] = cells
    }
    await query(
      `update households set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{permissions}', $2::jsonb) where id = $1`,
      [tenant.householdId, JSON.stringify(clean)]
    )
    return { permissions: getPermissions(await householdSettings(tenant.householdId)) }
  })
}
