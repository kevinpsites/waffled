import { useState } from 'react'
import { mealsApi, type RecipeDetail } from '../../lib/api'

const MEALS = [
  { key: 'breakfast', label: 'Breakfast' },
  { key: 'lunch', label: 'Lunch' },
  { key: 'dinner', label: 'Dinner' },
  { key: 'snack', label: 'Snack' },
]

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Schedule a recipe onto a day + meal slot (this week / next week).
export function ScheduleModal({ recipe, onClose, onScheduled }: { recipe: RecipeDetail; onClose: () => void; onScheduled: (label: string) => void }) {
  const [weekOffset, setWeekOffset] = useState(0)
  const [meal, setMeal] = useState('dinner')
  const [saving, setSaving] = useState('')

  const sunday = (() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - d.getDay() + weekOffset * 7)
    return d
  })()
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(sunday)
    d.setDate(d.getDate() + i)
    return d
  })

  async function schedule(d: Date) {
    if (saving) return
    setSaving(ymd(d))
    try {
      await mealsApi.planSlot({ date: ymd(d), mealType: meal, recipeId: recipe.id })
      onScheduled(`${d.toLocaleDateString('en-US', { weekday: 'long' })} ${meal}`)
      onClose()
    } catch {
      setSaving('')
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>Schedule “{recipe.title}”</div>
        <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 14 }}>Pick a day to add it to the plan.</div>

        <div className="field">
          <span>Meal</span>
          <div className="seg" style={{ width: 'fit-content' }}>
            {MEALS.map((m) => (
              <button key={m.key} type="button" className={meal === m.key ? 'on' : ''} style={{ cursor: 'pointer' }} onClick={() => setMeal(m.key)}>{m.label}</button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 10px' }}>
          <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={() => setWeekOffset((w) => Math.max(0, w - 1))}>‹</button>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{weekOffset === 0 ? 'This week' : weekOffset === 1 ? 'Next week' : `${days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}</div>
          <button type="button" className="pill" style={{ cursor: 'pointer', marginLeft: 'auto' }} onClick={() => setWeekOffset((w) => w + 1)}>›</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
          {days.map((d) => (
            <button
              key={ymd(d)}
              type="button"
              className="sched-day"
              onClick={() => schedule(d)}
              disabled={!!saving}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '10px 0', borderRadius: 12, border: '1px solid var(--hair)', background: saving === ymd(d) ? 'var(--person-3)' : 'var(--card-2)', color: saving === ymd(d) ? '#fff' : 'var(--ink)', cursor: 'pointer', font: 'inherit' }}
            >
              <span className="tiny" style={{ fontWeight: 700 }}>{d.toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 2)}</span>
              <span style={{ fontFamily: 'var(--serif)', fontSize: 17, fontWeight: 600 }}>{d.getDate()}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
