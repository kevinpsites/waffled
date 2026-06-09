// Meals & recipes domain — client slice, types, and hooks.
import { useEffect, useState } from 'react'
import { apiGet, localToday } from './client'

export interface MealRecipe {
  title: string | null
  emoji: string | null
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
  recipe: MealRecipe | null
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
  recipe: (id: string) =>
    apiGet<{ recipe: RecipeDetail; ingredients: RecipeIngredient[] }>(`/api/recipes/${id}`),
}

export interface MealsState {
  entries: WeekEntry[]
  loading: boolean
  error: boolean
}

export function useMealsWeek(): MealsState {
  const [state, setState] = useState<MealsState>({ entries: [], loading: true, error: false })
  useEffect(() => {
    let alive = true
    mealsApi
      .mealsWeek(localToday())
      .then((d) => alive && setState({ entries: d.entries, loading: false, error: false }))
      .catch(() => alive && setState({ entries: [], loading: false, error: true }))
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
