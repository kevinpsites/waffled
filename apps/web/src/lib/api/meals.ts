// Meals & recipes domain — client slice, types, and hooks.
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete, localToday } from './client'
import { tap, useRefetchOn } from './bus'

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

export interface WeekEntry {
  id: string
  date: string
  mealType: string
  title: string | null
  recipeId: string | null
  cook: MealCook | null
  recipe: MealRecipe | null
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
  recipe: (id: string) =>
    apiGet<{ recipe: RecipeDetail; ingredients: RecipeIngredient[]; steps: RecipeStep[] }>(`/api/recipes/${id}`),
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
    patch: { isFavorite?: boolean; title?: string; rating?: number; userNotes?: string; overrides?: RecipeOverrides },
  ) => apiSend<{ recipe: RecipeDetail }>('PATCH', `/api/recipes/${id}`, patch).then((r) => r.recipe),
  markCooked: (id: string) => apiSend<{ recipe: RecipeDetail }>('POST', `/api/recipes/${id}/cooked`).then((r) => r.recipe),
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

export function useRecipes(): RecipesState {
  const [state, setState] = useState<RecipesState>({ recipes: [], loading: true, error: false })
  useEffect(() => {
    let alive = true
    mealsApi
      .recipes()
      .then((d) => alive && setState({ recipes: d.recipes, loading: false, error: false }))
      .catch(() => alive && setState({ recipes: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [])
  return state
}

export interface RecipeState {
  recipe: RecipeDetail | null
  ingredients: RecipeIngredient[]
  steps: RecipeStep[]
  loading: boolean
  error: boolean
  refetch: () => void
}

export function useRecipe(id: string | null): RecipeState {
  const [state, setState] = useState<Omit<RecipeState, 'refetch'>>({
    recipe: null,
    ingredients: [],
    steps: [],
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
      .then((d) => alive && setState({ recipe: d.recipe, ingredients: d.ingredients, steps: d.steps ?? [], loading: false, error: false }))
      .catch(() => alive && setState({ recipe: null, ingredients: [], steps: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [id, nonce])
  return { ...state, refetch }
}
