// Meals & recipes — HTTP routes (/api/recipes, /api/meals). Logic in
// meals.service.ts; types in meals.types.ts.
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from '../../platform/db'
import { requireTenant, requireAdmin } from '../households/households'
import {
  syncMealEventForEntry,
  removeMealEventForEntry,
  getMealSettings,
  setMealSettings,
  resyncMealEvents,
} from './meal-events'
import type { RecipeRow, CreateRecipeInput, IngredientInput, RecipeOverrides } from './meals.types'
import {
  createRecipe,
  listRecipes,
  getRecipe,
  addIngredients,
  listIngredients,
  presentIngredient,
  listSteps,
  getOverrides,
  presentRecipe,
  getOrCreateActivePlan,
  upsertEntry,
  clearEntry,
  weekEntries,
  presentEntry,
  planWeek,
  MEAL_TYPES,
  DATE_RE,
  todayDate,
} from './meals.service'

type Api = ReturnType<typeof createAPI>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
