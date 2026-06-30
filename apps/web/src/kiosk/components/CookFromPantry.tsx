// "Cook from your pantry" — the sidebar card + modal. Deterministic recipe↔pantry
// matching (server). "Plan from pantry" lists what you can make now and can hand the
// soon-to-expire items to the AI weekly planner (via a sessionStorage seed the Meals
// page reads). Only shown when the meals module is on.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { pantryApi, groceryApi, useHousehold, type CookableRecipe } from '../../lib/api'
import { moduleEnabled } from '../../lib/modules'

export function CookFromPantry({ useSoon }: { useSoon: string[] }) {
  const { household } = useHousehold()
  const mealsOn = moduleEnabled(household, 'meals')
  const [cook, setCook] = useState<{ makeable: CookableRecipe[]; nearly: CookableRecipe[] } | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => { if (mealsOn) pantryApi.cookable().then(setCook).catch(() => {}) }, [mealsOn])
  if (!mealsOn) return null

  const makeable = cook?.makeable ?? []
  if (!makeable.length && !useSoon.length) return null // nothing useful to surface yet

  return (
    <div className="pl-cook">
      <div className="pl-cook-h">🍳 Cook from your pantry</div>
      <div className="pl-cook-sub">
        {makeable.length > 0 && <><b>{makeable.length}</b> dinner{makeable.length === 1 ? '' : 's'} with nothing to buy</>}
        {makeable.length > 0 && useSoon.length > 0 && ' · '}
        {useSoon.length > 0 && <><b>{useSoon.length}</b> to use up</>}
      </div>
      <button type="button" className="pill pl-cook-btn" onClick={() => setOpen(true)}>Plan from pantry</button>
      {open && <CookModal cook={cook} useSoon={useSoon} onClose={() => setOpen(false)} />}
    </div>
  )
}

function CookModal({ cook, useSoon, onClose }: { cook: { makeable: CookableRecipe[]; nearly: CookableRecipe[] } | null; useSoon: string[]; onClose: () => void }) {
  const navigate = useNavigate()
  const [addedList, setAddedList] = useState<string | null>(null)
  const makeable = cook?.makeable ?? []
  const nearly = cook?.nearly ?? []

  function planMyWeek() {
    if (useSoon.length) sessionStorage.setItem('nook.planUseUp', JSON.stringify(useSoon.slice(0, 12)))
    navigate('/meals')
  }
  async function addMissing(r: CookableRecipe) {
    setAddedList(r.recipeId)
    try { await Promise.all(r.missing.map((m) => groceryApi.addGroceryItem(m))) } catch { /* ignore */ }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card pl-cookm" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="nk-serif pl-cookm-title">Cook from your pantry</div>

        {useSoon.length > 0 && (
          <button type="button" className="pill btn-primary pl-cookm-ai" style={{ color: '#fff', border: 0 }} onClick={planMyWeek}>
            ✨ Plan my week — use up {useSoon.length} soon-to-expire
          </button>
        )}

        <div className="pl-cookm-h">Make now — nothing to buy</div>
        {makeable.length === 0 ? (
          <div className="pl-cookm-empty">Nothing fully on hand yet. Scan or add a few more items.</div>
        ) : (
          <div className="pl-cookm-list">
            {makeable.map((r) => (
              <button type="button" key={r.recipeId} className="pl-cookm-row" onClick={() => navigate(`/meals/recipe/${r.recipeId}`)}>
                <span className="pl-cookm-emoji">{r.emoji ?? '🍽️'}</span>
                <span className="pl-cookm-name">{r.title}</span>
                {r.usesExpiring && <span className="pl-cookm-soon">uses soon</span>}
                <span className="pl-cookm-go">›</span>
              </button>
            ))}
          </div>
        )}

        {nearly.length > 0 && (
          <>
            <div className="pl-cookm-h">Almost — need a couple things</div>
            <div className="pl-cookm-list">
              {nearly.map((r) => (
                <div key={r.recipeId} className="pl-cookm-row near">
                  <span className="pl-cookm-emoji">{r.emoji ?? '🍽️'}</span>
                  <span className="pl-cookm-name">{r.title}<span className="pl-cookm-need">need {r.missing.join(', ')}</span></span>
                  <button type="button" className="pill pl-cookm-add" onClick={() => addMissing(r)}>{addedList === r.recipeId ? '✓ Added' : '+ List'}</button>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="pl-cookm-foot"><button type="button" className="pill" onClick={onClose}>Done</button></div>
      </div>
    </div>
  )
}
