// "Cook from your pantry" — sidebar card + modal. Deterministic recipe↔pantry
// matching (server): "Ready now" (nothing to buy) + "You have the main" (proteins
// you have on hand → chips that jump to the recipe library filtered to that protein).
// Plus "Use these up" — meal-flagged + soon-to-expire items that need no recipe.
// Only shown when the meals module is on.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { pantryApi, useHousehold, type CookableRecipe, type PantryMain } from '../../lib/api'
import { moduleEnabled } from '../../lib/modules'

export interface EatUpItem { name: string; expiresOn: string | null; isMeal: boolean }

export function CookFromPantry({ eatUp, useSoon }: { eatUp: EatUpItem[]; useSoon: string[] }) {
  const { household } = useHousehold()
  const mealsOn = moduleEnabled(household, 'meals')
  const [cook, setCook] = useState<{ ready: CookableRecipe[]; mains: PantryMain[] } | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => { if (mealsOn) pantryApi.cookable().then(setCook).catch(() => {}) }, [mealsOn])
  if (!mealsOn) return null

  const ready = cook?.ready ?? []
  const mains = cook?.mains ?? []
  if (!ready.length && !mains.length && !eatUp.length) return null

  return (
    <div className="pl-cook">
      <div className="pl-cook-h">🍳 Cook from your pantry</div>
      <div className="pl-cook-sub">
        {ready.length > 0 && <><b>{ready.length}</b> ready to make</>}
        {ready.length > 0 && mains.length > 0 && ' · '}
        {mains.length > 0 && <><b>{mains.length}</b> main{mains.length === 1 ? '' : 's'} on hand</>}
        {(ready.length > 0 || mains.length > 0) && eatUp.length > 0 && ' · '}
        {eatUp.length > 0 && <><b>{eatUp.length}</b> to use up</>}
      </div>
      <button type="button" className="pill pl-cook-btn" onClick={() => setOpen(true)}>Plan from pantry</button>
      {open && <CookModal ready={ready} mains={mains} eatUp={eatUp} useSoon={useSoon} onClose={() => setOpen(false)} />}
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
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function CookModal({ ready, mains, eatUp, useSoon, onClose }: {
  ready: CookableRecipe[]; mains: PantryMain[]; eatUp: EatUpItem[]; useSoon: string[]; onClose: () => void
}) {
  const navigate = useNavigate()

  function planMyWeek() {
    if (useSoon.length) sessionStorage.setItem('nook.planUseUp', JSON.stringify(useSoon.slice(0, 12)))
    navigate('/meals')
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

        {mains.length > 0 && (
          <>
            <div className="pl-cookm-h">You have the main</div>
            <div className="pl-cookm-chips">
              {mains.map((m) => (
                <button type="button" key={m.protein} className="pl-cookm-chip" onClick={() => navigate(`/meals/recipes?protein=${encodeURIComponent(m.protein)}`)}>
                  {cap(m.protein)} <span className="pl-cookm-chip-n">{m.count}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="pl-cookm-h">Ready now — nothing to buy</div>
        {ready.length === 0 ? (
          <div className="pl-cookm-empty">Nothing fully on hand yet.</div>
        ) : (
          <div className="pl-cookm-list">
            {ready.map((r) => (
              <button type="button" key={r.recipeId} className="pl-cookm-row" onClick={() => navigate(`/meals/recipe/${r.recipeId}`)}>
                <span className="pl-cookm-emoji">{r.emoji ?? '🍽️'}</span>
                <span className="pl-cookm-name">{r.title}{r.usesExpiring && <span className="pl-cookm-need">uses something soon</span>}</span>
                <span className="pl-cookm-go">›</span>
              </button>
            ))}
          </div>
        )}

        <div className="pl-cookm-foot"><button type="button" className="pill" onClick={onClose}>Done</button></div>
      </div>
    </div>
  )
}
