import { useRef, useState } from 'react'
import { api, usePersons, useRecipes, type PlanCard, type Recipe } from '../../lib/api'
import { useTopbarFull } from '../topbar-slot'
import { Icon } from '../icons'
import { RecipeModal } from './RecipeModal'
import { RecipeBrowser, type MealType } from './RecipeBrowser'

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW1 = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const VIA_LABEL: Record<string, string> = { anthropic: 'Claude', openai: 'OpenAI', ollama: 'local LLM' }

// Must mirror MONTH_THEMES on the server (modules/meals/meals.service.ts).
const THEME_OPTS: Array<{ key: string; label: string }> = [
  { key: '', label: 'No theme' },
  { key: 'meatless', label: 'Meatless' },
  { key: 'tacos', label: 'Taco night' },
  { key: 'pizza', label: 'Pizza night' },
  { key: 'pasta', label: 'Pasta night' },
  { key: 'seafood', label: 'Seafood' },
  { key: 'soup', label: 'Soup & salad' },
  { key: 'breakfast', label: 'Breakfast for dinner' },
  { key: 'grill', label: 'Grill night' },
  { key: 'takeout', label: 'Takeout' },
  { key: 'leftovers', label: 'Leftovers' },
]

function friendlyAiError(msg: string): string {
  if (/no ai provider|not configured/i.test(msg)) return 'Pick an AI provider in Settings → AI & capture first.'
  if (/abort|timeout|timed out|ETIMEDOUT/i.test(msg)) return 'The model took too long — try a smaller pool, or switch to a faster provider in Settings.'
  return 'Couldn’t draft the month — please try again.'
}

