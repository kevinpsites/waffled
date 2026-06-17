import { useMemo, useState } from 'react'
import { usePersons, type AgendaEvent } from '../../lib/api'
import { DOW, ymd, addDays, localDate, fmtHour, fmtTime, minutesOfDay, durationMin, eventPeople } from './cal-utils'

const DAY_START = 6 // 6 AM — top of the grid
const DAY_END = 22 // 10 PM — bottom
const HOUR_PX = 52

// One week (Sun–Sat) as a time grid: an all-day strip on top, then an hour grid
// with timed events absolutely positioned. Person chips filter the week; the
// quick-add bar opens the create modal pre-dated to the week's first day.
export function WeekView({
  weekStart,
  events,
  tz,
  onOpenEvent,
  onCreate,
}: {
  weekStart: Date
  events: AgendaEvent[]
  tz: string
  onOpenEvent: (e: AgendaEvent) => void
  onCreate: (date: string, time?: string) => void
}) {
  const { persons = [] } = usePersons()
  // Empty selection = everyone (no filter); toggling a chip narrows to those people.
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart])
  const hours = useMemo(() => Array.from({ length: DAY_END - DAY_START + 1 }, (_, i) => DAY_START + i), [])
  const today = ymd(new Date())

  const visible = useMemo(() => {
    if (selected.size === 0) return events
    return events.filter((e) => {
      const ids = eventPeople(e).map((p) => p.id)
      return ids.some((id) => selected.has(id)) || (e.personId && selected.has(e.personId))
    })
  }, [events, selected])

  const byDay = useMemo(() => {
    const map: Record<string, AgendaEvent[]> = {}
    for (const e of visible) (map[localDate(e.startsAt, tz)] ??= []).push(e)
    return map
  }, [visible, tz])

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  return (
    <div className="wk-screen">
      <div className="wk-bar">
        <button type="button" className="wk-add" onClick={() => onCreate(ymd(weekStart))}>
          <span className="wk-add-plus">＋</span>
          <span className="wk-add-ph">Add an event…</span>
        </button>
        <div className="wk-chips">
          {persons.map((p) => {
            const on = selected.has(p.id)
            const color = p.colorHex ?? '#6B6B70'
            return (
              <button
                key={p.id}
                type="button"
                className={`wk-chip ${on ? 'on' : ''}`}
                style={on ? { background: `${color}22`, borderColor: color, color } : undefined}
                onClick={() => toggle(p.id)}
              >
                <span className="av sm" style={{ background: `${color}22` }}>{p.avatarEmoji ?? '🙂'}</span>
                {p.name}
              </button>
            )
          })}
        </div>
      </div>

      <div className="wk">
        <div className="wk-head">
          <div className="wk-rail-sp" />
          {days.map((d) => {
            const key = ymd(d)
            return (
              <div key={key} className={`wk-day-h ${key === today ? 'today' : ''}`}>
                <div className="wk-dow">{DOW[d.getDay()]}</div>
                <div className="wk-dn">{d.getDate()}</div>
              </div>
            )
          })}
        </div>

        <div className="wk-allday">
          <div className="wk-rail-lbl">ALL-DAY</div>
          {days.map((d) => {
            const key = ymd(d)
            const allday = (byDay[key] ?? []).filter((e) => e.allDay)
            return (
              <div key={key} className="wk-allday-cell">
                {allday.map((e) => {
                  const color = e.personColor ?? '#6B6B70'
                  return (
                    <div
                      key={e.id}
                      className="wk-allday-ev"
                      style={{ background: `${color}22`, color }}
                      onClick={() => onOpenEvent(e)}
                    >
                      {e.title}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>

        <div className="wk-body">
          <div className="wk-grid" style={{ height: hours.length * HOUR_PX }}>
            <div className="wk-rail">
              {hours.map((h) => (
                <div key={h} className="wk-hr" style={{ height: HOUR_PX }}>
                  <span>{fmtHour(h)}</span>
                </div>
              ))}
            </div>
            {days.map((d) => {
              const key = ymd(d)
              const timed = (byDay[key] ?? []).filter((e) => !e.allDay)
              return (
                <div
                  key={key}
                  className="wk-col"
                  style={{ backgroundSize: `100% ${HOUR_PX}px` }}
                  onClick={() => onCreate(key)}
                >
                  {timed.map((e) => {
                    const startMin = minutesOfDay(e.startsAt) - DAY_START * 60
                    const top = Math.max(0, (startMin / 60) * HOUR_PX)
                    const height = Math.max(22, (durationMin(e) / 60) * HOUR_PX - 3)
                    const color = e.personColor ?? '#6B6B70'
                    const isMeal = e.origin === 'meal_plan'
                    return (
                      <div
                        key={e.id}
                        className={`wk-ev ${isMeal ? 'ev-meal' : ''}`}
                        style={{ top, height, background: `${color}22`, color, borderLeft: `3px solid ${color}` }}
                        title={isMeal ? 'Planned meal' : undefined}
                        onClick={(ev) => {
                          ev.stopPropagation()
                          onOpenEvent(e)
                        }}
                      >
                        <div className="wk-ev-t">{fmtTime(e)}</div>
                        <div className="wk-ev-title">{e.title}</div>
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
