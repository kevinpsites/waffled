// "Cook from your pantry" — sidebar card + modal. Five sections (per the mock):
//   • Plan my week (AI) — seeds the weekly planner with soon-to-expire items
//   • Tonight · no cooking — your meal-flagged items (heat & serve / ready to eat)
//   • You have everything — recipes makeable now (Cook + checked ingredient chips)
//   • You have the main — grouped by an on-hand protein; top recipes + what's missing;
//     the group taps through to the recipe library filtered to that protein
//   • Use up soon — loose soon-to-expire items (not meals, not a main)
// Deterministic matching lives server-side; only shown when the meals module is on.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { pantryApi, groceryApi, mealsApi, daysUntil, useHousehold, type PantryItem, type CookReady, type CookMain } from '../../lib/api'
import { MEALS, MEAL_LABEL } from './RecipeBrowser'
import { moduleEnabled } from '../../lib/modules'

const PROTEIN_EMOJI: Record<string, string> = {
  pork: '🐖', beef: '🥩', chicken: '🍗', turkey: '🦃', fish: '🐟', shrimp: '🦐', seafood: '🦐',
  tofu: '🧈', lamb: '🍖', sausage: '🥓', egg: '🥚',
}
const proteinEmoji = (p: string) => PROTEIN_EMOJI[p.toLowerCase()] ?? '🍖'

function expiryNote(d: string | null): string {
  if (!d) return ''
  const days = daysUntil(d)
  if (days == null) return ''
  if (days < 0) return 'expired'
  if (days === 0) return 'use today'
  if (days === 1) return '1 day'
  return `${days} days`
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
function dayLabel(d: string): string {
  if (d === new Date().toISOString().slice(0, 10)) return 'today'
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' })
}
const isSoon = (i: PantryItem) => { const d = daysUntil(i.expiresOn); return d != null && d <= 3 }

export function CookFromPantry({ items, onChanged }: { items: PantryItem[]; onChanged?: () => void }) {
  const { household } = useHousehold()
  const mealsOn = moduleEnabled(household, 'meals')
  const [cook, setCook] = useState<{ ready: CookReady[]; mains: CookMain[] } | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => { if (mealsOn) pantryApi.cookable().then(setCook).catch(() => {}) }, [mealsOn])
  if (!mealsOn) return null

  const ready = cook?.ready ?? []
  const mains = cook?.mains ?? []
  const meals = items.filter((i) => i.isMeal)
  const useSoon = items.filter(isSoon).map((i) => i.name)
  if (!ready.length && !mains.length && !meals.length && !useSoon.length) return null

  return (
    <div className="pl-cook">
      <div className="pl-cook-h">🍳 Cook from your pantry</div>
      <div className="pl-cook-sub">
        {ready.length > 0 && <><b>{ready.length}</b> ready</>}
        {ready.length > 0 && mains.length > 0 && ' · '}
        {mains.length > 0 && <><b>{mains.length}</b> main{mains.length === 1 ? '' : 's'}</>}
        {(ready.length > 0 || mains.length > 0) && (meals.length + useSoon.length) > 0 && ' · '}
        {(meals.length + useSoon.length) > 0 && <><b>{meals.length + useSoon.length}</b> to use up</>}
      </div>
      <button type="button" className="pill pl-cook-btn" onClick={() => setOpen(true)}>Plan from pantry</button>
      {open && <CookModal items={items} ready={ready} mains={mains} onClose={() => setOpen(false)} onChanged={onChanged} />}
    </div>
  )
}

function Dots({ have, total }: { have: number; total: number }) {
  return (
    <span className="pl-dots" aria-label={`have ${have} of ${total}`}>
      {Array.from({ length: Math.min(total, 6) }).map((_, i) => <span key={i} className={`pl-dot${i < have ? ' on' : ''}`} />)}
    </span>
  )
}

