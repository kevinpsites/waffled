// Currencies — the per-household reward-economy catalog (phase A). Gives each
// ledger `currency` key a label/symbol/color so the UI stops hardcoding stars and
// families can rename it or run several. The ledger stays the source of truth;
// this is presentation + the set of currencies chores/rewards can use.
import createAPI, { type Request, type Response } from 'lambda-api'
import type { QueryResultRow } from 'pg'
import { getPool, query } from '../../platform/db'
import { requireTenant, requireAdmin, type Tenant } from '../households/households'

type Api = ReturnType<typeof createAPI>
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface CurrencyRow extends QueryResultRow {
  id: string
  key: string
  label: string
  symbol: string | null
  color: string | null
  is_default: boolean
  spendable: boolean
  sort_order: number
}

export function presentCurrency(c: CurrencyRow) {
  return {
    id: c.id,
    key: c.key,
    label: c.label,
    symbol: c.symbol,
    color: c.color,
    isDefault: c.is_default,
    spendable: c.spendable,
    sortOrder: c.sort_order,
  }
}

// A household always has at least a default "Stars ⭐" (the migration backfills
// existing households; this self-heals any that slip through — e.g. brand new).
export async function ensureDefaultCurrency(householdId: string): Promise<void> {
  const { rowCount } = await query(`select 1 from currencies where household_id=$1 and deleted_at is null limit 1`, [householdId])
  if (rowCount) return
  await query(
    `insert into currencies (household_id, key, label, symbol, color, is_default, spendable, sort_order)
     values ($1, 'stars', 'Stars', '⭐', '#7A5AF8', true, true, 0)
     on conflict do nothing`,
    [householdId]
  )
}

export async function listCurrencies(householdId: string): Promise<CurrencyRow[]> {
  await ensureDefaultCurrency(householdId)
  const { rows } = await query<CurrencyRow>(
    `select * from currencies where household_id=$1 and deleted_at is null order by sort_order, created_at`,
    [householdId]
  )
  return rows
}

// The default earn currency's key — used wherever a chore/reward doesn't name one.
export async function getDefaultCurrencyKey(householdId: string): Promise<string> {
  await ensureDefaultCurrency(householdId)
  const { rows } = await query<{ key: string }>(
    `select key from currencies where household_id=$1 and deleted_at is null
      order by is_default desc, sort_order, created_at limit 1`,
    [householdId]
  )
  return rows[0]?.key ?? 'stars'
}

// Slug from a label, made unique within the household (stars, stars-2, …).
async function uniqueKey(householdId: string, label: string): Promise<string> {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'currency'
  const { rows } = await query<{ key: string }>(`select key from currencies where household_id=$1 and deleted_at is null`, [householdId])
  const taken = new Set(rows.map((r) => r.key))
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
}

export interface CreateCurrencyInput {
  label: string
  symbol?: string | null
  color?: string | null
  spendable?: boolean
  isDefault?: boolean
}

export async function createCurrency(tenant: Tenant, input: CreateCurrencyInput): Promise<CurrencyRow> {
  await ensureDefaultCurrency(tenant.householdId)
  const client = await getPool().connect()
  try {
    await client.query('begin')
    if (input.isDefault) {
      await client.query(`update currencies set is_default=false where household_id=$1 and deleted_at is null`, [tenant.householdId])
    }
    const key = await uniqueKey(tenant.householdId, input.label)
    const { rows: maxRows } = await client.query<{ m: number | null }>(
      `select max(sort_order) as m from currencies where household_id=$1 and deleted_at is null`,
      [tenant.householdId]
    )
    const sort = (maxRows[0]?.m ?? 0) + 1
    const { rows } = await client.query<CurrencyRow>(
      `insert into currencies (household_id, key, label, symbol, color, is_default, spendable, sort_order)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [tenant.householdId, key, input.label.trim(), input.symbol ?? null, input.color ?? null, input.isDefault ?? false, input.spendable ?? true, sort]
    )
    await client.query('commit')
    return rows[0]
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

const UPDATABLE: Record<string, string> = {
  label: 'label',
  symbol: 'symbol',
  color: 'color',
  spendable: 'spendable',
  sortOrder: 'sort_order',
}

export async function updateCurrency(householdId: string, id: string, patch: Record<string, unknown>): Promise<CurrencyRow | null> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    // Promoting a new default demotes the others first (one default per household).
    if (patch.isDefault === true) {
      await client.query(`update currencies set is_default=false where household_id=$1 and deleted_at is null`, [householdId])
    }
    const sets: string[] = []
    const vals: unknown[] = []
    let i = 1
    for (const [field, col] of Object.entries(UPDATABLE)) {
      if (field in patch && patch[field] !== undefined) { sets.push(`${col}=$${i++}`); vals.push(patch[field]) }
    }
    if (patch.isDefault === true) sets.push(`is_default=true`)
    if (sets.length === 0) {
      const cur = await client.query<CurrencyRow>(`select * from currencies where household_id=$1 and id=$2 and deleted_at is null`, [householdId, id])
      await client.query('commit')
      return cur.rows[0] ?? null
    }
    vals.push(householdId, id)
    const { rows } = await client.query<CurrencyRow>(
      `update currencies set ${sets.join(', ')} where household_id=$${i++} and id=$${i} and deleted_at is null returning *`,
      vals
    )
    await client.query('commit')
    return rows[0] ?? null
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Soft-delete. The default can't be removed (promote another first) and we keep at
// least one currency so the economy always has a unit.
export async function deleteCurrency(householdId: string, id: string): Promise<{ ok: boolean; error?: string }> {
  const { rows } = await query<CurrencyRow>(`select * from currencies where household_id=$1 and id=$2 and deleted_at is null`, [householdId, id])
  const cur = rows[0]
  if (!cur) return { ok: false }
  if (cur.is_default) return { ok: false, error: 'Set another currency as default before deleting this one' }
  const { rowCount } = await query(`select 1 from currencies where household_id=$1 and deleted_at is null`, [householdId])
  if ((rowCount ?? 0) <= 1) return { ok: false, error: 'A household needs at least one currency' }
  await query(`update currencies set deleted_at=now() where household_id=$1 and id=$2`, [householdId, id])
  return { ok: true }
}

export function registerCurrencyRoutes(api: Api): void {
  api.get('/api/currencies', async (req: Request) => {
    const tenant = await requireTenant(req)
    return { currencies: (await listCurrencies(tenant.householdId)).map(presentCurrency) }
  })

  api.post('/api/currencies', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const body = (req.body ?? {}) as Partial<CreateCurrencyInput>
    if (!body.label || !body.label.trim()) return res.status(400).json({ error: 'BadRequest', message: 'label is required' })
    const currency = await createCurrency(tenant, { ...body, label: body.label.trim() } as CreateCurrencyInput)
    return res.status(201).json({ currency: presentCurrency(currency) })
  })

  api.patch('/api/currencies/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'currency not found' })
    const currency = await updateCurrency(tenant.householdId, id, (req.body ?? {}) as Record<string, unknown>)
    if (!currency) return res.status(404).json({ error: 'NotFound', message: 'currency not found' })
    return { currency: presentCurrency(currency) }
  })

  api.delete('/api/currencies/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'currency not found' })
    const result = await deleteCurrency(tenant.householdId, id)
    if (!result.ok && !result.error) return res.status(404).json({ error: 'NotFound', message: 'currency not found' })
    if (!result.ok) return res.status(409).json({ error: 'Conflict', message: result.error })
    return res.status(204).send('')
  })
}
