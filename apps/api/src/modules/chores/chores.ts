// Chores domain. MVP: daily-recurring chores assigned to a person; today's
// instances are materialized on demand; completion awards stars via the ledger.
// (rrule expansion beyond daily, photo proof, approval, up-for-grabs: later.)
import createAPI, { type Request, type Response } from 'lambda-api'
import type { QueryResultRow, PoolClient } from 'pg'
import { getPool, query } from '../../platform/db'
import { requireTenant, requireAdmin, type Tenant } from '../households/households'

type Api = ReturnType<typeof createAPI>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface ChoreInstanceRow extends QueryResultRow {
  id: string
  person_id: string | null
  status: string
  completed_at: Date | null
  reward_currency: string | null
  reward_amount: number | null
  awarded: boolean
  requires_approval: boolean
}

export interface ChoreRow extends QueryResultRow {
  id: string
  title: string
  emoji: string | null
  person_id: string | null
  rrule: string | null
  reward_currency: string | null
  reward_amount: number
  due_time: string | null
  is_active: boolean
}

// "Today" as a calendar day. With a timezone it's the household-local day (so
// chores don't roll over at UTC midnight — i.e. early in the evening); without
// one it falls back to UTC.
export function todayDate(tz?: string): string {
  if (!tz) return new Date().toISOString().slice(0, 10)
  const m: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())) m[p.type] = p.value
  return `${m.year}-${m.month}-${m.day}`
}

export async function householdTz(householdId: string): Promise<string> {
  const { rows } = await query<{ timezone: string }>(`select timezone from households where id = $1`, [householdId])
  return rows[0]?.timezone ?? 'UTC'
}

