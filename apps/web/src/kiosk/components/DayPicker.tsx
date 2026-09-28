import { useMemo, useState } from 'react'
import { Icon } from '../icons'
import { MONTHS, addDays, dowFrom, monthGridStart, ymd } from './cal-utils'
import { dayLabel } from './event-when'

// A month of day buttons with prev/next: the Agenda sidebar's mini month (with event dots) and
// the event editor's date picker (with the picked day marked). Each day is labelled
// "Sep 14, 2026", the same text as the editor's date pills.
export function DayPicker({
  onPick,
  firstDay,
  selected,
  dotsFor,
  withYear,
  className,
}: {
  onPick: (day: string) => void
  firstDay: number
  selected?: string
  dotsFor?: (day: string) => string[] | undefined
  withYear?: boolean
  className?: string
}) {
  const [view, setView] = useState(() => {
    const d = selected ? new Date(`${selected}T12:00`) : new Date()
    return { year: d.getFullYear(), month: d.getMonth() }
  })
  const todayKey = ymd(new Date())
  const cells = useMemo(
    () => Array.from({ length: 42 }, (_, i) => addDays(monthGridStart(view.year, view.month, firstDay), i)),
    [view, firstDay],
  )

  function shift(delta: number) {
    setView((v) => {
      const m = v.month + delta
      return { year: v.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 }
    })
  }

  return (
    <div className={className}>
      <div className="ag-mini-head">
        <div className="wf-serif" style={{ fontSize: 19, fontWeight: 600 }}>
          {MONTHS[view.month]}{withYear ? ` ${view.year}` : ''}
        </div>
        <div className="ag-mini-nav">
          <button type="button" aria-label="Previous month" onClick={() => shift(-1)}><Icon name="cl" /></button>
          <button type="button" aria-label="Next month" onClick={() => shift(1)}><Icon name="cr" /></button>
        </div>
      </div>
      <div className="ag-mini-dow">
        {dowFrom(['S', 'M', 'T', 'W', 'T', 'F', 'S'], firstDay).map((d, i) => <div key={i}>{d}</div>)}
      </div>
      <div className="ag-mini-grid">
        {cells.map((d) => {
          const key = ymd(d)
          const dim = d.getMonth() !== view.month
          const colors = dotsFor?.(key)
          return (
            <button
              type="button"
              key={key}
              aria-label={dayLabel(key)}
              aria-pressed={selected ? key === selected : undefined}
              className={`ag-mini-cell ${dim ? 'dim' : ''} ${key === todayKey ? 'today' : ''} ${key === selected ? 'selected' : ''}`}
              onClick={() => onPick(key)}
            >
              <span className="ag-mini-n">{d.getDate()}</span>
              {colors && colors.length > 0 && (
                <span className="ag-mini-dots">
                  {colors.slice(0, 3).map((c, i) => (
                    <span key={i} className="ag-mini-dot" style={{ background: c }} />
                  ))}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
