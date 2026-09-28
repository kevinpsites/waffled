// Permissions admin surface — read/edit the per-role capability matrix that lives
// in households.settings.permissions. Admin-only; non-admins are governed by it,
// they don't configure it. The matrix only matters for non-admin members (admins
// always have every capability).
import createAPI, { type Request, type Response } from 'lambda-api'
import { getPool, query } from '../../platform/db'
import { adminRoute } from '../../platform/route-guards'
import {
  getPermissions,
  CAPABILITIES,
  ROLES,
} from '../../platform/permissions'

type Api = ReturnType<typeof createAPI>

async function householdSettings(householdId: string): Promise<unknown> {
  const { rows } = await query<{ settings: unknown }>(`select settings from households where id = $1`, [householdId])
  return rows[0]?.settings
}

export function registerPermissionRoutes(api: Api): void {
  api.get('/api/permissions', adminRoute(async (tenant) => {
    return {
      permissions: getPermissions(await householdSettings(tenant.householdId)),
      capabilities: CAPABILITIES,
      roles: ROLES,
    }
  }))

  api.put('/api/permissions', adminRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { permissions?: unknown }
    if (typeof body.permissions !== 'object' || body.permissions === null) {
      return res.status(400).json({ error: 'BadRequest', message: 'permissions object is required' })
    }
    // Sanitize: keep only known roles/capabilities + boolean values, then merge over
    // current settings so older clients cannot reset capabilities added after they
    // shipped merely by saving another cell.
    const incoming = body.permissions as Record<string, unknown>
    const client = await getPool().connect()
    try {
      await client.query('begin')
      const current = await client.query<{ settings: unknown }>(
        `select settings from households where id = $1 for update`,
        [tenant.householdId]
      )
      const merged = getPermissions(current.rows[0]?.settings)
      for (const role of ROLES) {
        const row = incoming[role]
        if (typeof row !== 'object' || row === null) continue
        const cells = row as Record<string, unknown>
        for (const cap of CAPABILITIES) {
          if (typeof cells[cap] === 'boolean') merged[role][cap] = cells[cap]
        }
      }
      await client.query(
        `update households set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{permissions}', $2::jsonb) where id = $1`,
        [tenant.householdId, JSON.stringify(merged)]
      )
      await client.query('commit')
      return { permissions: merged }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }))
}
