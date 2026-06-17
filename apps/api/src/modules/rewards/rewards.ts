// Rewards domain — the "spend" half of the stars loop. A rewards catalog
// (admin-curated) + redemption requests with a parent-approval gate. Approving a
// redemption writes a negative ledger entry (reason 'reward_redeemed'), so the
// ledger remains the single source of truth for every balance.
import createAPI, { type Request, type Response } from 'lambda-api'
import type { QueryResultRow } from 'pg'
import { getPool, query } from '../../platform/db'
import { requireTenant, requireAdmin, type Tenant } from '../households/households'
import { listCurrencies, getDefaultCurrencyKey, presentCurrency } from '../currencies/currencies'

type Api = ReturnType<typeof createAPI>
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface RewardRow extends QueryResultRow {
  id: string
  title: string
  emoji: string | null
  cost: number
  currency: string
  sort_order: number
}

interface RedemptionRow extends QueryResultRow {
  id: string
  reward_id: string
  person_id: string
  title: string
  emoji: string | null
  cost: number
  currency: string
  status: string
  requested_by: string | null
  decided_by: string | null
  decided_at: string | null
  created_at: string
}

function presentReward(r: RewardRow) {
  return { id: r.id, title: r.title, emoji: r.emoji, cost: r.cost, currency: r.currency, sortOrder: r.sort_order }
}

function presentRedemption(r: RedemptionRow & { person_name?: string | null; avatar_emoji?: string | null; color_hex?: string | null }) {
  return {
    id: r.id,
    rewardId: r.reward_id,
    personId: r.person_id,
    personName: r.person_name ?? null,
    personAvatar: r.avatar_emoji ?? null,
    personColor: r.color_hex ?? null,
    title: r.title,
    emoji: r.emoji,
    cost: r.cost,
    currency: r.currency,
    status: r.status,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  }
}

export async function listRewards(householdId: string): Promise<RewardRow[]> {
  const { rows } = await query<RewardRow>(
    `select * from rewards where household_id=$1 and deleted_at is null order by sort_order, lower(title)`,
    [householdId]
  )
  return rows
}

export async function balanceFor(householdId: string, personId: string, currency = 'stars'): Promise<number> {
  const { rows } = await query<{ balance: string | null }>(
    `select coalesce(sum(amount),0) as balance from ledger_entries
       where household_id=$1 and person_id=$2 and currency=$3 and deleted_at is null`,
    [householdId, personId, currency]
  )
  return Number(rows[0]?.balance ?? 0)
}

// Per-person balances (per currency) + recent earn/spend history. Returns the
// currency catalog too so the kiosk can render symbols/labels without a second
// fetch. `stars` is kept as the default-currency total for older consumers.
export async function balancesSummary(householdId: string) {
  const currencies = await listCurrencies(householdId)
  const defaultKey = currencies.find((c) => c.is_default)?.key ?? currencies[0]?.key ?? 'stars'
  const people = await query<{ id: string; name: string | null; avatar_emoji: string | null; color_hex: string | null }>(
    `select id, name, avatar_emoji, color_hex from persons where household_id=$1 and deleted_at is null order by sort_order, created_at`,
    [householdId]
  )
  const balances = await query<{ person_id: string; currency: string; balance: string }>(
    `select person_id, currency, sum(amount) as balance from ledger_entries
       where household_id=$1 and deleted_at is null group by person_id, currency`,
    [householdId]
  )
  const recent = await query<{ person_id: string; amount: number; reason: string; currency: string; created_at: string }>(
    `select person_id, amount, reason, currency, created_at from ledger_entries
       where household_id=$1 and deleted_at is null order by created_at desc limit 50`,
    [householdId]
  )
  const byPerson = new Map<string, Map<string, number>>()
  for (const b of balances.rows) {
    if (!byPerson.has(b.person_id)) byPerson.set(b.person_id, new Map())
    byPerson.get(b.person_id)!.set(b.currency, Number(b.balance))
  }
  return {
    currencies: currencies.map(presentCurrency),
    people: people.rows.map((p) => {
      const m = byPerson.get(p.id) ?? new Map<string, number>()
      return {
        personId: p.id,
        name: p.name,
        avatarEmoji: p.avatar_emoji,
        colorHex: p.color_hex,
        stars: m.get(defaultKey) ?? 0,
        // one entry per catalog currency, so zero balances still render as chips
        balances: currencies.map((c) => ({ currency: c.key, balance: m.get(c.key) ?? 0 })),
        recent: recent.rows
          .filter((e) => e.person_id === p.id)
          .slice(0, 8)
          .map((e) => ({ amount: e.amount, reason: e.reason, currency: e.currency, createdAt: e.created_at })),
      }
    }),
  }
}

// A kid requests a reward → pending redemption (snapshots cost/title).
export async function requestRedemption(tenant: Tenant, rewardId: string, personId: string): Promise<RedemptionRow | null> {
  const { rows } = await query<RewardRow>(
    `select * from rewards where household_id=$1 and id=$2 and deleted_at is null`,
    [tenant.householdId, rewardId]
  )
  const reward = rows[0]
  if (!reward) return null
  const { rows: ins } = await query<RedemptionRow>(
    `insert into reward_redemptions
       (household_id, reward_id, person_id, title, emoji, cost, currency, status, requested_by)
     values ($1,$2,$3,$4,$5,$6,$7,'pending',$8) returning *`,
    [tenant.householdId, rewardId, personId, reward.title, reward.emoji, reward.cost, reward.currency, tenant.personId]
  )
  return ins[0]
}

