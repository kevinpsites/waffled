import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
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

// A night in the planner — a drafted/edited dinner, flagged if it was already on
// the calendar when the planner opened.
type MonthCard = PlanCard & { wasPlanned?: boolean }

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

const byDate = (a: { date: string }, b: { date: string }) => (a.date < b.date ? -1 : 1)

// Full-screen "Plan my month": rotation guardrails on the left, the whole month
// (drafted + already-planned, all editable) grouped by week on the right. Nights
// can be AI-swapped, hand-picked, locked, skipped, or dragged onto each other to
// swap dishes. `monthStart` is the 1st of the target month.
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

  const [cards, setCards] = useState<MonthCard[]>([])
  const [plannedDates, setPlannedDates] = useState<Set<string>>(new Set()) // dates with a meal in the DB at draft time
  const [dirty, setDirty] = useState<Set<string>>(new Set()) // edited nights (always include new drafts)
  const [locked, setLocked] = useState<Set<string>>(new Set())
  const [removed, setRemoved] = useState<Set<string>>(new Set()) // skipped nights
  const rejected = useRef<Set<string>>(new Set())
  const [viewRecipeId, setViewRecipeId] = useState<string | null>(null)
  const [pickForDate, setPickForDate] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [via, setVia] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  // Drag-to-swap state (pointer events → works with mouse and touch).
  const [drag, setDrag] = useState<{ date: string } | null>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [overDate, setOverDate] = useState<string | null>(null)
  const overRef = useRef<string | null>(null)
  overRef.current = overDate

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

  function markDirty(...dates: string[]) {
    setDirty((s) => {
      const n = new Set(s)
      for (const d of dates) n.add(d)
      return n
    })
  }

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
      const existCards: MonthCard[] = (r.existing ?? []).map((c) => ({ ...c, wasPlanned: true }))
      setPlannedDates(new Set(existCards.map((c) => c.date)))
      setCards((prev) => {
        if (!dates) {
          // Initial draft: new suggestions (empty nights) + already-planned nights.
          const fresh: MonthCard[] = r.suggestions.map((c) => ({ ...c, wasPlanned: false }))
          return [...fresh, ...existCards].sort(byDate)
        }
        // Redraft specific nights: replace just those, keep everything else.
        const sug = new Map(r.suggestions.map((s) => [s.date, s]))
        return prev.map((c) => (sug.has(c.date) ? { ...sug.get(c.date)!, wasPlanned: c.wasPlanned } : c)).sort(byDate)
      })
      if (dates) markDirty(...dates)
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
  function swap(card: MonthCard) {
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
          ? { ...c, title: r.title, recipeId: r.id, emoji: r.emoji, minutes: r.cookTimeMinutes, note: 'Your pick' }
          : c
      )
    )
    markDirty(date)
    setPickForDate(null)
  }
  // Exchange the dishes on two nights (dates stay put) — the drag-to-swap drop.
  function swapNights(a: string, b: string) {
    setCards((prev) => {
      const ca = prev.find((c) => c.date === a)
      const cb = prev.find((c) => c.date === b)
      if (!ca || !cb) return prev
      return prev.map((c) => {
        if (c.date === a) return { ...c, title: cb.title, recipeId: cb.recipeId, emoji: cb.emoji, minutes: cb.minutes, note: cb.note }
        if (c.date === b) return { ...c, title: ca.title, recipeId: ca.recipeId, emoji: ca.emoji, minutes: ca.minutes, note: ca.note }
        return c
      })
    })
    markDirty(a, b)
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

  // Drag-to-swap: while dragging, track the night under the pointer; on release,
  // swap dishes with it.
  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      setPos({ x: e.clientX, y: e.clientY })
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const night = el && (el as Element).closest('[data-night]')
      setOverDate(night ? night.getAttribute('data-night') : null)
    }
    const up = () => {
      const t = overRef.current
      if (t && t !== drag.date) swapNights(drag.date, t)
      setDrag(null)
      setOverDate(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
    }
  }, [drag])

  function startDrag(e: ReactPointerEvent, date: string) {
    e.preventDefault()
    e.stopPropagation()
    setPos({ x: e.clientX, y: e.clientY })
    setOverDate(null)
    setDrag({ date })
  }

  // Nights that will actually be written: new drafts + edited existing ones.
  const toApply = cards.filter((c) => !c.wasPlanned || dirty.has(c.date))

  async function applyAll() {
    setApplying(true)
    try {
      for (const c of toApply) {
        await api.planSlot(c.recipeId ? { date: c.date, mealType: 'dinner', recipeId: c.recipeId } : { date: c.date, mealType: 'dinner', title: c.title })
      }
      // Clear nights that were planned before but the user skipped.
      for (const d of removed) {
        if (plannedDates.has(d)) await api.clearSlot(d, 'dinner').catch(() => {})
      }
      await api.rebuildGrocery(monthStart).catch(() => {})
      onApplied()
      onClose()
    } finally {
      setApplying(false)
    }
  }

  const monthLabel = new Date(`${monthStart}T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const cookNightsCount = useMemo(() => {
    const base = new Date(`${monthStart}T00:00:00`)
    const y = base.getFullYear()
    const m = base.getMonth()
    const dim = new Date(y, m + 1, 0).getDate()
    let n = 0
    for (let day = 1; day <= dim; day++) {
      const dt = new Date(y, m, day)
      const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      if (weekdays.has(dt.getDay()) && !removed.has(iso)) n++
    }
    return n
  }, [monthStart, weekdays, removed])
  const libShort = recipes.length > 0 && recipes.length < cookNightsCount
  const labelFor = (date: string) => {
    const d = new Date(`${date}T12:00:00`)
    return { dow: DOW[d.getDay()], dt: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
  }

  // Group every night by week for the review.
  const weeks: Array<{ key: string; cards: MonthCard[] }> = []
  for (const c of [...cards].sort(byDate)) {
    const k = isoWeekKey(c.date)
    let g = weeks.find((w) => w.key === k)
    if (!g) {
      g = { key: k, cards: [] }
      weeks.push(g)
    }
    g.cards.push(c)
  }

  const dragCard = drag ? cards.find((c) => c.date === drag.date) : null

  return (
    <div className="plan-screen">
      {/* Left: the guardrails */}
      <div className="plan-config">
        <div className="plan-title nk-serif">Plan {monthLabel}</div>
        <div className="tiny muted plan-sub">Nook drafts a rotation of your recipes and spreads it across the month — then builds your grocery list.</div>

        {libShort && (
          <div className="plan-lib-hint tiny">
            📖 You have {recipes.length} recipe{recipes.length === 1 ? '' : 's'} but this month has ~{cookNightsCount} dinners, so some will repeat. Add more in <b>Explore recipes</b> for more variety.
          </div>
        )}

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

      {/* Right: the month */}
      <div className="plan-results">
        <div className="plan-results-head">
          <div className="card-h nk-serif">Your {monthLabel} dinners</div>
          {cards.length > 0 && (
            <button type="button" className="pill" onClick={reshuffle} disabled={loading}>
              {loading ? <><span className="spinner" /> Reshuffling…</> : <><Icon name="spark" /> Reshuffle</>}
            </button>
          )}
        </div>
        {cards.length > 0 && (
          <div className="tiny muted" style={{ margin: '-4px 2px 12px' }}>
            {via && VIA_LABEL[via] ? `Drafted via ${VIA_LABEL[via]} · ` : ''}drag a night by its handle onto another to swap them.
          </div>
        )}

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
                const isDrop = !!drag && overDate === c.date && drag.date !== c.date
                return (
                  <div key={c.date} data-night={c.date} className={`plan-day ${isLocked ? 'locked' : ''} ${isDrop ? 'pm-drop' : ''} ${drag?.date === c.date ? 'pm-dragging' : ''}`}>
                    <button type="button" className="pm-grip" title="Drag onto another night to swap" aria-label="Drag to swap" onPointerDown={(e) => startDrag(e, c.date)}>
                      ⠿
                    </button>
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
                        <div className="pd-t">
                          {c.title}
                          {c.wasPlanned && <span className="pm-tag">was planned</span>}
                        </div>
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
              <div className="tiny muted">Saves {toApply.length} dinner{toApply.length === 1 ? '' : 's'} to the calendar &amp; builds your grocery list.</div>
            </div>
            <button type="button" className="btn btn-primary" onClick={applyAll} disabled={applying || loading || toApply.length === 0}>
              {applying ? 'Saving…' : 'Save month & build list'}
            </button>
          </div>
        )}
      </div>

      {drag && dragCard && (
        <div className="pm-drag-ghost" style={{ left: pos.x, top: pos.y }}>
          {dragCard.emoji ? `${dragCard.emoji} ` : ''}
          {dragCard.title}
        </div>
      )}

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
