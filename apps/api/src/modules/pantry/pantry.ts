// Pantry module — on-hand food inventory (REST-only; gated behind the optional
// `pantry` module). Items carry a free-text amount + unit (like ingredients), a
// location, and an optional expiry. The per-household location list lives in
// households.settings.pantry.locations.
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from '../../platform/db'
import { tenantRoute } from '../../platform/route-guards'
import { moduleEnabled } from '../../platform/modules'
import { AuthError } from '../../platform/auth'
import type { Tenant } from '../households/households'
import { lookupBarcode } from './off'

type Api = ReturnType<typeof createAPI>
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DEFAULT_LOCATIONS = ['Freezer', 'Fridge', 'Pantry']
// The allergens a household can flag to "avoid" (the GF-rule warning set). The
// canonical keys match off.ts's normalized allergens.
const ALLERGEN_KEYS = ['gluten', 'milk', 'soy', 'egg', 'peanut', 'tree_nut', 'fish', 'shellfish', 'sesame']

interface PantryRow {
  id: string
  name: string
  amount: string | null
  unit: string | null
  location: string
  expires_on: string | null
  note: string | null
  used_up_at: string | null
  barcode: string | null
  brand: string | null
  image_url: string | null
  quantity_text: string | null
  serving_basis: string | null
  nutrition: Record<string, number> | null
  allergens: string[] | null
  dietary: string[] | null
  source: string | null
  created_at: string
}

const RETURNING = `id, name, amount, unit, location, expires_on::text as expires_on, note, used_up_at::text as used_up_at,
  barcode, brand, image_url, quantity_text, serving_basis, nutrition, allergens, dietary, source, created_at::text as created_at`

function present(r: PantryRow) {
  return {
    id: r.id,
    name: r.name,
    amount: r.amount ?? '',
    unit: r.unit ?? '',
    location: r.location,
    expiresOn: r.expires_on,
    note: r.note ?? '',
    usedUp: !!r.used_up_at,
    // OFF snapshot (null when the item was added manually without a lookup).
    barcode: r.barcode,
    brand: r.brand,
    imageUrl: r.image_url,
    quantityText: r.quantity_text,
    servingBasis: r.serving_basis,
    nutrition: r.nutrition,
    allergens: r.allergens,
    dietary: r.dietary,
    source: r.source,
    createdAt: r.created_at,
  }
}

// Pull the OFF snapshot fields off a request body (shared by create + update). Each
// is optional; arrays/objects are stored as-is, blanks become null.
type OffPatch = { col: string; val: unknown }
function offPatches(b: Record<string, unknown>, opts: { includeUnset?: boolean } = {}): OffPatch[] {
  const out: OffPatch[] = []
  const strField = (key: string, col: string) => {
    if (key in b || opts.includeUnset) out.push({ col, val: b[key] != null && String(b[key]).trim() ? String(b[key]).trim() : null })
  }
  strField('barcode', 'barcode')
  strField('brand', 'brand')
  strField('imageUrl', 'image_url')
  strField('quantityText', 'quantity_text')
  strField('servingBasis', 'serving_basis')
  if ('nutrition' in b) out.push({ col: 'nutrition', val: b.nutrition && typeof b.nutrition === 'object' ? JSON.stringify(b.nutrition) : null })
  if ('allergens' in b) out.push({ col: 'allergens', val: Array.isArray(b.allergens) ? (b.allergens as unknown[]).map(String) : null })
  if ('dietary' in b) out.push({ col: 'dietary', val: Array.isArray(b.dietary) ? (b.dietary as unknown[]).map(String) : null })
  strField('source', 'source')
  return out
}

// Module gate: 403 unless the household has the pantry module enabled.
async function requirePantry(tenant: Tenant): Promise<unknown> {
  const { rows } = await query<{ settings: unknown }>(`select settings from households where id = $1`, [tenant.householdId])
  const settings = rows[0]?.settings
  if (!moduleEnabled(settings, 'pantry')) throw new AuthError('Pantry module is not enabled', 403)
  return settings
}

function readLocations(settings: unknown): string[] {
  const l = (settings as { pantry?: { locations?: unknown } } | null | undefined)?.pantry?.locations
  return Array.isArray(l) && l.length ? (l as unknown[]).map(String) : DEFAULT_LOCATIONS
}

