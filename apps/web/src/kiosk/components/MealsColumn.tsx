import { useState } from 'react'
import { Icon } from '../icons'
import { api, useMealsWeek, localToday, type WeekEntry, type MealRecipe } from '../../lib/api'

function dayAbbrev(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short' })
}

function TonightCard({ recipe, recipeId }: { recipe: MealRecipe; recipeId: string | null }) {
  const [status, setStatus] = useState<'idle' | 'adding' | 'added'>('idle')
  const [added, setAdded] = useState(0)

  async function toList() {
    if (!recipeId || status === 'adding') return
    setStatus('adding')
    try {
      const r = await api.groceryFromRecipe(recipeId)
      setAdded(r.added)
      setStatus('added')
    } catch {
      setStatus('idle')
    }
  }

  const toListLabel =
    status === 'added' ? `Added ${added}` : status === 'adding' ? 'Adding…' : 'To list'

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 112, background: 'linear-gradient(135deg,#f6d9c6,#e9b596)', position: 'relative' }}>
        <div style={{ position: 'absolute', right: 12, top: 10, fontSize: 34 }}>{recipe.emoji ?? '🍽️'}</div>
      </div>
      <div style={{ padding: '14px 16px 15px' }}>
        <div className="tiny" style={{ color: 'var(--lottie)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>
          Tonight · Dinner
        </div>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, margin: '3px 0 6px' }}>
          {recipe.title}
        </div>
        <div className="tiny muted" style={{ display: 'flex', gap: 14 }}>
          {recipe.cookTimeMinutes != null && <span>🕐 {recipe.cookTimeMinutes} min</span>}
          {recipe.servings != null && <span>🍽️ Serves {recipe.servings}</span>}
        </div>
        {/* TODO: wire when the recipe-detail screen (View) and grocery auto-build
            (To list) land — see ROADMAP 6.3. Disabled until then, not dead-clickable. */}
        <div style={{ display: 'flex', gap: 9, paddingTop: 13 }}>
          <button
            className="btn btn-ghost"
            disabled
            title="Recipe view — coming soon"
            style={{ flex: 1, justifyContent: 'center', fontSize: 14, padding: 10, opacity: 0.5, cursor: 'not-allowed' }}
          >
            View recipe
          </button>
          <button
            className="btn btn-primary"
            onClick={toList}
            disabled={!recipeId || status !== 'idle'}
            title="Add this recipe's ingredients to the grocery list"
            style={{
              flex: 1,
              justifyContent: 'center',
              fontSize: 14,
              padding: 10,
              cursor: !recipeId || status !== 'idle' ? 'default' : 'pointer',
              opacity: !recipeId ? 0.5 : 1,
            }}
          >
            <Icon name="bag" />
            {toListLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function TonightEmpty() {
  return (
    <div className="card" style={{ padding: '18px 20px' }}>
      <div className="tiny" style={{ color: 'var(--lottie)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>
        Tonight · Dinner
      </div>
      <div className="muted" style={{ fontSize: 14, padding: '8px 0' }}>Nothing planned for tonight.</div>
    </div>
  )
}

export function MealsColumn() {
  const { entries, loading, error } = useMealsWeek()
  const dinners = entries.filter((e) => e.mealType === 'dinner')
  const tonight = dinners.find((e) => e.date === localToday()) ?? null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
      {tonight?.recipe ? (
        <TonightCard recipe={tonight.recipe} recipeId={tonight.recipeId} />
      ) : (
        <TonightEmpty />
      )}

      <div className="card" style={{ padding: '15px 18px 8px', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
          <div className="card-h" style={{ fontSize: 16 }}>
            This week’s dinners
          </div>
          <div style={{ marginLeft: 'auto' }} className="tiny muted">
            {dinners.length} planned
          </div>
        </div>
        {loading && <div className="tiny muted" style={{ padding: '6px 0' }}>Loading…</div>}
        {error && <div className="tiny muted" style={{ padding: '6px 0' }}>Sign this kiosk in to see meals.</div>}
        {!loading && !error && dinners.length === 0 && (
          <div className="tiny muted" style={{ padding: '6px 0' }}>No dinners planned yet.</div>
        )}
        {dinners.map((e: WeekEntry) => (
          <div
            key={e.id}
            style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '6px 0', borderBottom: '1px solid var(--hair-2)' }}
          >
            <div className="tiny" style={{ width: 34, fontWeight: 700, color: 'var(--ink-2)' }}>
              {dayAbbrev(e.date)}
            </div>
            <div style={{ fontSize: 16, width: 22, textAlign: 'center' }}>{e.recipe?.emoji ?? '🍽️'}</div>
            <div style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{e.recipe?.title ?? e.title ?? 'Planned'}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
