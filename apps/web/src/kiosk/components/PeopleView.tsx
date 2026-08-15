import { useEffect, useMemo, useRef } from 'react'
import { type AgendaEvent } from '../../lib/api'
import { evVars, useEventColor } from '../../lib/event-color'
import { ymd, localDate, fmtHour, fmtTime, minutesOfDay, durationMin } from './cal-utils'
import { peopleColumns, UNASSIGNED_COLUMN, type ColumnPerson } from './cal-people'

const DAY_START = 0
const DAY_END = 23
const HOUR_PX = 52

// One day, split into a column per person: an event shows in its owner's column
// and in every participant's, so each person's day reads top-to-bottom on its own.
//
// Deliberately built on the WEEK grid (`.wk-*`), not the day grid — a person's
// column is meant to read exactly like Mon/Tue/Wed does: one shared `--wk-cols`
// template across the header, all-day and body rows so the three stay aligned,
// strict equal-width columns with the same dividers, and the person pinned in the
// header where the weekday + date sits. iOS does the same thing by reusing its
// `CalTimeGrid`; keep the two in step.
//
// Countdowns are deliberately absent — they belong to the household rather than to
// any one person, and they're already on Month/Week/Day.
export function PeopleView({
  day,
  events,
  people,
  loading = false,
  tz,
  onOpenEvent,
  onCreate,
}: {
  day: Date
  events: AgendaEvent[]
  people: ColumnPerson[]
  /** The roster is still being fetched — an empty `people` means "not yet", not "nobody". */
  loading?: boolean
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

  // "Add family members" is a claim about the household, so wait until the roster
  // has actually come back empty before making it.
  if (people.length === 0) {
    return (
      <div className="pv-screen">
        <p className="muted">{loading ? 'Loading…' : 'Add family members to see per-person columns.'}</p>
      </div>
    )
  }

  // The same shared template the week grid uses, with a track per person instead of
  // per day. minmax keeps a column readable when the household is large.
  const cols = { '--wk-cols': `64px repeat(${columns.length}, minmax(120px, 1fr))` } as React.CSSProperties

  return (
    <div className="pv-screen">
      <div className="wk" style={cols} data-testid="people-columns">
        <div className="wk-head">
          <div className="wk-rail-sp" />
          {columns.map((c) => (
            <div key={`h:${c.id}`} className="wk-day-h pv-day-h" title={c.name}>
              <div className="wk-dow pv-person-name">{c.id === UNASSIGNED_COLUMN ? 'Everyone' : c.name}</div>
              <div className="pv-person-av" style={{ background: c.colorHex ?? 'var(--panel)' }}>
                {c.id === UNASSIGNED_COLUMN ? '👪' : (c.avatarEmoji ?? '🙂')}
              </div>
            </div>
          ))}
        </div>

        {hasAllDay && (
          <div className="wk-allday">
            <div className="wk-rail-lbl">ALL-DAY</div>
            {columns.map((c) => (
              <div key={`a:${c.id}`} className="wk-allday-cell">
                {c.events.filter((e) => e.allDay).map((e) => (
                  <div
                    // An event repeats across columns, so its id alone isn't unique.
                    key={`${c.id}:${e.id}`}
                    className="wk-allday-ev ev-tint"
                    style={evVars(colorOf(e))}
                    onClick={() => onOpenEvent(e)}
                  >
                    {e.title}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        <div className="wk-body" ref={bodyRef}>
          <div className="wk-grid" style={{ height: hours.length * HOUR_PX }}>
            <div className="wk-rail">
              {hours.map((h) => (
                <div key={h} className="wk-hr" style={{ height: HOUR_PX }}>
                  <span>{fmtHour(h)}</span>
                </div>
              ))}
            </div>
            {columns.map((c) => {
              const timed = c.events.filter((e) => !e.allDay)
              return (
                <div
                  key={`c:${c.id}`}
                  className="wk-col"
                  style={{ backgroundSize: `100% ${HOUR_PX}px` }}
                  onClick={() => onCreate(key)}
                >
                  {timed.map((e) => {
                    const top = Math.max(0, ((minutesOfDay(e.startsAt) - DAY_START * 60) / 60) * HOUR_PX)
                    const height = Math.max(22, (durationMin(e) / 60) * HOUR_PX - 3)
                    const color = colorOf(e)
                    // Lanes come from THIS column's packing — an event that overlaps
                    // something in another person's column still spans full width here.
                    const lane = c.lanes.get(e.id) ?? { lane: 0, lanes: 1 }
                    const width = `calc((100% - 6px) / ${lane.lanes})`
                    const left = `calc((100% - 6px) / ${lane.lanes} * ${lane.lane} + 3px)`
                    const tight = height < 34
                    return (
                      <div
                        key={`${c.id}:${e.id}`}
                        className={`wk-ev ev-tint ${e.origin === 'meal_plan' ? 'ev-meal' : ''} ${tight ? 'tight' : ''}`}
                        style={{ top, height, left, width, ...evVars(color), borderLeft: `3px solid ${color}` }}
                        title={`${fmtTime(e)} · ${e.title}`}
                        onClick={(ev) => { ev.stopPropagation(); onOpenEvent(e) }}
                      >
                        <div className="wk-ev-t">{fmtTime(e)}</div>
                        <div className="wk-ev-title">
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
    </div>
  )
}
