// Trackers — HTTP routes (/api/trackers). Logic in trackers.ts.
import createAPI, { type Request, type Response } from 'lambda-api'
import { moduleRoutes } from '../../platform/route-guards'
import { InvalidReferenceError } from '../../platform/household-refs'
import { listTrackers, createTracker, updateTracker, deleteTracker, TrackerValidationError } from './trackers'

type Api = ReturnType<typeof createAPI>

// Every route here is gated by the `trackers` module (403 when off).
const { tenantRoute } = moduleRoutes('trackers')

function badRequest(res: Response, message: string) {
  return res.status(400).json({ error: 'BadRequest', message })
}

function mapError(res: Response, e: unknown) {
  if (e instanceof InvalidReferenceError || e instanceof TrackerValidationError) return badRequest(res, e.message)
  throw e
}

const notFound = (res: Response) => res.status(404).json({ error: 'NotFound', message: 'tracker not found' })

export function registerTrackerRoutes(api: Api): void {
  api.get('/api/trackers', tenantRoute(async (tenant, req: Request) => {
    const includeArchived = String(req.query?.includeArchived ?? '') === '1'
    return { trackers: await listTrackers(tenant.householdId, includeArchived) }
  }))

  api.post('/api/trackers', tenantRoute(async (tenant, req: Request, res: Response) => {
    try {
      const tracker = await createTracker(tenant, (req.body ?? {}) as Record<string, unknown>)
      return res.status(201).json({ tracker })
    } catch (e) {
      return mapError(res, e)
    }
  }))

  api.patch('/api/trackers/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    try {
      const tracker = await updateTracker(tenant, req.params.id!, (req.body ?? {}) as Record<string, unknown>)
      if (!tracker) return notFound(res)
      return { tracker }
    } catch (e) {
      return mapError(res, e)
    }
  }))

  api.delete('/api/trackers/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    if (!(await deleteTracker(tenant, req.params.id!))) return notFound(res)
    return res.status(204).send('')
  }))
}
