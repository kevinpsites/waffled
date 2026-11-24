// Mealie — HTTP routes (/api/mealie). Not behind moduleRoutes: it is an integration, not a module.
// MealieError carries name + statusCode, which app.ts serializes as {error, message}.
import createAPI, { type Request, type Response } from 'lambda-api'
import { tenantRoute, adminRoute } from '../../platform/route-guards'
import { getConnection, requireConnection, presentConnection, saveConnection, deleteConnection, listShoppingLists } from './mealie-connection'
import { addShoppingItem, setShoppingItemChecked, createPlanEntry, deletePlanEntry } from './mealie-writes'
import { parseRange, readShopping, readMealplan, readRecipes, readRecipe, fetchImage } from './mealie-reads'

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

  api.get('/api/mealie/mealplan', tenantRoute(async (tenant, req: Request) => {
    const conn = await requireConnection(tenant.householdId)
    return readMealplan(tenant.householdId, conn, parseRange(req.query?.start, req.query?.end))
  }))

  api.get('/api/mealie/recipes', tenantRoute(async (tenant, req: Request) => {
    const conn = await requireConnection(tenant.householdId)
    const search = String(req.query?.search ?? '').trim()
    const page = Math.max(1, parseInt(String(req.query?.page ?? '1'), 10) || 1)
    return readRecipes(tenant.householdId, conn, search, page)
  }))

  api.get('/api/mealie/recipes/:slug', tenantRoute(async (tenant, req: Request) => {
    const conn = await requireConnection(tenant.householdId)
    return readRecipe(tenant.householdId, conn, String(req.params.slug ?? ''))
  }))

  // lambda-api returns a Buffer as base64; platform/http-server.ts decodes it on the wire.
  api.get('/api/mealie/images/:recipeId/:size', tenantRoute(async (tenant, req: Request, res: Response) => {
    const conn = await requireConnection(tenant.householdId)
    const { bytes, contentType } = await fetchImage(conn, String(req.params.recipeId ?? ''), String(req.params.size ?? ''))
    res.type(contentType)
    await res.sendFile(bytes, { cacheControl: 'private, max-age=3600', lastModified: false })
  }))

  api.get('/api/mealie/shopping', tenantRoute(async (tenant) => readShopping(tenant.householdId, await requireConnection(tenant.householdId))))

  api.post('/api/mealie/shopping/items', tenantRoute(async (tenant, req: Request, res: Response) => {
    const conn = await requireConnection(tenant.householdId)
    await addShoppingItem(tenant.householdId, conn, (req.body as { text?: unknown } | undefined)?.text)
    return res.status(201).send({ ok: true })
  }))

  api.patch('/api/mealie/shopping/items/:id', tenantRoute(async (tenant, req: Request) => {
    const conn = await requireConnection(tenant.householdId)
    await setShoppingItemChecked(tenant.householdId, conn, String(req.params.id ?? ''), (req.body as { checked?: unknown } | undefined)?.checked)
    return { ok: true }
  }))

  api.post('/api/mealie/mealplan', tenantRoute(async (tenant, req: Request, res: Response) => {
    const conn = await requireConnection(tenant.householdId)
    await createPlanEntry(tenant.householdId, conn, (req.body ?? {}) as Record<string, unknown>)
    return res.status(201).send({ ok: true })
  }))

  api.delete('/api/mealie/mealplan/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const conn = await requireConnection(tenant.householdId)
    await deletePlanEntry(tenant.householdId, conn, String(req.params.id ?? ''))
    return res.status(204).send('')
  }))
}
