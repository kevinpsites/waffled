// Meals & recipes — HTTP routes (/api/recipes, /api/meals). Logic in
// meals.service.ts; types in meals.types.ts.
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from '../../platform/db'
import { moduleRoutes, requireModule } from '../../platform/route-guards'
import {
  syncMealEventForEntry,
  removeMealEventForEntry,
  syncPrepReminderForEntry,
  removePrepReminderForEntry,
  getMealSettings,
  setMealSettings,
  resyncMealEvents,
} from './meal-events'
import type { RecipeRow, CreateRecipeInput, UpdateRecipeInput, IngredientInput } from './meals.types'
import {
  createRecipe,
  updateRecipe,
  softDeleteRecipe,
  suggestRecipeMetadata,
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
  shuffleWeek,
  planMonth,
  shuffleMonth,
  MEAL_TYPES,
  DATE_RE,
  todayDate,
} from './meals.service'
import { parseRecipe } from './recipe-markdown'
import { serializeRecipe, recipeFilename } from './recipe-serialize'
import {
  ingestRecipeFromText,
  ingestRecipeFromPhotos,
  isAiUnavailable,
  IngestInputError,
  MAX_INGEST_PHOTOS,
  type IngestPhotoInput,
} from './recipe-ingest.service'
import { getAiConfig, availability, visionAvailable } from '../../platform/llm'
import {
  assertPersonInHousehold,
  assertPersonsInHousehold,
  assertRecipeInHousehold,
  assertMealInHousehold,
} from '../../platform/household-refs'
import {
  createMeal,
  getMeal,
  updateMeal,
  softDeleteMeal,
  setMealRecipe,
  patchMealRecipe,
  removeMealRecipe,
  reorderMealRecipes,
  flattenMealInto,
  copyMeal,
  presentMeal,
  listMeals,
  type MealRecipeInput,
} from './meal-builder.service'
import { onHandForRecipe } from '../pantry/on-hand'
import { addMealToGrocery, removeMealFromGrocery, householdWeekStart, presentListItem } from '../lists/lists.service'
import { mediaKeyBelongsToHousehold } from '../../platform/storage'

type Api = ReturnType<typeof createAPI>

