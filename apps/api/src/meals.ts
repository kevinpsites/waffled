// Meals & recipes. Recipes are shared household assets; meal-plan entries (added
// in the next chunk) schedule recipes onto days and power the kiosk meal card.
import createAPI, { type Request, type Response } from 'lambda-api'
import type { QueryResultRow } from 'pg'
import { query } from './db'
import { requireTenant, requireAdmin, type Tenant } from './households'
import { completeJson } from './llm'
import { syncMealEventForEntry, removeMealEventForEntry, getMealSettings, setMealSettings, resyncMealEvents } from './meal-events'

type Api = ReturnType<typeof createAPI>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface RecipeRow extends QueryResultRow {
  id: string
  title: string
  emoji: string | null
  description: string | null
  category: string | null
  tags: string[] | null
  prep_time_minutes: number | null
  cook_time_minutes: number | null
  servings: number
  image_url: string | null
  source_name: string | null
  is_favorite: boolean
  cooked_count: number
}

export interface CreateRecipeInput {
  title: string
  emoji?: string | null
  description?: string | null
  category?: string | null
  tags?: string[] | null
  prepTimeMinutes?: number | null
  cookTimeMinutes?: number | null
  servings?: number
  imageUrl?: string | null
  sourceName?: string | null
  sourceUrl?: string | null
}

export async function createRecipe(tenant: Tenant, input: CreateRecipeInput): Promise<RecipeRow> {
  const { rows } = await query<RecipeRow>(
    `insert into recipes
       (household_id, title, emoji, description, category, tags,
        prep_time_minutes, cook_time_minutes, servings, image_url, source_name, source_url)
     values ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9,4), $10,$11,$12)
     returning *`,
    [
      tenant.householdId,
      input.title,
      input.emoji ?? null,
      input.description ?? null,
      input.category ?? null,
      input.tags ?? null,
      input.prepTimeMinutes ?? null,
      input.cookTimeMinutes ?? null,
      input.servings ?? null,
      input.imageUrl ?? null,
      input.sourceName ?? null,
      input.sourceUrl ?? null,
    ]
  )
  return rows[0]
}

export async function listRecipes(householdId: string): Promise<RecipeRow[]> {
  const { rows } = await query<RecipeRow>(
    `select * from recipes where household_id = $1 and deleted_at is null order by title`,
    [householdId]
  )
  return rows
}

export async function getRecipe(householdId: string, id: string): Promise<RecipeRow | null> {
  const { rows } = await query<RecipeRow>(
    `select * from recipes where household_id = $1 and id = $2 and deleted_at is null`,
    [householdId, id]
  )
  return rows[0] ?? null
}

export interface RecipeIngredientRow extends QueryResultRow {
  id: string
  name: string
  amount: string | null
  unit: string | null
  prep_note: string | null
  display: string | null
  section: string | null
  sort_order: number | null
}

export interface IngredientInput {
  name: string
  amount?: number | null
  unit?: string | null
  prepNote?: string | null
  display?: string | null
  section?: string | null
  sortOrder?: number | null
}