// Whether the pantry shows a card on Today — default on (the glance is the point).
function readShowOnToday(settings: unknown): boolean {
  const v = (settings as { pantry?: { showOnToday?: unknown } } | null | undefined)?.pantry?.showOnToday
  return v !== false
}

// Allergens the household flags to avoid (e.g. a gluten-free home) — items that
// contain them get a red warning. Empty by default.
function readAvoidAllergens(settings: unknown): string[] {
  const v = (settings as { pantry?: { avoidAllergens?: unknown } } | null | undefined)?.pantry?.avoidAllergens
  return Array.isArray(v) ? (v as unknown[]).map(String).filter((a) => ALLERGEN_KEYS.includes(a)) : []
}

export function registerPantryRoutes(api: Api): void {
  // List all pantry items + the household's configured locations.
  api.get('/api/pantry', tenantRoute(async (tenant) => {
    const settings = await requirePantry(tenant)
    const { rows } = await query<PantryRow>(
      `select ${RETURNING}
         from pantry_items
        where household_id = $1 and deleted_at is null
        order by location, (used_up_at is not null), name`,
      [tenant.householdId]
    )
    return {
      items: rows.map(present),
      locations: readLocations(settings),
      showOnToday: readShowOnToday(settings),
      avoidAllergens: readAvoidAllergens(settings),
    }
  }))

  // Look up a barcode via Open Food Facts (cached). Returns the normalized product
  // to prefill the add/scan flow; 404 (found:false) when OFF has no such barcode.
  api.get('/api/pantry/lookup/:barcode', tenantRoute(async (tenant, req: Request, res: Response) => {
    await requirePantry(tenant)
    const barcode = String(req.params.barcode ?? '').replace(/\D/g, '')
    if (!barcode) return res.status(400).json({ error: 'BadRequest', message: 'barcode required' })
    let product
    try {
      product = await lookupBarcode(barcode)
    } catch {
      return res.status(502).json({ error: 'LookupFailed', message: 'Open Food Facts is unreachable — add it manually.' })
    }
    if (!product) return res.status(404).json({ found: false, barcode })
    return { found: true, product }
  }))

  // Add an item (any member — collaborative, like lists).
  api.post('/api/pantry', tenantRoute(async (tenant, req: Request, res: Response) => {
    await requirePantry(tenant)
    const b = (req.body ?? {}) as Record<string, unknown>
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) return res.status(400).json({ error: 'BadRequest', message: 'name is required' })
    if (b.expiresOn != null && b.expiresOn !== '' && !DATE_RE.test(String(b.expiresOn))) {
      return res.status(400).json({ error: 'BadRequest', message: 'expiresOn must be YYYY-MM-DD' })
    }
    const cols = ['household_id', 'name', 'amount', 'unit', 'location', 'expires_on', 'note']
    const vals: unknown[] = [
      tenant.householdId,
      name,
      b.amount != null ? String(b.amount).trim() : null,
      b.unit != null ? String(b.unit).trim() : null,
      b.location != null && String(b.location).trim() ? String(b.location).trim() : 'Pantry',
      b.expiresOn ? String(b.expiresOn) : null,
      b.note != null ? String(b.note).trim() : null,
    ]
    // OFF snapshot (barcode/brand/nutrition/allergens/…) when added via a lookup.
    for (const p of offPatches(b)) { cols.push(p.col); vals.push(p.val) }
    const placeholders = vals.map((_, idx) => `$${idx + 1}${cols[idx] === 'nutrition' ? '::jsonb' : ''}`)
    const { rows } = await query<PantryRow>(
      `insert into pantry_items (${cols.join(', ')}) values (${placeholders.join(', ')}) returning ${RETURNING}`,
      vals
    )
    return res.status(201).json({ item: present(rows[0]) })
  }))

  // Update an item.
  api.patch('/api/pantry/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    await requirePantry(tenant)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'item not found' })
    const b = (req.body ?? {}) as Record<string, unknown>
    if (b.expiresOn != null && b.expiresOn !== '' && !DATE_RE.test(String(b.expiresOn))) {
      return res.status(400).json({ error: 'BadRequest', message: 'expiresOn must be YYYY-MM-DD' })
    }
    const cols: string[] = []
    const vals: unknown[] = []
    let i = 1
    const set = (col: string, v: unknown) => { cols.push(`${col} = $${i++}`); vals.push(v) }
    if (typeof b.name === 'string') { if (!b.name.trim()) return res.status(400).json({ error: 'BadRequest', message: 'name cannot be empty' }); set('name', b.name.trim()) }
    if ('amount' in b) set('amount', b.amount != null ? String(b.amount).trim() : null)
    if ('unit' in b) set('unit', b.unit != null ? String(b.unit).trim() : null)
    if (typeof b.location === 'string' && b.location.trim()) set('location', b.location.trim())
    if ('expiresOn' in b) set('expires_on', b.expiresOn ? String(b.expiresOn) : null)
    if ('note' in b) set('note', b.note != null ? String(b.note).trim() : null)
    // OFF snapshot edits (relink a barcode, replace the photo, refresh nutrition).
    for (const p of offPatches(b)) {
      if (p.col === 'nutrition') { cols.push(`nutrition = $${i++}::jsonb`); vals.push(p.val) }
      else set(p.col, p.val)
    }
    // "Used up" is a soft, recoverable state (distinct from delete). The timestamp
    // is set/cleared server-side, so it takes no bind param.
    if (typeof b.usedUp === 'boolean') cols.push(b.usedUp ? 'used_up_at = now()' : 'used_up_at = null')
    if (cols.length === 0) return res.status(400).json({ error: 'BadRequest', message: 'no updatable fields provided' })
    vals.push(tenant.householdId, id)
    const { rows } = await query<PantryRow>(
      `update pantry_items set ${cols.join(', ')}
        where household_id = $${i++} and id = $${i} and deleted_at is null
        returning ${RETURNING}`,
      vals
    )
    if (!rows[0]) return res.status(404).json({ error: 'NotFound', message: 'item not found' })
    return { item: present(rows[0]) }
  }))

  // Soft-delete an item.
  api.delete('/api/pantry/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    await requirePantry(tenant)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'item not found' })
    const { rowCount } = await query(
      `update pantry_items set deleted_at = now() where household_id = $1 and id = $2 and deleted_at is null`,
      [tenant.householdId, id]
    )
    if (!rowCount) return res.status(404).json({ error: 'NotFound', message: 'item not found' })
    return res.status(204).send('')
  }))

  // Update the pantry module's per-household config (any member): the location list
  // and/or whether it shows a Today card. Both live in settings.pantry.
  api.put('/api/pantry/config', tenantRoute(async (tenant, req: Request, res: Response) => {
    await requirePantry(tenant)
    const b = (req.body ?? {}) as { locations?: unknown; showOnToday?: unknown; avoidAllergens?: unknown }
    const merge: Record<string, unknown> = {}
    if (Array.isArray(b.avoidAllergens)) {
      // Keep only known allergen keys, deduped.
      merge.avoidAllergens = Array.from(new Set((b.avoidAllergens as unknown[]).map(String).filter((a) => ALLERGEN_KEYS.includes(a))))
    }
    if (Array.isArray(b.locations)) {
      const seen = new Set<string>()
      const clean: string[] = []
      for (const raw of b.locations) {
        const s = String(raw).trim()
        const key = s.toLowerCase()
        if (!s || seen.has(key)) continue
        seen.add(key)
        clean.push(s)
      }
      merge.locations = clean.length ? clean : DEFAULT_LOCATIONS
    }
    if (typeof b.showOnToday === 'boolean') merge.showOnToday = b.showOnToday
    if (Object.keys(merge).length === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'provide locations, showOnToday, and/or avoidAllergens' })
    }
    // Nested merge (jsonb_set's 2-level path won't create a missing `pantry` parent):
    // preserve sibling settings + any other pantry keys.
    const { rows } = await query<{ settings: unknown }>(
      `update households
          set settings = coalesce(settings, '{}'::jsonb)
               || jsonb_build_object('pantry', coalesce(settings->'pantry', '{}'::jsonb) || $2::jsonb)
        where id = $1
        returning settings`,
      [tenant.householdId, JSON.stringify(merge)]
    )
    const settings = rows[0]?.settings
    return { locations: readLocations(settings), showOnToday: readShowOnToday(settings), avoidAllergens: readAvoidAllergens(settings) }
  }))
}