// Every route here is gated by the optional `meals` module (403 when off).
const { tenantRoute, adminRoute } = moduleRoutes('meals')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function registerMealRoutes(api: Api): void {
  api.post('/api/recipes', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<CreateRecipeInput>
    if (!body.title || !body.title.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'title is required' })
    }
    if (body.storageKey != null && !mediaKeyBelongsToHousehold(body.storageKey, tenant.householdId)) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid uploaded image key' })
    }
    if (Array.isArray(body.ingredients) && body.ingredients.some((it) => !it?.name || !String(it.name).trim())) {
      return res.status(400).json({ error: 'BadRequest', message: 'every ingredient needs a name' })
    }
    const recipe = await createRecipe(tenant, { ...body, title: body.title.trim() } as CreateRecipeInput)
    return res.status(201).json({ recipe: presentRecipe(recipe) })
  }))

  api.get('/api/recipes', tenantRoute(async (tenant) => {
    const recipes = await listRecipes(tenant.householdId)
    return { recipes: recipes.map(presentRecipe) }
  }))

  // Distinct section names used across the household's recipes (most-used first) —
  // powers the recipe editor's section-name suggestions. Registered before
  // /api/recipes/:id so "sections" isn't taken as an id.
  api.get('/api/recipes/sections', tenantRoute(async (tenant) => {
    const { rows } = await query<{ section: string }>(
      `select section from recipe_ingredients
        where household_id = $1 and deleted_at is null
          and section is not null and btrim(section) <> ''
        group by section
        order by count(*) desc, section
        limit 50`,
      [tenant.householdId]
    )
    return { sections: rows.map((r) => r.section) }
  }))

  api.get('/api/recipes/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
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
    // Real pantry-matched on-hand for the detail banner. `onHand` is null when the
    // pantry module is off (show no claim at all); `toBuy` is not pantry-derived and
    // always answers "how many of these will land on the grocery list".
    // `toBuyNames` is what makes the count actionable: with the pantry ON the count
    // is the *unmatched* subset, which the client cannot derive from `ingredients`.
    const { onHand, toBuy, toBuyNames } = await onHandForRecipe(tenant.householdId, id)
    return { recipe: presentRecipe(recipe), ingredients, steps, onHand, toBuy, toBuyNames }
  }))

  // Compile a recipe into the blessed Markdown format (docs/RECIPE_FORMAT.md) for
  // sharing — the inverse of parse-markdown. Returns the markdown text (as-presented,
  // so user overrides are included) plus a suggested .md filename; clients hand it to
  // the native share sheet / clipboard / download.
  api.get('/api/recipes/:id/markdown', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    const recipe = await getRecipe(tenant.householdId, id)
    if (!recipe) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    const presented = presentRecipe(recipe)
    const ingredients = (await listIngredients(tenant.householdId, id)).map(presentIngredient)
    const steps = await listSteps(tenant.householdId, id)
    const markdown = serializeRecipe({ recipe: presented, ingredients, steps })
    return { markdown, filename: recipeFilename(presented.title) }
  }))

  // Update a recipe — favorite/rename/rating/notes/overrides (non-destructive) and
  // full scalar/metadata edits. Passing `ingredients` or `steps` replaces them
  // wholesale and detaches an imported recipe from its markdown source.
  api.patch('/api/recipes/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    const body = (req.body ?? {}) as UpdateRecipeInput
    if (body.storageKey != null && !mediaKeyBelongsToHousehold(body.storageKey, tenant.householdId)) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid uploaded image key' })
    }
    if (Array.isArray(body.ingredients) && body.ingredients.some((it) => !it?.name || !String(it.name).trim())) {
      return res.status(400).json({ error: 'BadRequest', message: 'every ingredient needs a name' })
    }
    let recipe
    try {
      recipe = await updateRecipe(tenant, id, body)
    } catch {
      return res.status(400).json({ error: 'BadRequest', message: 'could not update recipe' })
    }
    if (!recipe) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    return { recipe: presentRecipe(recipe) }
  }))

  // Soft-delete a recipe (and its ingredients/steps).
  api.delete('/api/recipes/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    const deleted = await softDeleteRecipe(tenant, id)
    if (!deleted) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    return res.status(204).send('')
  }))

  // Parse a pasted Markdown recipe (the blessed format) into the structured shape the
  // editor prefills from. Does NOT save — the user reviews, then POSTs.
  api.post('/api/recipes/parse-markdown', tenantRoute(async (_tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { markdown?: string }
    if (!body.markdown || !body.markdown.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'markdown is required' })
    }
    const r = parseRecipe(body.markdown)
    return {
      recipe: {
        title: r.title,
        emoji: r.emoji,
        servings: r.servings,
        tags: r.tags,
        notes: r.notes,
        sourceName: r.sourceName,
        mealType: r.mealType,
        protein: r.protein,
        base: r.base,
        cuisine: r.cuisine,
        effort: r.effort,
        cookMethod: r.cookMethod,
        flavorProfile: r.flavorProfile,
        dietary: r.dietary,
        vegetables: r.vegetables,
      },
      ingredients: r.ingredients.map((it) => ({
        name: it.name || it.display,
        amount: it.amount,
        unit: it.unit,
        prepNote: it.prepNote,
        section: it.section,
      })),
      steps: r.steps.map((s) => ({ instruction: s.text, ingredients: s.ingredients, timerSeconds: s.timerSeconds ?? null })),
    }
  }))

  // Which AI recipe-import paths this household can use right now: `text` (speech/
  // free-form → recipe) needs any non-heuristic provider; `vision` (photo → recipe)
  // needs a vision-capable model. The web client uses this to show/disable the two
  // import entry points.
  api.get('/api/recipes/ingest/config', tenantRoute(async (tenant) => {
    const { provider } = await getAiConfig(tenant.householdId)
    const text = provider !== 'heuristic' && availability()[provider]
    const vision = await visionAvailable(tenant.householdId)
    return { text, vision }
  }))

  // Speech/text → recipe. Free-form spoken (transcribed client-side) or typed
  // description → our markdown → structured draft. Does NOT save. 501 when no AI
  // provider is selected.
  api.post('/api/recipes/ingest/voice', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { text?: string }
    if (!body.text || !body.text.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'text is required' })
    }
    try {
      const { draft, via } = await ingestRecipeFromText(tenant, body.text)
      return { ...draft, via }
    } catch (err) {
      if (isAiUnavailable(err)) return res.status(501).json({ error: 'AIUnavailable', message: (err as Error).message })
      return res.status(502).json({ error: 'IngestFailed', message: (err as Error).message })
    }
  }))

  // Photo(s) → recipe. One or more photos of a physical/printed recipe → vision LLM →
  // our markdown → structured draft. Does NOT save the recipe; source photos are
  // persisted for a short window then swept. 501 when no vision-capable model.
  api.post('/api/recipes/ingest/photo', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { images?: IngestPhotoInput[] }
    const images = Array.isArray(body.images) ? body.images : []
    if (images.length === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'at least one image is required' })
    }
    if (images.length > MAX_INGEST_PHOTOS) {
      return res.status(400).json({ error: 'BadRequest', message: `at most ${MAX_INGEST_PHOTOS} images` })
    }
    if (images.some((im) => !im || typeof im.data !== 'string' || typeof im.contentType !== 'string')) {
      return res.status(400).json({ error: 'BadRequest', message: 'each image needs data + contentType' })
    }
    try {
      const { draft, via, photoKeys } = await ingestRecipeFromPhotos(tenant, images)
      return { ...draft, via, photoKeys }
    } catch (err) {
      if (err instanceof IngestInputError) return res.status(400).json({ error: 'BadRequest', message: err.message })
      if (isAiUnavailable(err)) return res.status(501).json({ error: 'AIUnavailable', message: (err as Error).message })
      return res.status(502).json({ error: 'IngestFailed', message: (err as Error).message })
    }
  }))

  // AI auto-fill: infer recipe metadata (cuisine/base/method/vegetables/…) from the
  // title + ingredients + steps. 501 when no LLM provider is configured.
  api.post('/api/recipes/suggest-metadata', tenantRoute(async (tenant, req: Request, res: Response) => {
    const b = (req.body ?? {}) as { title?: string; ingredients?: unknown; steps?: unknown }
    if (!b.title || !b.title.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'title is required' })
    }
    const ingredients = Array.isArray(b.ingredients) ? b.ingredients.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []
    const steps = Array.isArray(b.steps) ? b.steps.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []
    try {
      return await suggestRecipeMetadata(tenant, { title: b.title.trim(), ingredients, steps })
    } catch (err) {
      const message = (err as Error).message
      if (/no ai provider|not configured|not selected/i.test(message)) {
        return res.status(501).json({ error: 'AIUnavailable', message })
      }
      return res.status(200).json({ suggestion: null, via: 'none', error: message })
    }
  }))

  // Mark a recipe cooked — bumps cooked_count + last_cooked_at (powers "recently
  // cooked" sort + the "cooked N×" badge).
  api.post('/api/recipes/:id/cooked', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    const { rows } = await query<RecipeRow>(
      `update recipes set cooked_count = cooked_count + 1, last_cooked_at = now()
         where household_id = $1 and id = $2 and deleted_at is null returning *`,
      [tenant.householdId, id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    // Best-effort: if this recipe is on today's plan, reflect reality by marking that
    // slot cooked. Silent — cooking a recipe you never planned is fine.
    await query(
      `update meal_plan_entries set status = 'cooked'
         where household_id = $1 and recipe_id = $2 and date = current_date
           and status = 'planned' and deleted_at is null`,
      [tenant.householdId, id]
    )
    return { recipe: presentRecipe(rows[0]) }
  }))

  // Add ingredients to a recipe (bulk).
  api.post('/api/recipes/:id/ingredients', tenantRoute(async (tenant, req: Request, res: Response) => {
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
  }))

  // Plan (or re-plan) a meal slot. Assigns a recipe or free-text title (and
  // optionally who's cooking). Powers the Meals-screen "+" picker.
  api.post('/api/meals/plan', tenantRoute(async (tenant, req: Request, res: Response) => {
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
      await assertRecipeInHousehold(tenant.householdId, recipeId)
    }
    let cookPersonId: string | null = null
    if (body.cookPersonId != null && body.cookPersonId !== '') {
      if (!UUID_RE.test(body.cookPersonId)) {
        return res.status(400).json({ error: 'BadRequest', message: 'cookPersonId must be a uuid' })
      }
      cookPersonId = body.cookPersonId
      await assertPersonInHousehold(tenant.householdId, cookPersonId)
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
    await syncPrepReminderForEntry(tenant, entry.id).catch((err) => console.error('prep reminder sync failed', err))
    return res.status(200).json({ entry: presentEntry(entry) })
  }))

  // Clear a planned slot (date + mealType). Idempotent: 404 if nothing planned.
  api.delete('/api/meals/plan', tenantRoute(async (tenant, req: Request, res: Response) => {
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
    if (existing.rows[0]) {
      await removeMealEventForEntry(tenant.householdId, existing.rows[0].id).catch((err) => console.error('meal event remove failed', err))
      await removePrepReminderForEntry(tenant.householdId, existing.rows[0].id).catch((err) => console.error('prep reminder remove failed', err))
    }
    const cleared = await clearEntry(tenant, date, mealType)
    if (!cleared) return res.status(404).json({ error: 'NotFound', message: 'nothing planned in that slot' })
    return res.status(204).send('')
  }))

  // Meals → calendar settings (per household): whether meals appear on the
  // calendar, whether they push to Google, whose calendar, who's invited, and the
  // time each meal type lands at.
  api.get('/api/meals/calendar-settings', tenantRoute(async (tenant) => {
    return { settings: await getMealSettings(tenant.householdId) }
  }))

  api.put('/api/meals/calendar-settings', adminRoute(async (tenant, req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    if (typeof b.addToCalendar === 'boolean') patch.addToCalendar = b.addToCalendar
    if (typeof b.pushToGoogle === 'boolean') patch.pushToGoogle = b.pushToGoogle
    if (b.calendarPersonId === null || (typeof b.calendarPersonId === 'string' && UUID_RE.test(b.calendarPersonId))) patch.calendarPersonId = b.calendarPersonId
    if (b.participantIds === null || (Array.isArray(b.participantIds) && b.participantIds.every((p) => typeof p === 'string' && UUID_RE.test(p)))) patch.participantIds = b.participantIds
    if (typeof patch.calendarPersonId === 'string') {
      await assertPersonInHousehold(tenant.householdId, patch.calendarPersonId)
    }
    if (Array.isArray(patch.participantIds)) {
      await assertPersonsInHousehold(tenant.householdId, patch.participantIds as string[])
    }
    if (b.times && typeof b.times === 'object') {
      const t: Record<string, string> = {}
      for (const [k, v] of Object.entries(b.times as Record<string, unknown>)) {
        if (MEAL_TYPES.has(k) && typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)) t[k] = v
      }
      if (Object.keys(t).length) patch.times = t
    }
    if (typeof b.durationMinutes === 'number' && b.durationMinutes > 0 && b.durationMinutes <= 600) patch.durationMinutes = Math.round(b.durationMinutes)
    if (typeof b.prepReminder === 'boolean') patch.prepReminder = b.prepReminder
    if (typeof b.prepReminderTime === 'string' && /^\d{2}:\d{2}$/.test(b.prepReminderTime)) patch.prepReminderTime = b.prepReminderTime
    if (Array.isArray(b.prepReminderMealTypes) && b.prepReminderMealTypes.every((t) => typeof t === 'string' && MEAL_TYPES.has(t))) {
      patch.prepReminderMealTypes = [...new Set(b.prepReminderMealTypes as string[])]
    }
    const settings = await setMealSettings(tenant.householdId, patch)
    // Apply the new settings to meals already on the plan.
    await resyncMealEvents(tenant).catch((err) => console.error('meal event resync failed', err))
    return res.status(200).json({ settings })
  }))

  // Resolve a planned-meal entry to its recipe — the calendar uses this to open
  // the linked recipe when a meal event is tapped.
  api.get('/api/meals/entry/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'entry not found' })
    const { rows } = await query<{ recipe_id: string | null; meal_id: string | null; title: string | null }>(
      `select recipe_id, meal_id, title from meal_plan_entries where household_id=$1 and id=$2 and deleted_at is null`,
      [tenant.householdId, id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'NotFound', message: 'entry not found' })
    // A Meal Builder plate in the slot resolves to every recipe on the plate, so the
    // calendar can open the plate (or any one dish) instead of a single recipe.
    const mealId = rows[0].meal_id
    const dishes = mealId
      ? (await query<{ recipe_id: string }>(
          `select mr.recipe_id from meal_recipes mr where mr.meal_id = $1 order by mr.sort_order`,
          [mealId]
        )).rows.map((r) => r.recipe_id)
      : rows[0].recipe_id
        ? [rows[0].recipe_id]
        : []
    return { recipeId: rows[0].recipe_id, mealId, recipeIds: dishes, title: rows[0].title }
  }))

  // The planned week (entries joined to recipes) — powers the kiosk meal card.
  api.get('/api/meals/week', tenantRoute(async (tenant, req: Request) => {
    const startParam = typeof req.query?.start === 'string' ? req.query.start : ''
    const start = DATE_RE.test(startParam) ? startParam : todayDate()
    const daysParam = Number(req.query?.days)
    const days = Number.isFinite(daysParam) && daysParam > 0 ? daysParam : 7
    const entries = await weekEntries(tenant.householdId, start, days)
    return { start, entries }
  }))

  // AI "Plan my week": suggest dinners for the empty slots (review, then apply via
  // POST /api/meals/plan). 501 when no LLM provider is selected/configured.
  api.post('/api/meals/plan-week', tenantRoute(async (tenant, req: Request, res: Response) => {
    const b = (req.body ?? {}) as {
      start?: string
      mealType?: string
      dates?: unknown
      cookingFor?: unknown
      keepInMind?: unknown
      useUp?: unknown
      avoidTitles?: unknown
      wantToTry?: unknown
      trySomethingNew?: unknown
    }
    const start = typeof b.start === 'string' && DATE_RE.test(b.start) ? b.start : todayDate()
    const dates = Array.isArray(b.dates) ? b.dates.filter((d): d is string => typeof d === 'string' && DATE_RE.test(d)) : undefined
    const useUp = Array.isArray(b.useUp) ? b.useUp.filter((s): s is string => typeof s === 'string' && !!s.trim()).slice(0, 12) : undefined
    const avoidTitles = Array.isArray(b.avoidTitles) ? b.avoidTitles.filter((s): s is string => typeof s === 'string').slice(0, 40) : undefined
    const wantToTry = Array.isArray(b.wantToTry) ? b.wantToTry.filter((s): s is string => typeof s === 'string' && !!s.trim()).slice(0, 12) : undefined
    const trySomethingNew = typeof b.trySomethingNew === 'boolean' ? b.trySomethingNew : undefined
    const mealType = typeof b.mealType === 'string' ? b.mealType : undefined
    // No LLM provider configured (heuristic) or the selected provider isn't usable in
    // this environment → shuffle the empty slots from the library instead of 501ing.
    const ai = await getAiConfig(tenant.householdId)
    if (ai.provider === 'heuristic' || !availability()[ai.provider]) {
      return await shuffleWeek(tenant, { start, mealType, dates, cookingFor: typeof b.cookingFor === 'number' ? b.cookingFor : null })
    }
    try {
      return await planWeek(tenant, {
        start,
        mealType,
        dates,
        cookingFor: typeof b.cookingFor === 'number' ? b.cookingFor : null,
        keepInMind: typeof b.keepInMind === 'string' ? b.keepInMind : null,
        useUp,
        avoidTitles,
        wantToTry,
        trySomethingNew,
      })
    } catch (err) {
      const message = (err as Error).message
      // No provider chosen / missing creds → 501 (UI: "pick a provider"). Runtime
      // failures (timeout, network, bad JSON) → 200 with a readable error so the UI
      // can show what actually went wrong instead of "pick a provider".
      if (/no ai provider|not configured/i.test(message)) {
        return res.status(501).json({ error: 'AIUnavailable', message })
      }
      return { start, mealType: mealType ?? 'dinner', suggestions: [], via: 'none', error: message }
    }
  }))

  // AI "Plan my month": draft a rotation pool and lay it across the month's chosen
  // dinners with the month guardrails. Applied via POST /api/meals/plan like the week.
  api.post('/api/meals/plan-month', tenantRoute(async (tenant, req: Request, res: Response) => {
    const b = (req.body ?? {}) as {
      start?: string
      weekdays?: unknown
      skipDates?: unknown
      dates?: unknown
      cookingFor?: unknown
      keepInMind?: unknown
      useUp?: unknown
      avoidTitles?: unknown
      allowRepeats?: unknown
      repeatGapDays?: unknown
      weekdayThemes?: unknown
      weeknightMaxMin?: unknown
      leftovers?: unknown
    }
    const start = typeof b.start === 'string' && DATE_RE.test(b.start) ? b.start : todayDate()
    const weekdays = Array.isArray(b.weekdays) ? b.weekdays.filter((n): n is number => typeof n === 'number' && n >= 0 && n <= 6) : undefined
    const skipDates = Array.isArray(b.skipDates) ? b.skipDates.filter((d): d is string => typeof d === 'string' && DATE_RE.test(d)) : undefined
    const dates = Array.isArray(b.dates) ? b.dates.filter((d): d is string => typeof d === 'string' && DATE_RE.test(d)) : undefined
    const useUp = Array.isArray(b.useUp) ? b.useUp.filter((s): s is string => typeof s === 'string' && !!s.trim()).slice(0, 12) : undefined
    const avoidTitles = Array.isArray(b.avoidTitles) ? b.avoidTitles.filter((s): s is string => typeof s === 'string').slice(0, 60) : undefined
    const weekdayThemes =
      b.weekdayThemes && typeof b.weekdayThemes === 'object' && !Array.isArray(b.weekdayThemes)
        ? Object.fromEntries(Object.entries(b.weekdayThemes as Record<string, unknown>).filter(([k, v]) => /^[0-6]$/.test(k) && typeof v === 'string'))
        : undefined
    // No LLM provider configured (heuristic) or the selected provider isn't usable
    // here → shuffle the month's empty nights from the library instead of 501ing.
    const ai = await getAiConfig(tenant.householdId)
    if (ai.provider === 'heuristic' || !availability()[ai.provider]) {
      return await shuffleMonth(tenant, {
        start,
        weekdays,
        skipDates,
        dates,
        cookingFor: typeof b.cookingFor === 'number' ? b.cookingFor : null,
      })
    }
    try {
      return await planMonth(tenant, {
        start,
        weekdays,
        skipDates,
        dates,
        cookingFor: typeof b.cookingFor === 'number' ? b.cookingFor : null,
        keepInMind: typeof b.keepInMind === 'string' ? b.keepInMind : null,
        useUp,
        avoidTitles,
        allowRepeats: typeof b.allowRepeats === 'boolean' ? b.allowRepeats : undefined,
        repeatGapDays: typeof b.repeatGapDays === 'number' ? b.repeatGapDays : undefined,
        weekdayThemes: weekdayThemes as Record<string, string> | undefined,
        weeknightMaxMin: typeof b.weeknightMaxMin === 'number' ? b.weeknightMaxMin : null,
        leftovers: typeof b.leftovers === 'boolean' ? b.leftovers : undefined,
      })
    } catch (err) {
      const message = (err as Error).message
      if (/no ai provider|not configured/i.test(message)) {
        return res.status(501).json({ error: 'AIUnavailable', message })
      }
      return { start, mealType: 'dinner', suggestions: [], via: 'none', error: message }
    }
  }))

  // ── Meal Builder (plates) ──────────────────────────────────────────────────
  // A "plate" is a named, multi-recipe meal. Registered last so the static
  // /api/meals/* routes above (week, plan, entry, calendar-settings, …) always win
  // over /api/meals/:id — lambda-api prefers a literal segment over a path variable,
  // but keeping these together is the readable guarantee.

  // Validate + normalise one dish from a request body.
  async function readDish(householdId: string, raw: unknown): Promise<MealRecipeInput> {
    const d = (raw ?? {}) as { recipeId?: string; role?: unknown; sortOrder?: unknown; cookPersonId?: unknown }
    const recipeId = typeof d.recipeId === 'string' ? d.recipeId : ''
    await assertRecipeInHousehold(householdId, recipeId)
    // `undefined` means "the caller didn't mention this", `null` means "clear it".
    // Collapsing the two made a bare re-add of an existing dish reset everything it
    // didn't name — see setMealRecipe.
    let cookPersonId: string | null | undefined
    if ('cookPersonId' in d) {
      if (typeof d.cookPersonId === 'string' && d.cookPersonId) {
        await assertPersonInHousehold(householdId, d.cookPersonId)
        cookPersonId = d.cookPersonId
      } else {
        cookPersonId = null
      }
    }
    const role = typeof d.role === 'string' && d.role.trim() ? d.role.trim().slice(0, 40) : undefined
    return {
      recipeId,
      role,
      sortOrder: typeof d.sortOrder === 'number' ? Math.trunc(d.sortOrder) : undefined,
      cookPersonId,
    }
  }

  // Load a plate or answer 404 — every :id route starts here, so another
  // household's plate is indistinguishable from a missing one.
  async function loadMeal(tenant: { householdId: string }, req: Request, res: Response) {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: 'NotFound', message: 'meal not found' })
      return null
    }
    const meal = await getMeal(tenant.householdId, id)
    if (!meal) {
      res.status(404).json({ error: 'NotFound', message: 'meal not found' })
      return null
    }
    return meal
  }

  // Create a plate. `recipes` seeds the dishes in the given order.
  api.post('/api/meals', tenantRoute(async (tenant, req: Request, res: Response) => {
    const b = (req.body ?? {}) as { name?: string; servings?: unknown; isSaved?: unknown; recipes?: unknown }
    if (typeof b.name !== 'string' || !b.name.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'name is required' })
    }
    const dishes: MealRecipeInput[] = []
    if (Array.isArray(b.recipes)) {
      for (const raw of b.recipes) dishes.push(await readDish(tenant.householdId, raw))
    }
    const meal = await createMeal(tenant, {
      name: b.name,
      servings: typeof b.servings === 'number' && b.servings > 0 ? Math.trunc(b.servings) : null,
      isSaved: typeof b.isSaved === 'boolean' ? b.isSaved : false,
    })
    for (const [i, d] of dishes.entries()) await setMealRecipe(meal.id, { ...d, sortOrder: d.sortOrder ?? i })
    return res.status(201).json({ meal: await presentMeal(tenant.householdId, meal) })
  }))

  // The saved-meal library: list + search (?q=). Saved meals are first-class members
  // of the recipe library, so clients merge these with GET /api/recipes.
  api.get('/api/meals', tenantRoute(async (tenant, req: Request) => {
    const q = typeof req.query?.q === 'string' ? req.query.q : ''
    const limitRaw = Number(req.query?.limit)
    const meals = await listMeals(tenant.householdId, { q, limit: Number.isFinite(limitRaw) ? limitRaw : undefined })
    return { meals }
  }))

  api.get('/api/meals/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const meal = await loadMeal(tenant, req, res)
    if (!meal) return
    return res.status(200).json({ meal: await presentMeal(tenant.householdId, meal) })
  }))

  api.patch('/api/meals/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const existing = await loadMeal(tenant, req, res)
    if (!existing) return
    const b = (req.body ?? {}) as { name?: unknown; servings?: unknown; isSaved?: unknown }
    if (b.name != null && (typeof b.name !== 'string' || !b.name.trim())) {
      return res.status(400).json({ error: 'BadRequest', message: 'name cannot be blank' })
    }
    const meal = await updateMeal(tenant.householdId, existing.id, {
      name: typeof b.name === 'string' ? b.name : undefined,
      servings: typeof b.servings === 'number' && b.servings > 0 ? Math.trunc(b.servings) : undefined,
      isSaved: typeof b.isSaved === 'boolean' ? b.isSaved : undefined,
    })
    if (!meal) return res.status(404).json({ error: 'NotFound', message: 'meal not found' })
    return res.status(200).json({ meal: await presentMeal(tenant.householdId, meal) })
  }))

  api.delete('/api/meals/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const meal = await loadMeal(tenant, req, res)
    if (!meal) return
    await softDeleteMeal(tenant.householdId, meal.id)
    return res.status(204).send('')
  }))

  // Add a dish — either a recipe (`recipeId`) or a SAVED MEAL (`mealId`), which is
  // FLATTENED into individual dishes. Meals never nest (decision 12).
  api.post('/api/meals/:id/recipes', tenantRoute(async (tenant, req: Request, res: Response) => {
    const meal = await loadMeal(tenant, req, res)
    if (!meal) return
    const b = (req.body ?? {}) as { recipeId?: unknown; mealId?: unknown }
    if (typeof b.mealId === 'string' && b.mealId) {
      await assertMealInHousehold(tenant.householdId, b.mealId)
      await flattenMealInto(tenant.householdId, meal.id, b.mealId)
      return res.status(200).json({ meal: await presentMeal(tenant.householdId, meal) })
    }
    if (typeof b.recipeId !== 'string' || !b.recipeId) {
      return res.status(400).json({ error: 'BadRequest', message: 'recipeId or mealId is required' })
    }
    await setMealRecipe(meal.id, await readDish(tenant.householdId, b))
    return res.status(200).json({ meal: await presentMeal(tenant.householdId, meal) })
  }))

  // Reorder the plate. Registered before the :recipeId route below purely for
  // readability — 'order' is a literal segment, so it can never be read as an id.
  api.put('/api/meals/:id/recipes/order', tenantRoute(async (tenant, req: Request, res: Response) => {
    const meal = await loadMeal(tenant, req, res)
    if (!meal) return
    const b = (req.body ?? {}) as { recipeIds?: unknown }
    if (!Array.isArray(b.recipeIds) || b.recipeIds.some((id) => typeof id !== 'string')) {
      return res.status(400).json({ error: 'BadRequest', message: 'recipeIds must be an array of ids' })
    }
    await reorderMealRecipes(tenant.householdId, meal.id, b.recipeIds as string[])
    return res.status(200).json({ meal: await presentMeal(tenant.householdId, meal) })
  }))

  // Per-dish edits: its role, its place on the plate, and who's cooking it (a
  // four-dish plate has up to four cooks).
  api.patch('/api/meals/:id/recipes/:recipeId', tenantRoute(async (tenant, req: Request, res: Response) => {
    const meal = await loadMeal(tenant, req, res)
    if (!meal) return
    const recipeId = req.params.recipeId ?? ''
    if (!UUID_RE.test(recipeId)) return res.status(404).json({ error: 'NotFound', message: 'dish not found' })
    const b = (req.body ?? {}) as { role?: unknown; sortOrder?: unknown; cookPersonId?: unknown }
    const patch: { role?: string; sortOrder?: number; cookPersonId?: string | null } = {}
    if (typeof b.role === 'string') patch.role = b.role.trim().slice(0, 40)
    if (typeof b.sortOrder === 'number') patch.sortOrder = Math.trunc(b.sortOrder)
    if ('cookPersonId' in b) {
      if (b.cookPersonId == null || b.cookPersonId === '') patch.cookPersonId = null
      else if (typeof b.cookPersonId === 'string') {
        await assertPersonInHousehold(tenant.householdId, b.cookPersonId)
        patch.cookPersonId = b.cookPersonId
      }
    }
    const ok = await patchMealRecipe(meal.id, recipeId, patch)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'dish not found' })
    return res.status(200).json({ meal: await presentMeal(tenant.householdId, meal) })
  }))

  // Schedule a plate into a (date, meal_type) slot. Writes a meal_plan_entries row
  // with meal_id set and recipe_id NULL, honouring the existing
  // (meal_plan_id, date, meal_type) unique index — so it replaces whatever was there.
  //
  // Scheduling a SAVED plate COPIES it: editing next week's BBQ Sunday must not
  // rewrite the plate that already went out last week. A one-off (unsaved) plate is
  // scheduled as itself.
  api.post('/api/meals/:id/schedule', tenantRoute(async (tenant, req: Request, res: Response) => {
    const meal = await loadMeal(tenant, req, res)
    if (!meal) return
    const b = (req.body ?? {}) as { date?: string; mealType?: string; cookPersonId?: unknown }
    if (!b.date || !DATE_RE.test(b.date) || !b.mealType || !MEAL_TYPES.has(b.mealType)) {
      return res.status(400).json({ error: 'BadRequest', message: 'date (YYYY-MM-DD) and mealType are required' })
    }
    let cookPersonId: string | null = null
    if (typeof b.cookPersonId === 'string' && b.cookPersonId) {
      await assertPersonInHousehold(tenant.householdId, b.cookPersonId)
      cookPersonId = b.cookPersonId
    }
    const scheduled = meal.is_saved ? await copyMeal(tenant, meal.id) : meal
    const plan = await getOrCreateActivePlan(tenant)
    const entry = await upsertEntry(plan.id, tenant, {
      date: b.date,
      mealType: b.mealType,
      recipeId: null,
      mealId: scheduled.id,
      title: scheduled.name,
      cookPersonId,
    })
    await syncMealEventForEntry(tenant, entry.id).catch((err) => console.error('meal event sync failed', err))
    await syncPrepReminderForEntry(tenant, entry.id).catch((err) => console.error('prep reminder sync failed', err))
    return res.status(200).json({ entry: presentEntry(entry), meal: await presentMeal(tenant.householdId, scheduled) })
  }))

  // "Add plate to list" — put the whole plate's shopping on the grocery list without
  // scheduling it anywhere. Rows land as source='recipe' (an explicit off-plan add
  // the weekly rebuild must never wipe) and are credited to the plate, so the board
  // can group them under one parent row.
  api.post('/api/meals/:id/add-to-list', tenantRoute(async (tenant, req: Request, res: Response) => {
    // Double-gated: this writes grocery rows, which belong to the lists module, so a
    // household that has turned lists off must not be able to grow a list from the
    // meals side. Mirrors /api/lists/grocery/from-recipe, which is lists-gated.
    await requireModule(tenant, 'lists')
    const meal = await loadMeal(tenant, req, res)
    if (!meal) return
    const ws = typeof req.query?.weekStart === 'string' ? req.query.weekStart : ''
    let weekStart = await householdWeekStart(tenant.householdId)
    if (DATE_RE.test(ws)) {
      const d = new Date(`${ws}T00:00:00Z`)
      if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ws) weekStart = ws
    }
    const added = await addMealToGrocery(tenant, meal.id, weekStart)
    if (added === null) return res.status(404).json({ error: 'NotFound', message: 'meal not found' })
    return res.status(201).json({ added: added.length, items: added.map(presentListItem), weekStart })
  }))

  // Undo the add above. Same double gate: it writes to the grocery list.
  api.delete('/api/meals/:id/add-to-list', tenantRoute(async (tenant, req: Request, res: Response) => {
    await requireModule(tenant, 'lists')
    const meal = await loadMeal(tenant, req, res)
    if (!meal) return
    const ws = typeof req.query?.weekStart === 'string' ? req.query.weekStart : ''
    let weekStart = await householdWeekStart(tenant.householdId)
    if (DATE_RE.test(ws)) {
      const d = new Date(`${ws}T00:00:00Z`)
      if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ws) weekStart = ws
    }
    const removed = await removeMealFromGrocery(tenant, meal.id, weekStart)
    if (removed === null) return res.status(404).json({ error: 'NotFound', message: 'meal not found' })
    return res.status(200).json({ removed, weekStart })
  }))

  api.delete('/api/meals/:id/recipes/:recipeId', tenantRoute(async (tenant, req: Request, res: Response) => {
    const meal = await loadMeal(tenant, req, res)
    if (!meal) return
    const recipeId = req.params.recipeId ?? ''
    if (!UUID_RE.test(recipeId)) return res.status(404).json({ error: 'NotFound', message: 'dish not found' })
    const removed = await removeMealRecipe(meal.id, recipeId)
    if (!removed) return res.status(404).json({ error: 'NotFound', message: 'dish not found' })
    return res.status(200).json({ meal: await presentMeal(tenant.householdId, meal) })
  }))
}
