// Meal Builder — compose a named, multi-recipe plate, then schedule it or send it
// straight to the grocery list. See docs/product/meal-builder-plan.md.
//
// WAVE 1 SHELL: this file exists so the route registration in routes.tsx compiles
// and so the API contract can be exercised end-to-end. The real builder UI (role
// drop zones, drag-and-drop from the library drawer, the search bar, the footer
// stats bar) is Wave 2 Agent A's work and replaces the body below.
import { useParams } from 'react-router'
import { useMeal } from '../lib/api'
import '../styles/mealbuilder.css'

export function MealBuilder() {
  const { id } = useParams()
  const { meal, loading, error } = useMeal(id ?? null)

  if (loading) return <div className="mb-shell" />
  if (error) return <div className="mb-shell mb-empty">Couldn’t load that meal.</div>

  return (
    <div className="mb-shell">
      <h1 className="mb-title">{meal?.name ?? 'New meal'}</h1>
      {meal ? (
        <p className="mb-stats">
          Serves {meal.servings} · {meal.recipeCount} {meal.recipeCount === 1 ? 'recipe' : 'recipes'}
          {meal.onHand ? ` · ${meal.onHand.have}/${meal.onHand.total} on hand` : ''}
          {` · ${meal.toBuy} to buy`}
        </p>
      ) : null}
    </div>
  )
}
