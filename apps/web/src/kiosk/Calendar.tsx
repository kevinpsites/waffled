import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { Icon } from './icons'
import { EventModal } from './components/EventModal'
import { MonthView } from './components/MonthView'
import { WeekView } from './components/WeekView'
import { AgendaView } from './components/AgendaView'
import { useTopbarRight } from './topbar-slot'
import { useEventsRange, useHousehold, type AgendaEvent } from '../lib/api'
import { MONTHS, MONTHS_SHORT, ymd, addDays, startOfWeek } from './components/cal-utils'

type View = 'month' | 'week' | 'agenda'

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

// The [from,to] date window to fetch for a given view/anchor.
function rangeFor(view: View, anchor: Date): { from: string; to: string } {
  if (view === 'week') {
    const ws = startOfWeek(anchor)
    return { from: ymd(ws), to: ymd(addDays(ws, 6)) }
  }
  if (view === 'agenda') {
    const today = new Date()
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    return { from: ymd(start), to: ymd(addDays(start, 44)) }
  }
  // month: the full 6-week grid, including spill days
  const startWeekday = new Date(anchor.getFullYear(), anchor.getMonth(), 1).getDay()
  const gridStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1 - startWeekday)
  return { from: ymd(gridStart), to: ymd(addDays(gridStart, 41)) }
}

// The label between the nav arrows for the current view.
function periodLabel(view: View, anchor: Date): string {
  if (view === 'month') return `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`
  const ws = startOfWeek(anchor)
  const we = addDays(ws, 6)
  const start = `${MONTHS_SHORT[ws.getMonth()]} ${ws.getDate()}`
  const end = ws.getMonth() === we.getMonth() ? `${we.getDate()}` : `${MONTHS_SHORT[we.getMonth()]} ${we.getDate()}`
  return `${start} – ${end}`
}

export function Calendar() {
  const navigate = useNavigate()
  const [view, setView] = useState<View>('month')
  const [anchor, setAnchor] = useState(() => new Date())
  const [modal, setModal] = useState<{ date?: string; time?: string } | null>(null)

  const { from, to } = useMemo(() => rangeFor(view, anchor), [view, anchor])
  const { events, refetch } = useEventsRange(from, to)

  const { household } = useHousehold()
  const tz = household?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

  function shift(delta: number) {
    setAnchor((a) => (view === 'month' ? addMonths(a, delta) : addDays(a, delta * 7)))
  }
  const openEvent = (e: AgendaEvent) => navigate(`/calendar/event/${e.id}`)
  const jumpToWeek = (d: Date) => {
    setAnchor(d)
    setView('week')
  }

  // The view toggle + period nav live in the topbar's right slot (replacing the
  // capture bar on this screen), matching the per-screen-topbar pattern.
  useTopbarRight(
    () => (
      <div className="cal-topbar">
        <div className="seg">
          {(['month', 'week', 'agenda'] as View[]).map((v) => (
            <button key={v} type="button" className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        {view !== 'agenda' && (
          <div className="cal-nav">
            <button type="button" className="icon-btn" aria-label={view === 'month' ? 'Previous month' : 'Previous week'} onClick={() => shift(-1)}>
              <Icon name="cl" />
            </button>
            <button type="button" className="pill cal-period" onClick={() => setAnchor(new Date())}>
              {periodLabel(view, anchor)}
            </button>
            <button type="button" className="icon-btn" aria-label={view === 'month' ? 'Next month' : 'Next week'} onClick={() => shift(1)}>
              <Icon name="cr" />
            </button>
          </div>
        )}
      </div>
    ),
    [view, anchor.getTime()]
  )

  return (
    <div className="cal-screen">
      {view === 'month' && (
        <MonthView
          year={anchor.getFullYear()}
          month={anchor.getMonth()}
          events={events}
          tz={tz}
          onOpenEvent={openEvent}
          onCreateOnDay={(date) => setModal({ date })}
          onMore={(date) => jumpToWeek(new Date(`${date}T12:00:00`))}
        />
      )}
      {view === 'week' && (
        <WeekView
          weekStart={startOfWeek(anchor)}
          events={events}
          tz={tz}
          onOpenEvent={openEvent}
          onCreate={(date, time) => setModal({ date, time })}
        />
      )}
      {view === 'agenda' && (
        <AgendaView events={events} tz={tz} onOpenEvent={openEvent} onPickDate={jumpToWeek} />
      )}

      {modal && (
        <EventModal date={modal.date} time={modal.time} onClose={() => setModal(null)} onSaved={refetch} />
      )}
    </div>
  )
}
