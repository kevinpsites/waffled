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

export async function weekEntries(householdId: string, start: string) {
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
