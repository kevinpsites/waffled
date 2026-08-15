// Meals & recipes domain — client slice, types, and hooks.
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete, localToday } from './client'
import { tap, useRefetchOn } from './bus'
import type { OnHandCount } from './mealBuilder'

// ── Recipe authoring (create / edit) ─────────────────────────────────────────
export interface IngredientInput {
  name: string
  amount?: number | null
  unit?: string | null
  prepNote?: string | null
  section?: string | null
  sortOrder?: number | null
}

export interface StepInput {
  instruction: string
  ingredients?: string[]
  timerSeconds?: number | null
}

// What the editor sends to create or fully edit a recipe.
export interface RecipeWriteInput {
  title?: string
  emoji?: string | null
  description?: string | null
  category?: string | null
  tags?: string[] | null
  servings?: number
  prepTimeMinutes?: number | null
  cookTimeMinutes?: number | null
  imageUrl?: string | null
  storageKey?: string | null
  sourceName?: string | null
  notes?: string | null
  mealType?: string | null
  protein?: string | null
  base?: string | null
  cuisine?: string | null
  effort?: string | null
  cookMethod?: string | null
  flavorProfile?: string | null
  dietary?: string[] | null
  vegetables?: string[] | null
  collection?: string | null
  ingredients?: IngredientInput[]
  steps?: StepInput[]
}

// AI-inferred metadata for the editor's quiet auto-fill (POST /api/recipes/suggest-metadata).
export interface RecipeMetadataSuggestion {
  cuisine: string | null
  mealType: string | null
  protein: string | null
  base: string | null
  effort: string | null
  cookMethod: string | null
  flavorProfile: string | null
  dietary: string[]
  vegetables: string[]
  tags: string[]
}

// The structured result of parsing pasted markdown (POST /api/recipes/parse-markdown).
export interface ParsedRecipe {
  recipe: {
    title: string
    emoji: string | null
    servings: number
    tags: string[]
    notes: string | null
    sourceName: string | null
    mealType: string | null
    protein: string | null
    base: string | null
    cuisine: string | null
    effort: string | null
    cookMethod: string | null
    flavorProfile: string | null
    dietary: string[]
    vegetables: string[]
  }
  ingredients: IngredientInput[]
  steps: StepInput[]
}

export interface MealCook {
  personId: string
  name: string | null
  avatarEmoji: string | null
  colorHex: string | null
}

export interface MealRecipe {
  title: string | null
  emoji: string | null
  category: string | null
  prepTimeMinutes: number | null
  cookTimeMinutes: number | null
  servings: number | null
  imageUrl: string | null
}

// The plate behind a meal-backed slot, trimmed to what a planner cell needs to draw
// its emoji strip and dish list. The full plate lives in ./mealBuilder.
export interface WeekEntryMeal {
  id: string
  name: string
  servings: number
  recipes: Array<{
    recipeId: string
    title: string | null
    emoji: string | null
    role: string
    sortOrder: number
  }>
}

// A planned slot holds EITHER a single recipe (recipeId set) or a whole Meal Builder
// plate (mealId set) — never both; the one-entry-per-(date, mealType) unique index is
// unchanged. A slot that flips type has the opposite column cleared server-side.
export interface WeekEntry {
  id: string
  date: string
  mealType: string
  title: string | null
  recipeId: string | null
  mealId: string | null
  cook: MealCook | null
  recipe: MealRecipe | null
  meal: WeekEntryMeal | null
}

// Rich frontmatter metadata shared by the list + detail shapes.
export interface RecipeMeta {
  mealType: string | null
  protein: string | null
  base: string | null
  cuisine: string | null
  effort: string | null
  cookMethod: string | null
  flavorProfile: string | null
  dietary: string[]
  vegetables: string[]
  collection: string | null
}

// A saved recipe in the household library (powers the "+" picker & Explore).
export interface Recipe extends RecipeMeta {
  id: string
  title: string
  emoji: string | null
  description: string | null
  category: string | null
  tags: string[] | null
  prepTimeMinutes: number | null
  cookTimeMinutes: number | null
  servings: number
  imageUrl: string | null
  storageKey: string | null
  sourceName: string | null
  isFavorite: boolean
  cookedCount: number
  lastCookedAt: string | null
}

export interface PlanSlot {
  date: string
  mealType: string
  recipeId?: string | null
  title?: string | null
  cookPersonId?: string | null
}

