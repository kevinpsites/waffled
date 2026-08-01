// Rewards domain — the "spend" half of the stars loop. A rewards catalog
// (admin-curated) + redemption requests with a parent-approval gate. Approving a
// redemption writes a negative ledger entry (reason 'reward_redeemed'), so the
// ledger remains the single source of truth for every balance.
import createAPI, { type Request, type Response } from 'lambda-api'
import type { PoolClient, QueryResultRow } from 'pg'
import { getPool, query } from '../../platform/db'
import { type Tenant } from '../households/households'
import { rewardsRoutes, moduleRoutes } from '../../platform/route-guards'
import { assertPersonInHousehold, HouseholdReferenceError } from '../../platform/household-refs'
import { requireCapability } from '../../platform/permissions'
import { lockLedgerSubject } from '../../platform/ledger-lock'
import { registerRewardCaptureTarget } from './rewards-capture'
import { listCurrencies, getDefaultCurrencyKey, presentCurrency } from '../currencies/currencies'

type Api = ReturnType<typeof createAPI>
// Rewards is the spend half of the chores economy: these routes require the chores
// module on AND its rewards sub-toggle (settings.chores.rewards) enabled.
const { tenantRoute, capRoute } = rewardsRoutes()
// A spot-award is an *earn* action, not a shop action — it must work even when the
// rewards shop sub-toggle is off. So it gates on the plain chores module, not the
// rewards-shop gate above.
const { capRoute: choresCapRoute } = moduleRoutes('chores')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CORRECTABLE_LEDGER_REASONS = new Set(['spot_award', 'ledger_correction'])

interface RewardRow extends QueryResultRow {
  id: string
  title: string
  emoji: string | null
  cost: number
  currency: string
  category: string | null
  sort_order: number
  requires_approval: boolean
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
  ledger_id: string | null
  refund_ledger_id: string | null
  created_at: string
}

interface LedgerEntryRow extends QueryResultRow {
  id: string
  household_id: string
  person_id: string
  currency: string
  amount: number
  reason: string
  ref_type: string | null
  ref_id: string | null
  note: string | null
  reverses_entry_id: string | null
  correction_of_id: string | null
  correction_group_id: string | null
  correction_reason: string | null
  idempotency_key: string | null
}

export class LedgerCorrectionError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409 = 400) {
    super(message)
    this.name = 'LedgerCorrectionError'
  }
}

function presentReward(r: RewardRow) {
  return { id: r.id, title: r.title, emoji: r.emoji, cost: r.cost, currency: r.currency, category: r.category, sortOrder: r.sort_order, requiresApproval: r.requires_approval }
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
    ledgerId: r.ledger_id,
    refundLedgerId: r.refund_ledger_id,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  }
}

interface CorrectionResult {
  originalId: string
  reversalId: string
  replacementId: string | null
  balance: number
  replayed: boolean
}

function validateCorrection(originalAmount: number, replacementAmount: number | undefined): void {
  if (replacementAmount === undefined) return
  if (!Number.isSafeInteger(replacementAmount)) {
    throw new LedgerCorrectionError('replacementAmount must be a whole number')
  }
  if (replacementAmount === originalAmount) {
    throw new LedgerCorrectionError('replacementAmount must differ from the original amount')
  }
  if (replacementAmount !== 0 && Math.sign(replacementAmount) !== Math.sign(originalAmount)) {
    throw new LedgerCorrectionError('replacementAmount must keep the original credit or debit direction')
  }
}

async function correctionResult(
  client: PoolClient,
  householdId: string,
  originalId: string,
  replayed: boolean
): Promise<CorrectionResult> {
  const reversal = await client.query<{ id: string; correction_group_id: string; person_id: string; currency: string }>(
    `select id, correction_group_id, person_id, currency from ledger_entries
      where household_id=$1 and reverses_entry_id=$2`,
    [householdId, originalId]
  )
  if (!reversal.rows[0]) throw new LedgerCorrectionError('ledger correction not found', 404)
  const replacement = await client.query<{ id: string }>(
    `select id from ledger_entries
      where household_id=$1 and correction_group_id=$2 and correction_of_id=$3
      order by created_at limit 1`,
    [householdId, reversal.rows[0].correction_group_id, originalId]
  )
  const balance = await client.query<{ balance: string }>(
    `select coalesce(sum(amount),0) as balance from ledger_entries
      where household_id=$1 and person_id=$2 and currency=$3 and deleted_at is null`,
    [householdId, reversal.rows[0].person_id, reversal.rows[0].currency]
  )
  return {
    originalId,
    reversalId: reversal.rows[0].id,
    replacementId: replacement.rows[0]?.id ?? null,
    balance: Number(balance.rows[0]?.balance ?? 0),
    replayed,
  }
}

