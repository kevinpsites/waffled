// PowerSync upload sink (offline writes). The client writes events locally and
// PowerSync POSTs the queued row ops here; we apply them to Postgres scoped to the
// caller's household and route/push events to Google — mirroring the REST create/
// update/delete paths but keyed on the CLIENT-generated id (so the optimistic
// local row and the replicated server row are the same row, never a duplicate).
//
// Ops are idempotent (upsert on id, idempotent delete) because PowerSync retries a
// transaction until it succeeds. Cross-household writes are silently no-op'd via a
// household guard. Google pushes are best-effort (pushEventNow records push_failed
// and the scheduler retries), so a write succeeds even when Google is unreachable.
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from '../../platform/db'
import { requireTenant, type Tenant } from '../households/households'
import { resolveWriteTarget, resolveWriteTargetById, pushEventNow } from '../calendar/calendar-sync'
import { updateEvent, softDeleteEvent } from '../events/events'

type Api = ReturnType<typeof createAPI>

interface CrudOp {
  op: 'PUT' | 'PATCH' | 'DELETE'
  table: string
  id: string
  data?: Record<string, unknown>
}

const asStr = (v: unknown): string | null =>
  v === null || v === undefined || v === '' ? null : String(v)
const asBool = (v: unknown): boolean => v === true || v === 1 || v === '1'

// events PUT — upsert the client's event row, then route to a calendar + push.
async function applyEventPut(tenant: Tenant, id: string, data: Record<string, unknown>): Promise<void> {
  await query(
    `insert into events
       (id, household_id, title, description, location, starts_at, ends_at, all_day, timezone,
        person_id, origin, sync_state)
     values ($1,$2,$3,$4,$5,$6,$7,$8,
             coalesce($9, (select timezone from households where id = $2)),
             $10, 'manual', 'local_only')
     on conflict (id) do update set
       title = excluded.title, description = excluded.description, location = excluded.location,
       starts_at = excluded.starts_at, ends_at = excluded.ends_at, all_day = excluded.all_day,
       person_id = excluded.person_id
     where events.household_id = $2`,
    [
      id,
      tenant.householdId,
      asStr(data.title) ?? '(untitled)',
      asStr(data.description),
      asStr(data.location),
      asStr(data.starts_at),
      asStr(data.ends_at),
      asBool(data.all_day),
      asStr(data.timezone),
      asStr(data.person_id),
    ]
  )
  // Pick the destination calendar (explicit choice, else the owner's ★ target).
  const calId = asStr(data.calendar_id)
  const target = calId
    ? await resolveWriteTargetById(tenant.householdId, calId)
    : await resolveWriteTarget(tenant.householdId, asStr(data.person_id))
  if (target) {
    await query(
      `update events set calendar_id = $2, sync_state = 'pending_push'
        where id = $1 and household_id = $3 and deleted_at is null`,
      [id, target.calendarId, tenant.householdId]
    )
    await pushEventNow(tenant.householdId, id)
  }
}

// events PATCH — reuse the REST update path (handles the Google push) by mapping
// the changed columns to its camelCase patch shape.
async function applyEventPatch(tenant: Tenant, id: string, data: Record<string, unknown>): Promise<void> {
  const patch: Record<string, unknown> = {}
  if ('title' in data) patch.title = asStr(data.title) ?? ''
  if ('description' in data) patch.description = asStr(data.description)
  if ('location' in data) patch.location = asStr(data.location)
  if ('starts_at' in data) patch.startsAt = asStr(data.starts_at)
  if ('ends_at' in data) patch.endsAt = asStr(data.ends_at)
  if ('all_day' in data) patch.allDay = asBool(data.all_day)
  if ('person_id' in data) patch.personId = asStr(data.person_id)
  if (Object.keys(patch).length) await updateEvent(tenant.householdId, id, patch)
}

async function applyParticipantPut(tenant: Tenant, id: string, data: Record<string, unknown>): Promise<void> {
  await query(
    `insert into event_participants (id, household_id, event_id, person_id)
     select $1, $2, $3, $4
      where exists (select 1 from events where id = $3 and household_id = $2)
     on conflict (id) do update set person_id = excluded.person_id, deleted_at = null
       where event_participants.household_id = $2`,
    [id, tenant.householdId, asStr(data.event_id), asStr(data.person_id)]
  )
}

export function registerPowerSyncCrudRoutes(api: Api): void {
  // PowerSync's connector uploads queued row ops here (see web NookConnector).
  api.post('/api/powersync/crud', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const ops = (req.body as { ops?: CrudOp[] } | undefined)?.ops
    if (!Array.isArray(ops)) {
      return res.status(400).json({ error: 'BadRequest', message: 'ops[] required' })
    }
    for (const op of ops) {
      if (!op || typeof op.id !== 'string' || !op.id) continue
      const data = op.data ?? {}
      if (op.table === 'events') {
        if (op.op === 'PUT') await applyEventPut(tenant, op.id, data)
        else if (op.op === 'PATCH') await applyEventPatch(tenant, op.id, data)
        else if (op.op === 'DELETE') await softDeleteEvent(tenant.householdId, op.id)
      } else if (op.table === 'event_participants') {
        if (op.op === 'PUT' || op.op === 'PATCH') await applyParticipantPut(tenant, op.id, data)
        else if (op.op === 'DELETE') {
          await query(`delete from event_participants where id = $1 and household_id = $2`, [op.id, tenant.householdId])
        }
      }
      // Unknown tables are ignored — the sync rules never sync them anyway.
    }
    return { applied: ops.length }
  })
}
