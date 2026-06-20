import { Link, useNavigate } from 'react-router'
import { useMealsWeek, localToday, type WeekEntry } from '../../lib/api'

function dayAbbrev(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short' })
}

// A meal can be eating-out (no cooking) — detected from a recipe-less title.
export function isEatingOut(entry: { recipeId: string | null; title: string | null }): boolean {
  return !entry.recipeId && /\b(eating|eat|dining|going)\s*out|take\s*-?out|order(ing)?\s+in|delivery|takeaway\b/i.test(entry.title ?? '')
}

// Tonight's dinner — works whether it's a recipe, a recipe-less ("Fish") plan, or
// an eating-out night. Never vanishes when something is planned.
function TonightCard({ entry }: { entry: WeekEntry }) {
  const navigate = useNavigate()
  const recipe = entry.recipe
  const recipeId = entry.recipeId
  const title = recipe?.title ?? entry.title ?? 'Dinner'
  const eatingOut = isEatingOut(entry)
  const emoji = recipe?.emoji ?? (eatingOut ? '🍴' : '🍽️')

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 112, background: eatingOut ? 'linear-gradient(135deg,#d9e7f6,#bcd0e9)' : 'linear-gradient(135deg,#f6d9c6,#e9b596)', position: 'relative' }}>
        <div style={{ position: 'absolute', right: 12, top: 10, fontSize: 34 }}>{emoji}</div>
      </div>
      <div style={{ padding: '14px 16px 15px' }}>
        <div className="tiny" style={{ color: 'var(--lottie)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>
          Tonight · Dinner
        </div>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, margin: '3px 0 6px' }}>
          {eatingOut ? 'Eating out' : title}
        </div>

        {recipeId ? (
          <>
            <div className="tiny muted" style={{ display: 'flex', gap: 14 }}>
              {recipe?.cookTimeMinutes != null && <span>🕐 {recipe.cookTimeMinutes} min</span>}
              {recipe?.servings != null && <span>🍽️ Serves {recipe.servings}</span>}
            </div>
            <div style={{ display: 'flex', gap: 9, paddingTop: 13 }}>
              <button className="btn btn-ghost" onClick={() => navigate(`/meals/recipe/${recipeId}`)} style={{ flex: 1, justifyContent: 'center', fontSize: 14, padding: 10, cursor: 'pointer' }}>
                View recipe
              </button>
              <button className="btn btn-primary" onClick={() => navigate(`/meals/recipe/${recipeId}/cook`)} title="Start step-by-step cook mode" style={{ flex: 1, justifyContent: 'center', fontSize: 14, padding: 10, cursor: 'pointer' }}>
                👨‍🍳 Cook Mode
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="tiny muted" style={{ paddingBottom: 2 }}>
              {eatingOut ? 'No cooking tonight 🎉' : 'No recipe attached yet.'}
            </div>
            <div style={{ display: 'flex', gap: 9, paddingTop: 13 }}>
              <button className="btn btn-ghost" onClick={() => navigate('/meals')} style={{ flex: 1, justifyContent: 'center', fontSize: 14, padding: 10, cursor: 'pointer' }}>
                {eatingOut ? 'Change plan' : '🔎 Find a recipe'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// Tonight's dinner as a standalone Today card (self-fetching). Renders nothing
// when nothing is planned for today, so it can sit in the draggable board.
export function TonightCardSlot() {
  const { entries } = useMealsWeek()
  const tonight = entries.find((e) => e.mealType === 'dinner' && e.date === localToday()) ?? null
  if (!tonight) return null
  return <TonightCard entry={tonight} />
}

// "This week's dinners" as a standalone Today card (self-fetching).
export function WeekDinnersCard() {
  const navigate = useNavigate()
  const { entries, loading, error } = useMealsWeek()
  const dinners = entries.filter((e) => e.mealType === 'dinner')
  return (
    <div className="card" style={{ padding: '15px 18px 8px', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <Link to="/meals" className="card-h" style={{ fontSize: 16, textDecoration: 'none', color: 'inherit' }}>
          This week’s dinners
        </Link>
        <Link to="/meals" className="tiny muted" style={{ marginLeft: 'auto', textDecoration: 'none', color: 'var(--ink-2)' }}>
          {dinners.length} planned ›
        </Link>
      </div>
      {loading && <div className="tiny muted" style={{ padding: '6px 0' }}>Loading…</div>}
      {error && <div className="tiny muted" style={{ padding: '6px 0' }}>Sign this kiosk in to see meals.</div>}
      {!loading && !error && dinners.length === 0 && (
        <div className="tiny muted" style={{ padding: '6px 0' }}>No dinners planned yet.</div>
      )}
      {dinners.map((e: WeekEntry) => {
        const clickable = !!e.recipeId
        const out = isEatingOut(e)
        return (
          <div
            key={e.id}
            onClick={() => clickable && navigate(`/meals/recipe/${e.recipeId}`)}
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            title={clickable ? 'Open recipe' : undefined}
            style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '6px 0', borderBottom: '1px solid var(--hair-2)', cursor: clickable ? 'pointer' : 'default' }}
          >
            <div className="tiny" style={{ width: 34, fontWeight: 700, color: 'var(--ink-2)' }}>
              {dayAbbrev(e.date)}
            </div>
            <div style={{ fontSize: 16, width: 22, textAlign: 'center' }}>{e.recipe?.emoji ?? (out ? '🍴' : '🍽️')}</div>
            <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{out ? 'Eating out' : e.recipe?.title ?? e.title ?? 'Planned'}</div>
            {clickable && <div className="tiny muted" style={{ fontSize: 16 }}>›</div>}
          </div>
        )
      })}
    </div>
  )
}

// The original combined meals column (Tonight + week), composed from the two
// slots above. Kept for any non-customizable surface and the unit tests.
export function MealsColumn() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
      <TonightCardSlot />
      <WeekDinnersCard />
    </div>
  )
}
