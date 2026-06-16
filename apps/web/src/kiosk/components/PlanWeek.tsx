import { useEffect, useState } from 'react'
import { api, usePersons, type PlanCard } from '../../lib/api'
import { useTopbarFull } from '../topbar-slot'
import { Icon } from '../icons'

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner'] as const
const MEAL_LABEL: Record<string, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' }
const VIA_LABEL: Record<string, string> = { anthropic: 'Claude', openai: 'OpenAI', ollama: 'local LLM' }

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Full-screen "Plan my week": guardrails on the left, the drafted week on the
// right. Drafts via the household's chosen LLM; reshuffle/swap re-draft (keeping
// locked nights); "Add week" applies every card via the normal plan endpoint.
export function PlanWeek({ startStr, days, onClose, onApplied }: { startStr: string; days: Date[]; onClose: () => void; onApplied: () => void }) {
  const { persons } = usePersons()
  const familySize = Math.max(1, persons.length)

  const [mealType, setMealType] = useState<(typeof MEAL_TYPES)[number]>('dinner')
  const [selectedDays, setSelectedDays] = useState<Set<string>>(() => {
    const s = new Set<string>()
    for (const d of days) if (d.getDay() >= 1 && d.getDay() <= 5) s.add(ymd(d)) // Mon–Fri by default
    return s
  })
  const [cookingFor, setCookingFor] = useState(0) // 0 = whole family
  const [useUp, setUseUp] = useState<string[]>([])
  const [useUpInput, setUseUpInput] = useState('')
  const [keepInMind, setKeepInMind] = useState('')

  const [cards, setCards] = useState<PlanCard[]>([])
  const [locked, setLocked] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [via, setVia] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  useTopbarFull(
    () => (
      <>
        <div className="pill" onClick={onClose} style={{ padding: '9px 14px 9px 11px', cursor: 'pointer' }}>
          <Icon name="cl" />
          Meals
        </div>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginLeft: 14 }}>Plan my week</div>
      </>
    ),
    []
  )

  async function draft(dates: string[], avoid: string[]) {
    if (dates.length === 0) return
    setLoading(true)
    setError(null)
    try {
      const r = await api.planWeek({
        start: startStr,
        mealType,
        dates,
        cookingFor: cookingFor > 0 ? cookingFor : null,
        keepInMind: keepInMind.trim() || null,
        useUp,
        avoidTitles: avoid,
      })
      setVia(r.via)
      setCards((prev) => {
        const kept = prev.filter((c) => !dates.includes(c.date)) // keep cards we didn't redraft
        return [...kept, ...r.suggestions].sort((a, b) => (a.date < b.date ? -1 : 1))
      })
    } catch (e) {
      setError(/501/.test((e as Error).message) ? 'Pick an AI provider in Settings → AI & capture first.' : 'Couldn’t draft the week — try again.')
    } finally {
      setLoading(false)
    }
  }

  // Initial draft on open.
  useEffect(() => {
    void draft([...selectedDays].sort(), [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function reshuffle() {
    const dates = [...selectedDays].filter((d) => !locked.has(d)).sort()
    void draft(dates, cards.map((c) => c.title))
  }
  function swap(card: PlanCard) {
    void draft([card.date], cards.map((c) => c.title))
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

  async function applyAll() {
    setApplying(true)
    try {
      for (const c of shown) {
        await api.planSlot(c.recipeId ? { date: c.date, mealType: c.mealType, recipeId: c.recipeId } : { date: c.date, mealType: c.mealType, title: c.title })
      }
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
      {/* Left: the guardrails */}
      <div className="plan-config">
        <div className="tiny muted">Tell Nook the guardrails — it drafts the meals and the grocery list in one go.</div>

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
      </div>

      {/* Right: the drafted week */}
      <div className="plan-results">
        <div className="plan-results-head">
          <div className="card-h nk-serif">Here’s your week</div>
          <button type="button" className="pill" onClick={reshuffle} disabled={loading}>
            <Icon name="spark" /> Reshuffle
          </button>
        </div>
        {via && VIA_LABEL[via] && <div className="tiny muted" style={{ margin: '-4px 2px 12px' }}>Drafted via {VIA_LABEL[via]}</div>}

        {loading && cards.length === 0 && <div className="muted" style={{ padding: 16 }}>Drafting your week…</div>}
        {error && <div className="muted" style={{ padding: 16, fontWeight: 600 }}>{error}</div>}
        {!loading && !error && cards.length > 0 && shown.length === 0 && (
          <div className="muted" style={{ padding: 16, fontWeight: 600 }}>Pick some days on the left to plan.</div>
        )}

        <div className="plan-list">
          {shown.map((c) => {
            const lab = labelFor(c.date)
            const isLocked = locked.has(c.date)
            return (
              <div key={c.date} className={`plan-day ${isLocked ? 'locked' : ''}`}>
                <div className="pd-day">
                  <div className="pd-dow">{lab.dow}</div>
                  <div className="pd-dt">{lab.dt}</div>
                </div>
                <div className="pd-img">{c.emoji ?? '🍽️'}</div>
                <div className="pd-b">
                  <div className="pd-t">{c.title}</div>
                  <div className="pd-m">
                    {[c.minutes ? `${c.minutes} min` : null, `Serves ${c.servings}`].filter(Boolean).join(' · ')}
                    {c.recipeId ? ' · from your recipes' : ''}
                  </div>
                  {c.note && <div className="reason"><Icon name="spark" />{c.note}</div>}
                </div>
                <div className="pd-act">
                  <button type="button" className="pd-icon" title="Swap this dish" onClick={() => swap(c)} disabled={loading}>⟳</button>
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
    </div>
  )
}