// Parent approves → write the debit ledger entry and link it. Transactional so a
// redemption never approves without its matching ledger row.
export async function decideRedemption(tenant: Tenant, id: string, approve: boolean): Promise<{ redemption: RedemptionRow } | { error: string } | null> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const cur = await client.query<RedemptionRow>(
      `select * from reward_redemptions where household_id=$1 and id=$2 and deleted_at is null for update`,
      [tenant.householdId, id]
    )
    const red = cur.rows[0]
    if (!red) { await client.query('rollback'); return null }
    if (red.status !== 'pending') { await client.query('rollback'); return { error: 'already decided' } }

    if (!approve) {
      const upd = await client.query<RedemptionRow>(
        `update reward_redemptions set status='denied', decided_by=$1, decided_at=now() where id=$2 returning *`,
        [tenant.personId, id]
      )
      await client.query('commit')
      return { redemption: upd.rows[0] }
    }

    const bal = await client.query<{ balance: string | null }>(
      `select coalesce(sum(amount),0) as balance from ledger_entries
         where household_id=$1 and person_id=$2 and currency=$3 and deleted_at is null`,
      [tenant.householdId, red.person_id, red.currency]
    )
    if (Number(bal.rows[0]?.balance ?? 0) < red.cost) {
      await client.query('rollback')
      return { error: 'not enough stars' }
    }
    const led = await client.query<{ id: string }>(
      `insert into ledger_entries (household_id, person_id, currency, amount, reason, ref_type, ref_id, created_by)
       values ($1,$2,$3,$4,'reward_redeemed','reward_redemption',$5,$6) returning id`,
      [tenant.householdId, red.person_id, red.currency, -red.cost, id, tenant.personId]
    )
    const upd = await client.query<RedemptionRow>(
      `update reward_redemptions set status='approved', decided_by=$1, decided_at=now(), ledger_id=$2 where id=$3 returning *`,
      [tenant.personId, led.rows[0].id, id]
    )
    await client.query('commit')
    return { redemption: upd.rows[0] }
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

export function registerRewardRoutes(api: Api): void {
  // Catalog
  api.get('/api/rewards', async (req: Request) => {
    const tenant = await requireTenant(req)
    return { rewards: (await listRewards(tenant.householdId)).map(presentReward) }
  })

  api.post('/api/rewards', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const body = (req.body ?? {}) as { title?: string; emoji?: string; cost?: number; currency?: string }
    const title = body.title?.trim()
    if (!title) return res.status(400).json({ error: 'BadRequest', message: 'title is required' })
    const currency = body.currency?.trim() || (await getDefaultCurrencyKey(tenant.householdId))
    const { rows } = await query<RewardRow>(
      `insert into rewards (household_id, title, emoji, cost, currency)
       values ($1,$2,$3,$4,$5) returning *`,
      [tenant.householdId, title, body.emoji ?? null, Math.max(0, Math.round(body.cost ?? 0)), currency]
    )
    return res.status(201).json({ reward: presentReward(rows[0]) })
  })

  api.delete('/api/rewards/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'reward not found' })
    const { rowCount } = await query(
      `update rewards set deleted_at=now() where household_id=$1 and id=$2 and deleted_at is null`,
      [tenant.householdId, id]
    )
    if (!rowCount) return res.status(404).json({ error: 'NotFound', message: 'reward not found' })
    return res.status(204).send('')
  })

  // Balances + history
  api.get('/api/balances', async (req: Request) => {
    const tenant = await requireTenant(req)
    return balancesSummary(tenant.householdId)
  })

  // Redemptions
  api.get('/api/redemptions', async (req: Request) => {
    const tenant = await requireTenant(req)
    const status = (req.query?.status as string | undefined)?.trim()
    const params: unknown[] = [tenant.householdId]
    let where = `r.household_id=$1 and r.deleted_at is null`
    if (status) { params.push(status); where += ` and r.status=$${params.length}` }
    const { rows } = await query<RedemptionRow & { person_name: string | null; avatar_emoji: string | null; color_hex: string | null }>(
      `select r.*, p.name as person_name, p.avatar_emoji, p.color_hex
         from reward_redemptions r left join persons p on p.id = r.person_id
        where ${where} order by r.created_at desc limit 100`,
      params
    )
    return { redemptions: rows.map(presentRedemption) }
  })

  api.post('/api/rewards/:id/redeem', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'reward not found' })
    const body = (req.body ?? {}) as { personId?: string }
    const personId = body.personId?.trim() || tenant.personId
    if (!UUID_RE.test(personId)) return res.status(400).json({ error: 'BadRequest', message: 'valid personId required' })
    const red = await requestRedemption(tenant, id, personId)
    if (!red) return res.status(404).json({ error: 'NotFound', message: 'reward not found' })
    return res.status(201).json({ redemption: presentRedemption(red) })
  })

  api.post('/api/redemptions/:id/approve', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    return decide(tenant, req, res, true)
  })

  api.post('/api/redemptions/:id/deny', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    return decide(tenant, req, res, false)
  })

  async function decide(tenant: Tenant, req: Request, res: Response, approve: boolean) {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'redemption not found' })
    const result = await decideRedemption(tenant, id, approve)
    if (result === null) return res.status(404).json({ error: 'NotFound', message: 'redemption not found' })
    if ('error' in result) return res.status(409).json({ error: 'Conflict', message: result.error })
    return res.status(200).json({ redemption: presentRedemption(result.redemption) })
  }
}