// The day the Tasks view is asking for: a valid ?date= within ±31 days of `today`,
// else today. Bounds keep on-demand materialization of future instances cheap.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000
export function requestedDate(raw: unknown, today: string): string {
  if (typeof raw !== 'string' || !DATE_RE.test(raw)) return today
  const diff = Math.round((Date.parse(`${raw}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS)
  if (Number.isNaN(diff) || diff < -31 || diff > 31) return today
  return raw
}

export interface CreateChoreInput {
  title: string
  personId?: string | null
  emoji?: string | null
  rewardAmount?: number
  rrule?: string | null
  dueTime?: string | null
  requiresApproval?: boolean
}

export async function createChore(tenant: Tenant, input: CreateChoreInput): Promise<ChoreRow> {
  const { rows } = await query<ChoreRow>(
    `insert into chores
       (household_id, title, emoji, person_id, rrule, reward_currency, reward_amount, due_time, requires_approval)
     values ($1, $2, $3, $4, coalesce($5,'FREQ=DAILY'), 'stars', coalesce($6,0), $7, $8)
     returning *`,
    [
      tenant.householdId,
      input.title,
      input.emoji ?? null,
      input.personId ?? null,
      input.rrule ?? null,
      input.rewardAmount ?? 0,
      input.dueTime ?? null,
      input.requiresApproval ?? false,
    ]
  )
  return rows[0]
}

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

// Materialize today's instances (idempotent) for active chores due today: DAILY
// always, WEEKLY when today's weekday is in the rrule's BYDAY list. Day codes are
// all distinct 2-letter tokens, so a substring match within a WEEKLY BYDAY is safe.
export async function ensureTodayInstances(householdId: string, dueOn: string): Promise<void> {
  const dow = WEEKDAY_CODES[new Date(dueOn + 'T00:00:00').getDay()]
  await query(
    `insert into chore_instances
       (household_id, chore_id, person_id, due_on, reward_currency, reward_amount, requires_approval)
     select household_id, id, person_id, $2::date, reward_currency, reward_amount, requires_approval
       from chores
      where household_id = $1 and is_active and deleted_at is null and rrule is not null
        and (
          rrule ilike '%FREQ=DAILY%'
          or (rrule ilike '%FREQ=WEEKLY%' and rrule ~ ('BYDAY=[A-Z,]*' || $3))
        )
     on conflict (chore_id, due_on) do nothing`,
    [householdId, dueOn, dow]
  )
}

// Claim an up-for-grabs (unassigned) instance for a person — only if still
// unclaimed, so two kids can't grab the same one.
export async function claimInstance(tenant: Tenant, id: string, personId: string): Promise<ChoreInstanceRow | null> {
  const { rows } = await query<ChoreInstanceRow>(
    `update chore_instances set person_id=$3
       where household_id=$1 and id=$2 and person_id is null and deleted_at is null
       returning *`,
    [tenant.householdId, id, personId]
  )
  return rows[0] ?? null
}

export interface PersonChoreSummary {
  id: string
  name: string
  avatarEmoji: string | null
  colorHex: string | null
  memberType: string
  isAdmin: boolean
  total: number
  done: number
  stars: number
}

interface SummaryRow extends QueryResultRow {
  id: string
  name: string
  avatar_emoji: string | null
  color_hex: string | null
  member_type: string
  is_admin: boolean
  total: string
  done: string
  stars: string
}

// Per-person done/total for the day + star balance (drives the kiosk rings).
export async function todaySummary(householdId: string, dueOn: string): Promise<PersonChoreSummary[]> {
  const { rows } = await query<SummaryRow>(
    `select p.id, p.name, p.avatar_emoji, p.color_hex, p.member_type, p.is_admin,
            count(c.id) as total,
            count(c.id) filter (where ci.status = 'done') as done,
            coalesce(b.balance, 0) as stars
       from persons p
       left join chore_instances ci
         on ci.person_id = p.id and ci.due_on = $2::date and ci.deleted_at is null
       left join chores c on c.id = ci.chore_id and c.deleted_at is null
       left join v_person_balances b
         on b.person_id = p.id and b.currency = 'stars'
      where p.household_id = $1 and p.deleted_at is null
      group by p.id, b.balance
      order by p.sort_order, p.created_at`,
    [householdId, dueOn]
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    avatarEmoji: r.avatar_emoji,
    colorHex: r.color_hex,
    memberType: r.member_type,
    isAdmin: r.is_admin,
    total: Number(r.total),
    done: Number(r.done),
    stars: Number(r.stars),
  }))
}

export interface TodayInstance {
  id: string
  choreId: string
  choreTitle: string
  emoji: string | null
  personId: string | null
  personName: string | null
  status: string
  rewardAmount: number | null
  rrule: string | null
  requiresApproval: boolean
  streak: number
}

// Per-chore streak: consecutive calendar days (ending today if done, else
// yesterday) the chore was completed. Day-based — exact for daily chores, an
// approximation for weekly ones. Computed in JS over the last ~60 days.
async function streaksByChore(householdId: string, dueOn: string): Promise<Map<string, number>> {
  const { rows } = await query<{ chore_id: string; due_on: string }>(
    `select chore_id, due_on::text from chore_instances
       where household_id=$1 and status='done' and deleted_at is null
         and due_on > ($2::date - 60) and due_on <= $2::date`,
    [householdId, dueOn]
  )
  const doneByChore = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!doneByChore.has(r.chore_id)) doneByChore.set(r.chore_id, new Set())
    doneByChore.get(r.chore_id)!.add(r.due_on.slice(0, 10))
  }
  const dayMs = 86_400_000
  const out = new Map<string, number>()
  for (const [choreId, days] of doneByChore) {
    // start at today if it's done, else yesterday, then walk back while done.
    let cursor = new Date(dueOn + 'T00:00:00')
    if (!days.has(dueOn)) cursor = new Date(cursor.getTime() - dayMs)
    let streak = 0
    while (days.has(cursor.toISOString().slice(0, 10))) {
      streak++
      cursor = new Date(cursor.getTime() - dayMs)
    }
    out.set(choreId, streak)
  }
  return out
}

export async function listTodayInstances(householdId: string, dueOn: string): Promise<TodayInstance[]> {
  const { rows } = await query<QueryResultRow>(
    `select ci.id, ci.status, ci.reward_amount, ci.person_id, ci.requires_approval,
            c.id as chore_id, c.title as chore_title, c.emoji, c.rrule, p.name as person_name
       from chore_instances ci
       join chores c on c.id = ci.chore_id and c.deleted_at is null
       left join persons p on p.id = ci.person_id
      where ci.household_id = $1 and ci.due_on = $2::date and ci.deleted_at is null
      order by p.sort_order nulls last, c.due_time nulls last, c.title`,
    [householdId, dueOn]
  )
  const streaks = await streaksByChore(householdId, dueOn)
  return rows.map((r) => ({
    id: r.id,
    choreId: r.chore_id,
    choreTitle: r.chore_title,
    emoji: r.emoji,
    personId: r.person_id,
    personName: r.person_name,
    status: r.status,
    rewardAmount: r.reward_amount,
    rrule: r.rrule,
    requiresApproval: r.requires_approval,
    streak: streaks.get(r.chore_id) ?? 0,
  }))
}

const UPDATABLE_CHORE: Record<string, string> = {
  title: 'title',
  emoji: 'emoji',
  personId: 'person_id',
  rewardAmount: 'reward_amount',
  dueTime: 'due_time',
  isActive: 'is_active',
  rrule: 'rrule',
  requiresApproval: 'requires_approval',
}

export async function updateChore(
  householdId: string,
  id: string,
  patch: Record<string, unknown>
): Promise<ChoreRow | null> {
  const sets: string[] = []
  const values: unknown[] = []
  let i = 1
  for (const [field, column] of Object.entries(UPDATABLE_CHORE)) {
    if (field in patch && patch[field] !== undefined) {
      sets.push(`${column} = $${i++}`)
      values.push(patch[field])
    }
  }
  values.push(householdId, id)
  const { rows } = await query<ChoreRow>(
    `update chores set ${sets.join(', ')}
       where household_id = $${i++} and id = $${i} and deleted_at is null
       returning *`,
    values
  )
  const updated = rows[0] ?? null

  // Reassigning the chore's "Who" should follow through to its not-yet-acted-on
  // instances from today forward, so editing the assignee (including back to
  // "up for grabs", person_id null) moves it on the board. Done/awaiting
  // instances keep whoever completed/submitted them, for stars-ledger integrity.
  if (updated && 'personId' in patch) {
    await query(
      `update chore_instances ci
          set person_id = $1
         from households h
        where ci.household_id = h.id
          and ci.household_id = $2
          and ci.chore_id = $3
          and ci.deleted_at is null
          and ci.status = 'pending'
          and ci.due_on >= (now() at time zone h.timezone)::date`,
      [(patch.personId as string | null) ?? null, householdId, id]
    )
  }
  return updated
}

export async function softDeleteChore(householdId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `update chores set deleted_at = now() where household_id = $1 and id = $2 and deleted_at is null`,
    [householdId, id]
  )
  return !!rowCount
}

function presentInstance(i: ChoreInstanceRow) {
  return {
    id: i.id,
    personId: i.person_id,
    status: i.status,
    completedAt: i.completed_at,
    rewardAmount: i.reward_amount,
    awarded: i.awarded,
  }
}

// Award a chore's stars once (one positive ledger entry + the awarded flag).
async function awardStars(client: PoolClient, tenant: Tenant, inst: ChoreInstanceRow, id: string): Promise<boolean> {
  if (inst.awarded || !inst.reward_amount || !inst.person_id) return false
  await client.query(
    `insert into ledger_entries (household_id, person_id, currency, amount, reason, ref_type, ref_id, created_by)
     values ($1,$2,$3,$4,'chore_completed','chore_instance',$5,$6)`,
    [tenant.householdId, inst.person_id, inst.reward_currency ?? 'stars', inst.reward_amount, id, tenant.personId]
  )
  await client.query(`update chore_instances set awarded=true where id=$1`, [id])
  return true
}

// Mark done + award stars. If the chore needs a parent's OK, park it in 'awaiting'
// (no stars yet — a parent approves later). Idempotent.
export async function completeInstance(tenant: Tenant, id: string): Promise<ChoreInstanceRow | null> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const cur = await client.query<ChoreInstanceRow>(
      `select * from chore_instances where household_id=$1 and id=$2 and deleted_at is null for update`,
      [tenant.householdId, id]
    )
    const inst = cur.rows[0]
    if (!inst) {
      await client.query('rollback')
      return null
    }
    if (inst.status === 'done' || inst.status === 'awaiting') {
      await client.query('commit')
      return inst
    }
    const nextStatus = inst.requires_approval ? 'awaiting' : 'done'
    const upd = await client.query<ChoreInstanceRow>(
      `update chore_instances set status=$2, completed_by=$1, completed_at=now() where id=$3 returning *`,
      [tenant.personId, nextStatus, id]
    )
    const updated = upd.rows[0]
    if (nextStatus === 'done' && (await awardStars(client, tenant, updated, id))) updated.awarded = true
    await client.query('commit')
    return updated
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Parent approves an 'awaiting' instance → 'done' + award. Idempotent on 'done'.
export async function approveInstance(tenant: Tenant, id: string): Promise<ChoreInstanceRow | null> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const cur = await client.query<ChoreInstanceRow>(
      `select * from chore_instances where household_id=$1 and id=$2 and deleted_at is null for update`,
      [tenant.householdId, id]
    )
    const inst = cur.rows[0]
    if (!inst) { await client.query('rollback'); return null }
    if (inst.status === 'done') { await client.query('commit'); return inst }
    const upd = await client.query<ChoreInstanceRow>(
      `update chore_instances set status='done', completed_at=coalesce(completed_at, now()) where id=$1 returning *`,
      [id]
    )
    const updated = upd.rows[0]
    if (await awardStars(client, tenant, updated, id)) updated.awarded = true
    await client.query('commit')
    return updated
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Parent rejects an 'awaiting' instance → back to 'pending' for a redo.
export async function rejectInstance(tenant: Tenant, id: string): Promise<ChoreInstanceRow | null> {
  const { rows } = await query<ChoreInstanceRow>(
    `update chore_instances set status='pending', completed_by=null, completed_at=null
       where household_id=$1 and id=$2 and status='awaiting' and deleted_at is null
       returning *`,
    [tenant.householdId, id]
  )
  return rows[0] ?? null
}

// Revert to pending; if stars were awarded, write a reversing ledger entry.
export async function uncompleteInstance(tenant: Tenant, id: string): Promise<ChoreInstanceRow | null> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const cur = await client.query<ChoreInstanceRow>(
      `select * from chore_instances where household_id=$1 and id=$2 and deleted_at is null for update`,
      [tenant.householdId, id]
    )
    const inst = cur.rows[0]
    if (!inst) {
      await client.query('rollback')
      return null
    }
    const upd = await client.query<ChoreInstanceRow>(
      `update chore_instances set status='pending', completed_by=null, completed_at=null where id=$1 returning *`,
      [id]
    )
    const updated = upd.rows[0]
    if (inst.awarded && inst.reward_amount && inst.person_id) {
      await client.query(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason, ref_type, ref_id, created_by)
         values ($1,$2,$3,$4,'chore_uncompleted','chore_instance',$5,$6)`,
        [
          tenant.householdId,
          inst.person_id,
          inst.reward_currency ?? 'stars',
          -inst.reward_amount,
          id,
          tenant.personId,
        ]
      )
      await client.query(`update chore_instances set awarded=false where id=$1`, [id])
      updated.awarded = false
    }
    await client.query('commit')
    return updated
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

export function presentChore(c: ChoreRow) {
  return {
    id: c.id,
    title: c.title,
    emoji: c.emoji,
    personId: c.person_id,
    rrule: c.rrule,
    rewardCurrency: c.reward_currency,
    rewardAmount: c.reward_amount,
    dueTime: c.due_time,
    isActive: c.is_active,
    requiresApproval: (c as { requires_approval?: boolean }).requires_approval ?? false,
  }
}

export function registerChoreRoutes(api: Api): void {
  // Create a chore (admins set up the family's chores).
  api.post('/api/chores', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const body = (req.body ?? {}) as Partial<CreateChoreInput>
    if (!body.title || !body.title.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'title is required' })
    }
    const chore = await createChore(tenant, { ...body, title: body.title.trim() })
    return res.status(201).json({ chore: presentChore(chore) })
  })

  // Edit a chore definition (admins).
  api.patch('/api/chores/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'chore not found' })
    const patch = (req.body ?? {}) as Record<string, unknown>
    if (typeof patch.title === 'string' && !patch.title.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'title cannot be empty' })
    }
    if (!Object.keys(UPDATABLE_CHORE).some((field) => field in patch)) {
      return res.status(400).json({ error: 'BadRequest', message: 'no updatable fields provided' })
    }
    const chore = await updateChore(tenant.householdId, id, patch)
    if (!chore) return res.status(404).json({ error: 'NotFound', message: 'chore not found' })
    return { chore: presentChore(chore) }
  })

  // Delete a chore (admins). Hides it + today's instances from the Tasks view.
  api.delete('/api/chores/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'chore not found' })
    const ok = await softDeleteChore(tenant.householdId, id)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'chore not found' })
    return res.status(204).send('')
  })

  // Per-person chore summary (rings + stars) for a day (default today, household-local).
  api.get('/api/chores/today', async (req: Request) => {
    const tenant = await requireTenant(req)
    const date = requestedDate(req.query?.date, todayDate(await householdTz(tenant.householdId)))
    await ensureTodayInstances(tenant.householdId, date)
    const people = await todaySummary(tenant.householdId, date)
    return { date, people }
  })

  // Individual chore instances (the Tasks list) for a day. `?date=YYYY-MM-DD`
  // (within ±31 days) lets the Tasks screen look ahead; defaults to today (local).
  api.get('/api/chore-instances/today', async (req: Request) => {
    const tenant = await requireTenant(req)
    const date = requestedDate(req.query?.date, todayDate(await householdTz(tenant.householdId)))
    await ensureTodayInstances(tenant.householdId, date)
    const instances = await listTodayInstances(tenant.householdId, date)
    return { date, instances }
  })

  // Complete / uncomplete an instance (any member can; e.g. a parent on the kiosk).
  api.post('/api/chore-instances/:id/complete', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    const inst = await completeInstance(tenant, id)
    if (!inst) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    return { instance: presentInstance(inst) }
  })

  api.post('/api/chore-instances/:id/uncomplete', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    const inst = await uncompleteInstance(tenant, id)
    if (!inst) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    return { instance: presentInstance(inst) }
  })

  // Claim an up-for-grabs instance for a person (default: the caller). 409 if
  // someone already grabbed it.
  api.post('/api/chore-instances/:id/claim', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    const personId = ((req.body ?? {}) as { personId?: string }).personId?.trim() || tenant.personId
    if (!UUID_RE.test(personId)) return res.status(400).json({ error: 'BadRequest', message: 'valid personId required' })
    const inst = await claimInstance(tenant, id, personId)
    if (!inst) return res.status(409).json({ error: 'Conflict', message: 'already claimed or not found' })
    return { instance: presentInstance(inst) }
  })

  // Parent approves a submitted (awaiting) chore → done + award stars (admins).
  api.post('/api/chore-instances/:id/approve', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    const inst = await approveInstance(tenant, id)
    if (!inst) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    return { instance: presentInstance(inst) }
  })

  // Parent rejects a submitted chore → back to pending for a redo (admins).
  api.post('/api/chore-instances/:id/reject', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    const inst = await rejectInstance(tenant, id)
    if (!inst) return res.status(409).json({ error: 'Conflict', message: 'not awaiting approval' })
    return { instance: presentInstance(inst) }
  })
}