export async function addIngredients(
  tenant: Tenant,
  recipeId: string,
  items: IngredientInput[]
): Promise<RecipeIngredientRow[]> {
  const out: RecipeIngredientRow[] = []
  for (const [i, it] of items.entries()) {
    const { rows } = await query<RecipeIngredientRow>(
      `insert into recipe_ingredients
         (household_id, recipe_id, name, amount, unit, prep_note, display, section, sort_order)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [
        tenant.householdId,
        recipeId,
        it.name,
        it.amount ?? null,
        it.unit ?? null,
        it.prepNote ?? null,
        it.display ?? null,
        it.section ?? null,
        it.sortOrder ?? i,
      ]
    )
    out.push(rows[0])
  }
  return out
}

export async function listIngredients(
  householdId: string,
  recipeId: string
): Promise<RecipeIngredientRow[]> {
  const { rows } = await query<RecipeIngredientRow>(
    `select * from recipe_ingredients
       where household_id = $1 and recipe_id = $2 and deleted_at is null
       order by sort_order nulls last, created_at`,
    [householdId, recipeId]
  )
  return rows
}

export function presentIngredient(i: RecipeIngredientRow) {
  return {
    id: i.id,
    name: i.name,
    amount: i.amount == null ? null : Number(i.amount),
    unit: i.unit,
    prepNote: i.prep_note,
    display: i.display,
    section: i.section,
    aisle: (i as { aisle?: string | null }).aisle ?? null,
    isStaple: (i as { is_staple?: boolean }).is_staple ?? false,
    sortOrder: i.sort_order,
  }
}

export async function listSteps(
  householdId: string,
  recipeId: string
): Promise<Array<{ stepNumber: number; instruction: string; ingredients: string[] }>> {
  const { rows } = await query<{ step_number: number; instruction: string; ingredients: string[] | null }>(
    `select step_number, instruction, ingredients from recipe_steps
       where household_id = $1 and recipe_id = $2 and deleted_at is null
       order by step_number`,
    [householdId, recipeId]
  )
  return rows.map((r) => ({ stepNumber: r.step_number, instruction: r.instruction, ingredients: r.ingredients ?? [] }))
}

export interface RecipeOverrides {
  meta?: Partial<Record<'mealType' | 'protein' | 'base' | 'cuisine' | 'effort' | 'cookMethod' | 'flavorProfile', string>>
  dietary?: string[]
  addedTags?: string[]
  removedTags?: string[]
  subs?: Record<string, string>
  stepNotes?: Record<string, string>
}

export function getOverrides(r: RecipeRow): RecipeOverrides {
  return ((r as { overrides?: unknown }).overrides ?? {}) as RecipeOverrides
}

// Merge user overrides over the markdown source — overrides win, so in-app edits
// survive a re-import (which only rewrites the source columns).
export function presentRecipe(r: RecipeRow) {
  const ov = getOverrides(r)
  const m = ov.meta ?? {}
  const src = r as Record<string, unknown>
  const sourceTags = (r.tags ?? []) as string[]
  const removed = new Set((ov.removedTags ?? []).map((t) => t.toLowerCase()))
  return {
    id: r.id,
    title: r.title,
    emoji: r.emoji,
    description: r.description,
    category: r.category,
    tags: [...new Set([...sourceTags, ...(ov.addedTags ?? [])])].filter((t) => !removed.has(t.toLowerCase())),
    prepTimeMinutes: r.prep_time_minutes,
    cookTimeMinutes: r.cook_time_minutes,
    servings: r.servings,
    imageUrl: r.image_url,
    sourceName: r.source_name,
    isFavorite: r.is_favorite,
    cookedCount: r.cooked_count,
    lastCookedAt: (src.last_cooked_at as string | null) ?? null,
    // metadata: override ?? markdown source
    mealType: m.mealType ?? (src.meal_type as string | null) ?? null,
    protein: m.protein ?? (src.protein as string | null) ?? null,
    base: m.base ?? (src.base as string | null) ?? null,
    cuisine: m.cuisine ?? (src.cuisine as string | null) ?? null,
    effort: m.effort ?? (src.effort as string | null) ?? null,
    cookMethod: m.cookMethod ?? (src.cook_method as string | null) ?? null,
    flavorProfile: m.flavorProfile ?? (src.flavor_profile as string | null) ?? null,
    dietary: ov.dietary ?? (src.dietary as string[] | null) ?? [],
    vegetables: (src.vegetables as string[] | null) ?? [],
    collection: (src.collection as string | null) ?? null,
    notes: (src.notes as string | null) ?? null,
    userNotes: (src.user_notes as string | null) ?? null,
    addedTags: ov.addedTags ?? [],
    overrides: ov,
  }
}

const MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner', 'snack'])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function todayDate(): string {
  return new Date().toISOString().slice(0, 10)
}

interface PlanRow extends QueryResultRow {
  id: string
}

async function getOrCreateActivePlan(tenant: Tenant): Promise<PlanRow> {
  const found = await query<PlanRow>(
    `select * from meal_plans where household_id=$1 and status='active' and deleted_at is null
     order by created_at limit 1`,
    [tenant.householdId]
  )
  if (found.rows[0]) return found.rows[0]
  const created = await query<PlanRow>(
    `insert into meal_plans (household_id, start_date, end_date, created_by)
     values ($1, current_date, current_date + 6, $2) returning *`,
    [tenant.householdId, tenant.personId]
  )
  return created.rows[0]
}

interface EntryRow extends QueryResultRow {
  id: string
  date: string
  meal_type: string
  recipe_id: string | null
  title: string | null
  cook_person_id: string | null
}

async function upsertEntry(
  planId: string,
  tenant: Tenant,
  input: { date: string; mealType: string; recipeId: string | null; title: string | null; cookPersonId: string | null }
): Promise<EntryRow> {
  const { rows } = await query<EntryRow>(
    `insert into meal_plan_entries (household_id, meal_plan_id, date, meal_type, recipe_id, title, cook_person_id)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (meal_plan_id, date, meal_type)
     do update set recipe_id = excluded.recipe_id, title = excluded.title,
                   cook_person_id = excluded.cook_person_id, deleted_at = null
     returning id, to_char(date,'YYYY-MM-DD') as date, meal_type, recipe_id, title, cook_person_id`,
    [tenant.householdId, planId, input.date, input.mealType, input.recipeId, input.title, input.cookPersonId]
  )
  return rows[0]
}

// Soft-clear a slot in the active plan. Returns true if a row was cleared.
async function clearEntry(tenant: Tenant, date: string, mealType: string): Promise<boolean> {
  const { rowCount } = await query(
    `update meal_plan_entries set deleted_at = now()
       where household_id = $1 and date = $2 and meal_type = $3 and deleted_at is null`,
    [tenant.householdId, date, mealType]
  )
  return (rowCount ?? 0) > 0
}

interface WeekEntryRow extends QueryResultRow {
  id: string
  date: string
  meal_type: string
  title: string | null
  recipe_id: string | null
  recipe_title: string | null
  recipe_emoji: string | null
  prep_time_minutes: number | null
  cook_time_minutes: number | null
  servings: number | null
  image_url: string | null
  category: string | null
  cook_person_id: string | null
  cook_name: string | null
  cook_avatar: string | null
  cook_color: string | null
}

async function weekEntries(householdId: string, start: string) {
  const { rows } = await query<WeekEntryRow>(
    `select mpe.id, to_char(mpe.date,'YYYY-MM-DD') as date, mpe.meal_type, mpe.title, mpe.recipe_id,
            r.title as recipe_title, r.emoji as recipe_emoji, r.category,
            r.prep_time_minutes, r.cook_time_minutes, r.servings, r.image_url,
            mpe.cook_person_id, p.name as cook_name, p.avatar_emoji as cook_avatar, p.color_hex as cook_color
       from meal_plan_entries mpe
       left join recipes r on r.id = mpe.recipe_id and r.deleted_at is null
       left join persons p on p.id = mpe.cook_person_id and p.deleted_at is null
      where mpe.household_id = $1 and mpe.deleted_at is null
        and mpe.date >= $2::date and mpe.date < ($2::date + 7)
      order by mpe.date, mpe.meal_type`,
    [householdId, start]
  )
  return rows.map((e) => ({
    id: e.id,
    date: e.date,
    mealType: e.meal_type,
    title: e.title,
    recipeId: e.recipe_id,
    cook: e.cook_person_id
      ? { personId: e.cook_person_id, name: e.cook_name, avatarEmoji: e.cook_avatar, colorHex: e.cook_color }
      : null,
    recipe: e.recipe_id
      ? {
          title: e.recipe_title,
          emoji: e.recipe_emoji,
          category: e.category,
          prepTimeMinutes: e.prep_time_minutes,
          cookTimeMinutes: e.cook_time_minutes,
          servings: e.servings,
          imageUrl: e.image_url,
        }
      : null,
  }))
}

function presentEntry(e: EntryRow) {
  return {
    id: e.id,
    date: e.date,
    mealType: e.meal_type,
    recipeId: e.recipe_id,
    title: e.title,
    cookPersonId: e.cook_person_id,
  }
}

// ── AI "Plan my week" (6.3) ──────────────────────────────────────────────────
// Draft a meal for each requested day from the family's "guardrails" (meal type,
// days, who's cooking for, ingredients to use up, free-text notes) + recipe library
// + dietary notes, via the household's chosen LLM (src/llm.ts). Returns rich cards
// for review (emoji, time, serves, a one-line reason) — applied via /api/meals/plan,
// never auto-saved. Supports reshuffle/swap by passing explicit dates + avoidTitles.

export interface PlanCard {
  date: string
  mealType: string
  title: string
  recipeId: string | null
  emoji: string | null
  minutes: number | null
  servings: number
  note: string | null
}

export interface PlanWeekInput {
  start: string
  mealType?: string
  dates?: string[] // specific days to fill; default = empty `mealType` slots this week
  cookingFor?: number | null
  keepInMind?: string | null
  useUp?: string[]
  avoidTitles?: string[] // steer away from these (variety / reshuffle / swap)
}

const PLAN_WEEK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD — exactly one of the requested dates' },
          title: { type: 'string', description: 'short dish name (no "for dinner")' },
          recipeId: { type: ['string', 'null'], description: 'id of a library recipe to reuse, or null for a new dish' },
          emoji: { type: ['string', 'null'], description: 'one food emoji for the dish' },
          minutes: { type: ['integer', 'null'], description: 'rough total cook time in minutes' },
          note: { type: ['string', 'null'], description: 'one very short reason (e.g. "Meatless Wednesday", "Uses chicken in freezer")' },
        },
        required: ['date', 'title'],
      },
    },
  },
  required: ['suggestions'],
}

export async function planWeek(tenant: Tenant, input: PlanWeekInput): Promise<{ start: string; mealType: string; suggestions: PlanCard[]; via: string }> {
  const start = input.start
  const mealType = input.mealType && MEAL_TYPES.has(input.mealType) ? input.mealType : 'dinner'

  const entries = await weekEntries(tenant.householdId, start)
  const filledForType = new Set<string>()
  const plannedTitles: string[] = []
  for (const e of entries) {
    const t = e.recipe?.title ?? e.title
    if (t) plannedTitles.push(t)
    if (e.mealType === mealType) filledForType.add(e.date)
  }

  // Window dates (Sun..+6 from start), then the target set.
  const base = new Date(`${start}T00:00:00Z`)
  const windowDates: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(base)
    d.setUTCDate(d.getUTCDate() + i)
    windowDates.push(d.toISOString().slice(0, 10))
  }
  const inWindow = new Set(windowDates)
  const targetDates = (input.dates && input.dates.length ? input.dates.filter((d) => inWindow.has(d)) : windowDates.filter((d) => !filledForType.has(d)))
  if (targetDates.length === 0) return { start, mealType, suggestions: [], via: 'none' }

  const recipes = await listRecipes(tenant.householdId)
  const lib = recipes.slice(0, 60).map((r) => ({ id: r.id, title: r.title, category: r.category, tags: (r.tags ?? []).slice(0, 4) }))
  const recipeById = new Map(recipes.map((r) => [r.id, r]))
  // Small models reliably echo a library title but drop the recipeId — so match
  // titles back to recipes to relink them (normalize: lowercase, alphanumeric only).
  const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const recipeByTitle = new Map(recipes.map((r) => [normTitle(r.title), r]))
  const { rows: people } = await query<{ name: string; dietary_notes: string | null }>(
    `select name, dietary_notes from persons where household_id = $1 and deleted_at is null order by sort_order, created_at`,
    [tenant.householdId]
  )
  const dietary = people.filter((p) => p.dietary_notes?.trim()).map((p) => `${p.name}: ${p.dietary_notes!.trim()}`)
  const servings = input.cookingFor && input.cookingFor > 0 ? input.cookingFor : Math.max(1, people.length)

  const dayLabel = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
  const system = [
    `You plan family ${mealType.toUpperCase()}S for a household meal planner — cooking for ${servings}.`,
    'Propose exactly one dish for EACH requested date. Vary the cuisine and do not repeat a dish already planned or listed to avoid.',
    "Prefer reusing a recipe from the family's library when it fits (return its recipeId); otherwise suggest a new dish with a short title and recipeId null.",
    'If ingredients are listed to "use up", try to feature them. Honor every dietary note and any "keep in mind" guidance (e.g. busy nights → quick meals).',
    'Give each a single food emoji, a rough total time in minutes, and ONE very short reason. Keep titles short. Return JSON only.',
  ].join('\n')
  const user = JSON.stringify({
    mealType,
    cookingFor: servings,
    datesToPlan: targetDates.map((d) => ({ date: d, day: dayLabel(d) })),
    useUpFirst: input.useUp ?? [],
    keepInMind: input.keepInMind ?? '',
    dietaryNotes: dietary,
    alreadyPlannedThisWeek: plannedTitles,
    avoid: input.avoidTitles ?? [],
    recipeLibrary: lib,
  })

  const { data, via } = await completeJson(tenant.householdId, {
    system,
    user,
    schema: PLAN_WEEK_SCHEMA,
    schemaName: 'meal_plan',
    maxTokens: 1200,
    timeoutMs: 120_000, // multi-dish draft on a local model can be slow (cold load)
  })

  const rawList = ((data as { suggestions?: unknown[] })?.suggestions ?? []) as Array<Record<string, unknown>>
  const libIds = new Set(lib.map((r) => r.id))
  const wanted = new Set(targetDates)
  const seen = new Set<string>()
  const suggestions: PlanCard[] = []
  for (const s of rawList) {
    const date = String(s.date ?? '')
    const title = String(s.title ?? '').trim()
    if (!wanted.has(date) || seen.has(date) || !title) continue // only requested days, once each
    seen.add(date)
    // Resolve to a library recipe by id, else by matching title — so a dish the
    // model copied from the library gets linked (viewable) even with a null id.
    let recipe = typeof s.recipeId === 'string' && libIds.has(s.recipeId) ? recipeById.get(s.recipeId) : undefined
    if (!recipe) recipe = recipeByTitle.get(normTitle(title))
    const finalTitle = recipe ? recipe.title : title
    // Prefer the library recipe's own emoji/time when it's one of ours.
    const emoji = recipe?.emoji ?? (typeof s.emoji === 'string' && s.emoji ? s.emoji : null)
    const minutes = recipe?.cook_time_minutes ?? (typeof s.minutes === 'number' ? Math.round(s.minutes) : null)
    suggestions.push({ date, mealType, title: finalTitle, recipeId: recipe?.id ?? null, emoji, minutes, servings, note: typeof s.note === 'string' ? s.note : null })
  }
  suggestions.sort((a, b) => (a.date < b.date ? -1 : 1))
  return { start, mealType, suggestions, via }
}

export function registerMealRoutes(api: Api): void {
  api.post('/api/recipes', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const body = (req.body ?? {}) as Partial<CreateRecipeInput>
    if (!body.title || !body.title.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'title is required' })
    }
    const recipe = await createRecipe(tenant, { ...body, title: body.title.trim() } as CreateRecipeInput)
    return res.status(201).json({ recipe: presentRecipe(recipe) })
  })

  api.get('/api/recipes', async (req: Request) => {
    const tenant = await requireTenant(req)
    const recipes = await listRecipes(tenant.householdId)
    return { recipes: recipes.map(presentRecipe) }
  })

  api.get('/api/recipes/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    const recipe = await getRecipe(tenant.householdId, id)
    if (!recipe) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    const ov = getOverrides(recipe)
    const subs = ov.subs ?? {}
    const stepNotes = ov.stepNotes ?? {}
    const ingredients = (await listIngredients(tenant.householdId, id)).map((i) => ({
      ...presentIngredient(i),
      sub: subs[i.name.trim().toLowerCase()] ?? null,
    }))
    const steps = (await listSteps(tenant.householdId, id)).map((s) => ({
      ...s,
      note: stepNotes[String(s.stepNumber)] ?? null,
    }))
    return { recipe: presentRecipe(recipe), ingredients, steps }
  })

  // Update a recipe (favorite toggle, rename, …).
  api.patch('/api/recipes/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    const body = (req.body ?? {}) as { isFavorite?: boolean; title?: string; rating?: number; userNotes?: string; overrides?: RecipeOverrides }
    const cols: string[] = []
    const vals: unknown[] = []
    let i = 1
    if (typeof body.isFavorite === 'boolean') { cols.push(`is_favorite = $${i++}`); vals.push(body.isFavorite) }
    if (typeof body.title === 'string' && body.title.trim()) { cols.push(`title = $${i++}`); vals.push(body.title.trim()) }
    if (typeof body.rating === 'number') { cols.push(`rating = $${i++}`); vals.push(body.rating) }
    if (typeof body.userNotes === 'string') { cols.push(`user_notes = $${i++}`); vals.push(body.userNotes.trim() || null) }
    if (body.overrides && typeof body.overrides === 'object') { cols.push(`overrides = $${i++}`); vals.push(JSON.stringify(body.overrides)) }
    if (cols.length === 0) return res.status(400).json({ error: 'BadRequest', message: 'no updatable fields' })
    vals.push(tenant.householdId, id)
    const { rows } = await query<RecipeRow>(
      `update recipes set ${cols.join(', ')} where household_id = $${i++} and id = $${i} and deleted_at is null returning *`,
      vals
    )
    if (!rows[0]) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    return { recipe: presentRecipe(rows[0]) }
  })

  // Mark a recipe cooked — bumps cooked_count + last_cooked_at (powers "recently
  // cooked" sort + the "cooked N×" badge).
  api.post('/api/recipes/:id/cooked', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    const { rows } = await query<RecipeRow>(
      `update recipes set cooked_count = cooked_count + 1, last_cooked_at = now()
         where household_id = $1 and id = $2 and deleted_at is null returning *`,
      [tenant.householdId, id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    return { recipe: presentRecipe(rows[0]) }
  })

  // Add ingredients to a recipe (bulk).
  api.post('/api/recipes/:id/ingredients', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    const recipe = await getRecipe(tenant.householdId, id)
    if (!recipe) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })

    const body = (req.body ?? {}) as { ingredients?: IngredientInput[] }
    if (!Array.isArray(body.ingredients) || body.ingredients.length === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'ingredients array is required' })
    }
    if (body.ingredients.some((i) => !i?.name || !String(i.name).trim())) {
      return res.status(400).json({ error: 'BadRequest', message: 'every ingredient needs a name' })
    }
    const added = await addIngredients(tenant, id, body.ingredients)
    return res.status(201).json({ ingredients: added.map(presentIngredient) })
  })

  // Plan (or re-plan) a meal slot. Assigns a recipe or free-text title (and
  // optionally who's cooking). Powers the Meals-screen "+" picker.
  api.post('/api/meals/plan', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const body = (req.body ?? {}) as {
      date?: string
      mealType?: string
      recipeId?: string
      title?: string
      cookPersonId?: string
    }
    if (!body.date || !DATE_RE.test(body.date) || !body.mealType || !MEAL_TYPES.has(body.mealType)) {
      return res
        .status(400)
        .json({ error: 'BadRequest', message: 'date (YYYY-MM-DD) and mealType are required' })
    }
    // recipeId is optional (null = leftovers/takeout); reject a malformed one.
    let recipeId: string | null = null
    if (body.recipeId != null && body.recipeId !== '') {
      if (!UUID_RE.test(body.recipeId)) {
        return res.status(400).json({ error: 'BadRequest', message: 'recipeId must be a uuid' })
      }
      recipeId = body.recipeId
    }
    let cookPersonId: string | null = null
    if (body.cookPersonId != null && body.cookPersonId !== '') {
      if (!UUID_RE.test(body.cookPersonId)) {
        return res.status(400).json({ error: 'BadRequest', message: 'cookPersonId must be a uuid' })
      }
      cookPersonId = body.cookPersonId
    }
    const plan = await getOrCreateActivePlan(tenant)
    const entry = await upsertEntry(plan.id, tenant, {
      date: body.date,
      mealType: body.mealType,
      recipeId,
      title: body.title ?? null,
      cookPersonId,
    })
    // Mirror the meal onto the calendar (and Google, if opted in). Never fail the
    // plan write if the calendar sync hiccups.
    await syncMealEventForEntry(tenant, entry.id).catch((err) => console.error('meal event sync failed', err))
    return res.status(200).json({ entry: presentEntry(entry) })
  })

  // Clear a planned slot (date + mealType). Idempotent: 404 if nothing planned.
  api.delete('/api/meals/plan', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const date = typeof req.query?.date === 'string' ? req.query.date : ''
    const mealType = typeof req.query?.mealType === 'string' ? req.query.mealType : ''
    if (!DATE_RE.test(date) || !MEAL_TYPES.has(mealType)) {
      return res
        .status(400)
        .json({ error: 'BadRequest', message: 'date (YYYY-MM-DD) and mealType are required' })
    }
    // Drop the linked calendar event before clearing the slot.
    const existing = await query<{ id: string }>(
      `select id from meal_plan_entries where household_id=$1 and date=$2 and meal_type=$3 and deleted_at is null`,
      [tenant.householdId, date, mealType]
    )
    if (existing.rows[0]) await removeMealEventForEntry(tenant.householdId, existing.rows[0].id).catch((err) => console.error('meal event remove failed', err))
    const cleared = await clearEntry(tenant, date, mealType)
    if (!cleared) return res.status(404).json({ error: 'NotFound', message: 'nothing planned in that slot' })
    return res.status(204).send('')
  })

  // Meals → calendar settings (per household): whether meals appear on the
  // calendar, whether they push to Google, whose calendar, who's invited, and the
  // time each meal type lands at.
  api.get('/api/meals/calendar-settings', async (req: Request) => {
    const tenant = await requireTenant(req)
    return { settings: await getMealSettings(tenant.householdId) }
  })

  api.put('/api/meals/calendar-settings', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const b = (req.body ?? {}) as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    if (typeof b.addToCalendar === 'boolean') patch.addToCalendar = b.addToCalendar
    if (typeof b.pushToGoogle === 'boolean') patch.pushToGoogle = b.pushToGoogle
    if (b.calendarPersonId === null || (typeof b.calendarPersonId === 'string' && UUID_RE.test(b.calendarPersonId))) patch.calendarPersonId = b.calendarPersonId
    if (b.participantIds === null || (Array.isArray(b.participantIds) && b.participantIds.every((p) => typeof p === 'string' && UUID_RE.test(p)))) patch.participantIds = b.participantIds
    if (b.times && typeof b.times === 'object') {
      const t: Record<string, string> = {}
      for (const [k, v] of Object.entries(b.times as Record<string, unknown>)) {
        if (MEAL_TYPES.has(k) && typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)) t[k] = v
      }
      if (Object.keys(t).length) patch.times = t
    }
    if (typeof b.durationMinutes === 'number' && b.durationMinutes > 0 && b.durationMinutes <= 600) patch.durationMinutes = Math.round(b.durationMinutes)
    const settings = await setMealSettings(tenant.householdId, patch)
    // Apply the new settings to meals already on the plan.
    await resyncMealEvents(tenant).catch((err) => console.error('meal event resync failed', err))
    return res.status(200).json({ settings })
  })

  // Resolve a planned-meal entry to its recipe — the calendar uses this to open
  // the linked recipe when a meal event is tapped.
  api.get('/api/meals/entry/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'entry not found' })
    const { rows } = await query<{ recipe_id: string | null; title: string | null }>(
      `select recipe_id, title from meal_plan_entries where household_id=$1 and id=$2 and deleted_at is null`,
      [tenant.householdId, id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'NotFound', message: 'entry not found' })
    return { recipeId: rows[0].recipe_id, title: rows[0].title }
  })

  // The planned week (entries joined to recipes) — powers the kiosk meal card.
  api.get('/api/meals/week', async (req: Request) => {
    const tenant = await requireTenant(req)
    const startParam = typeof req.query?.start === 'string' ? req.query.start : ''
    const start = DATE_RE.test(startParam) ? startParam : todayDate()
    const entries = await weekEntries(tenant.householdId, start)
    return { start, entries }
  })

  // AI "Plan my week": suggest dinners for the empty slots (review, then apply via
  // POST /api/meals/plan). 501 when no LLM provider is selected/configured.
  api.post('/api/meals/plan-week', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const b = (req.body ?? {}) as {
      start?: string
      mealType?: string
      dates?: unknown
      cookingFor?: unknown
      keepInMind?: unknown
      useUp?: unknown
      avoidTitles?: unknown
    }
    const start = typeof b.start === 'string' && DATE_RE.test(b.start) ? b.start : todayDate()
    const dates = Array.isArray(b.dates) ? b.dates.filter((d): d is string => typeof d === 'string' && DATE_RE.test(d)) : undefined
    const useUp = Array.isArray(b.useUp) ? b.useUp.filter((s): s is string => typeof s === 'string' && !!s.trim()).slice(0, 12) : undefined
    const avoidTitles = Array.isArray(b.avoidTitles) ? b.avoidTitles.filter((s): s is string => typeof s === 'string').slice(0, 40) : undefined
    try {
      return await planWeek(tenant, {
        start,
        mealType: typeof b.mealType === 'string' ? b.mealType : undefined,
        dates,
        cookingFor: typeof b.cookingFor === 'number' ? b.cookingFor : null,
        keepInMind: typeof b.keepInMind === 'string' ? b.keepInMind : null,
        useUp,
        avoidTitles,
      })
    } catch (err) {
      const message = (err as Error).message
      // No provider chosen / missing creds → 501 (UI: "pick a provider"). Runtime
      // failures (timeout, network, bad JSON) → 200 with a readable error so the UI
      // can show what actually went wrong instead of "pick a provider".
      if (/no ai provider|not configured/i.test(message)) {
        return res.status(501).json({ error: 'AIUnavailable', message })
      }
      const mealType = typeof b.mealType === 'string' ? b.mealType : 'dinner'
      return { start, mealType, suggestions: [], via: 'none', error: message }
    }
  })
}