async function correctLockedLedgerEntry(
  client: PoolClient,
  tenant: Tenant,
  original: LedgerEntryRow,
  reason: string,
  replacementAmount: number | undefined,
  idempotencyKey: string
): Promise<CorrectionResult> {
  if (original.reverses_entry_id) {
    throw new LedgerCorrectionError('a reversal entry cannot itself be corrected', 409)
  }
  validateCorrection(original.amount, replacementAmount)
  const already = await client.query<{ id: string }>(
    `select id from ledger_entries where household_id=$1 and reverses_entry_id=$2`,
    [tenant.householdId, original.id]
  )
  if (already.rowCount) throw new LedgerCorrectionError('this ledger entry has already been corrected', 409)

  await lockLedgerSubject(client, tenant.householdId, original.person_id)
  const group = await client.query<{ id: string }>(`select gen_random_uuid() as id`)
  const groupId = group.rows[0].id
  const reversal = await client.query<{ id: string }>(
    `insert into ledger_entries
       (household_id, person_id, currency, amount, reason, ref_type, ref_id, note,
        created_by, reverses_entry_id, correction_group_id, correction_reason, idempotency_key)
     values ($1,$2,$3,$4,'ledger_reversal',$5,$6,$7,$8,$9,$10,$7,$11)
     returning id`,
    [tenant.householdId, original.person_id, original.currency, -original.amount,
      original.ref_type, original.ref_id, reason, tenant.personId, original.id, groupId, idempotencyKey]
  )
  let replacementId: string | null = null
  if (replacementAmount !== undefined && replacementAmount !== 0) {
    const replacement = await client.query<{ id: string }>(
      `insert into ledger_entries
         (household_id, person_id, currency, amount, reason, ref_type, ref_id, note,
          created_by, correction_of_id, correction_group_id, correction_reason)
       values ($1,$2,$3,$4,'ledger_correction',$5,$6,$7,$8,$9,$10,$7)
       returning id`,
      [tenant.householdId, original.person_id, original.currency, replacementAmount,
        original.ref_type, original.ref_id, reason, tenant.personId, original.id, groupId]
    )
    replacementId = replacement.rows[0].id
  }
  const balance = await client.query<{ balance: string }>(
    `select coalesce(sum(amount),0) as balance from ledger_entries
      where household_id=$1 and person_id=$2 and currency=$3 and deleted_at is null`,
    [tenant.householdId, original.person_id, original.currency]
  )
  return {
    originalId: original.id,
    reversalId: reversal.rows[0].id,
    replacementId,
    balance: Number(balance.rows[0]?.balance ?? 0),
    replayed: false,
  }
}

export async function correctLedgerEntry(
  tenant: Tenant,
  id: string,
  reason: string,
  replacementAmount: number | undefined,
  idempotencyKey: string
): Promise<CorrectionResult> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const replay = await client.query<{ reverses_entry_id: string }>(
      `select reverses_entry_id from ledger_entries
        where household_id=$1 and idempotency_key=$2 and reverses_entry_id is not null`,
      [tenant.householdId, idempotencyKey]
    )
    if (replay.rows[0]) {
      if (replay.rows[0].reverses_entry_id !== id) {
        throw new LedgerCorrectionError('idempotencyKey was already used for another correction', 409)
      }
      const result = await correctionResult(client, tenant.householdId, replay.rows[0].reverses_entry_id, true)
      await client.query('commit')
      return result
    }
    const originalResult = await client.query<LedgerEntryRow>(
      `select * from ledger_entries
        where household_id=$1 and id=$2 and deleted_at is null for update`,
      [tenant.householdId, id]
    )
    const original = originalResult.rows[0]
    if (!original) throw new LedgerCorrectionError('ledger entry not found', 404)
    if (original.reason === 'reward_redeemed') {
      throw new LedgerCorrectionError('use the redemption refund action for a settled redemption', 409)
    }
    if (!CORRECTABLE_LEDGER_REASONS.has(original.reason)) {
      throw new LedgerCorrectionError('this activity must be corrected through its original feature', 409)
    }
    const result = await correctLockedLedgerEntry(client, tenant, original, reason, replacementAmount, idempotencyKey)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

