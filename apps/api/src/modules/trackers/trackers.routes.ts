// Trackers — HTTP routes (/api/trackers). Logic in trackers.ts.
import createAPI, { type Request, type Response } from 'lambda-api'
import { moduleRoutes } from '../../platform/route-guards'
import { InvalidReferenceError } from '../../platform/household-refs'
import {
  listTrackers, createTracker, updateTracker, deleteTracker, TrackerValidationError,
  logEntry, listEntries, updateEntry, deleteEntry, TrackerArchivedError, PersonRequiredError,
} from './trackers'

type Api = ReturnType<typeof createAPI>

// Every route here is gated by the `trackers` module (403 when off).
const { tenantRoute } = moduleRoutes('trackers')

function badRequest(res: Response, message: string) {
  return res.status(400).json({ error: 'BadRequest', message })
}

function mapError(res: Response, e: unknown) {
  if (e instanceof InvalidReferenceError || e instanceof TrackerValidationError) return badRequest(res, e.message)
  if (e instanceof TrackerArchivedError) return res.status(409).json({ error: 'Archived', message: e.message })
  if (e instanceof PersonRequiredError) return res.status(422).json({ error: 'PersonRequired', message: e.message })
  throw e
}

const notFound = (res: Response, what = 'tracker') => res.status(404).json({ error: 'NotFound', message: `${what} not found` })

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

  // Entries are open to any member, unlike tracker management.
  api.post('/api/trackers/:id/entries', tenantRoute(async (tenant, req: Request, res: Response) => {
    try {
      const entry = await logEntry(tenant, req.params.id!, (req.body ?? {}) as Record<string, unknown>)
      if (!entry) return notFound(res)
      return res.status(201).json({ entry })
    } catch (e) {
      return mapError(res, e)
    }
  }))

  api.get('/api/trackers/:id/entries', tenantRoute(async (tenant, req: Request, res: Response) => {
    try {
      const q = req.query ?? {}
      const page = await listEntries(tenant.householdId, req.params.id!, {
        personId: q.personId,
        before: q.before,
        limit: q.limit,
      })
      if (!page) return notFound(res)
      return page
    } catch (e) {
      return mapError(res, e)
    }
  }))

  api.patch('/api/tracker-entries/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    try {
      const entry = await updateEntry(tenant, req.params.id!, (req.body ?? {}) as Record<string, unknown>)
      if (!entry) return notFound(res, 'entry')
      return { entry }
    } catch (e) {
      return mapError(res, e)
    }
  }))

  api.delete('/api/tracker-entries/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    if (!(await deleteEntry(tenant, req.params.id!))) return notFound(res, 'entry')
    return res.status(204).send('')
  }))
}
