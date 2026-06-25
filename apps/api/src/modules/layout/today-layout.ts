// Today dashboard layout — a family default (households.today_layout) plus an
// optional per-person override (persons.today_layout). The resolved layout the
// kiosk renders is user ?? family ?? the built-in default, always reconciled
// against the canonical card set so newly added cards appear and removed/unknown
// keys are dropped (a card is never lost or duplicated).
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from '../../platform/db'
import { requireAdmin } from '../households/households'
import { tenantRoute } from '../../platform/route-guards'

type Api = ReturnType<typeof createAPI>

// The cards that can appear on Today. Order here is the default reading order.
export const TODAY_CARDS = ['agenda', 'tonight', 'week', 'chores', 'grocery'] as const
type CardKey = (typeof TODAY_CARDS)[number]
const CARD_SET = new Set<string>(TODAY_CARDS)

// The Today grid is a fixed 3 columns on the kiosk (CSS stacks them on narrow
// screens). Layouts are always normalized to exactly 3 columns — empty columns
// are allowed and kept, so the structure stays stable across reloads.
const COLS = 3
// The built-in default arrangement (mirrors the original fixed grid).
const DEFAULT_LAYOUT: string[][] = [['agenda'], ['tonight', 'week'], ['chores', 'grocery']]

// Coerce arbitrary stored/posted json into a clean 3-column string[][] of known
// card keys, guaranteeing every card appears exactly once: keep the given order,
// drop unknown/duplicate keys, merge any overflow columns into the last, then
// append any missing cards (so nothing is lost as the card set grows).
export function reconcileLayout(raw: unknown): string[][] {
  const out: string[][] = [[], [], []]
  const seen = new Set<string>()
  if (Array.isArray(raw)) {
    raw.forEach((col, ci) => {
      if (!Array.isArray(col)) return
      const target = Math.min(ci, COLS - 1) // columns past the 3rd merge into it
      for (const key of col) {
        if (typeof key === 'string' && CARD_SET.has(key) && !seen.has(key)) {
          seen.add(key)
          out[target].push(key)
        }
      }
    })
  }
  // Nothing usable → built-in default (don't dump every card into one column).
  if (seen.size === 0) return DEFAULT_LAYOUT.map((c) => [...c])
  const missing = (TODAY_CARDS as readonly string[]).filter((k) => !seen.has(k))
  if (missing.length) out[COLS - 1].push(...missing)
  return out
}

// A POST body is a valid layout only if it's an array of arrays of known cards.
function isLayoutShape(raw: unknown): raw is string[][] {
  return (
    Array.isArray(raw) &&
    raw.every((col) => Array.isArray(col) && col.every((k) => typeof k === 'string' && CARD_SET.has(k)))
  )
}

export function registerTodayLayoutRoutes(api: Api): void {
  // The resolved layout the kiosk renders, plus both raw tiers so the Customize
  // UI can show which is in effect and offer "reset".
  api.get('/api/today-layout', tenantRoute(async (tenant) => {
    const { rows } = await query<{ family: unknown; user: unknown }>(
      `select h.today_layout as family, p.today_layout as user
         from persons p join households h on h.id = p.household_id
        where p.id = $1`,
      [tenant.personId]
    )
    const family = rows[0]?.family ?? null
    const user = rows[0]?.user ?? null
    const source = user != null ? 'user' : family != null ? 'family' : 'default'
    const resolved = reconcileLayout(user ?? family ?? DEFAULT_LAYOUT)
    // Only admins can change what the shared kiosk shows (the family tier).
    return { resolved, family: family ?? null, user: user ?? null, source, cards: TODAY_CARDS, canEditFamily: tenant.isAdmin }
  }))

  // Save the layout to one tier. scope 'family' is admin-only (it's what the
  // shared kiosk shows); scope 'user' writes the caller's own override.
  api.put('/api/today-layout', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { scope?: unknown; layout?: unknown }
    const scope = body.scope === 'family' ? 'family' : body.scope === 'user' ? 'user' : null
    if (!scope) return res.status(400).json({ error: 'BadRequest', message: 'scope must be "user" or "family"' })
    if (!isLayoutShape(body.layout)) {
      return res.status(400).json({ error: 'BadRequest', message: 'layout must be an array of arrays of known card keys' })
    }
    const layout = reconcileLayout(body.layout)
    if (scope === 'family') {
      requireAdmin(tenant)
      await query(`update households set today_layout = $1 where id = $2`, [JSON.stringify(layout), tenant.householdId])
    } else {
      await query(`update persons set today_layout = $1 where id = $2`, [JSON.stringify(layout), tenant.personId])
    }
    return { ok: true, layout }
  }))

  // Reset a tier back to inheriting (user → family, family → built-in default).
  api.delete('/api/today-layout', tenantRoute(async (tenant, req: Request, res: Response) => {
    const scope = (req.query.scope as string) === 'family' ? 'family' : 'user'
    if (scope === 'family') {
      requireAdmin(tenant)
      await query(`update households set today_layout = null where id = $1`, [tenant.householdId])
    } else {
      await query(`update persons set today_layout = null where id = $1`, [tenant.personId])
    }
    return res.status(204).send('')
  }))
}
