// Loading the dishes of a Meal Builder plate for Cook Mode. A plate ("BBQ Sunday")
// is several recipes cooked side by side, so cook mode needs every dish's steps and
// ingredients up front — the tab strip shows each dish's own "Step 2 of 4" whether
// or not you've opened that tab yet.
//
// See docs/product/meal-builder-plan.md → Cook Mode.
import { useEffect, useState } from 'react'
import { mealBuilderApi, mealsApi, type RecipeIngredient, type RecipeStep } from '../../lib/api'

// One dish on the plate, flattened into just what cook mode renders.
export interface CookDish {
  recipeId: string
  title: string
  emoji: string | null
  ingredients: RecipeIngredient[]
  steps: RecipeStep[]
}

export interface CookPlateState {
  name: string | null
  dishes: CookDish[]
  loading: boolean
  error: boolean
}

// Fetch the plate, then every dish's recipe. `allSettled`, deliberately: one deleted
// or unreadable recipe should cost you that dish, not the whole plate.
export function useCookPlate(mealId: string | null): CookPlateState {
  const [state, setState] = useState<CookPlateState>({
    name: null,
    dishes: [],
    loading: !!mealId,
    error: false,
  })

  useEffect(() => {
    if (!mealId) {
      setState({ name: null, dishes: [], loading: false, error: true })
      return
    }
    let alive = true
    setState({ name: null, dishes: [], loading: true, error: false })
    void (async () => {
      try {
        const meal = await mealBuilderApi.get(mealId)
        const loaded = await Promise.allSettled(meal.recipes.map((d) => mealsApi.recipe(d.recipeId)))
        if (!alive) return
        const dishes: CookDish[] = []
        meal.recipes.forEach((d, k) => {
          const r = loaded[k]
          if (r.status !== 'fulfilled') return
          dishes.push({
            recipeId: d.recipeId,
            title: d.title ?? r.value.recipe.title,
            emoji: d.emoji ?? r.value.recipe.emoji,
            ingredients: r.value.ingredients ?? [],
            steps: r.value.steps ?? [],
          })
        })
        setState({ name: meal.name, dishes, loading: false, error: false })
      } catch {
        if (alive) setState({ name: null, dishes: [], loading: false, error: true })
      }
    })()
    return () => {
      alive = false
    }
  }, [mealId])

  return state
}
