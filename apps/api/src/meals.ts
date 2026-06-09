// Meals & recipes. Recipes are shared household assets; meal-plan entries (added
// in the next chunk) schedule recipes onto days and power the kiosk meal card.
import createAPI, { type Request, type Response } from 'lambda-api'
import type { QueryResultRow } from 'pg'
import { query } from './db'
import { requireTenant, type Tenant } from './households'

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

export function presentRecipe(r: RecipeRow) {
  return {
    id: r.id,
    title: r.title,
    emoji: r.emoji,
    description: r.description,
    category: r.category,
    tags: r.tags,
    prepTimeMinutes: r.prep_time_minutes,
    cookTimeMinutes: r.cook_time_minutes,
    servings: r.servings,
    imageUrl: r.image_url,
    sourceName: r.source_name,
    isFavorite: r.is_favorite,
    cookedCount: r.cooked_count,
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
    const ingredients = await listIngredients(tenant.householdId, id)
    const steps = await listSteps(tenant.householdId, id)
    return { recipe: presentRecipe(recipe), ingredients: ingredients.map(presentIngredient), steps }
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
    const cleared = await clearEntry(tenant, date, mealType)
    if (!cleared) return res.status(404).json({ error: 'NotFound', message: 'nothing planned in that slot' })
    return res.status(204).send('')
  })

  // The planned week (entries joined to recipes) — powers the kiosk meal card.
  api.get('/api/meals/week', async (req: Request) => {
    const tenant = await requireTenant(req)
    const startParam = typeof req.query?.start === 'string' ? req.query.start : ''
    const start = DATE_RE.test(startParam) ? startParam : todayDate()
    const entries = await weekEntries(tenant.householdId, start)
    return { start, entries }
  })
}
