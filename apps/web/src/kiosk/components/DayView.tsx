import { useMemo } from 'react'
import { type AgendaEvent } from '../../lib/api'
import { DOW_FULL, MONTHS, ymd, localDate, fmtHour, fmtTime, minutesOfDay, durationMin, packLanes } from './cal-utils'

const DAY_START = 6 // 6 AM — top of the grid
const DAY_END = 22 // 10 PM — bottom
const HOUR_PX = 64 // a touch taller than the week grid — one day has room to breathe

// A single day as a full-width time grid: an all-day strip, an hour rail, timed
// events laid out in lanes, and a live "now" line when you're looking at today.
export function DayView({
  day,
  events,
  tz,
  onOpenEvent,
  onCreate,
}: {
  day: Date
  events: AgendaEvent[]
  tz: string
  onOpenEvent: (e: AgendaEvent) => void
  onCreate: (date: string, time?: string) => void
}) {
  const key = ymd(day)
  const hours = useMemo(() => Array.from({ length: DAY_END - DAY_START + 1 }, (_, i) => DAY_START + i), [])

  const todays = useMemo(() => events.filter((e) => localDate(e.startsAt, tz) === key), [events, tz, key])
  const allDay = todays.filter((e) => e.allDay)
  const timed = useMemo(() => todays.filter((e) => !e.allDay), [todays])
  const lanes = useMemo(() => packLanes(timed), [timed])

  const now = new Date()
  const isToday = ymd(now) === key
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const nowTop = ((nowMin - DAY_START * 60) / 60) * HOUR_PX
  const showNow = isToday && nowMin >= DAY_START * 60 && nowMin <= DAY_END * 60

  return (
    <div className="dv-screen">
      <div className="dv-bar">
        <div className="dv-heading">
          <span className="nk-serif dv-dow">{DOW_FULL[day.getDay()]}</span>
          <span className="muted dv-date">{MONTHS[day.getMonth()]} {day.getDate()}</span>
        </div>
        <button type="button" className="wk-add dv-add" onClick={() => onCreate(key)}>
          <span className="wk-add-plus">＋</span>
          <span className="wk-add-ph">Add an event…</span>
        </button>
      </div>

      {allDay.length > 0 && (
        <div className="dv-allday">
          <div className="dv-rail-lbl">ALL-DAY</div>
          <div className="dv-allday-cell">
            {allDay.map((e) => {
              const color = e.personColor ?? '#6B6B70'
              return (
                <div key={e.id} className="dv-allday-ev" style={{ background: `${color}22`, color }} onClick={() => onOpenEvent(e)}>
                  {e.title}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="dv-body">
        <div className="dv-grid" style={{ height: hours.length * HOUR_PX }}>
          <div className="dv-rail">
            {hours.map((h) => (
              <div key={h} className="dv-hr" style={{ height: HOUR_PX }}>
                <span>{fmtHour(h)}</span>
              </div>
            ))}
          </div>
          <div className="dv-col" style={{ backgroundSize: `100% ${HOUR_PX}px` }} onClick={() => onCreate(key)}>
            {showNow && (
              <div className="dv-now" style={{ top: nowTop }}>
                <span className="dv-now-dot" />
              </div>
            )}
            {timed.map((e) => {
              const startMin = minutesOfDay(e.startsAt) - DAY_START * 60
              const top = Math.max(0, (startMin / 60) * HOUR_PX)
              const height = Math.max(26, (durationMin(e) / 60) * HOUR_PX - 3)
              const color = e.personColor ?? '#6B6B70'
              const isMeal = e.origin === 'meal_plan'
              const lane = lanes.get(e.id) ?? { lane: 0, lanes: 1 }
              const width = `calc((100% - 8px) / ${lane.lanes})`
              const left = `calc((100% - 8px) / ${lane.lanes} * ${lane.lane} + 4px)`
              return (
                <div
                  key={e.id}
                  className={`dv-ev ${isMeal ? 'ev-meal' : ''}`}
                  style={{ top, height, left, width, background: `${color}22`, color, borderLeft: `3px solid ${color}` }}
                  title={isMeal ? 'Planned meal' : undefined}
                  onClick={(ev) => { ev.stopPropagation(); onOpenEvent(e) }}
                >
                  <div className="dv-ev-t">{fmtTime(e)}</div>
                  <div className="dv-ev-title">{e.title}</div>
                  {e.location && <div className="dv-ev-loc">📍 {e.location}</div>}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
