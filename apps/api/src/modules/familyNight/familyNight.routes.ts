// Family Night — HTTP routes (/api/family-night). Logic in familyNight.ts.
import createAPI, { type Request, type Response } from 'lambda-api'
import { moduleRoutes } from '../../platform/route-guards'
import {
  getView,
  getConfig,
  setConfig,
  upsertOccurrence,
  scheduleEvent,
  unscheduleEvent,
  type FamilyNightConfig,
  type FamilyNightPart,
  type UpsertOccurrenceInput,
} from './familyNight'

type Api = ReturnType<typeof createAPI>

// Every route here is gated by the optional `familyNight` module (403 when off).
const { tenantRoute, adminRoute } = moduleRoutes('familyNight')

export function registerFamilyNightRoutes(api: Api): void {
  // The card/settings read: config + members + the upcoming gathering with
  // resolved (suggested-or-overridden) assignments.
  api.get('/api/family-night', tenantRoute(async (tenant) => {
    return getView(tenant.householdId)
  }))

  // Update the agenda structure (parts, day, time, rotation order). Admin-only.
  api.put('/api/family-night/config', adminRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<FamilyNightConfig>
    const patch: Partial<FamilyNightConfig> = {}
    if (Array.isArray(body.parts)) {
      const parts = body.parts
        .filter((p): p is FamilyNightPart => !!p && typeof p.label === 'string' && !!p.label.trim())
        .map((p, i) => ({
          id: typeof p.id === 'string' && p.id ? p.id : `part${i + 1}`,
          label: p.label.trim(),
          emoji: typeof p.emoji === 'string' && p.emoji ? p.emoji : '⭐',
          rotates: p.rotates !== false,
        }))
      if (!parts.length) return res.status(400).json({ error: 'BadRequest', message: 'at least one part is required' })
      patch.parts = parts
    }
    if (typeof body.dayOfWeek === 'number') patch.dayOfWeek = body.dayOfWeek
    if (typeof body.time === 'string' && /^\d{2}:\d{2}$/.test(body.time)) patch.time = body.time
    if (body.rotationOrder === null || Array.isArray(body.rotationOrder)) patch.rotationOrder = body.rotationOrder
    if (typeof body.showOnToday === 'boolean') patch.showOnToday = body.showOnToday
    const config = await setConfig(tenant.householdId, patch)
    return { config }
  }))

  // Materialize / update the gathering for a date and persist assignments.
  api.post('/api/family-night/occurrence', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<UpsertOccurrenceInput>
    if (!body.date) return res.status(400).json({ error: 'BadRequest', message: 'date is required' })
    const assignments = Array.isArray(body.assignments)
      ? body.assignments
          .filter((a) => a && typeof a.partId === 'string')
          .map((a) => ({ partId: a.partId, personId: a.personId ?? null }))
      : undefined
    const result = await upsertOccurrence(tenant, {
      date: body.date,
      theme: body.theme,
      notes: body.notes,
      status: body.status,
      assignments,
    })
    return result
  }))

  // Put Family Night on the calendar (create/refresh the recurring event). Admin-only.
  api.post('/api/family-night/schedule', adminRoute(async (tenant) => {
    const eventId = await scheduleEvent(tenant)
    return { eventId }
  }))

  // Remove it from the calendar. Admin-only.
  api.delete('/api/family-night/schedule', adminRoute(async (tenant) => {
    await unscheduleEvent(tenant)
    return { ok: true }
  }))

  // Bare config (no occurrence resolution) — handy for settings.
  api.get('/api/family-night/config', tenantRoute(async (tenant) => {
    return { config: await getConfig(tenant.householdId) }
  }))
}
