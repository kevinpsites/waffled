import { useMemo, useState } from 'react'
import { Icon } from './icons'
import { EventModal } from './components/EventModal'
import { useEventsRange, useHousehold, type AgendaEvent } from '../lib/api'
import { localDate } from '../lib/powersync/events-local'

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// The visible 6-week (42-cell) grid for a month, including leading/trailing days.
function monthGrid(year: number, month: number): Date[] {
  const startWeekday = new Date(year, month, 1).getDay()
  const gridStart = new Date(year, month, 1 - startWeekday)
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart)
    d.setDate(gridStart.getDate() + i)
    return d
  })
}

export function Calendar() {
  const now = new Date()
  const [view, setView] = useState({ year: now.getFullYear(), month: now.getMonth() })

  const cells = useMemo(() => monthGrid(view.year, view.month), [view])
  const from = ymd(cells[0])
  const to = ymd(cells[41])
  const { events, refetch } = useEventsRange(from, to)
  const [modal, setModal] = useState<{ date?: string; event?: AgendaEvent } | null>(null)

  // Bucket events by the household timezone (matching the data layer), not the
  // device's — otherwise a kiosk in a different zone shifts evening events (a 6pm
  // dinner is near midnight UTC) onto the wrong day.
  const { household } = useHousehold()
  const tz = household?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

  const byDate = useMemo(() => {
    const map: Record<string, AgendaEvent[]> = {}
    for (const e of events) {
      const key = localDate(e.startsAt, tz) // YYYY-MM-DD in the household's zone
      ;(map[key] ??= []).push(e)
    }
    return map
  }, [events, tz])

  const today = ymd(now)

  function shift(delta: number) {
    setView((v) => {
      const m = v.month + delta
      return { year: v.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 }
    })
  }

  return (
    <div className="cal-screen">
      <div className="cal-head">
        <button type="button" className="icon-btn" aria-label="Previous month" onClick={() => shift(-1)}>
          <Icon name="cl" />
        </button>
        <div className="nk-serif" style={{ fontSize: 24, fontWeight: 600 }}>
          {MONTHS[view.month]} {view.year}
        </div>
        <button type="button" className="icon-btn" aria-label="Next month" onClick={() => shift(1)}>
          <Icon name="cr" />
        </button>
        <button
          type="button"
          className="pill"
          style={{ marginLeft: 'auto', cursor: 'pointer' }}
          onClick={() => setModal({ date: ymd(now) })}
        >
          <Icon name="plus" />
          <span>New</span>
        </button>
      </div>

      <div className="cal">
        <div className="cal-dow">
          {DOW.map((d) => (
            <div key={d}>{d}</div>
          ))}
        </div>
        <div className="cal-grid">
          {cells.map((d) => {
            const key = ymd(d)
            const dayEvents = byDate[key] ?? []
            const dim = d.getMonth() !== view.month
            return (
              <div
                key={key}
                className={`cal-cell ${dim ? 'dim' : ''} ${key === today ? 'today' : ''}`}
                onClick={() => setModal({ date: key })}
              >
                <div className="dn">{d.getDate()}</div>
                {dayEvents.slice(0, 3).map((e) => {
                  const color = e.personColor ?? '#6B6B70'
                  const isMeal = e.origin === 'meal_plan'
                  return (
                    <div
                      key={e.id}
                      className={`ev ${isMeal ? 'ev-meal' : ''}`}
                      style={{ background: `${color}22`, color, cursor: 'pointer' }}
                      title={isMeal ? 'Planned meal' : undefined}
                      onClick={(ev) => {
                        ev.stopPropagation()
                        setModal({ event: e })
                      }}
                    >
                      {e.title}
                    </div>
                  )
                })}
                {dayEvents.length > 3 && <div className="ev-more">+{dayEvents.length - 3} more</div>}
              </div>
            )
          })}
        </div>
      </div>

      {modal && (
        <EventModal
          event={modal.event}
          date={modal.date}
          onClose={() => setModal(null)}
          onSaved={refetch}
        />
      )}
    </div>
  )
}
