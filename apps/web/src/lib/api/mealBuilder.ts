// Meal Builder — a "plate" is a named, multi-recipe meal ("BBQ Sunday" = BBQ Chicken
// (main) + Potato Salad + Coleslaw (sides) + Peach Cobbler (dessert)). A plate can be
// scheduled into a meal-plan slot, or added to the grocery list on its own without
// ever being scheduled. See docs/product/meal-builder-plan.md.
//
// This slice is the shared contract every Meal Builder surface codes against — the
// builder screen, the meal detail, the unified library and the grocery board.
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'
import { tap, useRefetchOn } from './bus'
import type { MealCook } from './meals'

// Pantry-derived, and therefore absent when the pantry module is off. `null` means
// "we can't say" — render nothing. It is deliberately NOT `{have: 0, total: n}`,
// which would read as "you have none of these", a different and equally untrue claim.
export interface OnHandCount {
  have: number
  total: number
}

// One dish on the plate. `role` is free text ('main' | 'side' | 'dessert' today) —
// soft scaffolding to help people compose, not a rigid taxonomy, so new roles are a
// data change rather than a migration. Note it is NOT `mealType`, which already means
// breakfast/lunch/dinner/snack elsewhere in this codebase.
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
  // Who cooks THIS dish — a four-dish plate has up to four cooks.
  cook: MealCook | null
  onHand: OnHandCount | null
  toBuy: number
}

// The full plate. The builder screen, the meal detail and the library card all read
// this same shape.
export interface Meal {
  id: string
  name: string
  // Stored and displayed only — v1 deliberately does not rescale ingredient
  // quantities (see decision 4 in the plan).
  servings: number
  // The "Save to reuse" toggle. An unsaved plate is a one-off and never appears in
  // the library; a saved one is a reusable template.
  isSaved: boolean
  createdBy: string | null
  createdAt: string
  recipeCount: number
  emojis: string[]
  totalMinutes: number | null
  // Plate-level counts dedupe shared ingredients across dishes — two dishes both
  // wanting mayonnaise is one thing to buy.
  onHand: OnHandCount | null
  toBuy: number
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

  // The saved-meal library. `q` matches the plate name OR any dish title, so
  // searching "chicken" finds "BBQ Sunday".
  list: (q?: string, limit?: number) => {
    const qs = new URLSearchParams()
    if (q) qs.set('q', q)
    if (limit) qs.set('limit', String(limit))
    const suffix = qs.toString()
    return apiGet<{ meals: Meal[] }>(`/api/meals${suffix ? `?${suffix}` : ''}`).then((r) => r.meals)
  },

  get: (id: string) => apiGet<{ meal: Meal }>(`/api/meals/${id}`).then((r) => r.meal),

  update: (id: string, patch: MealWriteInput) =>
    apiSend<{ meal: Meal }>('PATCH', `/api/meals/${id}`, patch).then(tap('meals')).then((r) => r.meal),

  remove: (id: string) => apiDelete(`/api/meals/${id}`).then(tap('meals')),

  addDish: (id: string, input: AddDishInput) =>
    apiSend<{ meal: Meal }>('POST', `/api/meals/${id}/recipes`, input).then((r) => r.meal),

  // Adding a SAVED plate to the plate under construction flattens it — its dishes
  // come in as individual, editable rows. Meals never nest (decision 12).
  flattenInto: (id: string, mealId: string) =>
    apiSend<{ meal: Meal }>('POST', `/api/meals/${id}/recipes`, { mealId }).then((r) => r.meal),

  reorder: (id: string, recipeIds: string[]) =>
    apiSend<{ meal: Meal }>('PUT', `/api/meals/${id}/recipes/order`, { recipeIds }).then((r) => r.meal),

  patchDish: (id: string, recipeId: string, patch: DishPatch) =>
    apiSend<{ meal: Meal }>('PATCH', `/api/meals/${id}/recipes/${recipeId}`, patch).then((r) => r.meal),

  removeDish: (id: string, recipeId: string) =>
    apiSend<{ meal: Meal }>('DELETE', `/api/meals/${id}/recipes/${recipeId}`).then((r) => r.meal),

  // Scheduling a SAVED plate copies it, so editing the library plate never rewrites
  // a meal that already happened. Unsaved one-offs are scheduled as themselves.
  schedule: (id: string, input: ScheduleMealInput) =>
    apiSend<{ entry: { id: string; date: string; mealType: string; mealId: string | null }; meal: Meal }>(
      'POST',
      `/api/meals/${id}/schedule`,
      input,
    ).then(tap('meals')),

  // "Add plate to list" — put the whole plate's shopping on the grocery list without
  // scheduling it anywhere. Double-gated on the lists module server-side.
  addToList: (id: string, weekStart?: string) =>
    apiSend<{ added: number; weekStart: string }>(
      'POST',
      `/api/meals/${id}/add-to-list${weekStart ? `?weekStart=${weekStart}` : ''}`,
    ).then(tap('grocery')),
}

export interface SavedMealsState {
  meals: Meal[]
  loading: boolean
  error: boolean
  refetch: () => void
}

// The saved-meal library, optionally filtered by a search query. Debounce `q` at the
// call site if it's wired straight to a text input.
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
  // Optimistic local update — every mutation above returns the whole plate, so a
  // builder edit can paint immediately with `set(updated)` instead of refetching.
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
