// Read-only Mealie views: meal plan, recipe library, recipe detail and the image proxy.
import { mealieFetch, mealieFetchRaw, MealieError } from './mealie-client'
import { cacheGet } from './mealie-cache'
import type { MealieConn } from './mealie-connection'

export interface MealieEntry {
  id: number
  date: string
  entryType: string
  title: string
  recipe: { id: string; slug: string; name: string; imageUrl: string | null } | null
}

export interface MealieRecipeCard {
  id: string
  slug: string
  name: string
  imageUrl: string | null
  totalTime: string | null
  description: string | null
}

export const RECIPES_PER_PAGE = 24
const MAX_RANGE_DAYS = 62
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IMAGE_FILES: Record<string, string> = { min: 'min-original.webp', original: 'original.webp', tiny: 'tiny-original.webp' }
const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'side']

const badRequest = (m: string) => new MealieError('BadRequest', m, 400)
const imageUrlOf = (id: string, image: unknown) => (image ? `/api/mealie/images/${id}/min` : null)

interface RawRecipe {
  id: string
  slug: string
  name: string
  image?: unknown
  description?: string | null
  totalTime?: string | null
  recipeYield?: string | null
  recipeIngredient?: { title?: string | null; display?: string | null; note?: string | null }[]
  recipeInstructions?: { title?: string | null; text?: string | null }[]
}

const rankOf = (t: string) => {
  const i = MEAL_ORDER.indexOf(t)
  return i === -1 ? MEAL_ORDER.length : i
}

function dayNumber(s: string): number {
  const [y, m, d] = s.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86_400_000
}

export function parseRange(start: unknown, end: unknown): { start: string; end: string } {
  if (typeof start !== 'string' || typeof end !== 'string' || !DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw badRequest('start and end must be YYYY-MM-DD dates')
  }
  const span = dayNumber(end) - dayNumber(start)
  if (!Number.isFinite(span) || span < 0) throw badRequest('end must not be before start')
  if (span > MAX_RANGE_DAYS) throw badRequest(`The date range can be at most ${MAX_RANGE_DAYS} days`)
  return { start, end }
}

export function readMealplan(householdId: string, conn: MealieConn, range: { start: string; end: string }): Promise<{ entries: MealieEntry[] }> {
  return cacheGet(householdId, 'plan', `${range.start}|${range.end}`, async () => {
    const qs = new URLSearchParams({ start_date: range.start, end_date: range.end, perPage: '-1' })
    const page = await mealieFetch<{ items?: Record<string, unknown>[] }>(conn, `/api/households/mealplans?${qs}`)
    const entries = (page.items ?? []).map((m): MealieEntry => {
      const r = m.recipe as RawRecipe | null | undefined
      const recipe = r ? { id: r.id, slug: r.slug, name: r.name, imageUrl: imageUrlOf(r.id, r.image) } : null
      return {
        id: m.id as number,
        date: String(m.date),
        entryType: String(m.entryType),
        title: (m.title as string) || recipe?.name || '',
        recipe,
      }
    })
    entries.sort((a, b) =>
      a.date.localeCompare(b.date) ||
      rankOf(a.entryType) - rankOf(b.entryType) ||
      (rankOf(a.entryType) === MEAL_ORDER.length ? a.entryType.localeCompare(b.entryType) : 0) ||
      a.id - b.id)
    return { entries }
  })
}

export function readRecipes(householdId: string, conn: MealieConn, search: string, page: number) {
  return cacheGet(householdId, 'recipes', `${search}|${page}`, async () => {
    const qs = new URLSearchParams({ page: String(page), perPage: String(RECIPES_PER_PAGE) })
    if (search) qs.set('search', search)
    else qs.set('orderBy', 'name')
    const res = await mealieFetch<{ items?: RawRecipe[]; page?: number; total_pages?: number }>(conn, `/api/recipes?${qs}`)
    const items = (res.items ?? []).map((r): MealieRecipeCard => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      imageUrl: imageUrlOf(r.id, r.image),
      totalTime: r.totalTime ?? null,
      description: r.description ?? null,
    }))
    return { items, page: res.page ?? page, totalPages: res.total_pages ?? 1 }
  })
}

export function readRecipe(householdId: string, conn: MealieConn, slug: string) {
  return cacheGet(householdId, 'recipe', slug, async () => {
    const r = await mealieFetch<RawRecipe>(conn, `/api/recipes/${encodeURIComponent(slug)}`)
    const base = (conn.publicUrl ?? conn.baseUrl).replace(/\/+$/, '')
    return {
      recipe: {
        id: r.id,
        slug: r.slug,
        name: r.name,
        imageUrl: imageUrlOf(r.id, r.image),
        description: r.description ?? null,
        totalTime: r.totalTime ?? null,
        recipeYield: r.recipeYield ?? null,
        ingredients: (r.recipeIngredient ?? []).map((i) => ({ title: i.title || null, display: i.display ?? i.note ?? '' })),
        steps: (r.recipeInstructions ?? []).map((s) => ({ title: s.title || null, text: s.text ?? '' })),
        mealieUrl: `${base}/r/${encodeURIComponent(r.slug)}`,
      },
    }
  })
}

// Images are public in Mealie, so no token is sent. Only the whitelisted file names are requested.
export async function fetchImage(conn: MealieConn, recipeId: string, size: string): Promise<{ bytes: Buffer; contentType: string }> {
  const file = IMAGE_FILES[size]
  if (!file) throw badRequest('Unknown image size')
  if (!UUID_RE.test(recipeId)) throw badRequest('Invalid recipe id')
  const res = await mealieFetchRaw({ baseUrl: conn.baseUrl }, `/api/media/recipes/${recipeId}/images/${file}`)
  if (res.status === 404) throw new MealieError('NotFound', 'Image not found', 404)
  if (!res.ok) throw new MealieError('MealieUnavailable', "Can't reach Mealie right now.", 502)
  return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'image/webp' }
}
