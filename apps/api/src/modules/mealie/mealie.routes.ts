// Mealie — HTTP routes (/api/mealie). Not behind moduleRoutes: it is an integration, not a module.
// MealieError carries name + statusCode, which app.ts serializes as {error, message}.
import createAPI, { type Request, type Response } from 'lambda-api'
import { tenantRoute, adminRoute } from '../../platform/route-guards'
import { getConnection, requireConnection, presentConnection, saveConnection, deleteConnection, listShoppingLists } from './mealie-connection'

type Api = ReturnType<typeof createAPI>

export function registerMealieRoutes(api: Api): void {
  api.get('/api/mealie/connection', tenantRoute(async (tenant) => presentConnection(await getConnection(tenant.householdId))))

  api.put('/api/mealie/connection', adminRoute(async (tenant, req: Request) => {
    const conn = await saveConnection(tenant.householdId, tenant.personId, (req.body ?? {}) as Record<string, unknown> & { baseUrl: unknown })
    return presentConnection(conn)
  }))

  api.delete('/api/mealie/connection', adminRoute(async (tenant, _req: Request, res: Response) => {
    await deleteConnection(tenant.householdId)
    return res.status(204).send('')
  }))

  api.get('/api/mealie/shopping-lists', adminRoute(async (tenant) => {
    const conn = await requireConnection(tenant.householdId)
    return listShoppingLists(conn)
  }))
}
