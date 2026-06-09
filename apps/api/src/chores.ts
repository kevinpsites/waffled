// Chores domain. MVP: daily-recurring chores assigned to a person; today's
// instances are materialized on demand; completion awards stars via the ledger.
// (rrule expansion beyond daily, photo proof, approval, up-for-grabs: later.)
import createAPI, { type Request, type Response } from 'lambda-api'
import type { QueryResultRow } from 'pg'
import { getPool, query } from './db'
import { requireTenant, requireAdmin, type Tenant } from './households'

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

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export interface CreateChoreInput {
  title: string
  personId?: string | null
  emoji?: string | null
  rewardAmount?: number
  rrule?: string | null
  dueTime?: string | null
}

export async function createChore(tenant: Tenant, input: CreateChoreInput): Promise<ChoreRow> {
  const { rows } = await query<ChoreRow>(
    `insert into chores
       (household_id, title, emoji, person_id, rrule, reward_currency, reward_amount, due_time)
     values ($1, $2, $3, $4, coalesce($5,'FREQ=DAILY'), 'stars', coalesce($6,0), $7)
     returning *`,
    [
      tenant.householdId,
      input.title,
      input.emoji ?? null,
      input.personId ?? null,
      input.rrule ?? null,
      input.rewardAmount ?? 0,
      input.dueTime ?? null,
    ]
  )
  return rows[0]
}

// Materialize today's instances for active daily chores (idempotent).
export async function ensureTodayInstances(householdId: string, dueOn: string): Promise<void> {
  await query(
    `insert into chore_instances
       (household_id, chore_id, person_id, due_on, reward_currency, reward_amount)
     select household_id, id, person_id, $2::date, reward_currency, reward_amount
       from chores
      where household_id = $1 and is_active and deleted_at is null
        and rrule is not null and rrule like '%DAILY%'
     on conflict (chore_id, due_on) do nothing`,
    [householdId, dueOn]
  )
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
            count(ci.id) as total,
            count(ci.id) filter (where ci.status = 'done') as done,
            coalesce(b.balance, 0) as stars
       from persons p
       left join chore_instances ci
         on ci.person_id = p.id and ci.due_on = $2::date and ci.deleted_at is null
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
  choreTitle: string
  emoji: string | null
  personId: string | null
  personName: string | null
  status: string
  rewardAmount: number | null
}

export async function listTodayInstances(householdId: string, dueOn: string): Promise<TodayInstance[]> {
  const { rows } = await query<QueryResultRow>(
    `select ci.id, ci.status, ci.reward_amount, ci.person_id,
            c.title as chore_title, c.emoji, p.name as person_name
       from chore_instances ci
       join chores c on c.id = ci.chore_id
       left join persons p on p.id = ci.person_id
      where ci.household_id = $1 and ci.due_on = $2::date and ci.deleted_at is null
      order by p.sort_order nulls last, c.due_time nulls last, c.title`,
    [householdId, dueOn]
  )
  return rows.map((r) => ({
    id: r.id,
    choreTitle: r.chore_title,
    emoji: r.emoji,
    personId: r.person_id,
    personName: r.person_name,
    status: r.status,
    rewardAmount: r.reward_amount,
  }))
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

// Mark done + award stars (one ledger entry, once). Idempotent if already done.
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
    if (inst.status === 'done') {
      await client.query('commit')
      return inst
    }
    const upd = await client.query<ChoreInstanceRow>(
      `update chore_instances set status='done', completed_by=$1, completed_at=now() where id=$2 returning *`,
      [tenant.personId, id]
    )
    const updated = upd.rows[0]
    if (!updated.awarded && updated.reward_amount && updated.person_id) {
      await client.query(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason, ref_type, ref_id, created_by)
         values ($1,$2,$3,$4,'chore_completed','chore_instance',$5,$6)`,
        [
          tenant.householdId,
          updated.person_id,
          updated.reward_currency ?? 'stars',
          updated.reward_amount,
          id,
          tenant.personId,
        ]
      )
      await client.query(`update chore_instances set awarded=true where id=$1`, [id])
      updated.awarded = true
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

  // Today's per-person chore summary (rings + stars).
  api.get('/api/chores/today', async (req: Request) => {
    const tenant = await requireTenant(req)
    const date = todayDate()
    await ensureTodayInstances(tenant.householdId, date)
    const people = await todaySummary(tenant.householdId, date)
    return { date, people }
  })

  // Today's individual chore instances (the Tasks list).
  api.get('/api/chore-instances/today', async (req: Request) => {
    const tenant = await requireTenant(req)
    const date = todayDate()
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
}
