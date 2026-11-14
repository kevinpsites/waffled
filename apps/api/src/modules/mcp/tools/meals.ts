import { listRecipes, presentRecipe, weekEntries } from '../../meals/meals.service'
import { householdWeekStart, householdWeekStartFor } from '../../lists/lists.service'
import { rankCandidates } from '../../capture/candidate-match'
import { defineTool, ToolInputError } from '../registry'
import { capped, DATE_SCHEMA, optDate, optNumber, reqString, truncNote } from '../args'
import { DATA_NOTE, READ } from './shared'

const DEFAULT_RECIPES = 10
const MAX_RECIPES = 25

type Entry = Awaited<ReturnType<typeof weekEntries>>[number]

export function presentEntryForAgent(e: Entry) {
  return {
    id: e.id,
    date: e.date,
    mealType: e.mealType,
    title: e.recipe?.title ?? e.meal?.name ?? e.title,
    recipeId: e.recipeId,
    mealId: e.mealId,
    dishes: e.meal ? e.meal.recipes.map((r) => ({ recipeId: r.recipeId, title: r.title })) : [],
    cook: e.cook ? { id: e.cook.personId, name: e.cook.name } : null,
  }
}

defineTool({
  name: 'get_meal_plan',
  description:
    "The meal plan for one household week (breakfast, lunch, dinner, snack per day). week is any date in it (default this week); weekStart in the result is the server's key for that week." +
    DATA_NOTE,
  scope: 'meals:read',
  module: 'meals',
  annotations: { title: 'Get the meal plan', ...READ },
  inputSchema: {
    type: 'object',
    properties: { week: { ...DATE_SCHEMA, description: 'Any day in the week, YYYY-MM-DD (default this week)' } },
    additionalProperties: false,
  },
  run: async (tenant, args) => {
    const week = optDate(args, 'week')
    const weekStart = week ? await householdWeekStartFor(tenant.householdId, week) : await householdWeekStart(tenant.householdId)
    const entries = (await weekEntries(tenant.householdId, weekStart, 7)).map(presentEntryForAgent)
    return { data: { weekStart, entries }, summary: `${entries.length} planned meal(s) in the week of ${weekStart}.` }
  },
})

defineTool({
  name: 'search_recipes',
  description:
    "Search the household's recipe library by words in the title, tags, cuisine or protein. Returns the best matches first; a recipe id works with plan_meal." +
    DATA_NOTE,
  scope: 'meals:read',
  module: 'meals',
  annotations: { title: 'Search recipes', ...READ },
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words to look for, e.g. "chicken tacos"' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_RECIPES, description: `Default ${DEFAULT_RECIPES}` },
    },
    required: ['query'],
    additionalProperties: false,
  },
  run: async (tenant, args) => {
    const q = reqString(args, 'query', 200)
    const limit = optNumber(args, 'limit') ?? DEFAULT_RECIPES
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECIPES) throw new ToolInputError(`limit must be 1–${MAX_RECIPES}`)
    const recipes = (await listRecipes(tenant.householdId)).map(presentRecipe)
    const byId = new Map(recipes.map((r) => [r.id, r]))
    const ranked = rankCandidates(
      q,
      recipes.map((r) => ({ id: r.id, title: r.title, keywords: [...r.tags, r.cuisine, r.protein, r.category].filter((k): k is string => !!k) }))
    )
    const c = capped(
      ranked.map((m) => {
        const r = byId.get(m.id)!
        return { id: r.id, title: r.title, tags: r.tags, cuisine: r.cuisine, prepTimeMinutes: r.prepTimeMinutes, cookTimeMinutes: r.cookTimeMinutes, servings: r.servings, isFavorite: r.isFavorite }
      }),
      limit
    )
    return { data: { query: q, ...c }, summary: `${c.total} recipe(s) match "${q}"${truncNote(c)}.` }
  },
})
