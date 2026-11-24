// Trackers — tap-to-log items. Logic here, routes in trackers.routes.ts.
import { query } from '../../platform/db'
import { AuthError } from '../../platform/auth'
import { type Tenant } from '../households/households'
import { assertPersonInHousehold, HouseholdReferenceError, InvalidReferenceError } from '../../platform/household-refs'

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
       order by e.occurred_at desc, e.id desc
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

export class TrackerArchivedError extends Error {}
export class PersonRequiredError extends Error {}

export interface EntryDto {
  id: string
  trackerId: string
  occurredAt: string
  personId: string | null
  personName: string | null
  loggedBy: string | null
  loggedByName: string | null
  note: string | null
}

interface EntryRow {
  id: string
  tracker_id: string
  occurred_at: Date
  person_id: string | null
  person_name: string | null
  logged_by: string | null
  logged_by_name: string | null
  note: string | null
}

// persons joined without deleted_at: history keeps the names of removed people.
const SELECT_ENTRY = `
  select e.id, e.tracker_id, e.occurred_at, e.person_id, p.name as person_name,
         e.logged_by, lb.name as logged_by_name, e.note
    from tracker_entries e
    left join persons p on p.id = e.person_id and p.household_id = e.household_id
    left join persons lb on lb.id = e.logged_by and lb.household_id = e.household_id`

function toEntryDto(r: EntryRow): EntryDto {
  return {
    id: r.id,
    trackerId: r.tracker_id,
    occurredAt: r.occurred_at.toISOString(),
    personId: r.person_id,
    personName: r.person_name,
    loggedBy: r.logged_by,
    loggedByName: r.logged_by_name,
    note: r.note,
  }
}

const FUTURE_SKEW_MS = 5 * 60_000
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function parseOccurredAt(v: unknown): Date {
  if (typeof v !== 'string') throw new TrackerValidationError('occurredAt must be an ISO timestamp')
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) throw new TrackerValidationError('occurredAt must be an ISO timestamp')
  if (d.getTime() > Date.now() + FUTURE_SKEW_MS) throw new TrackerValidationError('occurredAt cannot be in the future')
  return d
}

function cleanNote(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') throw new TrackerValidationError('note must be a string')
  return v.trim() || null
}

// A foreign or deleted person is a bad request here (not a 404), per the trackers contract.
async function checkPerson(householdId: string, personId: unknown): Promise<string> {
  if (typeof personId !== 'string') throw new TrackerValidationError('personId must be a string')
  try {
    await assertPersonInHousehold(householdId, personId)
  } catch (e) {
    if (e instanceof HouseholdReferenceError) throw new InvalidReferenceError('person not found')
    throw e
  }
  return personId
}

async function getEntry(householdId: string, id: string): Promise<EntryDto | null> {
  if (!isUuid(id)) return null
  const res = await query<EntryRow>(`${SELECT_ENTRY} where e.household_id = $1 and e.id = $2`, [householdId, id])
  return res.rows[0] ? toEntryDto(res.rows[0]) : null
}

/** Returns null when the tracker is not in this household. */
export async function logEntry(tenant: Tenant, trackerId: string, body: Record<string, unknown>): Promise<EntryDto | null> {
  const tracker = await getTracker(tenant.householdId, trackerId)
  if (!tracker) return null
  if (tracker.archivedAt) throw new TrackerArchivedError('tracker is archived')
  const hasPerson = body.personId !== undefined && body.personId !== null
  if (tracker.askPerson && !hasPerson) throw new PersonRequiredError('personId is required for this tracker')
  const personId = hasPerson ? await checkPerson(tenant.householdId, body.personId) : null
  // Explicit ms-precision timestamp (not the column default) so the paging cursor round-trips exactly.
  const occurredAt = body.occurredAt === undefined || body.occurredAt === null ? new Date() : parseOccurredAt(body.occurredAt)
  const note = cleanNote(body.note)
  const ins = await query<{ id: string }>(
    `insert into tracker_entries (household_id, tracker_id, occurred_at, person_id, logged_by, note)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [tenant.householdId, trackerId, occurredAt, personId, tenant.personId, note]
  )
  return getEntry(tenant.householdId, ins.rows[0]!.id)
}

// Cursor is "<iso>_<entry id>" so equal occurred_at values page deterministically
// (order is occurred_at desc, id desc). A bare ISO timestamp is accepted too and
// simply means "strictly older than that instant".
function parseCursor(v: string): { at: Date; id: string | null } {
  const [iso, id] = v.split('_')
  const at = new Date(iso ?? '')
  if (Number.isNaN(at.getTime()) || (id !== undefined && !isUuid(id))) throw new TrackerValidationError('invalid before cursor')
  return { at, id: id ?? null }
}

export async function listEntries(
  householdId: string,
  trackerId: string,
  opts: { personId?: string; before?: string; limit?: string }
): Promise<{ entries: EntryDto[]; nextBefore: string | null } | null> {
  if (!(await getTracker(householdId, trackerId))) return null
  let limit = DEFAULT_LIMIT
  if (opts.limit !== undefined && opts.limit !== '') {
    limit = Number(opts.limit)
    if (!Number.isInteger(limit) || limit < 1) throw new TrackerValidationError('limit must be a positive integer')
    limit = Math.min(limit, MAX_LIMIT)
  }
  const params: unknown[] = [householdId, trackerId]
  const where = ['e.household_id = $1', 'e.tracker_id = $2']
  if (opts.personId) {
    if (!isUuid(opts.personId)) throw new TrackerValidationError('invalid person id')
    params.push(opts.personId)
    where.push(`e.person_id = $${params.length}`)
  }
  if (opts.before) {
    const c = parseCursor(opts.before)
    params.push(c.at)
    if (c.id) {
      params.push(c.id)
      where.push(`(e.occurred_at, e.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`)
    } else {
      where.push(`e.occurred_at < $${params.length}::timestamptz`)
    }
  }
  params.push(limit + 1)
  const res = await query<EntryRow>(
    `${SELECT_ENTRY} where ${where.join(' and ')}
      order by e.occurred_at desc, e.id desc limit $${params.length}`,
    params
  )
  const page = res.rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    entries: page.map(toEntryDto),
    nextBefore: res.rows.length > limit && last ? `${last.occurred_at.toISOString()}_${last.id}` : null,
  }
}

export async function updateEntry(tenant: Tenant, id: string, body: Record<string, unknown>): Promise<EntryDto | null> {
  if (!isUuid(id)) return null
  const sets: string[] = []
  const params: unknown[] = [tenant.householdId, id]
  const add = (col: string, val: unknown) => {
    params.push(val)
    sets.push(`${col} = $${params.length}`)
  }
  if (body.occurredAt !== undefined) add('occurred_at', parseOccurredAt(body.occurredAt))
  if (body.personId !== undefined) {
    add('person_id', body.personId === null ? null : await checkPerson(tenant.householdId, body.personId))
  }
  if (body.note !== undefined) add('note', cleanNote(body.note))
  if (sets.length === 0) return getEntry(tenant.householdId, id)
  const res = await query(`update tracker_entries set ${sets.join(', ')} where household_id = $1 and id = $2`, params)
  if (res.rowCount === 0) return null
  return getEntry(tenant.householdId, id)
}

export async function deleteEntry(tenant: Tenant, id: string): Promise<boolean> {
  if (!isUuid(id)) return false
  const res = await query(`delete from tracker_entries where household_id = $1 and id = $2`, [tenant.householdId, id])
  return (res.rowCount ?? 0) > 0
}