export interface RecipeDetail extends RecipeMeta {
  id: string
  title: string
  emoji: string | null
  description: string | null
  category: string | null
  tags: string[] | null
  prepTimeMinutes: number | null
  cookTimeMinutes: number | null
  servings: number
  imageUrl: string | null
  storageKey: string | null
  sourceName: string | null
  isFavorite: boolean
  cookedCount: number
  lastCookedAt: string | null
  notes: string | null
  userNotes: string | null
  addedTags: string[]
  overrides: RecipeOverrides
}

export interface RecipeOverrides {
  meta?: Partial<Record<'mealType' | 'protein' | 'base' | 'cuisine' | 'effort' | 'cookMethod' | 'flavorProfile', string>>
  dietary?: string[]
  addedTags?: string[]
  removedTags?: string[]
  subs?: Record<string, string>
  stepNotes?: Record<string, string>
}

export interface RecipeIngredient {
  id: string
  name: string
  amount: number | null
  unit: string | null
  prepNote: string | null
  display: string | null
  section: string | null
  aisle: string | null
  isStaple: boolean
  sortOrder: number | null
  sub: string | null
}

export interface RecipeStep {
  stepNumber: number
  instruction: string
  ingredients: string[]
  note: string | null
  timerSeconds: number | null
}

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

export interface PlanWeekRequest {
  start: string
  mealType?: string
  dates?: string[]
  cookingFor?: number | null
  keepInMind?: string | null
  useUp?: string[]
  avoidTitles?: string[]
  wantToTry?: string[] // specific new dishes the family wants to try this week
  trySomethingNew?: boolean // nudge the plan toward at least one brand-new dish
}

export interface PlanMonthRequest {
  start: string
  weekdays?: number[]
  skipDates?: string[]
  dates?: string[]
  cookingFor?: number | null
  keepInMind?: string | null
  useUp?: string[]
  avoidTitles?: string[]
  allowRepeats?: boolean
  repeatGapDays?: number
  weekdayThemes?: Record<string, string>
  weeknightMaxMin?: number | null
  leftovers?: boolean
}

export interface MealCalendarSettings {
  addToCalendar: boolean
  pushToGoogle: boolean
  calendarPersonId: string | null
  participantIds: string[] | null
  times: Record<string, string>
  durationMinutes: number
  // Same-day "pull it out of the freezer" reminder for planned meals.
  prepReminder: boolean
  prepReminderTime: string // 'HH:MM'
  prepReminderMealTypes: string[]
}

