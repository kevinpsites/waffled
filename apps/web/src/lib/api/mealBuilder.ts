// Meal Builder — a "plate" is a named, multi-recipe meal. It can be scheduled into a
// meal-plan slot, or added to the grocery list without ever being scheduled. This slice is
// the shared contract every Meal Builder surface codes against.
// See docs/product/meal-builder-plan.md.
import { useCallback, useEffect, useState } from 'react'
import { apiDelete, apiGet, apiSend } from './client'
import { tap, useRefetchOn } from './bus'
import type { MealCook } from './meals'

// Pantry-derived, so absent when the pantry module is off. `null` means "we can't say" —
// render nothing. Deliberately NOT `{have: 0, total: n}`, which claims something else.
export interface OnHandCount {
  have: number
  total: number
}

// One dish on the plate. `role` is free text ('main' | 'side' | 'dessert' today), so new
// roles are a data change rather than a migration. NOT `mealType`, which already means
// breakfast/lunch/dinner/snack elsewhere.
export interface MealDish {
  recipeId: string
  title: string | null
  emoji: string | null
  category: string | null
  role: string
  sortOrder: number
  prepTimeMinutes: number | null
  cookTimeMinutes: number | null
  servings: number | null
  imageUrl: string | null
  cook: MealCook | null
  onHand: OnHandCount | null
  toBuy: number
  // Always exactly `toBuy` long, pantry on or off.
  toBuyNames: string[]
}

export interface Meal {
  id: string
  name: string
  // Stored and displayed only: v1 deliberately does not rescale ingredient quantities.
  servings: number
  // Applied the moment it is flipped, not deferred until the plate is scheduled: an
  // unsaved plate is a one-off and never appears in the library.
  isSaved: boolean
  createdBy: string | null
  createdAt: string
  recipeCount: number
  emojis: string[]
  totalMinutes: number | null
  // Plate-level counts dedupe shared ingredients across dishes.
  onHand: OnHandCount | null
  toBuy: number
  toBuyNames: string[]
  recipes: MealDish[]
}

export interface MealWriteInput {
  name?: string
  servings?: number
  isSaved?: boolean
}

export interface AddDishInput {
  recipeId: string
  role?: string
  sortOrder?: number
  cookPersonId?: string | null
}

export interface DishPatch {
  role?: string
  sortOrder?: number
  cookPersonId?: string | null
}

export interface ScheduleMealInput {
  date: string
  mealType: string
  cookPersonId?: string | null
}

export const mealBuilderApi = {
  create: (input: MealWriteInput & { name: string }) =>
    apiSend<{ meal: Meal }>('POST', '/api/meals', input).then(tap('meals')).then((r) => r.meal),

  list: (q?: string, limit?: number) => {
    const qs = new URLSearchParams()
    if (q) qs.set('q', q)
    if (limit) qs.set('limit', String(limit))
    const suffix = qs.toString()
    return apiGet<{ meals: Meal[] }>(`/api/meals${suffix ? `?${suffix}` : ''}`).then((r) => r.meals)
  },

  get: (id: string) => apiGet<{ meal: Meal }>(`/api/meals/${id}`).then((r) => r.meal),

  // Soft-delete a plate. The plate is created lazily on the first dish, so without this
  // a cancelled build leaves a saved, empty plate in the library.
  remove: (id: string) => apiDelete(`/api/meals/${id}`).then(tap('meals')),

  update: (id: string, patch: MealWriteInput) =>
    apiSend<{ meal: Meal }>('PATCH', `/api/meals/${id}`, patch).then(tap('meals')).then((r) => r.meal),

  addDish: (id: string, input: AddDishInput) =>
    apiSend<{ meal: Meal }>('POST', `/api/meals/${id}/recipes`, input).then((r) => r.meal),

  // Adding a SAVED plate flattens it into individual rows: meals never nest.
  flattenInto: (id: string, mealId: string) =>
    apiSend<{ meal: Meal }>('POST', `/api/meals/${id}/recipes`, { mealId }).then((r) => r.meal),

  reorder: (id: string, recipeIds: string[]) =>
    apiSend<{ meal: Meal }>('PUT', `/api/meals/${id}/recipes/order`, { recipeIds }).then((r) => r.meal),

  patchDish: (id: string, recipeId: string, patch: DishPatch) =>
    apiSend<{ meal: Meal }>('PATCH', `/api/meals/${id}/recipes/${recipeId}`, patch).then((r) => r.meal),

  removeDish: (id: string, recipeId: string) =>
    apiSend<{ meal: Meal }>('DELETE', `/api/meals/${id}/recipes/${recipeId}`).then((r) => r.meal),

  // Scheduling a SAVED plate copies it, so editing the library plate never rewrites a
  // meal that already happened; unsaved one-offs are scheduled as themselves.
  schedule: (id: string, input: ScheduleMealInput) =>
    apiSend<{ entry: { id: string; date: string; mealType: string; mealId: string | null }; meal: Meal }>(
      'POST',
      `/api/meals/${id}/schedule`,
      input,
    ).then(tap('meals')),

  addToList: (id: string, weekStart?: string) =>
    apiSend<{ added: number; weekStart: string }>(
      'POST',
      `/api/meals/${id}/add-to-list${weekStart ? `?weekStart=${weekStart}` : ''}`,
    ).then(tap('grocery')),

  // Off-plan rows are source='recipe', which the weekly rebuild never wipes, so this is
  // the ONLY way a plate comes back off the list.
  removeFromList: (id: string, weekStart?: string) =>
    apiSend<{ removed: number; weekStart: string }>(
      'DELETE',
      `/api/meals/${id}/add-to-list${weekStart ? `?weekStart=${weekStart}` : ''}`,
    ).then(tap('grocery')),
}

export interface SavedMealsState {
  meals: Meal[]
  loading: boolean
  error: boolean
  refetch: () => void
}

export function useSavedMeals(q?: string): SavedMealsState {
  const [state, setState] = useState<Omit<SavedMealsState, 'refetch'>>({ meals: [], loading: true, error: false })
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((n) => n + 1), [])
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    mealBuilderApi
      .list(q)
      .then((meals) => alive && setState({ meals, loading: false, error: false }))
      .catch(() => alive && setState({ meals: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [q, nonce])
  useRefetchOn(['meals', 'recipes'], refetch)
  return { ...state, refetch }
}

export interface MealState {
  meal: Meal | null
  loading: boolean
  error: boolean
  refetch: () => void
  // Every mutation above returns the whole plate, so an edit paints with `set(updated)`
  // instead of refetching.
  set: (meal: Meal) => void
}

export function useMeal(id: string | null): MealState {
  const [state, setState] = useState<Omit<MealState, 'refetch' | 'set'>>({ meal: null, loading: !!id, error: false })
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((n) => n + 1), [])
  const set = useCallback((meal: Meal) => setState({ meal, loading: false, error: false }), [])
  useEffect(() => {
    if (!id) {
      setState({ meal: null, loading: false, error: false })
      return
    }
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    mealBuilderApi
      .get(id)
      .then((meal) => alive && setState({ meal, loading: false, error: false }))
      .catch(() => alive && setState({ meal: null, loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [id, nonce])
  return { ...state, refetch, set }
}
