// Meals & recipes — data access + business logic (incl. AI "Plan my week").
// Routes live in meals.routes.ts; shared types in meals.types.ts.
import type { QueryResultRow } from 'pg'
import { query } from '../../platform/db'
import { type Tenant } from '../households/households'
import { completeJson } from '../../platform/llm'
import type {
  RecipeRow,
  CreateRecipeInput,
  RecipeIngredientRow,
  IngredientInput,
  RecipeOverrides,
  PlanCard,
  PlanWeekInput,
  PlanMonthInput,
} from './meals.types'

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

export const MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner', 'snack'])
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10)
}

interface PlanRow extends QueryResultRow {
  id: string
}

export async function getOrCreateActivePlan(tenant: Tenant): Promise<PlanRow> {
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

export async function upsertEntry(
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
export async function clearEntry(tenant: Tenant, date: string, mealType: string): Promise<boolean> {
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

// `days` (default 7) is the window length — the month grid asks for ~42 days at
// once so it doesn't fan out a request per week.
export async function weekEntries(householdId: string, start: string, days = 7) {
  const span = Math.max(1, Math.min(45, Math.floor(days)))
  const { rows } = await query<WeekEntryRow>(
    `select mpe.id, to_char(mpe.date,'YYYY-MM-DD') as date, mpe.meal_type, mpe.title, mpe.recipe_id,
            r.title as recipe_title, r.emoji as recipe_emoji, r.category,
            r.prep_time_minutes, r.cook_time_minutes, r.servings, r.image_url,
            mpe.cook_person_id, p.name as cook_name, p.avatar_emoji as cook_avatar, p.color_hex as cook_color
       from meal_plan_entries mpe
       left join recipes r on r.id = mpe.recipe_id and r.deleted_at is null
       left join persons p on p.id = mpe.cook_person_id and p.deleted_at is null
      where mpe.household_id = $1 and mpe.deleted_at is null
        and mpe.date >= $2::date and mpe.date < ($2::date + $3::int)
      order by mpe.date, mpe.meal_type`,
    [householdId, start, span]
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

export function presentEntry(e: EntryRow) {
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

// ── AI "Plan my month" (rotation) ────────────────────────────────────────────
// The LLM drafts a POOL of dinners; the server lays them across the month's chosen
// nights honoring repeat gap, weekday themes, weeknight effort, and leftovers — so
// a month is one cheap LLM call (a rotation) rather than ~30 unique drafts.

// Weekday theme keys → label + an LLM hint. `special` themes consume no pool dish:
// 'takeout' becomes an eating-out night; 'leftovers' reuses the previous cook.
export const MONTH_THEMES: Record<string, { label: string; hint: string; special?: 'takeout' | 'leftovers' }> = {
  meatless: { label: 'Meatless', hint: 'vegetarian, no meat' },
  tacos: { label: 'Taco night', hint: 'tacos / Mexican' },
  pizza: { label: 'Pizza night', hint: 'pizza' },
  pasta: { label: 'Pasta night', hint: 'a pasta dish' },
  seafood: { label: 'Seafood', hint: 'fish or seafood' },
  soup: { label: 'Soup & salad', hint: 'a soup or big salad' },
  breakfast: { label: 'Breakfast for dinner', hint: 'breakfast-for-dinner' },
  grill: { label: 'Grill night', hint: 'grilled mains' },
  takeout: { label: 'Takeout', hint: '', special: 'takeout' },
  leftovers: { label: 'Leftovers', hint: '', special: 'leftovers' },
}

// Which themes a recipe fits, derived from its title/category/tags — far more
// reliable than a weak model's self-tagging (which mislabels, e.g. pasta as grill).
const THEME_RE: Record<string, RegExp> = {
  tacos: /\b(taco|burrito|enchilada|quesadilla|fajita|nacho|mexican|carnitas|al pastor)\b/i,
  pizza: /\b(pizza|flatbread|calzone)\b/i,
  pasta: /\b(pasta|spaghetti|linguine|penne|lasagn|noodle|macaroni|risotto|gnocchi|fettuccine|ravioli|orzo|carbonara|bolognese|pad thai|ramen|udon)\b/i,
  seafood: /\b(salmon|shrimp|fish|tuna|cod|crab|seafood|prawn|scallop|tilapia|halibut|mussel|clam|lobster)\b/i,
  soup: /\b(soup|stew|chili|chowder|bisque|broth)\b/i,
  breakfast: /\b(pancake|waffle|egg|omelet|omelette|frittata|breakfast|french toast|scramble|hash)\b/i,
  grill: /\b(grill|grilled|bbq|barbecue|barbeque|skewer|kebab|kabob|kabab|burger|char-?grilled)\b/i,
}
const VEG_RE = /\b(vegetarian|vegan|veggie|tofu|paneer|lentil|chickpea|falafel|halloumi|eggplant|cauliflower)\b/i

function recipeThemes(recipe: { title?: string | null; category?: string | null; tags?: string[] | null }): string[] {
  const hay = `${recipe.title ?? ''} ${recipe.category ?? ''} ${(recipe.tags ?? []).join(' ')}`
  const out = new Set<string>()
  for (const [key, re] of Object.entries(THEME_RE)) if (re.test(hay)) out.add(key)
  if (VEG_RE.test(hay) || /vegetarian|vegan/i.test(recipe.category ?? '')) out.add('meatless')
  return [...out]
}

const PLAN_MONTH_POOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pool: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'short dish name' },
          recipeId: { type: ['string', 'null'], description: 'id of a library recipe to reuse, or null' },
          emoji: { type: ['string', 'null'], description: 'one food emoji' },
          minutes: { type: ['integer', 'null'], description: 'rough total cook time' },
          effort: { type: ['string', 'null'], description: '"quick" or "involved"' },
          themes: { type: ['array', 'null'], items: { type: 'string' }, description: 'theme keys this dish fits' },
        },
        required: ['title'],
      },
    },
  },
  required: ['pool'],
}

