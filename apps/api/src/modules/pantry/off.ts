// Open Food Facts integration — barcode → product, with a global cache.
//
// Strategy (per the product spec): on lookup we consult the `products` cache by
// barcode. Cached and fresh (< 90d) → serve it with no API call; if it's in the
// 30–90d "stale-while-revalidate" window we still serve it but kick a background
// refresh. Missing or > 90d → fetch from OFF synchronously, normalize, upsert.
// `not_found` is cached too (so unknown barcodes don't re-hammer OFF), and on a
// network error we fall back to whatever stale row we have. OFF's read limit is
// 15 req/min/IP, so the shared cache matters on a single-IP self-host box.
import { query } from '../../platform/db'

export const PRODUCT_TTL_DAYS = 90 // older than this → refetch before serving
export const PRODUCT_SWR_DAYS = 30 // older than this (but < TTL) → serve + refresh in background

const OFF_BASE = process.env.OFF_API_BASE || 'https://world.openfoodfacts.org'
// OFF asks every client to identify itself: "AppName/Version (contact)".
const USER_AGENT = process.env.OFF_USER_AGENT || 'Nook-SelfHosted/1.0 (https://github.com/nook)'
const OFF_TIMEOUT_MS = 8000

// OFF allergen tags (en:<x>) → our canonical set (matches the avoid-list + legend).
const ALLERGEN_MAP: Record<string, string> = {
  gluten: 'gluten',
  milk: 'milk',
  soybeans: 'soy',
  eggs: 'egg',
  peanuts: 'peanut',
  nuts: 'tree_nut',
  fish: 'fish',
  crustaceans: 'shellfish',
  molluscs: 'shellfish',
  'sesame-seeds': 'sesame',
}

export interface ProductView {
  barcode: string
  name: string | null
  brand: string | null
  imageUrl: string | null
  quantityText: string | null
  servingBasis: string | null
  nutrition: Record<string, number>
  allergens: string[]
  dietary: string[]
  nutriscore: string | null
  nova: number | null
  source: string
  fetchedAt: string
}

interface ProductRow {
  barcode: string
  name: string | null
  brand: string | null
  image_url: string | null
  quantity_text: string | null
  serving_basis: string | null
  nutrition: Record<string, number>
  allergens: string[]
  dietary: string[]
  nutriscore: string | null
  nova: number | null
  status: string
  source: string
  fetched_at: string
}

