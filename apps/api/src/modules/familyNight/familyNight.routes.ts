// Family Night — HTTP routes (/api/family-night). Logic in familyNight.ts.
import createAPI, { type Request, type Response } from 'lambda-api'
import { moduleRoutes } from '../../platform/route-guards'
import { assertPersonsInHousehold } from '../../platform/household-refs'
import { query } from '../../platform/db'
import {
  getView,
  getConfig,
  setConfig,
  upsertOccurrence,
  createOccurrenceEvent,
  scheduleEvent,
  unscheduleEvent,
  type FamilyNightConfig,
  type FamilyNightPart,
  type UpsertOccurrenceInput,
} from './familyNight'

type Api = ReturnType<typeof createAPI>

// Every route here is gated by the optional `familyNight` module (403 when off).
const { tenantRoute, adminRoute } = moduleRoutes('familyNight')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function registerFamilyNightRoutes(api: Api): void {
  api.get('/api/family-night', tenantRoute(async (tenant) => {
    return getView(tenant.householdId)
  }))

  // Update the agenda structure (parts, day, time, rotation order).
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

  api.post('/api/family-night/occurrence', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<UpsertOccurrenceInput> & { createEvent?: unknown }
    if (!body.date) return res.status(400).json({ error: 'BadRequest', message: 'date is required' })
    // PRESENCE IS THE MESSAGE, so each field is copied only when the caller sent it.
    // `personId: a.personId ?? null` would turn "I only named the treat" into "…and nobody
    // has it". `personId` and `detail` answer different questions and travel independently.
    const assignments = Array.isArray(body.assignments)
      ? body.assignments
          .filter((a) => a && typeof a.partId === 'string')
          .map((a) => ({
            partId: a.partId,
            ...('personId' in a ? { personId: a.personId ?? null } : {}),
            ...('detail' in a ? { detail: typeof a.detail === 'string' ? a.detail : null } : {}),
          }))
      : undefined
    // A foreign id currently just renders as an empty slot (names resolve against
    // the household's own members), but the row would still be written — assert
    // membership so this stays a non-event if that read path ever changes.
    await assertPersonsInHousehold(
      tenant.householdId,
      (assignments ?? []).map((a) => a.personId).filter((id): id is string => typeof id === 'string')
    )

    // Checked against the household before it is stored: the column is a real FK, so a bad
    // id would 500 rather than 400, and another household's id would link across tenants.
    let eventId: string | null | undefined
    if ('eventId' in body) {
      if (body.eventId === null) eventId = null
      else if (typeof body.eventId !== 'string' || !UUID_RE.test(body.eventId)) {
        return res.status(400).json({ error: 'BadRequest', message: 'eventId must be an event id or null' })
      } else {
        const { rows } = await query<{ id: string }>(
          `select id from events where household_id = $1 and id = $2 and deleted_at is null`,
          [tenant.householdId, body.eventId]
        )
        if (!rows[0]) return res.status(404).json({ error: 'NotFound', message: 'no such event' })
        eventId = rows[0].id
      }
    }

    const result = await upsertOccurrence(tenant, {
      date: body.date,
      theme: body.theme,
      notes: body.notes,
      status: body.status,
      ...(eventId !== undefined ? { eventId } : {}),
      assignments,
    })

    // "Add this week to the calendar" — see createOccurrenceEvent for why it cannot be a
    // client round trip. Runs AFTER the upsert so a theme sent in the same call names the
    // event, and is ignored when the caller also named an event explicitly.
    if (body.createEvent === true && eventId === undefined) {
      const made = await createOccurrenceEvent(tenant, body.date)
      return { ...result, eventId: made.eventId }
    }
    return result
  }))

  api.post('/api/family-night/schedule', adminRoute(async (tenant) => {
    const eventId = await scheduleEvent(tenant)
    return { eventId }
  }))

  api.delete('/api/family-night/schedule', adminRoute(async (tenant) => {
    await unscheduleEvent(tenant)
    return { ok: true }
  }))

  // Bare config (no occurrence resolution) — handy for settings.
  api.get('/api/family-night/config', tenantRoute(async (tenant) => {
    return { config: await getConfig(tenant.householdId) }
  }))
}
