import { useMemo, type MouseEvent } from 'react'
import type { AgendaEvent, Countdown } from '../../lib/api'
import { DOW, ymd, localDate } from './cal-utils'
import { MonthDayPanel } from './MonthDayPanel'

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
  countdownsByDate,
  selectedDay,
  onSelectDay,
  onOpenEvent,
  onCountdownTap,
  onCreateOnDay,
  onMore,
}: {
  year: number
  month: number
  events: AgendaEvent[]
  tz: string
  countdownsByDate?: Record<string, Countdown[]>
  selectedDay: string
  onSelectDay: (date: string) => void
  onOpenEvent: (e: AgendaEvent) => void
  onCountdownTap?: (cds: Countdown[]) => void
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
    <div className="cal-month">
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
          const cds = countdownsByDate?.[key] ?? []
          const dim = d.getMonth() !== month
          return (
            <div
              key={key}
              className={`cal-cell ${dim ? 'dim' : ''} ${key === today ? 'today' : ''} ${key === selectedDay ? 'selected' : ''}`}
              onClick={() => onSelectDay(key)}
            >
              <div className="dn">{d.getDate()}</div>
              {cds.length > 0 && (
                <div
                  className={`cal-cd ${onCountdownTap ? 'link' : ''}`}
                  title={onCountdownTap ? `Edit: ${cds.map((c) => c.title).join(' · ')}` : cds.map((c) => c.title).join(' · ')}
                  {...(onCountdownTap
                    ? { role: 'button', tabIndex: 0, onClick: (e: MouseEvent) => { e.stopPropagation(); onCountdownTap(cds) } }
                    : {})}
                >
                  <span className="cal-cd-em">{cds[0].emoji ?? '⏳'}</span>
                  <span className="cal-cd-d">{cds[0].daysLeft <= 0 ? 'Today!' : `${cds[0].daysLeft}d`}</span>
                  {cds.length > 1 && <span className="cal-cd-n">+{cds.length - 1}</span>}
                </div>
              )}
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
                    {e.occurrenceStart && <span className="ev-rep" title="Repeats">↻ </span>}
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
    <MonthDayPanel day={selectedDay} events={events} tz={tz} onOpenEvent={onOpenEvent} onCreate={onCreateOnDay} />
    </div>
  )
}
