import { useMemo, type CSSProperties, type MouseEvent } from 'react'
import type { AgendaEvent, Countdown } from '../../lib/api'
import { evVars, useEventColor } from '../../lib/event-color'
import { DOW, dowFrom, monthGridStart, ymd } from './cal-utils'
import { eventsByDay, weekSpans } from './month-spans'
import { MonthDayPanel } from './MonthDayPanel'
import { RhythmMark } from './RhythmMark'

// The visible 6-week (42-cell) grid for a month, including leading/trailing days.
// `monthGridStart` is shared with Calendar's fetch window — the two must never disagree.
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
  maxChips,
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
  /// Which day starts the week (0 = Sunday) — passed from Calendar so the grid and the fetched range match.
  firstDay: number
  /// How many event chips a day cell draws before collapsing the rest into "+N more". Three on
  /// Calendar; Horizon passes 2 to keep its parked-notes board on screen (a chip never shrinks).
  maxChips?: number
}) {
  const chipCap = maxChips ?? 3
  const colorOf = useEventColor()
  const cells = useMemo(() => monthGrid(year, month, firstDay), [year, month, firstDay])
  const dowLabels = useMemo(() => dowFrom(DOW, firstDay), [firstDay])
  const byDate = useMemo(() => eventsByDay(events, tz), [events, tz])
  // Bars are grid siblings of the cells (a cell clips its overflow), so every cell is placed
  // explicitly and each bar takes its row and columns on top.
  const rowSpans = useMemo(
    () => Array.from({ length: 6 }, (_, r) => weekSpans(cells.slice(r * 7, r * 7 + 7).map(ymd), byDate, tz)),
    [cells, byDate, tz],
  )
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
        {cells.map((d, i) => {
          const key = ymd(d)
          const spans = rowSpans[Math.floor(i / 7)]
          const dayEvents = spans.chipsByDay[key] ?? []
          const shown = Math.max(0, chipCap - spans.lanes)
          const cds = countdownsByDate?.[key] ?? []
          const dim = d.getMonth() !== month
          return (
            <div
              key={key}
              className={`cal-cell ${dim ? 'dim' : ''} ${key === today ? 'today' : ''} ${key === selectedDay ? 'selected' : ''}`}
              style={{ gridRow: Math.floor(i / 7) + 1, gridColumn: (i % 7) + 1 }}
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
              {spans.lanes > 0 && <div className="cal-span-gap" style={{ '--lanes': spans.lanes } as CSSProperties} />}
              {dayEvents.slice(0, shown).map((e) => {
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
                    {/* A month cell gives a chip ~100px, and two leading glyphs leave six
                        characters of the title readable. The rhythm marker is the more specific
                        fact, so it wins here; week, day and agenda have room for both. */}
                    {e.occurrenceStart && !e.rhythmId && <span className="ev-rep" title="Repeats">↻ </span>}
                    <RhythmMark event={e} />
                    {e.title}
                  </div>
                )
              })}
              {dayEvents.length > shown && (
                <div
                  className="ev-more"
                  style={{ cursor: 'pointer' }}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    onMore(key)
                  }}
                >
                  +{dayEvents.length - shown} more
                </div>
              )}
            </div>
          )
        })}
        {rowSpans.flatMap((spans, r) =>
          spans.bars.map((b) => {
            const days = cells.slice(r * 7, r * 7 + 7)
            const outside = days[b.startCol].getMonth() !== month && days[b.endCol].getMonth() !== month
            return (
              <div
                key={`${r}-${b.event.id}`}
                className={`ev ev-tint cal-span ${b.continuesBefore ? 'cont-before' : ''} ${b.continuesAfter ? 'cont-after' : ''} ${outside ? 'dim' : ''}`}
                style={{
                  ...evVars(colorOf(b.event)),
                  '--span-row': r + 1,
                  '--span-col': b.startCol + 1,
                  '--span-len': b.endCol - b.startCol + 1,
                  '--lane': b.lane,
                } as CSSProperties}
                title={b.event.title}
                onClick={() => onOpenEvent(b.event)}
              >
                <RhythmMark event={b.event} />
                {b.event.title}
              </div>
            )
          }),
        )}
      </div>
    </div>
    <MonthDayPanel day={selectedDay} events={events} tz={tz} onOpenEvent={onOpenEvent} onCreate={onCreateOnDay} />
    </div>
  )
}
