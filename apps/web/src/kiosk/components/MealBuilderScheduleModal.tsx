// Drop the plate into a meal-plan slot. Any of breakfast / lunch / dinner, on
// any date — with prev/next week navigation so a meal can be planned weeks
// ahead (decision 7). Confirm stays disabled until a day is picked.
import { useState } from 'react'
import { mealBuilderApi, useHousehold, type Meal } from '../../lib/api'

const SLOTS = [
  { key: 'breakfast', label: 'Breakfast' },
  { key: 'lunch', label: 'Lunch' },
  { key: 'dinner', label: 'Dinner' },
]

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function MealBuilderScheduleModal({
  meal,
  onClose,
  onScheduled,
}: {
  meal: Meal
  onClose: () => void
  onScheduled: (r: { meal: Meal; dayLabel: string }) => void
}) {
  const [weekOffset, setWeekOffset] = useState(0)
  const [mealType, setMealType] = useState('dinner')
  const [picked, setPicked] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // "This week" has to mean the same seven days the planner is showing, so the week
  // is cut on the household's own first day. Sunday until the setting arrives, which
  // is what this picker always assumed.
  const { household } = useHousehold()
  const firstDay = household?.weekStart === 'monday' ? 1 : 0

  const weekStart = (() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - ((d.getDay() - firstDay + 7) % 7) + weekOffset * 7)
    return d
  })()
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + i)
    return d
  })
  const weekLabel =
    weekOffset === 0
      ? 'This week'
      : weekOffset === 1
        ? 'Next week'
        : `Week of ${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`

  async function confirm() {
    if (!picked || saving) return
    setSaving(true)
    try {
      const r = await mealBuilderApi.schedule(meal.id, { date: picked, mealType })
      const day = days.find((d) => ymd(d) === picked)!
      onScheduled({ meal: r.meal, dayLabel: `${day.toLocaleDateString('en-US', { weekday: 'long' })} ${mealType}` })
      onClose()
    } catch {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card mb-sched" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 470 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
          ×
        </button>

        <div className="mb-sched-strip">{meal.emojis.slice(0, 6).join(' ') || '🍽️'}</div>
        <div className="wf-serif mb-sched-name">{meal.name}</div>
        <div className="tiny muted mb-sched-sub">
          Meal · {meal.recipeCount} {meal.recipeCount === 1 ? 'recipe' : 'recipes'} · Serves {meal.servings}
        </div>

        <div className="field">
          <span>Meal</span>
          <div className="seg mb-sched-seg" style={{ width: 'fit-content' }}>
            {SLOTS.map((s) => (
              <button key={s.key} type="button" className={mealType === s.key ? 'on' : ''} onClick={() => setMealType(s.key)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-sched-week">
          <button type="button" className="pill" aria-label="Previous week" onClick={() => setWeekOffset((w) => Math.max(0, w - 1))}>
            ‹
          </button>
          <div className="mb-sched-weekl">{weekLabel}</div>
          <button type="button" className="pill" aria-label="Next week" onClick={() => setWeekOffset((w) => w + 1)}>
            ›
          </button>
        </div>

        <div className="mb-sched-days">
          {days.map((d) => (
            <button
              key={ymd(d)}
              type="button"
              data-testid={`mb-day-${ymd(d)}`}
              className={`mb-sched-day${picked === ymd(d) ? ' is-picked' : ''}`}
              onClick={() => setPicked(ymd(d))}
            >
              <span className="tiny mb-sched-dow">{d.toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 2)}</span>
              <span className="mb-sched-dom">{d.getDate()}</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          className="btn btn-primary mb-sched-go"
          disabled={!picked || saving}
          onClick={confirm}
        >
          {saving ? 'Scheduling…' : 'Confirm'}
        </button>
      </div>
    </div>
  )
}