// Strip a tag's language prefix: "en:milk" → "milk".
function untag(t: string): string {
  return String(t).includes(':') ? String(t).split(':').pop()! : String(t)
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

// Map OFF's raw `product` object to our normalized shape. Prefers per-serving
// nutrition when the product declares a serving size (matches a label like
// "per pie"), otherwise per-100g.
export function normalizeOffProduct(barcode: string, p: Record<string, unknown>): ProductView {
  const brands = typeof p.brands === 'string' ? p.brands.split(',')[0].trim() : null
  const serving = typeof p.serving_size === 'string' ? p.serving_size.trim() : ''
  const per = serving ? 'serving' : '100g'
  const n = (p.nutriments ?? {}) as Record<string, unknown>
  const pick = (base: string) => num(n[`${base}_${per}`]) ?? num(n[`${base}_100g`]) ?? num(n[base])

  const nutrition: Record<string, number> = {}
  const cal = pick('energy-kcal')
  if (cal != null) nutrition.calories = Math.round(cal)
  const protein = pick('proteins'); if (protein != null) nutrition.protein_g = protein
  const fat = pick('fat'); if (fat != null) nutrition.fat_g = fat
  const carbs = pick('carbohydrates'); if (carbs != null) nutrition.carbs_g = carbs
  // OFF reports sodium in grams; the UI shows mg.
  const sodium = pick('sodium'); if (sodium != null) nutrition.sodium_mg = Math.round(sodium * 1000)

  const allergens = Array.from(
    new Set((Array.isArray(p.allergens_tags) ? p.allergens_tags : []).map((t) => ALLERGEN_MAP[untag(String(t))] ?? untag(String(t))))
  )

  const analysis = (Array.isArray(p.ingredients_analysis_tags) ? p.ingredients_analysis_tags : []).map((t) => untag(String(t)))
  const dietary: string[] = []
  if (analysis.includes('vegan')) dietary.push('vegan')
  if (analysis.includes('vegetarian')) dietary.push('vegetarian')
  if (analysis.includes('palm-oil-free')) dietary.push('palm_oil_free')

  return {
    barcode,
    name: typeof p.product_name === 'string' && p.product_name.trim() ? p.product_name.trim() : null,
    brand: brands || null,
    imageUrl: (typeof p.image_front_url === 'string' && p.image_front_url) || (typeof p.image_url === 'string' && p.image_url) || null,
    quantityText: typeof p.quantity === 'string' && p.quantity.trim() ? p.quantity.trim() : null,
    servingBasis: serving ? `per ${serving}` : 'per 100 g',
    nutrition,
    allergens,
    dietary,
    nutriscore: typeof p.nutriscore_grade === 'string' ? p.nutriscore_grade : null,
    nova: num(p.nova_group),
    source: 'openfoodfacts',
    fetchedAt: new Date().toISOString(),
  }
}

function presentRow(r: ProductRow): ProductView {
  return {
    barcode: r.barcode,
    name: r.name,
    brand: r.brand,
    imageUrl: r.image_url,
    quantityText: r.quantity_text,
    servingBasis: r.serving_basis,
    nutrition: r.nutrition ?? {},
    allergens: r.allergens ?? [],
    dietary: r.dietary ?? [],
    nutriscore: r.nutriscore,
    nova: r.nova,
    source: r.source,
    fetchedAt: r.fetched_at,
  }
}

// Raw GET against OFF (read API v3). Returns the `product` object, or null for
// not-found / errors. v3 wraps the result in a `{ result: { id }, status, product }`
// envelope (found → result.id === 'product_found'); the product fields themselves
// are the same as v2. Exported so tests can stub it (or stub global fetch).
export async function fetchFromOff(barcode: string): Promise<Record<string, unknown> | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), OFF_TIMEOUT_MS)
  try {
    const fields = 'product_name,brands,quantity,serving_size,image_url,image_front_url,allergens_tags,ingredients_analysis_tags,nutriscore_grade,nova_group,nutriments'
    const res = await fetch(`${OFF_BASE}/api/v3/product/${barcode}?fields=${fields}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const json = (await res.json()) as { result?: { id?: string }; product?: Record<string, unknown> }
    if (json.result?.id !== 'product_found' || !json.product) return null
    return json.product
  } finally {
    clearTimeout(timer)
  }
}

// Fetch from OFF + upsert the cache. Caches not-found too. Returns the view (null if
// the product isn't in OFF).
async function fetchAndStore(barcode: string): Promise<ProductView | null> {
  const raw = await fetchFromOff(barcode)
  if (!raw) {
    await query(
      `insert into products (barcode, status, fetched_at) values ($1, 'not_found', now())
       on conflict (barcode) do update set status = 'not_found', fetched_at = now()`,
      [barcode]
    )
    return null
  }
  const v = normalizeOffProduct(barcode, raw)
  await query(
    `insert into products
       (barcode, name, brand, image_url, quantity_text, serving_basis, nutrition, allergens, dietary, nutriscore, nova, raw, status, source, fetched_at)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb,'found',$13, now())
     on conflict (barcode) do update set
       name=excluded.name, brand=excluded.brand, image_url=excluded.image_url, quantity_text=excluded.quantity_text,
       serving_basis=excluded.serving_basis, nutrition=excluded.nutrition, allergens=excluded.allergens, dietary=excluded.dietary,
       nutriscore=excluded.nutriscore, nova=excluded.nova, raw=excluded.raw, status='found', source=excluded.source, fetched_at=now()`,
    [barcode, v.name, v.brand, v.imageUrl, v.quantityText, v.servingBasis, JSON.stringify(v.nutrition), v.allergens, v.dietary, v.nutriscore, v.nova, JSON.stringify(raw), v.source]
  )
  return v
}

function ageDays(fetchedAt: string): number {
  return (Date.now() - new Date(fetchedAt).getTime()) / 86_400_000
}

// The cache-aware lookup. Returns the product view, or null if OFF has no such
// barcode (cached as not_found within the TTL).
export async function lookupBarcode(rawBarcode: string): Promise<ProductView | null> {
  const barcode = String(rawBarcode).replace(/\D/g, '')
  if (!barcode) return null

  const { rows } = await query<ProductRow>('select * from products where barcode = $1', [barcode])
  const cached = rows[0]

  if (cached && ageDays(cached.fetched_at) < PRODUCT_TTL_DAYS) {
    // Fresh enough to serve. If it's in the SWR window, refresh in the background
    // (the container is long-lived, so the write lands; we don't await it).
    if (ageDays(cached.fetched_at) >= PRODUCT_SWR_DAYS) void fetchAndStore(barcode).catch(() => {})
    return cached.status === 'not_found' ? null : presentRow(cached)
  }

  // Missing or stale → refetch. On a network error, fall back to the stale row.
  try {
    return await fetchAndStore(barcode)
  } catch {
    if (cached) return cached.status === 'not_found' ? null : presentRow(cached)
    throw new Error('Open Food Facts lookup failed')
  }
}