function CookModal({ items, ready, mains, onClose, onChanged }: { items: PantryItem[]; ready: CookReady[]; mains: CookMain[]; onClose: () => void; onChanged?: () => void }) {
  const navigate = useNavigate()
  const [added, setAdded] = useState<Set<string>>(new Set())
  // Leftovers you've eaten (marked used-up) — hidden immediately, refetched on close.
  const [eaten, setEaten] = useState<Set<string>>(new Set())
  async function ateIt(item: PantryItem) {
    setEaten((s) => new Set(s).add(item.id))
    try { await pantryApi.consume([{ id: item.id, mode: 'used_up' }]) } catch { /* ignore */ }
    onChanged?.()
  }
  // Planning a meal-flagged item into a slot (tonight or another day/meal).
  const today = new Date().toISOString().slice(0, 10)
  const [planFor, setPlanFor] = useState<string | null>(null)
  const [planDate, setPlanDate] = useState(today)
  const [planMeal, setPlanMeal] = useState('dinner')
  // What's already on the plan (by free-text title → date), so a leftover that's been
  // scheduled shows "Planned" across reopens and we don't double-add it.
  const [plannedMap, setPlannedMap] = useState<Record<string, string>>({})
  useEffect(() => {
    mealsApi.mealsWeek(today, 21).then((d) => {
      const m: Record<string, string> = {}
      for (const e of d.entries) if (e.title && e.date >= today) m[e.title.trim().toLowerCase()] = e.date
      setPlannedMap(m)
    }).catch(() => {})
  }, [today])
  const plannedDate = (item: PantryItem) => plannedMap[item.name.trim().toLowerCase()]

  async function planItem(item: PantryItem) {
    try { await mealsApi.planSlot({ date: planDate, mealType: planMeal, title: item.name }) } catch { /* ignore */ }
    setPlannedMap((m) => ({ ...m, [item.name.trim().toLowerCase()]: planDate }))
    setPlanFor(null)
  }

  const meals = items.filter((i) => i.isMeal && !eaten.has(i.id))
  const useSoonNames = items.filter(isSoon).map((i) => i.name)
  const mainNames = new Set(mains.map((m) => m.item?.name).filter(Boolean) as string[])
  const loose = items.filter((i) => !i.isMeal && isSoon(i) && !mainNames.has(i.name))

  function planMyWeek() {
    if (useSoonNames.length) sessionStorage.setItem('nook.planUseUp', JSON.stringify(useSoonNames.slice(0, 12)))
    navigate('/meals')
  }
  async function addMissing(key: string, missing: string[]) {
    setAdded((s) => new Set(s).add(key))
    try { await Promise.all(missing.map((m) => groceryApi.addGroceryItem(m))) } catch { /* ignore */ }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card pl-cookm" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="nk-serif pl-cookm-title">Cook from your pantry</div>

        <button type="button" className="pl-cookm-plan" onClick={planMyWeek}>
          <span className="pl-cookm-plan-ic">✨</span>
          <span className="pl-cookm-plan-t">
            <b>Plan my week</b>
            <span>{useSoonNames.length > 0 ? `Builds your week & uses up ${useSoonNames.length} before they spoil` : 'Build your dinners with AI'}</span>
          </span>
          <span className="pl-cookm-go">›</span>
        </button>

        {meals.length > 0 && (
          <section className="pl-sec">
            <div className="pl-sec-h"><span>🕘 Tonight · no cooking</span></div>
            {meals.map((m) => {
              const heat = (m.location ?? '').toLowerCase().includes('freez')
              return (
                <div key={m.id} className="pl-cookm-card">
                  <span className="pl-cookm-thumb">{m.imageUrl ? <img src={m.imageUrl} alt="" /> : '🍱'}</span>
                  <div className="pl-cookm-cardmain">
                    <div className="pl-cookm-cardrow">
                      <span className="pl-cookm-cardname">{m.name}</span>
                      <span className="pl-cookm-cardacts">
                        <button type="button" className="pl-ate-btn" onClick={() => ateIt(m)}>Ate it</button>
                        <button type="button" className={`pl-plan-btn${plannedDate(m) ? ' done' : ''}`} onClick={() => { if (plannedDate(m)) { navigate('/meals'); return } setPlanDate(today); setPlanMeal('dinner'); setPlanFor(planFor === m.id ? null : m.id) }}>
                          {plannedDate(m) ? `✓ Planned ${dayLabel(plannedDate(m)!)}` : 'Plan'}
                        </button>
                      </span>
                    </div>
                    <div className="pl-cookm-badges">
                      <span className="pl-badge green">{heat ? 'Heat & serve' : 'Ready to eat'}</span>
                      {m.expiresOn && <span className="pl-badge amber">{expiryNote(m.expiresOn)} left</span>}
                    </div>
                    {(m.note || m.amount) && <div className="pl-cookm-cardsub">{m.note || [m.amount, m.unit, m.location].filter(Boolean).join(' ')}</div>}
                    {planFor === m.id && (
                      <div className="pl-plan-pick">
                        <select value={planMeal} onChange={(e) => setPlanMeal(e.target.value)} aria-label="Meal">
                          {MEALS.map((mt) => <option key={mt} value={mt}>{MEAL_LABEL[mt]}</option>)}
                        </select>
                        <input type="date" value={planDate} onChange={(e) => setPlanDate(e.target.value)} aria-label="Day" />
                        <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} onClick={() => planItem(m)}>Add to plan</button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </section>
        )}

        {ready.length > 0 && (
          <section className="pl-sec">
            <div className="pl-sec-h"><span>✓ You have everything</span><span className="pl-sec-r">Nothing to buy</span></div>
            {ready.map((r) => (
              <div key={r.recipeId} className="pl-cookm-card">
                <button type="button" className="pl-cookm-thumb btn" onClick={() => navigate(`/meals/recipe/${r.recipeId}`)}>{r.emoji ?? '🍽️'}</button>
                <div className="pl-cookm-cardmain">
                  <div className="pl-cookm-cardrow">
                    <span className="pl-cookm-cardname">{r.title}</span>
                    <button type="button" className="pl-cook-go" onClick={() => navigate(`/meals/recipe/${r.recipeId}/cook`)}>Cook</button>
                  </div>
                  {r.expiringItem && <div className="pl-cookm-uses">Uses {r.expiringItem} due soon</div>}
                  <div className="pl-chips">{r.have.map((h) => <span key={h} className="pl-chip ok">✓ {h}</span>)}</div>
                </div>
              </div>
            ))}
          </section>
        )}

        {mains.length > 0 && (
          <section className="pl-sec">
            <div className="pl-sec-h"><span>📈 You have the main</span><span className="pl-sec-r">A few things to grab</span></div>
            {mains.map((m) => {
              const soon = m.item && isSoonDate(m.item.expiresOn)
              return (
                <div key={m.protein} className="pl-main">
                  <button type="button" className="pl-main-head" onClick={() => navigate(`/meals/recipes?protein=${encodeURIComponent(m.protein)}`)}>
                    <span className="pl-main-emoji">{proteinEmoji(m.protein)}</span>
                    <span className="pl-main-name">{m.item?.name ?? cap(m.protein)}</span>
                    <span className={`pl-main-meta${soon ? ' soon' : ''}`}>
                      {m.item && [
                        m.item.amount && `${m.item.amount}${m.item.unit ? ' ' + m.item.unit : ''}`,
                        m.item.expiresOn ? ((daysUntil(m.item.expiresOn) ?? 99) <= 0 ? expiryNote(m.item.expiresOn) : `use in ${expiryNote(m.item.expiresOn)}`) : '',
                      ].filter(Boolean).join(' · ')}
                    </span>
                    <span className="pl-main-all">{m.count} recipes ›</span>
                  </button>
                  {m.recipes.map((rec) => {
                    const key = m.protein + rec.recipeId
                    return (
                      <div key={rec.recipeId} className="pl-main-rec">
                        <button type="button" className="pl-main-rec-main" onClick={() => navigate(`/meals/recipe/${rec.recipeId}`)}>
                          <span className="pl-main-rec-name">{rec.title}</span>
                          <span className="pl-main-rec-prog"><Dots have={rec.have} total={rec.total} /> Have {rec.have} of {rec.total} · need {rec.missing.length <= 1 ? (rec.missing[0] ?? '—') : rec.missing.length}</span>
                        </button>
                        <button type="button" className="pill pl-cookm-add" onClick={() => addMissing(key, rec.missing)}>{added.has(key) ? '✓ Added' : '+ List'}</button>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </section>
        )}

        {loose.length > 0 && (
          <section className="pl-sec">
            <div className="pl-sec-h"><span>🗑 Use up soon</span><span className="pl-sec-r">Loose items</span></div>
            <div className="pl-loose">
              {loose.map((i) => (
                <span key={i.id} className="pl-loose-chip">{i.name}<span className="pl-loose-exp">{expiryNote(i.expiresOn)}</span></span>
              ))}
            </div>
          </section>
        )}

        <div className="pl-cookm-foot"><button type="button" className="pill" onClick={onClose}>Done</button></div>
      </div>
    </div>
  )
}

function isSoonDate(d: string | null): boolean { const x = daysUntil(d); return x != null && x <= 1 }