export async function cancelRedemption(tenant: Tenant, id: string): Promise<RedemptionRow> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const current = await client.query<RedemptionRow>(
      `select * from reward_redemptions
        where household_id=$1 and id=$2 and deleted_at is null for update`,
      [tenant.householdId, id]
    )
    const redemption = current.rows[0]
    if (!redemption) throw new LedgerCorrectionError('redemption not found', 404)
    if (redemption.status !== 'pending') {
      throw new LedgerCorrectionError('only a pending redemption can be canceled', 409)
    }
    if (redemption.requested_by !== tenant.personId) await requireCapability(tenant, 'reward.approve')
    const updated = await client.query<RedemptionRow>(
      `update reward_redemptions
        set status='canceled', decided_by=$1, decided_at=now()
        where id=$2 returning *`,
      [tenant.personId, id]
    )
    await client.query('commit')
    return updated.rows[0]
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

export async function refundRedemption(
  tenant: Tenant,
  id: string,
  reason: string,
  idempotencyKey: string
): Promise<{ redemption: RedemptionRow; correction: CorrectionResult }> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const replay = await client.query<RedemptionRow>(
      `select * from reward_redemptions
        where household_id=$1 and id=$2 and deleted_at is null for update`,
      [tenant.householdId, id]
    )
    const redemption = replay.rows[0]
    if (!redemption) throw new LedgerCorrectionError('redemption not found', 404)
    const keyUse = await client.query<{ reverses_entry_id: string }>(
      `select reverses_entry_id from ledger_entries
        where household_id=$1 and idempotency_key=$2 and reverses_entry_id is not null`,
      [tenant.householdId, idempotencyKey]
    )
    if (keyUse.rows[0] && keyUse.rows[0].reverses_entry_id !== redemption.ledger_id) {
      throw new LedgerCorrectionError('idempotencyKey was already used for another correction', 409)
    }
    if (redemption.status === 'pending') {
      throw new LedgerCorrectionError('cancel a pending redemption instead of refunding it', 409)
    }
    if (redemption.status === 'refunded' && redemption.ledger_id) {
      const result = await correctionResult(client, tenant.householdId, redemption.ledger_id, true)
      await client.query('commit')
      return { redemption, correction: result }
    }
    if (redemption.status !== 'approved' || !redemption.ledger_id) {
      throw new LedgerCorrectionError('only an approved redemption can be refunded', 409)
    }
    const originalResult = await client.query<LedgerEntryRow>(
      `select * from ledger_entries
        where household_id=$1 and id=$2 and deleted_at is null for update`,
      [tenant.householdId, redemption.ledger_id]
    )
    if (!originalResult.rows[0]) throw new LedgerCorrectionError('redemption ledger entry not found', 409)
    const correction = await correctLockedLedgerEntry(client, tenant, originalResult.rows[0], reason, undefined, idempotencyKey)
    const updated = await client.query<RedemptionRow>(
      `update reward_redemptions
        set status='refunded', decided_by=$1, decided_at=now(), refund_ledger_id=$2
        where id=$3 returning *`,
      [tenant.personId, correction.reversalId, id]
    )
    await client.query('commit')
    return { redemption: updated.rows[0], correction }
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

export async function listRewards(householdId: string): Promise<RewardRow[]> {
  const { rows } = await query<RewardRow>(
    `select * from rewards where household_id=$1 and deleted_at is null order by sort_order, lower(title)`,
    [householdId]
  )
  return rows
}

