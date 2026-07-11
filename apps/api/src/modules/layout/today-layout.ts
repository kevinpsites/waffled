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
// Module cards (pantry, familyNight, goals) are injected on the client when their module
// is on; they must be accepted here too or saving a layout that includes one 400s.
export const TODAY_CARDS = ['agenda', 'countdowns', 'tonight', 'week', 'chores', 'grocery', 'pantry', 'familyNight', 'goals'] as const
type CardKey = (typeof TODAY_CARDS)[number]
const CARD_SET = new Set<string>(TODAY_CARDS)

// The Today grid is a fixed 3 columns on the kiosk (CSS stacks them on narrow
// screens). Layouts are always normalized to exactly 3 columns — empty columns
// are allowed and kept, so the structure stays stable across reloads.
const COLS = 3
// The built-in default arrangement (mirrors the original fixed grid).
const DEFAULT_LAYOUT: string[][] = [['agenda', 'countdowns'], ['tonight', 'week'], ['chores', 'grocery']]

// A normalized layout: the 3-column card grid plus the cards the user has
// explicitly hidden from Today. Hidden cards are kept out of the columns AND out
// of the missing-append pass, so a card the user removed stays removed (module
// cards like grocery/goals otherwise pop back on every reconcile).
export interface StoredLayout {
  cols: string[][]
  hidden: string[]
}

// Pull a clean, deduped list of known card keys out of arbitrary json.
function cleanKeys(raw: unknown, skip?: Set<string>): { keys: string[]; seen: Set<string> } {
  const keys: string[] = []
  const seen = new Set<string>()
  if (Array.isArray(raw)) {
    for (const k of raw) {
      if (typeof k === 'string' && CARD_SET.has(k) && !seen.has(k) && !skip?.has(k)) {
        seen.add(k)
        keys.push(k)
      }
    }
  }
  return { keys, seen }
}

// Coerce arbitrary stored/posted json into a clean {cols, hidden}: keep the given
// column order, drop unknown/duplicate/hidden keys, merge overflow columns into
// the last, then append any missing (not-placed, not-hidden) cards so nothing is
// lost as the card set grows. Accepts both the {cols, hidden} shape and a legacy
// bare `string[][]` (treated as no hidden cards).
export function reconcileLayout(raw: unknown): StoredLayout {
  const isTagged = !!raw && typeof raw === 'object' && !Array.isArray(raw) && 'cols' in (raw as object)
  const rawCols = isTagged ? (raw as { cols: unknown }).cols : raw
  const rawHidden = isTagged ? (raw as { hidden: unknown }).hidden : undefined

  const { keys: hidden, seen: hiddenSet } = cleanKeys(rawHidden)

  const cols: string[][] = [[], [], []]
  const seen = new Set<string>()
  if (Array.isArray(rawCols)) {
    rawCols.forEach((col, ci) => {
      if (!Array.isArray(col)) return
      const target = Math.min(ci, COLS - 1) // columns past the 3rd merge into it
      for (const key of col) {
        if (typeof key === 'string' && CARD_SET.has(key) && !seen.has(key) && !hiddenSet.has(key)) {
          seen.add(key)
          cols[target].push(key)
        }
      }
    })
  }
  // Nothing placed AND nothing hidden → built-in default (don't dump every card
  // into one column). A fully-hidden layout is legitimate, so keep it.
  if (seen.size === 0 && hidden.length === 0) return { cols: DEFAULT_LAYOUT.map((c) => [...c]), hidden: [] }
  const missing = (TODAY_CARDS as readonly string[]).filter((k) => !seen.has(k) && !hiddenSet.has(k))
  if (missing.length) cols[COLS - 1].push(...missing)
  return { cols, hidden }
}

// A POST body is a valid layout if it's a legacy array of arrays of known cards,
// or the {cols, hidden} shape with the same for `cols` and an (optional) `hidden`
// array of known cards.
function isLayoutShape(raw: unknown): boolean {
  const isTagged = !!raw && typeof raw === 'object' && !Array.isArray(raw) && 'cols' in (raw as object)
  const cols = isTagged ? (raw as { cols: unknown }).cols : raw
  const hidden = isTagged ? (raw as { hidden: unknown }).hidden : undefined
  const colsOk =
    Array.isArray(cols) &&
    cols.every((col) => Array.isArray(col) && col.every((k) => typeof k === 'string' && CARD_SET.has(k)))
  const hiddenOk =
    hidden == null ||
    (Array.isArray(hidden) && hidden.every((k) => typeof k === 'string' && CARD_SET.has(k)))
  return colsOk && hiddenOk
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
    const layout: StoredLayout = reconcileLayout(body.layout)
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
