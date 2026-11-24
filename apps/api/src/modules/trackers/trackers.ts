// Trackers — tap-to-log items. Logic here, routes in trackers.routes.ts.
import { query } from '../../platform/db'
import { AuthError } from '../../platform/auth'
import { type Tenant } from '../households/households'

export interface TrackerDto {
  id: string
  title: string
  emoji: string | null
  askPerson: boolean
  sortOrder: number
  archivedAt: string | null
  lastEntry: { id: string; occurredAt: string; personId: string | null; personName: string | null } | null
}

interface TrackerRow {
  id: string
  title: string
  emoji: string | null
  ask_person: boolean
  sort_order: number
  archived_at: Date | null
  le_id: string | null
  le_occurred_at: Date | null
  le_person_id: string | null
  le_person_name: string | null
}

// persons is joined without a deleted_at filter: a removed person's name is still the
// right history for an entry they logged.
const SELECT_TRACKER = `
  select t.id, t.title, t.emoji, t.ask_person, t.sort_order, t.archived_at,
         le.id as le_id, le.occurred_at as le_occurred_at,
         le.person_id as le_person_id, p.name as le_person_name
    from trackers t
    left join lateral (
      select e.id, e.occurred_at, e.person_id
        from tracker_entries e
       where e.tracker_id = t.id
       order by e.occurred_at desc, e.created_at desc
       limit 1
    ) le on true
    left join persons p on p.id = le.person_id and p.household_id = t.household_id`

function toDto(r: TrackerRow): TrackerDto {
  return {
    id: r.id,
    title: r.title,
    emoji: r.emoji,
    askPerson: r.ask_person,
    sortOrder: r.sort_order,
    archivedAt: r.archived_at ? r.archived_at.toISOString() : null,
    lastEntry: r.le_id
      ? {
          id: r.le_id,
          occurredAt: r.le_occurred_at!.toISOString(),
          personId: r.le_person_id,
          personName: r.le_person_name,
        }
      : null,
  }
}

export class TrackerValidationError extends Error {}

export function requireTrackerManager(tenant: Tenant): void {
  if (!(tenant.isAdmin || tenant.memberType === 'adult')) {
    throw new AuthError('Only adults can manage trackers', 403)
  }
}

export async function listTrackers(householdId: string, includeArchived: boolean): Promise<TrackerDto[]> {
  const res = await query<TrackerRow>(
    `${SELECT_TRACKER}
      where t.household_id = $1 ${includeArchived ? '' : 'and t.archived_at is null'}
      order by t.sort_order, t.created_at`,
    [householdId]
  )
  return res.rows.map(toDto)
}

export async function getTracker(householdId: string, id: string): Promise<TrackerDto | null> {
  if (!isUuid(id)) return null
  const res = await query<TrackerRow>(`${SELECT_TRACKER} where t.household_id = $1 and t.id = $2`, [householdId, id])
  return res.rows[0] ? toDto(res.rows[0]) : null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuid(v: string): boolean {
  return UUID_RE.test(v)
}

function cleanTitle(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw new TrackerValidationError('title is required')
  return v.trim()
}

function cleanEmoji(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') throw new TrackerValidationError('emoji must be a string')
  return v.trim() || null
}

export async function createTracker(tenant: Tenant, body: Record<string, unknown>): Promise<TrackerDto> {
  requireTrackerManager(tenant)
  const title = cleanTitle(body.title)
  const emoji = cleanEmoji(body.emoji)
  if (body.askPerson !== undefined && typeof body.askPerson !== 'boolean') {
    throw new TrackerValidationError('askPerson must be a boolean')
  }
  const ins = await query<{ id: string }>(
    `insert into trackers (household_id, title, emoji, ask_person) values ($1, $2, $3, $4) returning id`,
    [tenant.householdId, title, emoji, body.askPerson === true]
  )
  return (await getTracker(tenant.householdId, ins.rows[0]!.id))!
}

export async function updateTracker(
  tenant: Tenant,
  id: string,
  body: Record<string, unknown>
): Promise<TrackerDto | null> {
  requireTrackerManager(tenant)
  if (!isUuid(id)) return null
  const sets: string[] = []
  const params: unknown[] = [tenant.householdId, id]
  const add = (col: string, val: unknown) => {
    params.push(val)
    sets.push(`${col} = $${params.length}`)
  }
  if (body.title !== undefined) add('title', cleanTitle(body.title))
  if (body.emoji !== undefined) add('emoji', cleanEmoji(body.emoji))
  if (body.askPerson !== undefined) {
    if (typeof body.askPerson !== 'boolean') throw new TrackerValidationError('askPerson must be a boolean')
    add('ask_person', body.askPerson)
  }
  if (body.sortOrder !== undefined) {
    if (typeof body.sortOrder !== 'number' || !Number.isInteger(body.sortOrder)) {
      throw new TrackerValidationError('sortOrder must be an integer')
    }
    add('sort_order', body.sortOrder)
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== 'boolean') throw new TrackerValidationError('archived must be a boolean')
    sets.push(body.archived ? 'archived_at = coalesce(archived_at, now())' : 'archived_at = null')
  }
  if (sets.length === 0) return getTracker(tenant.householdId, id)
  const res = await query(
    `update trackers set ${sets.join(', ')}, updated_at = now() where household_id = $1 and id = $2`,
    params
  )
  if (res.rowCount === 0) return null
  return getTracker(tenant.householdId, id)
}

export async function deleteTracker(tenant: Tenant, id: string): Promise<boolean> {
  requireTrackerManager(tenant)
  if (!isUuid(id)) return false
  const res = await query(`delete from trackers where household_id = $1 and id = $2`, [tenant.householdId, id])
  return (res.rowCount ?? 0) > 0
}
