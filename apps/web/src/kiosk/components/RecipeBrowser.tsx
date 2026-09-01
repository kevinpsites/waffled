import { Suspense, lazy, useEffect, useState } from 'react'
import { RecipeModal } from './RecipeModal'
import { MealCard } from './MealCard'
import { mealBuilderApi, type Meal, type Recipe } from '../../lib/api'

// The full editor, opened in a modal over the picker. Lazy so picking a recipe
// doesn't pay for the editor's weight (it's one of the heavier screens) until you
// actually decide to write one.
const RecipeEditorBody = lazy(() =>
  import('../RecipeEditor').then((m) => ({ default: m.RecipeEditorBody }))
)

// Shared meal-type vocabulary + the category→gradient mapping, used by the meal
// planner grid and the recipe browser.
export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'] as const
export type MealType = (typeof MEALS)[number]
export const MEAL_LABEL: Record<string, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
}
const GRAD_BY_CATEGORY: Record<string, string> = {
  breakfast: 'g-pan',
  lunch: 'g-veg',
  dinner: 'g-pasta',
  snack: 'g-cookie',
  dessert: 'g-cookie',
}
export function gradClass(r: { category: string | null }): string {
  return (r.category && GRAD_BY_CATEGORY[r.category.toLowerCase()]) || 'g-veg'
}