export const mealsApi = {
  mealsWeek: (start: string, days?: number) =>
    apiGet<{ start: string; entries: WeekEntry[] }>(`/api/meals/week?start=${start}${days ? `&days=${days}` : ''}`),
  calendarSettings: () => apiGet<{ settings: MealCalendarSettings }>('/api/meals/calendar-settings').then((r) => r.settings),
  setCalendarSettings: (patch: Partial<MealCalendarSettings>) =>
    apiSend<{ settings: MealCalendarSettings }>('PUT', '/api/meals/calendar-settings', patch).then((r) => r.settings),
  entry: (id: string) => apiGet<{ recipeId: string | null; title: string | null }>(`/api/meals/entry/${id}`),
  planWeek: (req: PlanWeekRequest) =>
    apiSend<{ start: string; mealType: string; suggestions: PlanCard[]; via: string; error?: string }>('POST', '/api/meals/plan-week', req),
  planMonth: (req: PlanMonthRequest) =>
    apiSend<{ start: string; mealType: string; suggestions: PlanCard[]; via: string; error?: string; existing?: PlanCard[] }>('POST', '/api/meals/plan-month', req),
  recipes: () => apiGet<{ recipes: Recipe[] }>('/api/recipes'),
  // Distinct ingredient-section names across the household's recipes (most-used first)
  // — feeds the editor's section-name suggestions.
  recipeSections: () => apiGet<{ sections: string[] }>('/api/recipes/sections'),
  recipe: (id: string) =>
    apiGet<{
      recipe: RecipeDetail
      ingredients: RecipeIngredient[]
      steps: RecipeStep[]
      onHand?: OnHandCount | null
      toBuy?: number
      toBuyNames?: string[]
    }>(`/api/recipes/${id}`),
  // Compile a recipe into the blessed Markdown format for sharing (native share sheet /
  // clipboard / .md download). Returns the markdown text + a suggested filename.
  recipeMarkdown: (id: string) =>
    apiGet<{ markdown: string; filename: string }>(`/api/recipes/${id}/markdown`),
  planSlot: (slot: PlanSlot) => apiSend<{ entry: WeekEntry }>('POST', '/api/meals/plan', slot).then(tap('meals')),
  clearSlot: (date: string, mealType: string) =>
    apiDelete(`/api/meals/plan?date=${date}&mealType=${mealType}`).then(tap('meals')),
  // Quiet variants don't tap the refetch bus — used mid-swap so two writes don't
  // each trigger a refetch (which would briefly show the half-swapped state).
  planSlotQuiet: (slot: PlanSlot) => apiSend<{ entry: WeekEntry }>('POST', '/api/meals/plan', slot),
  clearSlotQuiet: (date: string, mealType: string) =>
    apiDelete(`/api/meals/plan?date=${date}&mealType=${mealType}`),
  updateRecipe: (
    id: string,
    patch: RecipeWriteInput & { isFavorite?: boolean; rating?: number; userNotes?: string; overrides?: RecipeOverrides },
  ) => apiSend<{ recipe: RecipeDetail }>('PATCH', `/api/recipes/${id}`, patch).then((r) => r.recipe),
  markCooked: (id: string) => apiSend<{ recipe: RecipeDetail }>('POST', `/api/recipes/${id}/cooked`).then((r) => r.recipe),
  // Recently-opened recipes — the caller's own, or the whole household's.
  recentRecipes: (scope: RecentScope, limit?: number) =>
    apiGet<{ recipes: Recipe[]; scope: RecentScope }>(
      `/api/recipes/recent?scope=${scope}${limit ? `&limit=${limit}` : ''}`
    ),
  // Record that this recipe was opened. Deliberately swallows failures: this is
  // telemetry for a convenience rail, and it must never surface as an error on the
  // recipe the user is trying to read.
  recordRecipeView: (id: string): void => {
    void apiSend('POST', `/api/recipes/${id}/view`).catch(() => {})
  },
  createRecipe: (input: RecipeWriteInput & { title: string }) =>
    apiSend<{ recipe: RecipeDetail }>('POST', '/api/recipes', input).then(tap('recipes')).then((r) => r.recipe),
  deleteRecipe: (id: string) => apiDelete(`/api/recipes/${id}`).then(tap('recipes')),
  parseMarkdown: (markdown: string) => apiSend<ParsedRecipe>('POST', '/api/recipes/parse-markdown', { markdown }),
  // Which AI import paths this household can use: `text` (speech/free-form → recipe)
  // needs any provider; `vision` (photo → recipe) needs a vision-capable model.
  ingestConfig: () => apiGet<{ text: boolean; vision: boolean }>('/api/recipes/ingest/config'),
  // Free-form spoken/typed description → structured recipe draft (does NOT save).
  ingestVoice: (text: string) => apiSend<ParsedRecipe>('POST', '/api/recipes/ingest/voice', { text }),
  // Photo(s) of a physical recipe → structured recipe draft (does NOT save). Source
  // photos are held server-side briefly then auto-deleted.
  ingestPhoto: (images: Array<{ data: string; contentType: string }>) =>
    apiSend<ParsedRecipe>('POST', '/api/recipes/ingest/photo', { images }),
  suggestMetadata: (input: { title: string; ingredients: string[]; steps: string[] }) =>
    apiSend<{ suggestion: RecipeMetadataSuggestion | null; via: string; error?: string }>('POST', '/api/recipes/suggest-metadata', input),
}

export interface MealsState {
  entries: WeekEntry[]
  loading: boolean
  error: boolean
  refetch: () => void
  mutate: (fn: (prev: WeekEntry[]) => WeekEntry[]) => void // optimistic local update
}

