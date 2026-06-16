import { useState } from 'react'
import { RecipeModal } from './RecipeModal'
import { type Recipe } from '../../lib/api'

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

// The reusable recipe browser body: meal-type filters + a card grid + a View
// preview (RecipeModal). Used full-screen inside MealPicker and inside the
// plan-my-week manual-swap overlay. Without onView, View opens the modal preview.
export function RecipeBrowser({
  recipes,
  loading,
  slot,
  onPick,
  onView,
  onEatingOut,
  selectLabel,
}: {
  recipes: Recipe[]
  loading: boolean
  slot?: MealType
  onPick?: (recipe: Recipe) => void
  onView?: (recipe: Recipe) => void
  onEatingOut?: () => void
  selectLabel?: string
}) {
  const browse = !onPick
  const [filter, setFilter] = useState<'all' | MealType>(browse ? 'all' : slot ?? 'dinner')
  const [preview, setPreview] = useState<Recipe | null>(null)
  // 'all' shows everything; a meal filter shows recipes tagged with it (or untagged,
  // which fit any slot).
  const shown = filter === 'all' ? recipes : recipes.filter((r) => !r.category || r.category.toLowerCase() === filter)
  const FILTERS: Array<'all' | MealType> = ['all', ...MEALS]

  return (
    <div className="meals-picker">
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
        {loading && <div className="muted picker-empty">Loading recipes…</div>}
        {!loading && shown.length === 0 && (
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
    </div>
  )
}