// Household default applied to *new* rewards (households.settings.rewards.requireApproval).
// Defaults to true. Per-reward `requires_approval` is the actual gate at redeem time; this
// is just the value a freshly created reward inherits (overridable per reward). A parent
// sets it in Settings → Chores & rewards.
export async function getRewardsRequireApproval(householdId: string): Promise<boolean> {
  const { rows } = await query<{ v: boolean | null }>(
    `select (settings #>> '{rewards,requireApproval}')::boolean as v from households where id=$1`,
    [householdId]
  )
  return rows[0]?.v ?? true
}

async function assertSpendableCurrencyInHousehold(householdId: string, currency: string): Promise<void> {
  const { rowCount } = await query(
    `select 1 from currencies
      where household_id=$1 and key=$2 and spendable=true and deleted_at is null`,
    [householdId, currency]
  )
  if (!rowCount) throw new HouseholdReferenceError('currency not found')
}

export async function balanceFor(householdId: string, personId: string, currency = 'stars'): Promise<number> {
  const { rows } = await query<{ balance: string | null }>(
    `select coalesce(sum(amount),0) as balance from ledger_entries
       where household_id=$1 and person_id=$2 and currency=$3 and deleted_at is null`,
    [householdId, personId, currency]
  )
  return Number(rows[0]?.balance ?? 0)
}