// Loads one planned week starting at `start` (YYYY-MM-DD). Refetch after a
// plan/clear so the grid reflects the mutation.
export function useMealsWeek(start?: string, days?: number): MealsState {
  const day = start ?? localToday()
  const [state, setState] = useState<Omit<MealsState, 'refetch' | 'mutate'>>({ entries: [], loading: true, error: false })
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((n) => n + 1), [])
  const mutate = useCallback((fn: (prev: WeekEntry[]) => WeekEntry[]) => setState((s) => ({ ...s, entries: fn(s.entries) })), [])
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    mealsApi
      .mealsWeek(day, days)
      .then((d) => alive && setState({ entries: d.entries, loading: false, error: false }))
      .catch(() => alive && setState({ entries: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [day, days, nonce])
  useRefetchOn(['meals'], refetch)
  return { ...state, refetch, mutate }
}

export interface RecipesState {
  recipes: Recipe[]
  loading: boolean
  error: boolean
}

/** Whose history a recently-viewed list reflects. */
export type RecentScope = 'me' | 'household'

/**
 * Record that a recipe was opened, for the "Recently viewed" rail.
 *
 * Belongs to the recipe *screen*, deliberately NOT to `useRecipe` — that hook is
 * also what the editor and Cook Mode fetch through, and counting those would fill
 * the rail with recipes nobody browsed. This mirrors iOS, which records in
 * `RecipeDetailView.task`.
 *
 * Keyed on `id` alone: a refetch after an edit is the same visit.
 */
export function useRecordRecipeView(id: string | null): void {
  useEffect(() => {
    if (!id) return
    mealsApi.recordRecipeView(id)
  }, [id])
}

export interface RecentRecipesState extends RecipesState {
  scope: RecentScope
  setScope: (s: RecentScope) => void
}

// Recently-opened recipes, newest first. The scope choice is per-device (it's a
// viewing preference, not household config) and remembered so the rail comes back
// the way you left it.
const RECENT_SCOPE_KEY = 'waffled.recentRecipesScope'

export function useRecentRecipes(limit = 12): RecentRecipesState {
  const [scope, setScopeState] = useState<RecentScope>(() =>
    (typeof localStorage !== 'undefined' && localStorage.getItem(RECENT_SCOPE_KEY)) === 'household'
      ? 'household'
      : 'me'
  )
  const [state, setState] = useState<RecipesState>({ recipes: [], loading: true, error: false })
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((n) => n + 1), [])

  const setScope = useCallback((s: RecentScope) => {
    setScopeState(s)
    try {
      localStorage.setItem(RECENT_SCOPE_KEY, s)
    } catch {
      // private mode / storage disabled — the choice just won't persist
    }
  }, [])

  useEffect(() => {
    let alive = true
    mealsApi
      .recentRecipes(scope, limit)
      .then((d) => alive && setState({ recipes: d.recipes, loading: false, error: false }))
      .catch(() => alive && setState({ recipes: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [scope, limit, nonce])
  // A newly-opened recipe (or a deleted one) should reorder the rail on return.
  useRefetchOn(['recipes'], refetch)
  return { ...state, scope, setScope }
}

export function useRecipes(): RecipesState {
  const [state, setState] = useState<RecipesState>({ recipes: [], loading: true, error: false })
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((n) => n + 1), [])
  useEffect(() => {
    let alive = true
    mealsApi
      .recipes()
      .then((d) => alive && setState({ recipes: d.recipes, loading: false, error: false }))
      .catch(() => alive && setState({ recipes: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [nonce])
  useRefetchOn(['recipes'], refetch)
  return state
}

export interface RecipeState {
  recipe: RecipeDetail | null
  ingredients: RecipeIngredient[]
  steps: RecipeStep[]
  // Real, pantry-derived shopping numbers. `onHand` is null when the pantry module
  // is off — render no on-hand claim at all rather than a misleading zero.
  onHand: OnHandCount | null
  toBuy: number
  // The ingredients behind `toBuy`. With the pantry ON these are the *unmatched*
  // subset, which is why they have to come from the server — the ingredient list
  // alone can't tell you which ones the pantry already covered.
  toBuyNames: string[]
  loading: boolean
  error: boolean
  refetch: () => void
}

export function useRecipe(id: string | null): RecipeState {
  const [state, setState] = useState<Omit<RecipeState, 'refetch'>>({
    recipe: null,
    ingredients: [],
    steps: [],
    onHand: null,
    toBuy: 0,
    toBuyNames: [],
    loading: true,
    error: false,
  })
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((n) => n + 1), [])
  useEffect(() => {
    if (!id) return
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    mealsApi
      .recipe(id)
      .then(
        (d) =>
          alive &&
          setState({
            recipe: d.recipe,
            ingredients: d.ingredients,
            steps: d.steps ?? [],
            onHand: d.onHand ?? null,
            toBuy: d.toBuy ?? 0,
            toBuyNames: d.toBuyNames ?? [],
            loading: false,
            error: false,
          }),
      )
      .catch(() => alive && setState({ recipe: null, ingredients: [], steps: [], onHand: null, toBuy: 0, toBuyNames: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [id, nonce])
  return { ...state, refetch }
}
