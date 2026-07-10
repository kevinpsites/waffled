// Meals & recipes — HTTP routes (/api/recipes, /api/meals). Logic in
// meals.service.ts; types in meals.types.ts.
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from '../../platform/db'
import { moduleRoutes } from '../../platform/route-guards'
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
  planMonth,
  MEAL_TYPES,
  DATE_RE,
  todayDate,
} from './meals.service'
import { parseRecipe } from './recipe-markdown'
import {
  ingestRecipeFromText,
  ingestRecipeFromPhotos,
  isAiUnavailable,
  IngestInputError,
  MAX_INGEST_PHOTOS,
  type IngestPhotoInput,
} from './recipe-ingest.service'
import { getAiConfig, availability, visionAvailable } from '../../platform/llm'

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
    return { recipe: presentRecipe(recipe), ingredients, steps }
  }))

  // Update a recipe — favorite/rename/rating/notes/overrides (non-destructive) and
  // full scalar/metadata edits. Passing `ingredients` or `steps` replaces them
  // wholesale and detaches an imported recipe from its markdown source.
  api.patch('/api/recipes/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    const body = (req.body ?? {}) as UpdateRecipeInput
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
    const { rows } = await query<{ recipe_id: string | null; title: string | null }>(
      `select recipe_id, title from meal_plan_entries where household_id=$1 and id=$2 and deleted_at is null`,
      [tenant.householdId, id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'NotFound', message: 'entry not found' })
    return { recipeId: rows[0].recipe_id, title: rows[0].title }
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
    try {
      return await planWeek(tenant, {
        start,
        mealType: typeof b.mealType === 'string' ? b.mealType : undefined,
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
      const mealType = typeof b.mealType === 'string' ? b.mealType : 'dinner'
      return { start, mealType, suggestions: [], via: 'none', error: message }
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
}