// Ad-hoc "spot-award": a parent hands a person stars on the spot ("5 stars for
// being so helpful"), not tied to any chore. A single positive ledger entry
// (reason 'spot_award', null ref) — no transaction/balance guard, since it only
// ever adds. `note` is the optional free-text reason ("being so helpful today").
export async function awardSpot(
  tenant: Tenant,
  personId: string,
  currency: string | undefined,
  amount: number,
  note?: string | null
): Promise<{ id: string }> {
  const cur = currency?.trim() || (await getDefaultCurrencyKey(tenant.householdId))
  await assertPersonInHousehold(tenant.householdId, personId)
  await assertSpendableCurrencyInHousehold(tenant.householdId, cur)
  const { rows } = await query<{ id: string }>(
    `insert into ledger_entries (household_id, person_id, currency, amount, reason, ref_type, ref_id, note, created_by)
     values ($1,$2,$3,$4,'spot_award',null,null,$5,$6) returning id`,
    [tenant.householdId, personId, cur, amount, note?.trim() || null, tenant.personId]
  )
  return rows[0]
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

// A kid redeems a reward (snapshots cost/title). When the *reward* requires approval
// this is a *pending* request a parent must OK; otherwise it's auto-approved and the debit
// is written immediately — but a balance guard still applies, so a kid can never redeem
// what they haven't earned. Returns the redemption row, an `{ error }` (can't afford the
// auto path), or null (reward not found).
export async function requestRedemption(tenant: Tenant, rewardId: string, personId: string): Promise<RedemptionRow | { error: string } | null> {
  const { rows } = await query<RewardRow>(
    `select * from rewards where household_id=$1 and id=$2 and deleted_at is null`,
    [tenant.householdId, rewardId]
  )
  const reward = rows[0]
  if (!reward) return null

  // `personId` is client-controlled (and capture commits call this service
  // directly), so prove the redemption subject belongs to the active household
  // before either the pending or auto-approved path can persist a relationship.
  await assertPersonInHousehold(tenant.householdId, personId)
  if (personId !== tenant.personId) await requireCapability(tenant, 'reward.manage')
  await assertSpendableCurrencyInHousehold(tenant.householdId, reward.currency)

  // This reward needs a parent → a pending request for the approval queue.
  if (reward.requires_approval) {
    const { rows: ins } = await query<RedemptionRow>(
      `insert into reward_redemptions
         (household_id, reward_id, person_id, title, emoji, cost, currency, status, requested_by)
       values ($1,$2,$3,$4,$5,$6,$7,'pending',$8) returning *`,
      [tenant.householdId, rewardId, personId, reward.title, reward.emoji, reward.cost, reward.currency, tenant.personId]
    )
    return ins[0]
  }

  // Gate off → auto-approve: insert as approved + write the debit, transactionally, so a
  // redemption never lands without its matching ledger row. `decided_by` stays null (no
  // parent decided — the household opted into instant redemption).
  const client = await getPool().connect()
  try {
    await client.query('begin')
    await lockLedgerSubject(client, tenant.householdId, personId)
    const bal = await client.query<{ balance: string | null }>(
      `select coalesce(sum(amount),0) as balance from ledger_entries
         where household_id=$1 and person_id=$2 and currency=$3 and deleted_at is null`,
      [tenant.householdId, personId, reward.currency]
    )
    if (Number(bal.rows[0]?.balance ?? 0) < reward.cost) {
      await client.query('rollback')
      return { error: 'not enough stars' }
    }
    const ins = await client.query<RedemptionRow>(
      `insert into reward_redemptions
         (household_id, reward_id, person_id, title, emoji, cost, currency, status, requested_by, decided_at)
       values ($1,$2,$3,$4,$5,$6,$7,'approved',$8, now()) returning *`,
      [tenant.householdId, rewardId, personId, reward.title, reward.emoji, reward.cost, reward.currency, tenant.personId]
    )
    const red = ins.rows[0]
    const led = await client.query<{ id: string }>(
      `insert into ledger_entries (household_id, person_id, currency, amount, reason, ref_type, ref_id, created_by)
       values ($1,$2,$3,$4,'reward_redeemed','reward_redemption',$5,$6) returning id`,
      [tenant.householdId, personId, reward.currency, -reward.cost, red.id, tenant.personId]
    )
    const upd = await client.query<RedemptionRow>(
      `update reward_redemptions set ledger_id=$1 where id=$2 returning *`,
      [led.rows[0].id, red.id]
    )
    await client.query('commit')
    return upd.rows[0]
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
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

    await lockLedgerSubject(client, tenant.householdId, red.person_id)
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
  api.get('/api/rewards', tenantRoute(async (tenant) => {
    return { rewards: (await listRewards(tenant.householdId)).map(presentReward) }
  }))

  api.post('/api/rewards', capRoute('reward.manage', async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { title?: string; emoji?: string; cost?: number; currency?: string; category?: string | null; requiresApproval?: boolean }
    const title = body.title?.trim()
    if (!title) return res.status(400).json({ error: 'BadRequest', message: 'title is required' })
    const currency = body.currency?.trim() || (await getDefaultCurrencyKey(tenant.householdId))
    await assertSpendableCurrencyInHousehold(tenant.householdId, currency)
    const category = body.category?.trim() || null
    // Inherit the household default unless the create form set it explicitly.
    const requiresApproval = typeof body.requiresApproval === 'boolean'
      ? body.requiresApproval
      : await getRewardsRequireApproval(tenant.householdId)
    const { rows } = await query<RewardRow>(
      `insert into rewards (household_id, title, emoji, cost, currency, category, requires_approval)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [tenant.householdId, title, body.emoji ?? null, Math.max(0, Math.round(body.cost ?? 0)), currency, category, requiresApproval]
    )
    return res.status(201).json({ reward: presentReward(rows[0]) })
  }))

  // Edit a reward (title / emoji / cost / currency / requiresApproval).
  api.patch('/api/rewards/:id', capRoute('reward.manage', async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'reward not found' })
    const body = (req.body ?? {}) as { title?: string; emoji?: string | null; cost?: number; currency?: string; category?: string | null; requiresApproval?: boolean }
    const sets: string[] = []
    const vals: unknown[] = []
    let i = 1
    if (typeof body.title === 'string') {
      if (!body.title.trim()) return res.status(400).json({ error: 'BadRequest', message: 'title cannot be empty' })
      sets.push(`title = $${i++}`); vals.push(body.title.trim())
    }
    if ('emoji' in body) { sets.push(`emoji = $${i++}`); vals.push(body.emoji ?? null) }
    if (typeof body.cost === 'number') { sets.push(`cost = $${i++}`); vals.push(Math.max(0, Math.round(body.cost))) }
    if (typeof body.currency === 'string' && body.currency.trim()) {
      const currency = body.currency.trim()
      await assertSpendableCurrencyInHousehold(tenant.householdId, currency)
      sets.push(`currency = $${i++}`); vals.push(currency)
    }
    if ('category' in body) { sets.push(`category = $${i++}`); vals.push(body.category?.trim() || null) }
    if (typeof body.requiresApproval === 'boolean') { sets.push(`requires_approval = $${i++}`); vals.push(body.requiresApproval) }
    if (sets.length === 0) return res.status(400).json({ error: 'BadRequest', message: 'no updatable fields' })
    vals.push(tenant.householdId, id)
    const { rows } = await query<RewardRow>(
      `update rewards set ${sets.join(', ')} where household_id = $${i++} and id = $${i} and deleted_at is null returning *`,
      vals
    )
    if (!rows[0]) return res.status(404).json({ error: 'NotFound', message: 'reward not found' })
    return { reward: presentReward(rows[0]) }
  }))

  api.delete('/api/rewards/:id', capRoute('reward.manage', async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'reward not found' })
    const { rowCount } = await query(
      `update rewards set deleted_at=now() where household_id=$1 and id=$2 and deleted_at is null`,
      [tenant.householdId, id]
    )
    if (!rowCount) return res.status(404).json({ error: 'NotFound', message: 'reward not found' })
    return res.status(204).send('')
  }))

  // Archived (soft-deleted) rewards — admin only; powers the collapsed "Archived"
  // section. Deleting is a soft archive, so redemption history + ledger entries
  // (which snapshot title/cost) are untouched and a reward can be restored.
  api.get('/api/rewards/archived', capRoute('reward.manage', async (tenant) => {
    const { rows } = await query<RewardRow>(
      `select * from rewards where household_id=$1 and deleted_at is not null order by deleted_at desc`,
      [tenant.householdId]
    )
    return { rewards: rows.map(presentReward) }
  }))

  // Restore an archived reward to the catalog (admin).
  api.post('/api/rewards/:id/restore', capRoute('reward.manage', async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'reward not found' })
    const { rows } = await query<RewardRow>(
      `update rewards set deleted_at=null where household_id=$1 and id=$2 and deleted_at is not null returning *`,
      [tenant.householdId, id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'NotFound', message: 'reward not found' })
    return { reward: presentReward(rows[0]) }
  }))

  // Balances + history
  api.get('/api/balances', tenantRoute(async (tenant) => {
    return balancesSummary(tenant.householdId)
  }))

  // Spot-award: a parent grants a person stars on the spot (not tied to a chore).
  // Guarded by the reward.grant capability and the plain chores module — so it
  // works even when the rewards shop sub-toggle is off (it's an *earn*, not a spend).
  api.post('/api/persons/:id/award', choresCapRoute('reward.grant', async (tenant, req: Request, res: Response) => {
    const personId = req.params.id ?? ''
    if (!UUID_RE.test(personId)) return res.status(404).json({ error: 'NotFound', message: 'person not found' })
    const body = (req.body ?? {}) as { amount?: number; currency?: string; note?: string }
    const amount = Math.round(Number(body.amount))
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'amount must be a positive number' })
    }
    const entry = await awardSpot(tenant, personId, body.currency, amount, body.note)
    return res.status(201).json({ id: entry.id })
  }))

  // Correct a manual award without editing history. The service writes an exact
  // reversal and, when requested, a replacement amount in one transaction.
  // Feature-backed activity stays with its original workflow: redemptions use
  // refunds, chores use completion state, and conversions remain paired.
  api.post('/api/ledger-entries/:id/correct', choresCapRoute('reward.correct', async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'ledger entry not found' })
    const body = (req.body ?? {}) as { reason?: string; replacementAmount?: number; idempotencyKey?: string }
    const reason = body.reason?.trim() ?? ''
    if (reason.length < 3 || reason.length > 500) {
      return res.status(400).json({ error: 'BadRequest', message: 'reason must be between 3 and 500 characters' })
    }
    const idempotencyKey = body.idempotencyKey?.trim() ?? ''
    if (!UUID_RE.test(idempotencyKey)) {
      return res.status(400).json({ error: 'BadRequest', message: 'valid idempotencyKey required' })
    }
    if ('replacementAmount' in body && !Number.isSafeInteger(body.replacementAmount)) {
      return res.status(400).json({ error: 'BadRequest', message: 'replacementAmount must be a whole number' })
    }
    try {
      const correction = await correctLedgerEntry(tenant, id, reason, body.replacementAmount, idempotencyKey)
      return res.status(correction.replayed ? 200 : 201).json({ correction })
    } catch (error) {
      return correctionError(error, res)
    }
  }))

  // Redemptions
  api.get('/api/redemptions', tenantRoute(async (tenant, req: Request) => {
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
  }))

  api.post('/api/rewards/:id/redeem', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'reward not found' })
    const body = (req.body ?? {}) as { personId?: string }
    const personId = body.personId?.trim() || tenant.personId
    if (!UUID_RE.test(personId)) return res.status(400).json({ error: 'BadRequest', message: 'valid personId required' })
    const red = await requestRedemption(tenant, id, personId)
    if (red === null) return res.status(404).json({ error: 'NotFound', message: 'reward not found' })
    if ('error' in red) return res.status(409).json({ error: 'Conflict', message: red.error })
    return res.status(201).json({ redemption: presentRedemption(red) })
  }))

  // Reward-approval policy (households.settings.rewards.requireApproval). GET for any
  // member (so the redeem UI can phrase itself); PUT is admin-only.
  api.get('/api/rewards/settings', tenantRoute(async (tenant) => {
    return { requireApproval: await getRewardsRequireApproval(tenant.householdId) }
  }))

  api.put('/api/rewards/settings', capRoute('reward.manage', async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { requireApproval?: boolean }
    if (typeof body.requireApproval !== 'boolean') {
      return res.status(400).json({ error: 'BadRequest', message: 'requireApproval must be a boolean' })
    }
    await query(
      `update households set settings = coalesce(settings, '{}'::jsonb)
         || jsonb_build_object('rewards', jsonb_build_object('requireApproval', $2::boolean))
       where id = $1`,
      [tenant.householdId, body.requireApproval]
    )
    return { requireApproval: body.requireApproval }
  }))

  api.post('/api/redemptions/:id/approve', capRoute('reward.approve', async (tenant, req: Request, res: Response) => {
    return decide(tenant, req, res, true)
  }))

  api.post('/api/redemptions/:id/deny', capRoute('reward.approve', async (tenant, req: Request, res: Response) => {
    return decide(tenant, req, res, false)
  }))

  // Pending requests have not touched the ledger and are canceled. Approved
  // requests are refunded through an append-only compensating ledger entry.
  api.post('/api/redemptions/:id/cancel', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'redemption not found' })
    try {
      return { redemption: presentRedemption(await cancelRedemption(tenant, id)) }
    } catch (error) {
      return correctionError(error, res)
    }
  }))

  api.post('/api/redemptions/:id/refund', choresCapRoute('reward.correct', async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'redemption not found' })
    const body = (req.body ?? {}) as { reason?: string; idempotencyKey?: string }
    const reason = body.reason?.trim() ?? ''
    if (reason.length < 3 || reason.length > 500) {
      return res.status(400).json({ error: 'BadRequest', message: 'reason must be between 3 and 500 characters' })
    }
    const idempotencyKey = body.idempotencyKey?.trim() ?? ''
    if (!UUID_RE.test(idempotencyKey)) {
      return res.status(400).json({ error: 'BadRequest', message: 'valid idempotencyKey required' })
    }
    try {
      const result = await refundRedemption(tenant, id, reason, idempotencyKey)
      return { redemption: presentRedemption(result.redemption), correction: result.correction }
    } catch (error) {
      return correctionError(error, res)
    }
  }))

  async function decide(tenant: Tenant, req: Request, res: Response, approve: boolean) {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'redemption not found' })
    const result = await decideRedemption(tenant, id, approve)
    if (result === null) return res.status(404).json({ error: 'NotFound', message: 'redemption not found' })
    if ('error' in result) return res.status(409).json({ error: 'Conflict', message: result.error })
    return res.status(200).json({ redemption: presentRedemption(result.redemption) })
  }

  function correctionError(error: unknown, res: Response) {
    if (!(error instanceof LedgerCorrectionError)) throw error
    const code = error.statusCode === 404 ? 'NotFound' : error.statusCode === 409 ? 'Conflict' : 'BadRequest'
    return res.status(error.statusCode).json({ error: code, message: error.message })
  }

  // Register the reward capture target (Tier 2 mutate: redeem) into the capture
  // registry so /api/capture/{resolve,commit} can dispatch to it.
  registerRewardCaptureTarget()
}