// Saved meals for the picker, searched server-side (`q` matches the plate name OR
// any dish title). Only fetched when the caller can actually put a plate somewhere —
// `enabled` is false for the plan-my-week/month draft overlays, which hold an
// unsaved plan and have nowhere to schedule a meal to.
function useBrowserMeals(enabled: boolean, q: string): Meal[] {
  const [meals, setMeals] = useState<Meal[]>([])
  useEffect(() => {
    if (!enabled) {
      setMeals([])
      return
    }
    let alive = true
    const run = () => {
      mealBuilderApi
        .list(q.trim() || undefined)
        .then((m) => alive && setMeals(m ?? []))
        .catch(() => alive && setMeals([]))
    }
    // Debounce only while typing; the first load shouldn't wait.
    const t = setTimeout(run, q.trim() ? 200 : 0)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [enabled, q])
  return meals
}

// The reusable recipe browser body: meal-type filters + a card grid + a View
// preview (RecipeModal). Used full-screen inside MealPicker and inside the
// plan-my-week manual-swap overlay. Without onView, View opens the modal preview.
//
// A saved meal can be picked anywhere a recipe can (decision 11), so the grid also
// lists plates — but only when `onPickMeal` is supplied. The target date lives in
// the caller's `onPick` closure and is never passed down here, so scheduling a plate
// has to happen where the date is; a caller that can't do that simply doesn't
// advertise meals.
export function RecipeBrowser({
  recipes,
  loading,
  slot,
  onPick,
  onPickMeal,
  onView,
  onEatingOut,
  onLeftovers,
  onTrySomething,
  selectLabel,
}: {
  recipes: Recipe[]
  loading: boolean
  slot?: MealType
  onPick?: (recipe: Recipe) => void
  onPickMeal?: (meal: Meal) => void
  onView?: (recipe: Recipe) => void
  onEatingOut?: () => void
  onLeftovers?: () => void
  onTrySomething?: () => void
  selectLabel?: string
}) {
  const browse = !onPick
  const [filter, setFilter] = useState<'all' | MealType>(browse ? 'all' : slot ?? 'dinner')
  const [q, setQ] = useState('')
  const [preview, setPreview] = useState<Recipe | null>(null)
  // Writing a recipe from inside the picker. The slot being filled lives in the
  // caller's onPick closure, so the new recipe is handed straight back through it —
  // the picker never navigates, and a draft plan behind it survives untouched.
  const [creating, setCreating] = useState(false)
  const query = q.trim().toLowerCase()
  // Free-text search across title + metadata, then the meal-type filter chip.
  const matchesQuery = (r: Recipe) =>
    !query ||
    [r.title, r.cuisine, r.protein, r.base, r.cookMethod, r.category, ...(r.tags ?? []), ...(r.vegetables ?? []), ...(r.dietary ?? []), r.collection]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(query)
  const shown = recipes.filter((r) => (filter === 'all' || !r.category || r.category.toLowerCase() === filter) && matchesQuery(r))
  const FILTERS: Array<'all' | MealType> = ['all', ...MEALS]
  // A plate has no breakfast/lunch/dinner category of its own, so the meal-type
  // chips leave saved meals alone — they show whenever meals are on offer.
  const meals = useBrowserMeals(!!onPickMeal, q)

  return (
    <div className="meals-picker">
      <div className="picker-search">
        <input className="cal-search" placeholder="Search recipes by name, cuisine, ingredient…" value={q} onChange={(e) => setQ(e.target.value)} />
        {/* Browsing the library? It has its own New recipe button in the topbar. */}
        {!browse && (
          <button type="button" className="btn btn-primary picker-new" onClick={() => setCreating(true)}>
            ＋ New recipe
          </button>
        )}
      </div>
      <div className="picker-filters">
        {FILTERS.map((f) => (
          <div key={f} className={`mp-filter tag ${f === filter ? 'on' : ''}`} onClick={() => setFilter(f)} role="button" tabIndex={0}>
            {f === 'all' ? 'All' : MEAL_LABEL[f]}
          </div>
        ))}
        <div className="tiny muted picker-count">
          {shown.length} {filter === 'all' ? 'recipe' : MEAL_LABEL[filter].toLowerCase() + ' idea'}
          {shown.length === 1 ? '' : 's'}
        </div>
      </div>

      <div className="picker-grid">
        {onEatingOut && (
          <div className="rc mp-card" role="button" tabIndex={0} onClick={onEatingOut}>
            <div className="rc-img" style={{ background: 'linear-gradient(135deg,#d9e7f6,#bcd0e9)', fontSize: 34, display: 'grid', placeItems: 'center' }}>🍴</div>
            <div className="rc-b" style={{ padding: '12px 14px 14px' }}>
              <div className="rc-t" style={{ fontSize: 16 }}>Eating out</div>
              <div className="rc-m"><span>No cooking tonight</span></div>
              <div className="mp-actions">
                <button type="button" className="pill btn-primary mp-select" onClick={(e) => { e.stopPropagation(); onEatingOut() }}>Select</button>
              </div>
            </div>
          </div>
        )}
        {onLeftovers && (
          <div className="rc mp-card" role="button" tabIndex={0} onClick={onLeftovers}>
            <div className="rc-img" style={{ background: 'linear-gradient(135deg,#f0e6d2,#e0cfa8)', fontSize: 34, display: 'grid', placeItems: 'center' }}>🥡</div>
            <div className="rc-b" style={{ padding: '12px 14px 14px' }}>
              <div className="rc-t" style={{ fontSize: 16 }}>Leftovers</div>
              <div className="rc-m"><span>Finish up a previous meal</span></div>
              <div className="mp-actions">
                <button type="button" className="pill btn-primary mp-select" onClick={(e) => { e.stopPropagation(); onLeftovers() }}>Select</button>
              </div>
            </div>
          </div>
        )}
        {onTrySomething && (
          <div className="rc mp-card" role="button" tabIndex={0} onClick={onTrySomething}>
            <div className="rc-img" style={{ background: 'linear-gradient(135deg,#efdcf3,#d9bce9)', fontSize: 34, display: 'grid', placeItems: 'center' }}>✨</div>
            <div className="rc-b" style={{ padding: '12px 14px 14px' }}>
              <div className="rc-t" style={{ fontSize: 16 }}>Try something new</div>
              <div className="rc-m"><span>Cook a brand-new dish</span></div>
              <div className="mp-actions">
                <button type="button" className="pill btn-primary mp-select" onClick={(e) => { e.stopPropagation(); onTrySomething() }}>Select</button>
              </div>
            </div>
          </div>
        )}
        {/* Saved plates — put a whole meal on the slot without a builder round-trip. */}
        {onPickMeal &&
          meals.map((m) => (
            <MealCard
              key={m.id}
              meal={m}
              className="mp-card"
              onOpen={() => onPickMeal(m)}
              onSelect={() => onPickMeal(m)}
              selectLabel={selectLabel ?? 'Select'}
            />
          ))}
        {loading && <div className="muted picker-empty">Loading recipes…</div>}
        {!loading && shown.length === 0 && meals.length === 0 && (
          <div className="muted picker-empty">
            {filter === 'all' ? 'No recipes yet.' : `No ${MEAL_LABEL[filter].toLowerCase()} recipes yet — tag a recipe with this meal to see it here.`}
          </div>
        )}
        {shown.map((r) => (
          <div key={r.id} className="rc mp-card" role="button" tabIndex={0} onClick={() => (onView ? onView(r) : setPreview(r))}>
            <div className={`rc-img ${gradClass(r)}`}>{r.emoji ?? '🍽️'}</div>
            <div className="rc-b" style={{ padding: '12px 14px 14px' }}>
              <div className="rc-t" style={{ fontSize: 16 }}>{r.title}</div>
              <div className="rc-m">
                {r.cookTimeMinutes != null && <span>🕐 {r.cookTimeMinutes} min</span>}
                {r.category && <span>{r.category}</span>}
              </div>
              <div className="mp-actions">
                <button type="button" className="pill" onClick={(e) => { e.stopPropagation(); onView ? onView(r) : setPreview(r) }}>View</button>
                {onPick && (
                  <button type="button" className="pill btn-primary mp-select" onClick={(e) => { e.stopPropagation(); onPick(r) }}>Select</button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {preview && (
        <RecipeModal
          recipeId={preview.id}
          onClose={() => setPreview(null)}
          onSelect={onPick ? () => onPick(preview) : undefined}
          selectLabel={onPick ? selectLabel ?? 'Select' : undefined}
        />
      )}

      {creating && onPick && (
        <div className="modal-overlay">
          <div className="modal-card picker-new-card" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="modal-close" aria-label="Close" onClick={() => setCreating(false)}>×</button>
            <div className="wf-serif picker-new-h">New recipe</div>
            <Suspense fallback={<div className="muted" style={{ padding: 30 }}>Loading…</div>}>
              <RecipeEditorBody
                mode="create"
                // Saving fills the slot with what was just written — that's the whole
                // point of creating from here, so there's no second "now select it".
                onSaved={(saved) => { setCreating(false); onPick(saved) }}
                onCancel={() => setCreating(false)}
              />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  )
}
