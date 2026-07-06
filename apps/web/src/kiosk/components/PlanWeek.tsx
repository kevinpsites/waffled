import { useRef, useState } from 'react'
import { api, usePersons, useRecipes, type PlanCard, type Recipe } from '../../lib/api'
import { useTopbarFull } from '../topbar-slot'
import { Icon } from '../icons'
import { RecipeModal } from './RecipeModal'
import { RecipeBrowser, type MealType } from './RecipeBrowser'

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner'] as const
const MEAL_LABEL: Record<string, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' }
const VIA_LABEL: Record<string, string> = { anthropic: 'Claude', openai: 'OpenAI', ollama: 'local LLM' }

function friendlyAiError(msg: string): string {
  if (/no ai provider|not configured/i.test(msg)) return 'Pick an AI provider in Settings → AI & capture first.'
  if (/abort|timeout|timed out|ETIMEDOUT/i.test(msg)) return 'The model took too long — try fewer days, or switch to a faster provider in Settings.'
  return 'Couldn’t draft the week — please try again.'
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Full-screen "Plan my week": guardrails on the left, the drafted week on the
// right. Drafts via the household's chosen LLM; reshuffle/swap re-draft (keeping
// locked nights); "Add week" applies every card via the normal plan endpoint.
export function PlanWeek({ startStr, days, onClose, onApplied, initialUseUp }: { startStr: string; days: Date[]; onClose: () => void; onApplied: () => void; initialUseUp?: string[] }) {
  const { persons } = usePersons()
  const familySize = Math.max(1, persons.length)

  const [mealType, setMealType] = useState<(typeof MEAL_TYPES)[number]>('dinner')
  const [selectedDays, setSelectedDays] = useState<Set<string>>(() => {
    const s = new Set<string>()
    for (const d of days) if (d.getDay() >= 1 && d.getDay() <= 5) s.add(ymd(d)) // Mon–Fri by default
    return s
  })
  const [cookingFor, setCookingFor] = useState(0) // 0 = whole family
  const [useUp, setUseUp] = useState<string[]>(initialUseUp ?? [])
  const [useUpInput, setUseUpInput] = useState('')
  const [keepInMind, setKeepInMind] = useState('')
  // "Try New Recipe" steering: a novelty toggle + a list of specific dishes to try.
  const [trySomethingNew, setTrySomethingNew] = useState(false)
  const [wantToTry, setWantToTry] = useState<string[]>([])
  const [wantToTryInput, setWantToTryInput] = useState('')

  const [cards, setCards] = useState<PlanCard[]>([])
  const [locked, setLocked] = useState<Set<string>>(new Set())
  // Dishes the user has shuffled away from — accumulated so they don't come back
  // on later reshuffles (until the week is applied / the planner closes).
  const rejected = useRef<Set<string>>(new Set())
  const { recipes } = useRecipes()
  const [viewRecipeId, setViewRecipeId] = useState<string | null>(null) // RecipeModal (preserves plan state)
  const [pickForDate, setPickForDate] = useState<string | null>(null) // manual recipe picker
  const [loading, setLoading] = useState(false)
  const [draftingDates, setDraftingDates] = useState<Set<string>>(new Set()) // nights currently being (re)drafted
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

  async function draft(dates: string[], avoid: string[]) {
    if (dates.length === 0) return
    setLoading(true)
    setError(null)
    setDraftingDates(new Set(dates))
    try {
      const r = await api.planWeek({
        start: startStr,
        mealType,
        dates,
        cookingFor: cookingFor > 0 ? cookingFor : null,
        keepInMind: keepInMind.trim() || null,
        useUp,
        avoidTitles: avoid,
        trySomethingNew,
        wantToTry,
      })
      if (r.error) {
        setError(friendlyAiError(r.error))
        return
      }
      setVia(r.via)
      setCards((prev) => {
        const kept = prev.filter((c) => !dates.includes(c.date)) // keep cards we didn't redraft
        return [...kept, ...r.suggestions].sort((a, b) => (a.date < b.date ? -1 : 1))
      })
    } catch (e) {
      setError(friendlyAiError((e as Error).message))
    } finally {
      setLoading(false)
      setDraftingDates(new Set())
    }
  }

  // Draft only when the user asks (after setting the guardrails) — no auto-kickoff.
  function planAll() {
    void draft([...selectedDays].sort(), [...rejected.current])
  }

  function reshuffle() {
    const dates = [...selectedDays].filter((d) => !locked.has(d)).sort()
    // Reject the dishes currently on those nights so they don't reappear.
    for (const c of cards) if (dates.includes(c.date)) rejected.current.add(c.title)
    const lockedTitles = cards.filter((c) => locked.has(c.date)).map((c) => c.title)
    void draft(dates, [...rejected.current, ...lockedTitles])
  }
  function swap(card: PlanCard) {
    rejected.current.add(card.title)
    const others = cards.filter((c) => c.date !== card.date).map((c) => c.title)
    void draft([card.date], [...rejected.current, ...others])
  }
  // Manually replace one night with a chosen library recipe.
  function pickRecipe(date: string, r: Recipe) {
    const old = cards.find((c) => c.date === date)
    if (old) rejected.current.add(old.title)
    setCards((prev) =>
      prev.map((c) =>
        c.date === date
          ? { date, mealType, title: r.title, recipeId: r.id, emoji: r.emoji, minutes: r.cookTimeMinutes, servings: c.servings, note: 'Your pick' }
          : c
      )
    )
    setPickForDate(null)
  }
  function toggleLock(date: string) {
    setLocked((s) => {
      const n = new Set(s)
      if (n.has(date)) n.delete(date)
      else n.add(date)
      return n
    })
  }
  function toggleDay(date: string) {
    setSelectedDays((s) => {
      const n = new Set(s)
      if (n.has(date)) n.delete(date)
      else n.add(date)
      return n
    })
  }
  function addUseUp() {
    const v = useUpInput.trim()
    if (!v) return
    setUseUp((u) => [...new Set([...u, v])])
    setUseUpInput('')
  }
  function addWantToTry() {
    const v = wantToTryInput.trim()
    if (!v) return
    setWantToTry((u) => [...new Set([...u, v])])
    setWantToTryInput('')
  }

  async function applyAll() {
    setApplying(true)
    try {
      for (const c of shown) {
        await api.planSlot(c.recipeId ? { date: c.date, mealType: c.mealType, recipeId: c.recipeId } : { date: c.date, mealType: c.mealType, title: c.title })
      }
      // "& build list": rebuild the grocery from the new week's dinners so items
      // are linked to the planned recipes (otherwise the By-meal view stays empty
      // / shows stale items from a previous plan).
      await api.rebuildGrocery(startStr).catch(() => {})
      onApplied()
      onClose()
    } finally {
      setApplying(false)
    }
  }

  const shown = cards.filter((c) => selectedDays.has(c.date)).sort((a, b) => (a.date < b.date ? -1 : 1))
  const labelFor = (date: string) => {
    const d = new Date(`${date}T12:00:00`)
    return { dow: DOW[d.getDay()], dt: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
  }

  return (
    <div className="plan-screen">
      {/* Left: the guardrails (headed by the screen title, per the mock) */}
      <div className="plan-config">
        <div className="plan-title wf-serif">Plan my week</div>
        <div className="tiny muted plan-sub">Tell Waffled the guardrails — it drafts the meals and the grocery list in one go.</div>
        <div className="flabel">Plan which meal?</div>
        <div className="seg seg-plantype">
          {MEAL_TYPES.map((m) => (
            <button key={m} type="button" className={mealType === m ? 'on' : ''} onClick={() => setMealType(m)}>{MEAL_LABEL[m]}</button>
          ))}
        </div>

        <div className="flabel">Which days?</div>
        <div className="plan-days">
          {days.map((d) => {
            const iso = ymd(d)
            return (
              <button key={iso} type="button" className={`plan-day-chip ${selectedDays.has(iso) ? 'on' : ''}`} onClick={() => toggleDay(iso)} title={`${DOW[d.getDay()]} ${d.getDate()}`}>
                {DOW[d.getDay()][0]}
              </button>
            )
          })}
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
          <textarea className="plan-keep" rows={2} placeholder="e.g. Lottie skips spicy · Tue & Thu are busy — keep under 30 min" value={keepInMind} onChange={(e) => setKeepInMind(e.target.value)} />
        </div>

        {/* "Try New Recipe": nudge the plan toward novelty + list specific dishes to try. */}
        <div className="plan-card">
          <button
            type="button"
            aria-pressed={trySomethingNew}
            onClick={() => setTrySomethingNew((v) => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              padding: '2px 0',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              font: 'inherit',
              fontWeight: 700,
              textAlign: 'left',
            }}
          >
            <span
              aria-hidden
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 20,
                height: 20,
                borderRadius: 6,
                fontSize: 13,
                lineHeight: 1,
                color: '#fff',
                border: '1.5px solid var(--line, #d7d2c8)',
                background: trySomethingNew ? 'var(--accent, #E0548B)' : 'transparent',
                borderColor: trySomethingNew ? 'var(--accent, #E0548B)' : 'var(--line, #d7d2c8)',
              }}
            >
              {trySomethingNew ? '✓' : ''}
            </span>
            <span>✨ Try something new this week</span>
          </button>
          <div className="tiny muted" style={{ margin: '6px 2px 2px' }}>Adds at least one brand-new dish, even if your library could fill the night.</div>
          <div className="tiny" style={{ marginTop: 12 }}>Dishes to try</div>
          <div className="use-up-list">
            {wantToTry.map((u) => (
              <span key={u} className="use-chip">{u} <b onClick={() => setWantToTry((x) => x.filter((y) => y !== u))}>×</b></span>
            ))}
            <input
              className="use-add-input"
              placeholder="+ Dish to try"
              value={wantToTryInput}
              onChange={(e) => setWantToTryInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addWantToTry()
                }
              }}
            />
          </div>
        </div>
      </div>

      {/* Right: the drafted week */}
      <div className="plan-results">
        <div className="plan-results-head">
          <div className="card-h wf-serif">Here’s your week</div>
          {cards.length > 0 && (
            <button type="button" className="pill" onClick={reshuffle} disabled={loading}>
              {loading ? <><span className="spinner" /> Reshuffling…</> : <><Icon name="spark" /> Reshuffle</>}
            </button>
          )}
        </div>
        {via && VIA_LABEL[via] && cards.length > 0 && <div className="tiny muted" style={{ margin: '-4px 2px 12px' }}>Drafted via {VIA_LABEL[via]}</div>}

        {/* Before drafting: configure on the left, then kick it off here. */}
        {!started && (
          <div className="plan-empty">
            <div className="plan-empty-emoji">🍽️</div>
            <div className="set-row2-t">Ready when you are</div>
            <div className="tiny muted" style={{ maxWidth: 340, margin: '4px 0 18px' }}>
              Set the guardrails on the left, then draft a week of {MEAL_LABEL[mealType].toLowerCase()}s.
            </div>
            <button type="button" className="btn btn-primary" onClick={planAll} disabled={selectedDays.size === 0}>
              <Icon name="spark" /> Plan my week
            </button>
          </div>
        )}

        {loading && cards.length === 0 && (
          <div className="plan-empty">
            <span className="spinner lg" />
            <div className="tiny muted" style={{ marginTop: 14 }}>Drafting your week…</div>
          </div>
        )}

        {error && (
          <div className="plan-empty">
            <div className="muted" style={{ fontWeight: 600, marginBottom: 16, maxWidth: 360 }}>{error}</div>
            <button type="button" className="btn btn-primary" onClick={planAll}><Icon name="spark" /> Try again</button>
          </div>
        )}

        {!loading && !error && cards.length > 0 && shown.length === 0 && (
          <div className="muted" style={{ padding: 16, fontWeight: 600 }}>Pick some days on the left to plan.</div>
        )}

        <div className="plan-list">
          {shown.map((c) => {
            const lab = labelFor(c.date)
            const isLocked = locked.has(c.date)
            return (
              <div key={c.date} className={`plan-day ${isLocked ? 'locked' : ''}`}>
                {draftingDates.has(c.date) && (
                  <div className="pd-loading"><span className="spinner" /></div>
                )}
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
                </div>
              </div>
            )
          })}
        </div>

        {shown.length > 0 && (
          <div className="plan-foot">
            <div>
              <div className="set-row2-t">Looks good?</div>
              <div className="tiny muted">Adds {shown.length} {MEAL_LABEL[mealType].toLowerCase()}{shown.length === 1 ? '' : 's'} to the calendar &amp; builds your grocery list.</div>
            </div>
            <button type="button" className="btn btn-primary" onClick={applyAll} disabled={applying || loading}>
              {applying ? 'Adding…' : 'Add week & build list'}
            </button>
          </div>
        )}
      </div>

      {viewRecipeId && <RecipeModal recipeId={viewRecipeId} onClose={() => setViewRecipeId(null)} />}

      {/* Manual swap: reuse the full recipe browser (filters + grid + View) in an
          overlay so the plan state stays intact behind it. */}
      {pickForDate && (
        <div className="plan-pick-overlay">
          <div className="plan-pick-head">
            <button type="button" className="pill" onClick={() => setPickForDate(null)} style={{ cursor: 'pointer' }}>
              <Icon name="cl" /> Back
            </button>
            <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginLeft: 14 }}>
              Choose a recipe · {labelFor(pickForDate).dow} {labelFor(pickForDate).dt}
            </div>
          </div>
          <RecipeBrowser
            recipes={recipes}
            loading={false}
            slot={mealType as MealType}
            onPick={(r) => pickRecipe(pickForDate, r)}
            selectLabel="Use this"
          />
        </div>
      )}
    </div>
  )
}
