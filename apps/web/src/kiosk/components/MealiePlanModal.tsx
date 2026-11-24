// Plan a meal in Mealie from the kiosk: pick a recipe (or type a title), a day and a type.
import { useEffect, useState } from 'react'
import { useHousehold } from '../../lib/api'
import { mealieApi, mealieErrorCode, type MealieRecipeCard } from '../../lib/api/mealie'
import { addDaysYmd, householdToday } from '../../lib/household-date'
import { mealieErrorMessage } from './MealieError'

const TYPES = ['breakfast', 'lunch', 'dinner', 'side'] as const
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function MealiePlanModal({ recipe, onClose }: { recipe?: { id: string; name: string }; onClose: () => void }) {
  const { household } = useHousehold()
  const tz = household?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const today = householdToday(tz)
  const days = Array.from({ length: 14 }, (_, i) => addDaysYmd(today, i))
  const [date, setDate] = useState(today)
  const [entryType, setEntryType] = useState<string>('dinner')
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(recipe ?? null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MealieRecipeCard[]>([])
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const q = query.trim()
    if (!q) { setResults([]); return }
    let alive = true
    const t = setTimeout(() => {
      mealieApi.recipes({ search: q }).then((r) => alive && setResults(r.items)).catch(() => alive && setResults([]))
    }, 300)
    return () => { alive = false; clearTimeout(t) }
  }, [query])

  const canSave = !!picked || !!title.trim()

  async function save() {
    if (!canSave || saving) return
    setSaving(true)
    setError(null)
    try {
      await mealieApi.plan(picked ? { date, entryType, recipeId: picked.id } : { date, entryType, title: title.trim() })
      onClose()
    } catch (e) {
      setError(mealieErrorCode(e) ? mealieErrorMessage(e) : e instanceof Error ? e.message : 'Could not plan that meal.')
      setSaving(false)
    }
  }

  const chip = (on: boolean) => `btn ${on ? 'btn-primary' : 'btn-ghost'}`

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>Plan a meal</div>

        {picked ? (
          <div className="field">
            <span>Recipe</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 600 }}>
              <span>{picked.name}</span>
              <button type="button" className="btn btn-ghost" onClick={() => setPicked(null)}>Change</button>
            </div>
          </div>
        ) : (
          <>
            <label className="field">
              <span>Recipe</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search Mealie recipes" />
            </label>
            {results.length > 0 && (
              <div className="mealie-plan-results">
                {results.slice(0, 6).map((r) => (
                  <button key={r.id} type="button" className="btn btn-ghost" onClick={() => setPicked({ id: r.id, name: r.name })}>{r.name}</button>
                ))}
              </div>
            )}
            <label className="field">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Or type a title" />
            </label>
          </>
        )}

        <div className="field"><span>Day</span></div>
        <div className="mealie-plan-chips">
          {days.map((d) => (
            <button key={d} type="button" data-day={d} className={chip(d === date)} onClick={() => setDate(d)}>
              {new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', timeZone: 'UTC' })}
            </button>
          ))}
        </div>

        <div className="field"><span>Meal</span></div>
        <div className="mealie-plan-chips">
          {TYPES.map((t) => (
            <button key={t} type="button" className={chip(t === entryType)} onClick={() => setEntryType(t)}>{cap(t)}</button>
          ))}
        </div>

        {error && <div role="alert" className="tiny" style={{ color: 'var(--danger)', marginTop: 12 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn btn-primary" disabled={!canSave || saving} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  )
}
