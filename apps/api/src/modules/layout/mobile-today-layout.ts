// Mobile Today layout — the phone counterpart to today-layout.ts. Same two-tier
// model (family default on households.today_mobile_layout + per-person override
// on persons.today_mobile_layout, resolved as user ?? family ?? built-in), but a
// mobile-specific shape: a single ordered list plus a hidden set, since the phone
// stacks cards in one column and lets you turn cards off. Always reconciled
// against the canonical card set so new cards appear (visible) and unknown keys
// are dropped — a card is never lost or duplicated.
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from '../../platform/db'
import { requireAdmin } from '../households/households'
import { tenantRoute } from '../../platform/route-guards'

type Api = ReturnType<typeof createAPI>

// The cards that can appear on the mobile Today screen, in default order. (The
// transient "review events" banner isn't here — it's pinned and auto-shown.)
export const MOBILE_TODAY_CARDS = ['agenda', 'tonight', 'chores', 'grocery', 'goals'] as const
const CARD_SET = new Set<string>(MOBILE_TODAY_CARDS)

export interface MobileLayout {
  order: string[]
  hidden: string[]
}

// Coerce arbitrary stored/posted json into a clean { order, hidden } of known
// card keys: keep the given order (deduped, known only), append any missing
// canonical cards (so new cards show up, visible by default), and keep only known
// hidden keys.
export function reconcileMobileLayout(raw: unknown): MobileLayout {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const order: string[] = []
  const seen = new Set<string>()
  if (Array.isArray(obj.order)) {
    for (const k of obj.order) {
      if (typeof k === 'string' && CARD_SET.has(k) && !seen.has(k)) {
        seen.add(k)
        order.push(k)
      }
    }
  }
  for (const k of MOBILE_TODAY_CARDS) if (!seen.has(k)) order.push(k)

  const hidden: string[] = []
  const hiddenSeen = new Set<string>()
  if (Array.isArray(obj.hidden)) {
    for (const k of obj.hidden) {
      if (typeof k === 'string' && CARD_SET.has(k) && !hiddenSeen.has(k)) {
        hiddenSeen.add(k)
        hidden.push(k)
      }
    }
  }
  return { order, hidden }
}

const DEFAULT_LAYOUT: MobileLayout = { order: [...MOBILE_TODAY_CARDS], hidden: [] }

// A POST body is a valid layout only if it's an object with an `order` array of
// known cards (and an optional `hidden` array of known cards).
function isMobileLayoutShape(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.order) || !o.order.every((k) => typeof k === 'string' && CARD_SET.has(k))) return false
  if (o.hidden != null && (!Array.isArray(o.hidden) || !o.hidden.every((k) => typeof k === 'string' && CARD_SET.has(k)))) {
    return false
  }
  return true
}

export function registerMobileTodayLayoutRoutes(api: Api): void {
  // The resolved layout the phone renders, plus both raw tiers so the Customize
  // UI can show which is in effect and offer "reset".
  api.get('/api/today-layout/mobile', tenantRoute(async (tenant) => {
    const { rows } = await query<{ family: unknown; user: unknown }>(
      `select h.today_mobile_layout as family, p.today_mobile_layout as user
         from persons p join households h on h.id = p.household_id
        where p.id = $1`,
      [tenant.personId]
    )
    const family = rows[0]?.family ?? null
    const user = rows[0]?.user ?? null
    const source = user != null ? 'user' : family != null ? 'family' : 'default'
    const resolved = reconcileMobileLayout(user ?? family ?? DEFAULT_LAYOUT)
    return { resolved, family: family ?? null, user: user ?? null, source, cards: MOBILE_TODAY_CARDS, canEditFamily: tenant.isAdmin }
  }))

  // Save the layout to one tier. scope 'family' is admin-only (the shared
  // default); scope 'user' writes the caller's own override.
  api.put('/api/today-layout/mobile', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { scope?: unknown; layout?: unknown }
    const scope = body.scope === 'family' ? 'family' : body.scope === 'user' ? 'user' : null
    if (!scope) return res.status(400).json({ error: 'BadRequest', message: 'scope must be "user" or "family"' })
    if (!isMobileLayoutShape(body.layout)) {
      return res.status(400).json({ error: 'BadRequest', message: 'layout must be { order: string[], hidden?: string[] } of known card keys' })
    }
    const layout = reconcileMobileLayout(body.layout)
    if (scope === 'family') {
      requireAdmin(tenant)
      await query(`update households set today_mobile_layout = $1 where id = $2`, [JSON.stringify(layout), tenant.householdId])
    } else {
      await query(`update persons set today_mobile_layout = $1 where id = $2`, [JSON.stringify(layout), tenant.personId])
    }
    return { ok: true, layout }
  }))

  // Reset a tier back to inheriting (user → family, family → built-in default).
  api.delete('/api/today-layout/mobile', tenantRoute(async (tenant, req: Request, res: Response) => {
    const scope = (req.query.scope as string) === 'family' ? 'family' : 'user'
    if (scope === 'family') {
      requireAdmin(tenant)
      await query(`update households set today_mobile_layout = null where id = $1`, [tenant.householdId])
    } else {
      await query(`update persons set today_mobile_layout = null where id = $1`, [tenant.personId])
    }
    return res.status(204).send('')
  }))
}
