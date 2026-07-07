import { useMemo } from 'react'
import type { AgendaEvent } from '../../lib/api'
import { localDate, ymd } from './cal-utils'
import { AgendaRow, isPastEvent } from './AgendaView'

// Relative name for the selected day, so the panel header reads "Today" / "Tomorrow"
// / "Yesterday" instead of a bare date. Falls back to the weekday for anything else.
function relLabel(day: string, todayKey: string): string {
  const d = new Date(`${day}T00:00:00`)
  const t = new Date(`${todayKey}T00:00:00`)
  const diff = Math.round((d.getTime() - t.getTime()) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'long' })
}

// The month view's right-hand day panel (iPad parity): the selected day's events as
// agenda rows, already-ended ones subtly faded, with an add button + tap-to-add empty
// state. Reuses AgendaRow + isPastEvent so it matches the Agenda view exactly.
export function MonthDayPanel({
  day,
  events,
  tz,
  onOpenEvent,
  onCreate,
}: {
  day: string
  events: AgendaEvent[]
  tz: string
  onOpenEvent: (e: AgendaEvent) => void
  onCreate: (date: string) => void
}) {
  const now = new Date()
  const todayKey = ymd(now)

  // Events on the selected local day, all-day first then chronological.
  const dayEvents = useMemo(() => {
    const list = events.filter((e) => localDate(e.startsAt, tz) === day)
    list.sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
      return new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
    })
    return list
  }, [events, tz, day])

  const dateObj = new Date(`${day}T00:00:00`)
  const fullDate = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <aside className="cal-day-panel ag-side">
      <div className="cal-day-h">
        <div>
          <div className="wf-serif cal-day-rel">{relLabel(day, todayKey)}</div>
          <div className="muted cal-day-date">{fullDate}</div>
        </div>
        <button
          type="button"
          className="ag-group-add cal-day-add"
          title={`Add an event on ${fullDate}`}
          aria-label="Add an event on this day"
          onClick={() => onCreate(day)}
        >
          ＋
        </button>
      </div>
      {dayEvents.length === 0 ? (
        <button type="button" className="cal-day-empty" onClick={() => onCreate(day)}>
          <span className="cal-day-empty-t">Nothing scheduled</span>
          <span className="muted">Tap to add an event</span>
        </button>
      ) : (
        <div className="cal-day-list">
          {dayEvents.map((e) => (
            <AgendaRow key={e.id} event={e} past={isPastEvent(e, now)} onClick={() => onOpenEvent(e)} />
          ))}
        </div>
      )}
    </aside>
  )
}
