import { useEffect, useMemo, useRef, useState } from 'react'
import { usePersons, type AgendaEvent, type Countdown } from '../../lib/api'
import { DOW, ymd, addDays, localDate, fmtHour, fmtTime, minutesOfDay, durationMin, eventPeople, packLanes } from './cal-utils'
import { CountdownChip } from './CountdownChip'

const DAY_START = 0 // midnight — top of the grid (full day so early events are reachable)
const DAY_END = 23 // 11 PM — bottom
const HOUR_PX = 52

// One week (Sun–Sat) as a time grid: an all-day strip on top, then an hour grid
// with timed events absolutely positioned. Person chips filter the week; the
// quick-add bar opens the create modal pre-dated to the week's first day.
export function WeekView({
  weekStart,
  events,
  tz,
  countdownsByDate,
  onOpenEvent,
  onOpenCountdown,
  onCreate,
  onPickDay,
}: {
  weekStart: Date
  events: AgendaEvent[]
  tz: string
  countdownsByDate?: Record<string, Countdown[]>
  onOpenEvent: (e: AgendaEvent) => void
  onOpenCountdown?: (c: Countdown) => void
  onCreate: (date: string, time?: string) => void
  onPickDay?: (d: Date) => void
}) {
  const { persons = [] } = usePersons()
  // Empty selection = everyone (no filter); toggling a chip narrows to those people.
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart])
  const hours = useMemo(() => Array.from({ length: DAY_END - DAY_START + 1 }, (_, i) => DAY_START + i), [])
  const today = ymd(new Date())

  // The grid spans the whole day, so open it scrolled to where the action is:
  // an hour before "now" when this week includes today, otherwise the morning.
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const now = new Date()
    const inWeek = days.some((d) => ymd(d) === ymd(now))
    const focusHour = inWeek ? Math.max(0, now.getHours() - 1) : 7
    el.scrollTop = focusHour * HOUR_PX
  }, [days])

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
            // Tapping a day header jumps to that day in Day view.
            return (
              <div
                key={key}
                className={`wk-day-h ${key === today ? 'today' : ''} ${onPickDay ? 'tappable' : ''}`}
                role={onPickDay ? 'button' : undefined}
                tabIndex={onPickDay ? 0 : undefined}
                title={onPickDay ? 'Open this day' : undefined}
                onClick={onPickDay ? () => onPickDay(d) : undefined}
              >
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
            const dayCountdowns = countdownsByDate?.[key] ?? []
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
                {dayCountdowns.map((c) => (
                  <CountdownChip key={c.id} c={c} onOpen={onOpenCountdown} />
                ))}
              </div>
            )
          })}
        </div>

        <div className="wk-body" ref={bodyRef}>
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
              // Lay overlapping events out side-by-side instead of stacking them.
              const lanes = packLanes(timed)
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
                    const lane = lanes.get(e.id) ?? { lane: 0, lanes: 1 }
                    const width = `calc((100% - 6px) / ${lane.lanes})`
                    const left = `calc((100% - 6px) / ${lane.lanes} * ${lane.lane} + 3px)`
                    const tight = height < 34 // short events: title beside the time, no wrap
                    return (
                      <div
                        key={e.id}
                        className={`wk-ev ${isMeal ? 'ev-meal' : ''} ${tight ? 'tight' : ''}`}
                        style={{ top, height, left, width, background: `${color}22`, color, borderLeft: `3px solid ${color}` }}
                        title={isMeal ? `Planned meal · ${e.title}` : `${fmtTime(e)} · ${e.title}`}
                        onClick={(ev) => {
                          ev.stopPropagation()
                          onOpenEvent(e)
                        }}
                      >
                        <div className="wk-ev-t">{fmtTime(e)}</div>
                        <div className="wk-ev-title">{e.occurrenceStart && <span className="ev-rep" title="Repeats">↻ </span>}{e.title}</div>
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
