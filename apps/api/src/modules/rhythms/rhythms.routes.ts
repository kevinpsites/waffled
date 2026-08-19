// Rhythms — HTTP routes (/api/rhythms). Logic in rhythms.ts.
import createAPI, { type Request, type Response } from 'lambda-api'
import { moduleRoutes } from '../../platform/route-guards'
import { InvalidReferenceError } from '../../platform/household-refs'
import {
  listRhythms,
  createRhythm,
  completeRhythm,
  listCompletions,
  skipPeriod,
  listAttention,
  scheduleRhythm,
  updateRhythm,
  deleteRhythm,
} from './rhythms'
import { presentEvent } from '../events/events'

type Api = ReturnType<typeof createAPI>

// Every route here is gated by the optional `rhythms` module (403 when off).
const { tenantRoute } = moduleRoutes('rhythms')

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function badRequest(res: Response, message: string) {
  return res.status(400).json({ error: 'BadRequest', message })
}

export function registerRhythmRoutes(api: Api): void {
  api.get('/api/rhythms', tenantRoute(async (tenant) => {
    return { rhythms: await listRhythms(tenant.householdId) }
  }))

  // The one question every surface asks — Today passes a one-day window, the weekly
  // planner passes a week. Both `due` (maintenance) and `unscheduled` (booking) come
  // back merged, so a caller never has to know the two shapes exist.
  api.get('/api/rhythms/attention', tenantRoute(async (tenant, req: Request, res: Response) => {
    const from = String(req.query?.from ?? '')
    const to = String(req.query?.to ?? '')
    if (!DATE_RE.test(to)) return badRequest(res, 'to is required as YYYY-MM-DD')
    // `from` is optional: the horizon is the only bound listAttention uses, so requiring
    // it would mean demanding a value we then discard. Still checked when supplied, so a
    // caller sending a window learns it's malformed instead of being quietly ignored.
    if (from) {
      if (!DATE_RE.test(from)) return badRequest(res, 'from must be YYYY-MM-DD')
      if (to < from) return badRequest(res, 'to must not precede from')
    }
    return { items: await listAttention(tenant.householdId, to) }
  }))

  api.post('/api/rhythms', tenantRoute(async (tenant, req: Request, res: Response) => {
    try {
      const rhythm = await createRhythm(tenant.householdId, (req.body ?? {}) as Record<string, unknown>)
      return res.status(201).json({ rhythm })
    } catch (e) {
      if (e instanceof InvalidReferenceError) return badRequest(res, e.message)
      throw e
    }
  }))

  api.post('/api/rhythms/:id/complete', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { completedAt?: unknown; notes?: unknown }
    const completedAt = typeof body.completedAt === 'string' ? body.completedAt : null
    const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null
    try {
      const rhythm = await completeRhythm(tenant.householdId, req.params.id!, tenant.personId ?? null, completedAt, notes)
      if (!rhythm) return res.status(404).json({ error: 'NotFound', message: 'rhythm not found' })
      return { rhythm }
    } catch (e) {
      if (e instanceof InvalidReferenceError) return badRequest(res, e.message)
      throw e
    }
  }))

  // Edit. Covers the safe-to-change fields only — see updateRhythm for why the shape and
  // the period anchor are not among them.
  api.patch('/api/rhythms/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    try {
      const rhythm = await updateRhythm(tenant.householdId, req.params.id!, (req.body ?? {}) as Record<string, unknown>)
      if (!rhythm) return res.status(404).json({ error: 'NotFound', message: 'rhythm not found' })
      return { rhythm }
    } catch (e) {
      if (e instanceof InvalidReferenceError) return badRequest(res, e.message)
      throw e
    }
  }))

  // Retire one for good. Soft, so its completion history survives.
  api.delete('/api/rhythms/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const ok = await deleteRhythm(tenant.householdId, req.params.id!)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'rhythm not found' })
    return res.status(204).send('')
  }))

  // Book a period — the rhythm puts a real event on the calendar itself. See
  // scheduleRhythm for why this is an event and not a rhythm-shaped calendar chip.
  api.post('/api/rhythms/:id/schedule', tenantRoute(async (tenant, req: Request, res: Response) => {
    try {
      const event = await scheduleRhythm(tenant, req.params.id!, (req.body ?? {}) as Record<string, unknown>)
      if (!event) return res.status(404).json({ error: 'NotFound', message: 'rhythm not found' })
      return res.status(201).json({ event: presentEvent(event) })
    } catch (e) {
      if (e instanceof InvalidReferenceError) return badRequest(res, e.message)
      throw e
    }
  }))

  api.get('/api/rhythms/:id/completions', tenantRoute(async (tenant, req: Request) => {
    return { completions: await listCompletions(tenant.householdId, req.params.id!) }
  }))

  // Skipping is how a period goes quiet without inventing a calendar entry for something
  // that simply isn't happening this quarter.
  api.post('/api/rhythms/:id/skip', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { periodStart?: unknown }
    const periodStart = typeof body.periodStart === 'string' ? body.periodStart : ''
    if (!DATE_RE.test(periodStart)) return badRequest(res, 'periodStart is required as YYYY-MM-DD')
    try {
      const ok = await skipPeriod(tenant.householdId, req.params.id!, periodStart, tenant.personId ?? null)
      if (!ok) return res.status(404).json({ error: 'NotFound', message: 'rhythm not found' })
      return { ok: true }
    } catch (e) {
      if (e instanceof InvalidReferenceError) return badRequest(res, e.message)
      throw e
    }
  }))
}
