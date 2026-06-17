import { useMemo } from 'react'
import type { AgendaEvent } from '../../lib/api'
import { DOW, ymd, localDate } from './cal-utils'

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

export function MonthView({
  year,
  month,
  events,
  tz,
  onOpenEvent,
  onCreateOnDay,
  onMore,
}: {
  year: number
  month: number
  events: AgendaEvent[]
  tz: string
  onOpenEvent: (e: AgendaEvent) => void
  onCreateOnDay: (date: string) => void
  onMore: (date: string) => void
}) {
  const cells = useMemo(() => monthGrid(year, month), [year, month])
  const byDate = useMemo(() => {
    const map: Record<string, AgendaEvent[]> = {}
    for (const e of events) (map[localDate(e.startsAt, tz)] ??= []).push(e)
    return map
  }, [events, tz])
  const today = ymd(new Date())

  return (
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
          const dim = d.getMonth() !== month
          return (
            <div
              key={key}
              className={`cal-cell ${dim ? 'dim' : ''} ${key === today ? 'today' : ''}`}
              onClick={() => onCreateOnDay(key)}
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
                      onOpenEvent(e)
                    }}
                  >
                    {e.title}
                  </div>
                )
              })}
              {dayEvents.length > 3 && (
                <div
                  className="ev-more"
                  style={{ cursor: 'pointer' }}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    onMore(key)
                  }}
                >
                  +{dayEvents.length - 3} more
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
