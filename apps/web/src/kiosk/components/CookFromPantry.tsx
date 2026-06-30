// "Cook from your pantry" — sidebar card + modal. Deterministic recipe↔pantry
// matching (server): "Ready now" (nothing to buy) + "You have the main" (the
// recipe's protein is on hand, lean into it even if missing sides). Plus "Use these
// up" — meal-flagged + soon-to-expire pantry items that need no recipe (frozen
// leftovers, a pre-made dinner, an orphan protein). Only shown when meals is on.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { pantryApi, groceryApi, useHousehold, type CookableRecipe } from '../../lib/api'
import { moduleEnabled } from '../../lib/modules'

export interface EatUpItem { name: string; expiresOn: string | null; isMeal: boolean }

export function CookFromPantry({ eatUp, useSoon }: { eatUp: EatUpItem[]; useSoon: string[] }) {
  const { household } = useHousehold()
  const mealsOn = moduleEnabled(household, 'meals')
  const [cook, setCook] = useState<{ ready: CookableRecipe[]; haveMain: CookableRecipe[] } | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => { if (mealsOn) pantryApi.cookable().then(setCook).catch(() => {}) }, [mealsOn])
  if (!mealsOn) return null

  const ready = cook?.ready ?? []
  const haveMain = cook?.haveMain ?? []
  if (!ready.length && !haveMain.length && !eatUp.length) return null

  return (
    <div className="pl-cook">
      <div className="pl-cook-h">🍳 Cook from your pantry</div>
      <div className="pl-cook-sub">
        {ready.length > 0 && <><b>{ready.length}</b> ready to make</>}
        {ready.length > 0 && haveMain.length > 0 && ' · '}
        {haveMain.length > 0 && <><b>{haveMain.length}</b> with the main</>}
        {(ready.length > 0 || haveMain.length > 0) && eatUp.length > 0 && ' · '}
        {eatUp.length > 0 && <><b>{eatUp.length}</b> to use up</>}
      </div>
      <button type="button" className="pill pl-cook-btn" onClick={() => setOpen(true)}>Plan from pantry</button>
      {open && <CookModal ready={ready} haveMain={haveMain} eatUp={eatUp} useSoon={useSoon} onClose={() => setOpen(false)} />}
    </div>
  )
}

function expiryNote(d: string | null): string {
  if (!d) return ''
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const days = Math.round((new Date(`${d}T00:00:00`).getTime() - today.getTime()) / 86_400_000)
  if (days < 0) return 'expired'
  if (days === 0) return 'use today'
  if (days <= 3) return `${days}d left`
  return `best by ${d}`
}

function CookModal({ ready, haveMain, eatUp, useSoon, onClose }: {
  ready: CookableRecipe[]; haveMain: CookableRecipe[]; eatUp: EatUpItem[]; useSoon: string[]; onClose: () => void
}) {
  const navigate = useNavigate()
  const [added, setAdded] = useState<string | null>(null)

  function planMyWeek() {
    if (useSoon.length) sessionStorage.setItem('nook.planUseUp', JSON.stringify(useSoon.slice(0, 12)))
    navigate('/meals')
  }
  async function addMissing(r: CookableRecipe) {
    setAdded(r.recipeId)
    try { await Promise.all(r.missing.map((m) => groceryApi.addGroceryItem(m))) } catch { /* ignore */ }
  }

  const RecipeRow = ({ r, showMissing }: { r: CookableRecipe; showMissing?: boolean }) => (
    <div className="pl-cookm-row near">
      <button type="button" className="pl-cookm-open" onClick={() => navigate(`/meals/recipe/${r.recipeId}`)}>
        <span className="pl-cookm-emoji">{r.emoji ?? '🍽️'}</span>
        <span className="pl-cookm-name">
          {r.title}
          {showMissing
            ? <span className="pl-cookm-need">{r.mainItem ? `uses your ${r.mainItem} · ` : ''}need {r.missing.join(', ')}</span>
            : r.usesExpiring ? <span className="pl-cookm-need">uses something soon</span> : null}
        </span>
      </button>
      {showMissing
        ? <button type="button" className="pill pl-cookm-add" onClick={() => addMissing(r)}>{added === r.recipeId ? '✓ Added' : '+ List'}</button>
        : <span className="pl-cookm-go" onClick={() => navigate(`/meals/recipe/${r.recipeId}`)}>›</span>}
    </div>
  )

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

        {eatUp.length > 0 && (
          <>
            <div className="pl-cookm-h">Use these up</div>
            <div className="pl-cookm-list">
              {eatUp.map((e) => (
                <div key={e.name + (e.expiresOn ?? '')} className="pl-cookm-row near">
                  <span className="pl-cookm-emoji">{e.isMeal ? '🍱' : '⏳'}</span>
                  <span className="pl-cookm-name">{e.name}{(e.isMeal || e.expiresOn) && <span className="pl-cookm-need">{[e.isMeal ? 'ready to eat' : '', expiryNote(e.expiresOn)].filter(Boolean).join(' · ')}</span>}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="pl-cookm-h">Ready now — nothing to buy</div>
        {ready.length === 0 ? (
          <div className="pl-cookm-empty">Nothing fully on hand yet.</div>
        ) : (
          <div className="pl-cookm-list">{ready.map((r) => <RecipeRow key={r.recipeId} r={r} />)}</div>
        )}

        {haveMain.length > 0 && (
          <>
            <div className="pl-cookm-h">You have the main</div>
            <div className="pl-cookm-list">{haveMain.map((r) => <RecipeRow key={r.recipeId} r={r} showMissing />)}</div>
          </>
        )}

        <div className="pl-cookm-foot"><button type="button" className="pill" onClick={onClose}>Done</button></div>
      </div>
    </div>
  )
}