function isoWeekKey(date: string): string {
  // Group nights by the Sunday that starts their week (for the review headers).
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() - d.getDay())
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Full-screen "Plan my month": rotation guardrails on the left, the drafted month
// (grouped by week) on the right. `monthStart` is the 1st of the target month.
export function PlanMonth({ monthStart, onClose, onApplied }: { monthStart: string; onClose: () => void; onApplied: () => void }) {
  const { persons } = usePersons()
  const familySize = Math.max(1, persons.length)
  const { recipes } = useRecipes()

  const [weekdays, setWeekdays] = useState<Set<number>>(() => new Set([1, 2, 3, 4, 5]))
  const [cookingFor, setCookingFor] = useState(0) // 0 = whole family
  const [allowRepeats, setAllowRepeats] = useState(true)
  const [repeatGapDays, setRepeatGapDays] = useState(7)
  const [quickWeeknights, setQuickWeeknights] = useState(false)
  const [weeknightMax, setWeeknightMax] = useState(30)
  const [leftovers, setLeftovers] = useState(false)
  const [themes, setThemes] = useState<Record<string, string>>({})
  const [useUp, setUseUp] = useState<string[]>([])
  const [useUpInput, setUseUpInput] = useState('')
  const [keepInMind, setKeepInMind] = useState('')

  const [cards, setCards] = useState<PlanCard[]>([])
  const [locked, setLocked] = useState<Set<string>>(new Set())
  const [removed, setRemoved] = useState<Set<string>>(new Set()) // skipped nights (excluded from apply + redraft)
  const rejected = useRef<Set<string>>(new Set())
  const [viewRecipeId, setViewRecipeId] = useState<string | null>(null)
  const [pickForDate, setPickForDate] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [via, setVia] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const started = cards.length > 0 || loading || !!error

  useTopbarFull(
    () => (
      <>
        <div className="pill" onClick={onClose} style={{ padding: '9px 14px 9px 11px', cursor: 'pointer' }}>
          <Icon name="cl" />
          Meals
        </div>
        <button type="button" className="pill" style={{ marginLeft: 'auto', cursor: 'pointer' }} onClick={onClose}>
          Cancel
        </button>
      </>
    ),
    []
  )

  function req(dates: string[] | undefined, avoid: string[]) {
    return {
      start: monthStart,
      weekdays: [...weekdays].sort(),
      skipDates: [...removed],
      dates,
      cookingFor: cookingFor > 0 ? cookingFor : null,
      keepInMind: keepInMind.trim() || null,
      useUp,
      avoidTitles: avoid,
      allowRepeats,
      repeatGapDays,
      weekdayThemes: themes,
      weeknightMaxMin: quickWeeknights ? weeknightMax : null,
      leftovers,
    }
  }

  async function draft(dates: string[] | undefined, avoid: string[]) {
    setLoading(true)
    setError(null)
    try {
      const r = await api.planMonth(req(dates, avoid))
      if (r.error) {
        setError(friendlyAiError(r.error))
        return
      }
      setVia(r.via)
      setCards((prev) => {
        // When redrafting specific dates, keep the others; otherwise replace all.
        const kept = dates ? prev.filter((c) => !dates.includes(c.date)) : []
        return [...kept, ...r.suggestions].sort((a, b) => (a.date < b.date ? -1 : 1))
      })
    } catch (e) {
      setError(friendlyAiError((e as Error).message))
    } finally {
      setLoading(false)
    }
  }

  function planAll() {
    void draft(undefined, [...rejected.current])
  }
  function reshuffle() {
    const dates = cards.filter((c) => !locked.has(c.date) && !removed.has(c.date)).map((c) => c.date)
    for (const c of cards) if (dates.includes(c.date)) rejected.current.add(c.title)
    const lockedTitles = cards.filter((c) => locked.has(c.date)).map((c) => c.title)
    void draft(dates, [...rejected.current, ...lockedTitles])
  }
  function swap(card: PlanCard) {
    rejected.current.add(card.title)
    const others = cards.filter((c) => c.date !== card.date).map((c) => c.title)
    void draft([card.date], [...rejected.current, ...others])
  }
  function pickRecipe(date: string, r: Recipe) {
    const old = cards.find((c) => c.date === date)
    if (old) rejected.current.add(old.title)
    setCards((prev) =>
      prev.map((c) =>
        c.date === date
          ? { date, mealType: 'dinner', title: r.title, recipeId: r.id, emoji: r.emoji, minutes: r.cookTimeMinutes, servings: c.servings, note: 'Your pick' }
          : c
      )
    )
    setPickForDate(null)
  }
  function toggleLock(date: string) {
    setLocked((s) => {
      const n = new Set(s)
      n.has(date) ? n.delete(date) : n.add(date)
      return n
    })
  }
  function removeNight(date: string) {
    setRemoved((s) => new Set(s).add(date))
    setCards((prev) => prev.filter((c) => c.date !== date))
  }
  function toggleWeekday(dow: number) {
    setWeekdays((s) => {
      const n = new Set(s)
      n.has(dow) ? n.delete(dow) : n.add(dow)
      return n
    })
  }
  function setTheme(dow: number, key: string) {
    setThemes((t) => {
      const n = { ...t }
      if (key) n[String(dow)] = key
      else delete n[String(dow)]
      return n
    })
  }
  function addUseUp() {
    const v = useUpInput.trim()
    if (!v) return
    setUseUp((u) => [...new Set([...u, v])])
    setUseUpInput('')
  }

  async function applyAll() {
    setApplying(true)
    try {
      for (const c of cards) {
        await api.planSlot(c.recipeId ? { date: c.date, mealType: 'dinner', recipeId: c.recipeId } : { date: c.date, mealType: 'dinner', title: c.title })
      }
      await api.rebuildGrocery(monthStart).catch(() => {})
      onApplied()
      onClose()
    } finally {
      setApplying(false)
    }
  }

  const monthLabel = new Date(`${monthStart}T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const labelFor = (date: string) => {
    const d = new Date(`${date}T12:00:00`)
    return { dow: DOW[d.getDay()], dt: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
  }
  // Group the drafted nights by week for the review.
  const weeks: Array<{ key: string; cards: PlanCard[] }> = []
  for (const c of cards) {
    const k = isoWeekKey(c.date)
    let g = weeks.find((w) => w.key === k)
    if (!g) {
      g = { key: k, cards: [] }
      weeks.push(g)
    }
    g.cards.push(c)
  }

  return (
    <div className="plan-screen">
      {/* Left: the guardrails */}
      <div className="plan-config">
        <div className="plan-title nk-serif">Plan {monthLabel}</div>
        <div className="tiny muted plan-sub">Nook drafts a rotation of dinners and spreads it across the month — then builds your grocery list.</div>

        <div className="flabel">Which nights?</div>
        <div className="plan-days">
          {DOW1.map((d, i) => (
            <button key={i} type="button" className={`plan-day-chip ${weekdays.has(i) ? 'on' : ''}`} onClick={() => toggleWeekday(i)} title={DOW[i]}>
              {d}
            </button>
          ))}
        </div>

        <div className="plan-card">
          <div className="constraint">
            <span className="cl">Cooking for</span>
            <select className="sel" value={cookingFor} onChange={(e) => setCookingFor(Number(e.target.value))}>
              <option value={0}>{familySize} · whole family</option>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>

        <div className="plan-card">
          <label className="pm-toggle">
            <input type="checkbox" checked={allowRepeats} onChange={(e) => setAllowRepeats(e.target.checked)} />
            <span>Allow repeat meals (a rotation)</span>
          </label>
          {allowRepeats && (
            <div className="constraint" style={{ marginTop: 8 }}>
              <span className="cl">No closer than</span>
              <select className="sel" value={repeatGapDays} onChange={(e) => setRepeatGapDays(Number(e.target.value))}>
                {[3, 5, 7, 10, 14].map((n) => <option key={n} value={n}>{n} days</option>)}
              </select>
            </div>
          )}
        </div>

        <div className="plan-card">
          <label className="pm-toggle">
            <input type="checkbox" checked={quickWeeknights} onChange={(e) => setQuickWeeknights(e.target.checked)} />
            <span>Quick weeknights</span>
          </label>
          {quickWeeknights && (
            <div className="constraint" style={{ marginTop: 8 }}>
              <span className="cl">Under</span>
              <select className="sel" value={weeknightMax} onChange={(e) => setWeeknightMax(Number(e.target.value))}>
                {[20, 30, 45].map((n) => <option key={n} value={n}>{n} min</option>)}
              </select>
            </div>
          )}
          <label className="pm-toggle" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={leftovers} onChange={(e) => setLeftovers(e.target.checked)} />
            <span>Leftover nights after a big cook</span>
          </label>
        </div>

        <div className="plan-card">
          <div className="tiny">Weekday themes</div>
          <div className="pm-themes">
            {[...weekdays].sort().map((dow) => (
              <div key={dow} className="pm-theme-row">
                <span className="pm-theme-dow">{DOW[dow]}</span>
                <select className="sel" value={themes[String(dow)] ?? ''} onChange={(e) => setTheme(dow, e.target.value)}>
                  {THEME_OPTS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
              </div>
            ))}
            {weekdays.size === 0 && <div className="tiny muted">Pick some nights above first.</div>}
          </div>
        </div>

        <div className="plan-card">
          <div className="tiny">Use up first</div>
          <div className="use-up-list">
            {useUp.map((u) => (
              <span key={u} className="use-chip">{u} <b onClick={() => setUseUp((x) => x.filter((y) => y !== u))}>×</b></span>
            ))}
            <input
              className="use-add-input"
              placeholder="+ Add"
              value={useUpInput}
              onChange={(e) => setUseUpInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addUseUp()
                }
              }}
            />
          </div>
        </div>

        <div className="plan-card">
          <div className="tiny">Keep in mind</div>
          <textarea className="plan-keep" rows={2} placeholder="e.g. school nights are hectic · no pork · the kids love pasta" value={keepInMind} onChange={(e) => setKeepInMind(e.target.value)} />
        </div>
      </div>

      {/* Right: the drafted month */}
      <div className="plan-results">
        <div className="plan-results-head">
          <div className="card-h nk-serif">Your {monthLabel} dinners</div>
          {cards.length > 0 && (
            <button type="button" className="pill" onClick={reshuffle} disabled={loading}>
              {loading ? <><span className="spinner" /> Reshuffling…</> : <><Icon name="spark" /> Reshuffle</>}
            </button>
          )}
        </div>
        {via && VIA_LABEL[via] && cards.length > 0 && <div className="tiny muted" style={{ margin: '-4px 2px 12px' }}>Drafted via {VIA_LABEL[via]}</div>}

        {!started && (
          <div className="plan-empty">
            <div className="plan-empty-emoji">📆</div>
            <div className="set-row2-t">Ready when you are</div>
            <div className="tiny muted" style={{ maxWidth: 360, margin: '4px 0 18px' }}>
              Set the guardrails on the left, then draft a month of dinners as a rotation you can tweak.
            </div>
            <button type="button" className="btn btn-primary" onClick={planAll} disabled={weekdays.size === 0}>
              <Icon name="spark" /> Plan my month
            </button>
          </div>
        )}

        {loading && cards.length === 0 && (
          <div className="plan-empty">
            <span className="spinner lg" />
            <div className="tiny muted" style={{ marginTop: 14 }}>Drafting your month…</div>
          </div>
        )}

        {error && (
          <div className="plan-empty">
            <div className="muted" style={{ fontWeight: 600, marginBottom: 16, maxWidth: 360 }}>{error}</div>
            <button type="button" className="btn btn-primary" onClick={planAll}><Icon name="spark" /> Try again</button>
          </div>
        )}

        {weeks.map((w) => (
          <div key={w.key} className="pm-week">
            <div className="pm-week-h tiny muted">Week of {labelFor(w.key).dt}</div>
            <div className="plan-list">
              {w.cards.map((c) => {
                const lab = labelFor(c.date)
                const isLocked = locked.has(c.date)
                return (
                  <div key={c.date} className={`plan-day ${isLocked ? 'locked' : ''}`}>
                    <div className="pd-day">
                      <div className="pd-dow">{lab.dow}</div>
                      <div className="pd-dt">{lab.dt}</div>
                    </div>
                    <div
                      className="pd-main clickable"
                      onClick={() => (c.recipeId ? setViewRecipeId(c.recipeId) : setPickForDate(c.date))}
                      role="button"
                      title={c.recipeId ? 'View recipe' : 'Choose a recipe'}
                    >
                      <div className="pd-img">{c.emoji ?? '🍽️'}</div>
                      <div className="pd-b">
                        <div className="pd-t">{c.title}</div>
                        <div className="pd-m">
                          {[c.minutes ? `${c.minutes} min` : null, `Serves ${c.servings}`].filter(Boolean).join(' · ')}
                          {c.recipeId ? ' · from your recipes' : ''}
                        </div>
                        {c.note && <div className="reason"><Icon name="spark" />{c.note}</div>}
                      </div>
                    </div>
                    <div className="pd-act">
                      <button type="button" className="pd-icon" title="Swap — let AI pick another" onClick={() => swap(c)} disabled={loading}>⟳</button>
                      <button type="button" className="pd-icon" title="Choose a recipe yourself" onClick={() => setPickForDate(c.date)}>
                        <Icon name="recipes" />
                      </button>
                      <button type="button" className={`pd-icon ${isLocked ? 'on' : ''}`} title={isLocked ? 'Locked — won’t reshuffle' : 'Lock this night'} onClick={() => toggleLock(c.date)}>
                        {isLocked ? '🔒' : '🔓'}
                      </button>
                      <button type="button" className="pd-icon" title="Skip this night" onClick={() => removeNight(c.date)}>✕</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}

        {cards.length > 0 && (
          <div className="plan-foot">
            <div>
              <div className="set-row2-t">Looks good?</div>
              <div className="tiny muted">Adds {cards.length} dinner{cards.length === 1 ? '' : 's'} to the calendar &amp; builds your grocery list.</div>
            </div>
            <button type="button" className="btn btn-primary" onClick={applyAll} disabled={applying || loading}>
              {applying ? 'Adding…' : 'Add month & build list'}
            </button>
          </div>
        )}
      </div>

      {viewRecipeId && <RecipeModal recipeId={viewRecipeId} onClose={() => setViewRecipeId(null)} />}

      {pickForDate && (
        <div className="plan-pick-overlay">
          <div className="plan-pick-head">
            <button type="button" className="pill" onClick={() => setPickForDate(null)} style={{ cursor: 'pointer' }}>
              <Icon name="cl" /> Back
            </button>
            <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginLeft: 14 }}>
              Choose a recipe · {labelFor(pickForDate).dow} {labelFor(pickForDate).dt}
            </div>
          </div>
          <RecipeBrowser recipes={recipes} loading={false} slot={'dinner' as MealType} onPick={(r) => pickRecipe(pickForDate, r)} selectLabel="Use this" />
        </div>
      )}
    </div>
  )
}
