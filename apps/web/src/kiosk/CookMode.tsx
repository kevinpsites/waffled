import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useTopbarFull } from './topbar-slot'
import { mealsApi, useRecipe } from '../lib/api'
import './../styles/cookmode.css'

// Full-screen, step-by-step cooking view for the kiosk — large type for across-the-
// kitchen reading, one step at a time, the step's ingredients pulled out, and a
// screen wake-lock so the tablet doesn't sleep mid-recipe.
export function CookMode() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { recipe, ingredients, steps, loading, error } = useRecipe(id ?? null)
  const [i, setI] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const [done, setDone] = useState(false)
  const wakeRef = useRef<{ release: () => void } | null>(null)

  // Keep the kiosk awake while cooking; release on unmount.
  useEffect(() => {
    let cancelled = false
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => void }> } }
    nav.wakeLock?.request('screen').then((s) => {
      if (cancelled) s.release()
      else wakeRef.current = s
    }).catch(() => {})
    return () => {
      cancelled = true
      wakeRef.current?.release()
    }
  }, [])

  const total = steps.length
  // Replace (not push) the cook-mode history entry with the recipe so pressing
  // back from the recipe goes to wherever you came from (Today, the meal plan)
  // instead of bouncing back into cook mode — that round-trip was an endless loop.
  const exit = () => navigate(`/meals/recipe/${id}`, { replace: true })

  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button className="pill" style={{ cursor: 'pointer' }} onClick={exit}>✕ Exit cook mode</button>
        <div className="cm-top-title nk-serif">{recipe?.title ?? ''}</div>
        <div style={{ marginLeft: 'auto' }} className="cm-top-prog tiny muted">
          {total > 0 && !done ? `Step ${i + 1} of ${total}` : ''}
        </div>
      </div>
    ),
    [recipe?.title, i, total, done, id]
  )

  if (loading) return <div className="muted" style={{ padding: 30 }}>Loading…</div>
  if (error || !recipe) return <div className="muted" style={{ padding: 30 }}>This recipe isn’t available.</div>
  if (total === 0) return <div className="muted" style={{ padding: 30 }}>No steps recorded for this recipe — nothing to cook through.</div>

  function finish() {
    setDone(true)
    if (recipe) mealsApi.markCooked(recipe.id).catch(() => {})
  }

  if (done) {
    return (
      <div className="cookmode cm-done">
        <div className="cm-done-emoji">🎉</div>
        <div className="nk-serif cm-done-h">Nicely done.</div>
        <div className="muted cm-done-sub">“{recipe.title}” is marked as cooked.</div>
        <div className="cm-done-actions">
          <button className="btn btn-ghost" onClick={() => { setDone(false); setI(0) }}>↻ Start over</button>
          <button className="btn btn-primary" onClick={exit}>Back to recipe</button>
        </div>
      </div>
    )
  }

  const step = steps[i]
  const pct = Math.round(((i + 1) / total) * 100)

  return (
    <div className="cookmode">
      <div className="cm-progress"><span style={{ width: `${pct}%` }} /></div>

      <div className="cm-stage">
        <div className="cm-step-n">Step {i + 1}</div>
        <div className="cm-instruction nk-serif">{step.instruction}</div>

        {step.ingredients.length > 0 && (
          <div className="cm-ings">
            <div className="cm-ings-label">For this step</div>
            <div className="cm-ings-row">
              {step.ingredients.map((ig, k) => (
                <span key={k} className="cm-ing-chip">{ig}</span>
              ))}
            </div>
          </div>
        )}

        {step.note && <div className="cm-note">📝 {step.note}</div>}
      </div>

      <div className="cm-controls">
        <button className="cm-nav" disabled={i === 0} onClick={() => setI((n) => Math.max(0, n - 1))}>‹ Back</button>
        <button className="cm-allbtn" onClick={() => setShowAll(true)}>All ingredients</button>
        {i < total - 1 ? (
          <button className="cm-nav cm-next" onClick={() => setI((n) => Math.min(total - 1, n + 1))}>Next ›</button>
        ) : (
          <button className="cm-nav cm-finish" onClick={finish}>✓ Finish &amp; mark cooked</button>
        )}
      </div>

      {showAll && (
        <div className="modal-overlay" onClick={() => setShowAll(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <button type="button" className="modal-close" aria-label="Close" onClick={() => setShowAll(false)}>×</button>
            <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 12 }}>All ingredients</div>
            <div className="cm-all-list">
              {ingredients.map((ing) => (
                <div key={ing.id} className="cm-all-row">
                  <span className="cm-all-amt">{ing.amount != null ? `${ing.amount}${ing.unit ? ` ${ing.unit}` : ''}` : '—'}</span>
                  <span>{ing.sub ?? ing.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
