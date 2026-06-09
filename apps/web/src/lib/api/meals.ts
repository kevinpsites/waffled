// Meals & recipes domain — client slice, types, and hooks.
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete, localToday } from './client'

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

// A saved recipe in the household library (powers the "+" picker & Explore).
export interface Recipe {
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
}

export interface PlanSlot {
  date: string
  mealType: string
  recipeId?: string | null
  title?: string | null
  cookPersonId?: string | null
}

export interface RecipeDetail {
  id: string
  title: string
  emoji: string | null
  description: string | null
  prepTimeMinutes: number | null
  cookTimeMinutes: number | null
  servings: number
  sourceName: string | null
}

export interface RecipeIngredient {
  id: string
  name: string
  amount: number | null
  unit: string | null
  prepNote: string | null
  display: string | null
  section: string | null
  sortOrder: number | null
}

export const mealsApi = {
  mealsWeek: (start: string) => apiGet<{ start: string; entries: WeekEntry[] }>(`/api/meals/week?start=${start}`),
  recipes: () => apiGet<{ recipes: Recipe[] }>('/api/recipes'),
  recipe: (id: string) =>
    apiGet<{ recipe: RecipeDetail; ingredients: RecipeIngredient[] }>(`/api/recipes/${id}`),
  planSlot: (slot: PlanSlot) => apiSend<{ entry: WeekEntry }>('POST', '/api/meals/plan', slot),
  clearSlot: (date: string, mealType: string) =>
    apiDelete(`/api/meals/plan?date=${date}&mealType=${mealType}`),
}

export interface MealsState {
  entries: WeekEntry[]
  loading: boolean
  error: boolean
  refetch: () => void
}

// Loads one planned week starting at `start` (YYYY-MM-DD). Refetch after a
// plan/clear so the grid reflects the mutation.
export function useMealsWeek(start?: string): MealsState {
  const day = start ?? localToday()
  const [state, setState] = useState<Omit<MealsState, 'refetch'>>({ entries: [], loading: true, error: false })
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((n) => n + 1), [])
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    mealsApi
      .mealsWeek(day)
      .then((d) => alive && setState({ entries: d.entries, loading: false, error: false }))
      .catch(() => alive && setState({ entries: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [day, nonce])
  return { ...state, refetch }
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
  loading: boolean
  error: boolean
}

export function useRecipe(id: string | null): RecipeState {
  const [state, setState] = useState<RecipeState>({
    recipe: null,
    ingredients: [],
    loading: true,
    error: false,
  })
  useEffect(() => {
    if (!id) return
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    mealsApi
      .recipe(id)
      .then((d) => alive && setState({ recipe: d.recipe, ingredients: d.ingredients, loading: false, error: false }))
      .catch(() => alive && setState({ recipe: null, ingredients: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [id])
  return state
}
