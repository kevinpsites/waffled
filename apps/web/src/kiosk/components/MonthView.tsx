import { useMemo, type MouseEvent } from 'react'
import type { AgendaEvent, Countdown } from '../../lib/api'
import { evVars, useEventColor } from '../../lib/event-color'
import { DOW, dowFrom, monthGridStart, ymd, localDate } from './cal-utils'
import { MonthDayPanel } from './MonthDayPanel'
import { RhythmMark } from './RhythmMark'

// The visible 6-week (42-cell) grid for a month, including leading/trailing days.
// `monthGridStart` is shared with Calendar's fetch window on purpose — this used to
// hold its own copy of the formula, and the two must never disagree.
function monthGrid(year: number, month: number, firstDay: number): Date[] {
  const gridStart = monthGridStart(year, month, firstDay)
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
  firstDay,
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
  /// Which day starts the week (0 = Sunday, 1 = Monday) — passed from Calendar so the
  /// grid and the fetched range are always cut the same way.
  firstDay: number
}) {
  const colorOf = useEventColor()
  const cells = useMemo(() => monthGrid(year, month, firstDay), [year, month, firstDay])
  const dowLabels = useMemo(() => dowFrom(DOW, firstDay), [firstDay])
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
        {dowLabels.map((d) => (
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
                const color = colorOf(e)
                const isMeal = e.origin === 'meal_plan'
                return (
                  <div
                    key={e.id}
                    className={`ev ev-tint ${isMeal ? 'ev-meal' : ''}`}
                    style={{ ...evVars(color), cursor: 'pointer' }}
                    title={isMeal ? 'Planned meal' : undefined}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      onOpenEvent(e)
                    }}
                  >
                    {/* A month cell gives a chip ~100px. Two leading glyphs on a
                        recurring rhythm ("↻ 🔁 Third-…") left six characters of the title
                        readable — and an auto-scheduled rhythm is always recurring, so
                        that's the ordinary case, not an edge one. The rhythm marker is the
                        more specific fact, so here it wins and the repeat arrow stands
                        down; week, day and agenda have room for both. */}
                    {e.occurrenceStart && !e.rhythmId && <span className="ev-rep" title="Repeats">↻ </span>}
                    <RhythmMark event={e} />
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
