import { useEffect, useMemo, useRef } from 'react'
import { type AgendaEvent } from '../../lib/api'
import { evVars, useEventColor, UNASSIGNED_COLOR } from '../../lib/event-color'
import { DOW_FULL, MONTHS, ymd, localDate, fmtHour, fmtTime, minutesOfDay, durationMin } from './cal-utils'
import { peopleColumns, UNASSIGNED_COLUMN, type ColumnPerson } from './cal-people'

const DAY_START = 0
const DAY_END = 23
const HOUR_PX = 56 // a little tighter than Day view — columns are narrower

// One day, split into a column per person: an event shows in its owner's column
// and in every participant's, so each person's day reads top-to-bottom on its own.
// Countdowns are deliberately absent — they belong to the household rather than to
// any one person, and they're already on Month/Week/Day.
export function PeopleView({
  day,
  events,
  people,
  tz,
  onOpenEvent,
  onCreate,
}: {
  day: Date
  events: AgendaEvent[]
  people: ColumnPerson[]
  tz: string
  onOpenEvent: (e: AgendaEvent) => void
  onCreate: (date: string, time?: string) => void
}) {
  const colorOf = useEventColor()
  const key = ymd(day)
  const hours = useMemo(() => Array.from({ length: DAY_END - DAY_START + 1 }, (_, i) => DAY_START + i), [])

  const todays = useMemo(() => events.filter((e) => localDate(e.startsAt, tz) === key), [events, tz, key])
  const columns = useMemo(() => peopleColumns(todays, people), [todays, people])
  const hasAllDay = columns.some((c) => c.events.some((e) => e.allDay))

  const now = new Date()
  const isToday = ymd(now) === key
  const nowTop = ((now.getHours() * 60 + now.getMinutes() - DAY_START * 60) / 60) * HOUR_PX

  // Open at the morning (or an hour before "now" on today) rather than at midnight.
  // `people.length` is in the deps because the roster arrives async: until it does
  // this renders the empty-state branch, where bodyRef is unattached and the scroll
  // silently no-ops — leaving the grid stranded at midnight once the columns appear.
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    el.scrollTop = (isToday ? Math.max(0, now.getHours() - 1) : 7) * HOUR_PX
  }, [key, isToday, people.length])

  // The rail plus one track per person. minmax keeps columns readable on a phone
  // (the strip scrolls sideways) while letting them share the width on a kiosk.
  const template = `var(--dv-rail) repeat(${columns.length}, minmax(150px, 1fr))`

  if (people.length === 0) {
    return <div className="pv-screen"><p className="muted">Add family members to see per-person columns.</p></div>
  }

  return (
    <div className="pv-screen">
      <div className="dv-bar">
        <div className="dv-heading">
          <span className="wf-serif dv-dow">{DOW_FULL[day.getDay()]}</span>
          <span className="muted dv-date">{MONTHS[day.getMonth()]} {day.getDate()}</span>
        </div>
        <button type="button" className="wk-add dv-add" onClick={() => onCreate(key)}>
          <span className="wk-add-plus">＋</span>
          <span className="wk-add-ph">Add an event…</span>
        </button>
      </div>

      <div className="pv-body" ref={bodyRef} data-testid="people-columns">
        <div className="pv-grid" style={{ gridTemplateColumns: template }}>
          {/* Header band — sticks to the top through the vertical scroll. */}
          <div className="pv-corner" />
          {columns.map((c) => (
            <div key={`h:${c.id}`} className="pv-head" title={c.name}>
              <span
                className="pv-dot"
                style={{ background: c.colorHex ?? UNASSIGNED_COLOR }}
                aria-hidden="true"
              />
              {c.avatarEmoji && <span className="pv-emo" aria-hidden="true">{c.avatarEmoji}</span>}
              <span className="pv-name">{c.id === UNASSIGNED_COLUMN ? 'Everyone' : c.name}</span>
            </div>
          ))}

          {hasAllDay && (
            <>
              <div className="dv-rail-lbl pv-sticky-l">ALL-DAY</div>
              {columns.map((c) => (
                <div key={`a:${c.id}`} className="pv-allday-cell">
                  {c.events.filter((e) => e.allDay).map((e) => (
                    <div
                      // An event repeats across columns, so the id alone is not unique.
                      key={`${c.id}:${e.id}`}
                      className="dv-allday-ev ev-tint"
                      style={evVars(colorOf(e))}
                      onClick={() => onOpenEvent(e)}
                    >
                      {e.title}
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}

          <div className="pv-rail pv-sticky-l">
            {hours.map((h) => (
              <div key={h} className="dv-hr" style={{ height: HOUR_PX }}>
                <span>{fmtHour(h)}</span>
              </div>
            ))}
          </div>
          {columns.map((c) => {
            const timed = c.events.filter((e) => !e.allDay)
            return (
              <div
                key={`c:${c.id}`}
                className="pv-col"
                style={{ backgroundSize: `100% ${HOUR_PX}px`, height: hours.length * HOUR_PX }}
                onClick={() => onCreate(key)}
              >
                {isToday && <div className="dv-now" style={{ top: nowTop }}><span className="dv-now-dot" /></div>}
                {timed.map((e) => {
                  const top = Math.max(0, ((minutesOfDay(e.startsAt) - DAY_START * 60) / 60) * HOUR_PX)
                  const height = Math.max(24, (durationMin(e) / 60) * HOUR_PX - 3)
                  const color = colorOf(e)
                  // Lanes come from THIS column's packing — an event that overlaps
                  // something in another person's column still spans full width here.
                  const lane = c.lanes.get(e.id) ?? { lane: 0, lanes: 1 }
                  const width = `calc((100% - 6px) / ${lane.lanes})`
                  const left = `calc((100% - 6px) / ${lane.lanes} * ${lane.lane} + 3px)`
                  return (
                    <div
                      key={`${c.id}:${e.id}`}
                      className={`dv-ev ev-tint ${e.origin === 'meal_plan' ? 'ev-meal' : ''}`}
                      style={{ top, height, left, width, ...evVars(color), borderLeft: `3px solid ${color}` }}
                      onClick={(ev) => { ev.stopPropagation(); onOpenEvent(e) }}
                    >
                      <div className="dv-ev-t">{fmtTime(e)}</div>
                      <div className="dv-ev-title">
                        {e.occurrenceStart && <span className="ev-rep" title="Repeats">↻ </span>}{e.title}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