const ymdUTC = (d: Date): string => d.toISOString().slice(0, 10)
const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

type PoolDish = { title: string; recipeId: string | null; emoji: string | null; minutes: number | null; effort: 'quick' | 'involved'; themes: string[] }

export async function planMonth(tenant: Tenant, input: PlanMonthInput): Promise<{ start: string; mealType: string; suggestions: PlanCard[]; via: string; error?: string; existing?: PlanCard[] }> {
  const mealType = 'dinner'
  const base = new Date(`${input.start}T00:00:00Z`)
  const year = base.getUTCFullYear()
  const month = base.getUTCMonth()
  const first = new Date(Date.UTC(year, month, 1))
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const monthStartStr = ymdUTC(first)

  // Existing dinners this month — fill only empty nights, and avoid repeating them.
  const entries = await weekEntries(tenant.householdId, monthStartStr, daysInMonth)
  const filled = new Set<string>()
  const plannedTitles: string[] = []
  for (const e of entries) {
    if (e.mealType !== mealType) continue
    filled.add(e.date)
    const t = e.recipe?.title ?? e.title
    if (t) plannedTitles.push(t)
  }
  // The month's already-planned dinners, surfaced so the review shows the whole
  // month (existing nights read-only) instead of just the newly-drafted ones.
  const existing: PlanCard[] = entries
    .filter((e) => e.mealType === mealType)
    .map((e) => ({
      date: e.date,
      mealType,
      title: e.recipe?.title ?? e.title ?? 'Planned',
      recipeId: e.recipeId,
      emoji: e.recipe?.emoji ?? null,
      minutes: e.recipe?.cookTimeMinutes ?? null,
      servings: e.recipe?.servings ?? (input.cookingFor && input.cookingFor > 0 ? input.cookingFor : 4),
      note: null,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))

  const weekdays = new Set(input.weekdays && input.weekdays.length ? input.weekdays : [1, 2, 3, 4, 5])
  const skip = new Set(input.skipDates ?? [])
  const themes = input.weekdayThemes ?? {}

  // Target nights: explicit dates (reshuffle) or the month's chosen weekdays minus
  // skipped/already-filled.
  let targetDates: string[]
  if (input.dates && input.dates.length) {
    targetDates = input.dates.filter((d) => new Date(`${d}T00:00:00Z`).getUTCMonth() === month)
  } else {
    targetDates = []
    for (let day = 1; day <= daysInMonth; day++) {
      const dt = new Date(Date.UTC(year, month, day))
      const iso = ymdUTC(dt)
      if (!weekdays.has(dt.getUTCDay()) || skip.has(iso) || filled.has(iso)) continue
      targetDates.push(iso)
    }
  }
  targetDates.sort()
  if (targetDates.length === 0) return { start: monthStartStr, mealType, suggestions: [], via: 'none', existing }

  const recipes = await listRecipes(tenant.householdId)
  const lib = recipes.slice(0, 60).map((r) => ({ id: r.id, title: r.title, category: r.category, tags: (r.tags ?? []).slice(0, 4), minutes: r.cook_time_minutes }))
  const recipeById = new Map(recipes.map((r) => [r.id, r]))
  const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const recipeByTitle = new Map(recipes.map((r) => [normTitle(r.title), r]))
  const { rows: people } = await query<{ name: string; dietary_notes: string | null }>(
    `select name, dietary_notes from persons where household_id = $1 and deleted_at is null order by sort_order, created_at`,
    [tenant.householdId]
  )
  const dietary = people.filter((p) => p.dietary_notes?.trim()).map((p) => `${p.name}: ${p.dietary_notes!.trim()}`)
  const servings = input.cookingFor && input.cookingFor > 0 ? input.cookingFor : Math.max(1, people.length)

  // Nights that need a real dish (takeout/leftovers themed nights don't).
  const cookNights = targetDates.filter((d) => {
    const tk = themes[String(new Date(`${d}T00:00:00Z`).getUTCDay())]
    return !(tk && MONTH_THEMES[tk]?.special)
  })
  const activeThemeKeys = [...new Set(Object.values(themes))].filter((k) => MONTH_THEMES[k] && !MONTH_THEMES[k].special)
  // The plan only ever schedules recipes the family actually has — never invented
  // dishes (those have no ingredients/steps and can't build a grocery list). So the
  // pool is capped by the library size; if it's small, repeats are unavoidable.
  if (lib.length === 0) {
    return { start: monthStartStr, mealType, suggestions: [], via: 'none', error: 'Add some recipes to your library first — the month planner only schedules recipes you have.', existing }
  }
  const allowRepeats = input.allowRepeats !== false // default on for a month
  // Aim for one distinct library recipe per night (bounded by the library) so the
  // month is as varied as the library allows — repeats only when there genuinely
  // aren't enough recipes. The pool is topped up from the library after the LLM
  // picks, so a weak model under-selecting doesn't force a repetitive month.
  const targetPool = Math.min(lib.length, Math.max(1, cookNights.length))
  const poolSize = Math.min(lib.length, Math.max(targetPool, activeThemeKeys.length + 6))

  const themeList = activeThemeKeys.map((k) => `${k} (${MONTH_THEMES[k].hint})`)
  const system = [
    `You plan a month of family DINNERS for a household meal planner — cooking for ${servings}.`,
    `Choose a ROTATION POOL of up to ${poolSize} dinners to spread across the month.`,
    `CRITICAL: only choose dishes that are in the family's recipe library below — return the recipeId for every dish. NEVER invent a dish that is not in the library.`,
    `Favor variety: pick as many DIFFERENT library recipes as fit (spanning cuisines/proteins) so the month doesn't feel repetitive. Do not list the same recipe twice.`,
    'Honor every dietary note and any "keep in mind" guidance when choosing.',
    input.weeknightMaxMin
      ? `Prefer QUICK library recipes (<= ${input.weeknightMaxMin} min) for weeknights and more involved ones for weekends.`
      : 'Mix quick and more involved library recipes.',
    themeList.length ? `Some nights have themes — pick library recipes that fit each and tag them with the theme keys: ${themeList.join(', ')}.` : '',
    'For each chosen recipe return: recipeId (required), title, emoji, minutes, effort ("quick" or "involved"), and themes (array of theme keys, may be empty). Return JSON only.',
  ].filter(Boolean).join('\n')
  const user = JSON.stringify({
    poolSize,
    cookingFor: servings,
    useUpFirst: input.useUp ?? [],
    keepInMind: input.keepInMind ?? '',
    dietaryNotes: dietary,
    themes: themeList,
    weeknightMaxMin: input.weeknightMaxMin ?? null,
    alreadyPlannedThisMonth: plannedTitles,
    avoid: input.avoidTitles ?? [],
    recipeLibrary: lib,
  })

  const { data, via } = await completeJson(tenant.householdId, {
    system,
    user,
    schema: PLAN_MONTH_POOL_SCHEMA,
    schemaName: 'meal_pool',
    maxTokens: 2200, // room for a larger distinct pool
    timeoutMs: 120_000,
  })

  // Effort from cook time vs the weeknight ceiling (default involved when unknown).
  const effortOf = (minutes: number | null, hint?: string): 'quick' | 'involved' => {
    if (hint && /involv|long|big|slow/i.test(hint)) return 'involved'
    if (hint && /quick|fast|easy|simple/i.test(hint)) return 'quick'
    if (minutes != null && input.weeknightMaxMin) return minutes <= input.weeknightMaxMin ? 'quick' : 'involved'
    return 'involved'
  }

  // Normalize the pool — LIBRARY ONLY: every dish must resolve to a real recipe
  // (by id, else by title). Invented dishes are dropped so we never plan something
  // the family can't actually cook / build a grocery list for.
  const libIds = new Set(lib.map((r) => r.id))
  const rawPool = ((data as { pool?: unknown[] })?.pool ?? []) as Array<Record<string, unknown>>
  const pool: PoolDish[] = []
  const seenTitles = new Set<string>()
  for (const d of rawPool) {
    const title0 = String(d.title ?? '').trim()
    let recipe = typeof d.recipeId === 'string' && libIds.has(d.recipeId) ? recipeById.get(d.recipeId) : undefined
    if (!recipe && title0) recipe = recipeByTitle.get(normTitle(title0))
    if (!recipe) continue // invented → discard
    const nt = normTitle(recipe.title)
    if (seenTitles.has(nt)) continue
    seenTitles.add(nt)
    const minutes = recipe.cook_time_minutes ?? null
    pool.push({ title: recipe.title, recipeId: recipe.id, emoji: recipe.emoji ?? null, minutes, effort: effortOf(minutes, typeof d.effort === 'string' ? d.effort : undefined), themes: recipeThemes(recipe) })
  }
  // Top up from the library with recipes the model didn't pick, up to one distinct
  // recipe per night. So a rich library yields a varied (often fully unique) month
  // even when a weak model under-selects — repeats only happen when the library is
  // genuinely smaller than the month. The LLM's themed/smart picks stay first.
  if (pool.length < targetPool) {
    // Top up theme-matching recipes FIRST so themed nights have real options within
    // the capped pool (otherwise a grilled recipe late in the library never makes it
    // in, and grill nights fall back to non-grill dishes).
    const activeSet = new Set(activeThemeKeys)
    const order = activeSet.size
      ? [...recipes].sort((a, b) => Number(recipeThemes(b).some((t) => activeSet.has(t))) - Number(recipeThemes(a).some((t) => activeSet.has(t))))
      : recipes
    for (const r of order) {
      if (pool.length >= targetPool) break
      const nt = normTitle(r.title)
      if (seenTitles.has(nt)) continue
      seenTitles.add(nt)
      pool.push({ title: r.title, recipeId: r.id, emoji: r.emoji ?? null, minutes: r.cook_time_minutes ?? null, effort: effortOf(r.cook_time_minutes ?? null), themes: recipeThemes(r) })
    }
  }
  if (pool.length === 0) return { start: monthStartStr, mealType, suggestions: [], via, existing }

  // Lay the pool across the nights.
  const repeatGap = allowRepeats ? Math.max(1, input.repeatGapDays ?? 7) : Number.POSITIVE_INFINITY
  const weeknightMax = input.weeknightMaxMin ?? null
  const lastUsed: Record<string, string> = {}
  const usedOnce = new Set<string>()
  const key = (d: PoolDish) => normTitle(d.title)
  const dowOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay()
  const lru = (arr: PoolDish[]) => arr.slice().sort((a, b) => Date.parse(lastUsed[key(a)] ?? '1970-01-01') - Date.parse(lastUsed[key(b)] ?? '1970-01-01'))

  // Pre-pass: reserve a DISTINCT theme-matching recipe for each themed night (in
  // date order), so themed nights aren't starved by regular nights eating the few
  // theme recipes first. When a theme runs out of distinct recipes, those nights
  // get no reservation and are filled with variety below (no repeat, no label).
  const reserved: Record<string, PoolDish> = {}
  for (const date of targetDates) {
    const tk = themes[String(dowOf(date))]
    if (!tk || MONTH_THEMES[tk]?.special) continue
    const matches = lru(pool.filter((d) => !usedOnce.has(key(d)) && d.themes.includes(tk)))
    if (matches.length) {
      reserved[date] = matches[0]
      usedOnce.add(key(matches[0]))
      lastUsed[key(matches[0])] = date
    }
  }

  const suggestions: PlanCard[] = []
  let lastCooked: PoolDish | null = null

  for (const date of targetDates) {
    const dow = dowOf(date)
    const themeKey = themes[String(dow)]
    const theme = themeKey ? MONTH_THEMES[themeKey] : undefined
    const isWeekend = dow === 0 || dow === 6

    if (theme?.special === 'takeout') {
      suggestions.push({ date, mealType, title: 'Eating out', recipeId: null, emoji: '🍴', minutes: null, servings, note: theme.label })
      lastCooked = null
      continue
    }
    const wantLeftover = theme?.special === 'leftovers' || (input.leftovers && !theme && lastCooked?.effort === 'involved')
    if (wantLeftover && lastCooked) {
      suggestions.push({ date, mealType, title: lastCooked.title, recipeId: lastCooked.recipeId, emoji: lastCooked.emoji, minutes: lastCooked.minutes, servings, note: 'Leftovers' })
      lastCooked = null // a leftover night doesn't itself spawn another leftover
      continue
    }

    let pick: PoolDish
    let themeSatisfied = false
    if (reserved[date]) {
      pick = reserved[date]
      themeSatisfied = true
    } else {
      // No theme (or its recipes ran out) → favor a brand-new recipe for variety;
      // only repeat (gap-respecting) as a last resort.
      const fresh = (d: PoolDish) => !usedOnce.has(key(d))
      const gapOk = (d: PoolDish) => {
        if (!allowRepeats) return !usedOnce.has(key(d))
        const last = lastUsed[key(d)]
        return !last || daysBetween(last, date) >= repeatGap
      }
      const weeknightOk = (d: PoolDish) => isWeekend || !weeknightMax || d.minutes == null || d.minutes <= weeknightMax
      const tiers: Array<(d: PoolDish) => boolean> = [
        (d) => fresh(d) && weeknightOk(d),
        (d) => fresh(d),
        (d) => gapOk(d),
        () => true,
      ]
      let cands: PoolDish[] = []
      for (const t of tiers) {
        cands = pool.filter(t)
        if (cands.length) break
      }
      pick = lru(cands)[0]
      themeSatisfied = !!themeKey && !theme?.special && pick.themes.includes(themeKey)
    }
    lastUsed[key(pick)] = date
    usedOnce.add(key(pick))
    suggestions.push({ date, mealType, title: pick.title, recipeId: pick.recipeId, emoji: pick.emoji, minutes: pick.minutes, servings, note: theme && !theme.special && themeSatisfied ? theme.label : null })
    lastCooked = pick
  }

  return { start: monthStartStr, mealType, suggestions, via, existing }
}
