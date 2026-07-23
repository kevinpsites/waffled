import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Icon } from './icons'
import { EventModal } from './components/EventModal'
import { CountdownEditModal } from './components/CountdownEditModal'
import { MonthView } from './components/MonthView'
import { WeekView } from './components/WeekView'
import { DayView } from './components/DayView'
import { AgendaView } from './components/AgendaView'
import { useTopbarRight } from './topbar-slot'
import { useEventsRange, useHousehold, useCountdowns, type AgendaEvent, type Countdown } from '../lib/api'
import { MONTHS, MONTHS_SHORT, DOW_FULL, ymd, addDays, startOfWeek, eventDetailPath } from './components/cal-utils'

type View = 'month' | 'week' | 'day' | 'agenda'

// Remember the last view + focused date across navigations (opening an event
// detail unmounts Calendar), so coming "back" returns you to where you were
// instead of resetting to the month grid. Module-level: lives for the SPA session.
const lastCalState: { view: View; anchorTime: number } = { view: 'month', anchorTime: Date.now() }

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

// Which day the month view's side panel should focus when landing on a month:
// today if we're looking at the current month, otherwise the 1st (so the panel
// always shows a day that's actually on screen).
function defaultDayForMonth(d: Date): string {
  const now = new Date()
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return ymd(now)
  return ymd(new Date(d.getFullYear(), d.getMonth(), 1))
}

// The [from,to] date window to fetch for a given view/anchor.
function rangeFor(view: View, anchor: Date): { from: string; to: string } {
  if (view === 'week') {
    const ws = startOfWeek(anchor)
    return { from: ymd(ws), to: ymd(addDays(ws, 6)) }
  }
  if (view === 'day') {
    return { from: ymd(anchor), to: ymd(anchor) }
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
  if (view === 'day') return `${DOW_FULL[anchor.getDay()]}, ${MONTHS[anchor.getMonth()]} ${anchor.getDate()}`
  const ws = startOfWeek(anchor)
  const we = addDays(ws, 6)
  const start = `${MONTHS_SHORT[ws.getMonth()]} ${ws.getDate()}`
  const end = ws.getMonth() === we.getMonth() ? `${we.getDate()}` : `${MONTHS_SHORT[we.getMonth()]} ${we.getDate()}`
  return `${start} – ${end}`
}

// A `?date=YYYY-MM-DD` present in the URL wins over the remembered state — it's how
// deep-links (e.g. tapping a countdown on Today) land the calendar on a given day.
const VIEWS: View[] = ['month', 'week', 'day', 'agenda']

export function Calendar() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const paramDate = searchParams.get('date')
  const paramView = searchParams.get('view')
  const [view, setView] = useState<View>(() =>
    paramView && VIEWS.includes(paramView as View) ? (paramView as View) : lastCalState.view
  )
  const [anchor, setAnchor] = useState(() =>
    paramDate && /^\d{4}-\d{2}-\d{2}$/.test(paramDate) ? new Date(`${paramDate}T12:00:00`) : new Date(lastCalState.anchorTime)
  )
  const [selectedDay, setSelectedDay] = useState(() =>
    paramDate && /^\d{4}-\d{2}-\d{2}$/.test(paramDate) ? paramDate : defaultDayForMonth(new Date(lastCalState.anchorTime))
  )
  const [modal, setModal] = useState<{ date?: string; time?: string } | null>(null)
  const [editCountdown, setEditCountdown] = useState<Countdown | null>(null)

  // Persist view + anchor so returning from an event detail restores this spot.
  useEffect(() => {
    lastCalState.view = view
    lastCalState.anchorTime = anchor.getTime()
  }, [view, anchor])

  const { from, to } = useMemo(() => rangeFor(view, anchor), [view, anchor])
  const { events, refetch } = useEventsRange(from, to)

  const { household } = useHousehold()
  const tz = household?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

  // Countdown badges on the calendar (all three sources, keyed by target day).
  const { countdowns } = useCountdowns()
  const countdownsByDate = useMemo(() => {
    const m: Record<string, Countdown[]> = {}
    for (const c of countdowns) (m[c.date] ??= []).push(c)
    return m
  }, [countdowns])

  function shift(delta: number) {
    setAnchor((a) => {
      if (view === 'month') {
        const next = addMonths(a, delta)
        setSelectedDay(defaultDayForMonth(next))
        return next
      }
      return view === 'day' ? addDays(a, delta) : addDays(a, delta * 7)
    })
  }
  function goToday() {
    const now = new Date()
    setAnchor(now)
    if (view === 'month') setSelectedDay(ymd(now))
  }
  const openEvent = (e: AgendaEvent) => navigate(eventDetailPath(e))
  // Tapping a countdown routes by source: an event-sourced one deep-links to that
  // event's detail page (rename + a "Show a countdown" toggle); a standalone one opens
  // the inline editor (rename/move/remove); a birthday has no editing surface here (it
  // comes from the person's profile), so it jumps to its day for context (parity with the
  // Today card, which also navigates a birthday tap to the calendar day).
  const openCountdown = (c: Countdown) => {
    if (c.source === 'event') navigate(`/calendar/event/${c.id}`)
    else if (c.source === 'standalone') setEditCountdown(c)
    else jumpToDay(new Date(`${c.date}T12:00:00`))
  }
  const jumpToWeek = (d: Date) => {
    setAnchor(d)
    setView('week')
  }
  const jumpToDay = (d: Date) => {
    setAnchor(d)
    setView('day')
  }
  const navLabel = view === 'month' ? 'month' : view === 'day' ? 'day' : 'week'

  // The view toggle + period nav live in the topbar's right slot (replacing the
  // capture bar on this screen), matching the per-screen-topbar pattern.
  useTopbarRight(
    () => (
      <div className="cal-topbar">
        <div className="seg">
          {(['month', 'week', 'day', 'agenda'] as View[]).map((v) => (
            <button key={v} type="button" className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        {view !== 'agenda' && (
          <div className="cal-nav">
            <button type="button" className="icon-btn" aria-label={`Previous ${navLabel}`} onClick={() => shift(-1)}>
              <Icon name="cl" />
            </button>
            <button type="button" className="pill cal-period" onClick={goToday}>
              {periodLabel(view, anchor)}
            </button>
            <button type="button" className="icon-btn" aria-label={`Next ${navLabel}`} onClick={() => shift(1)}>
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
          countdownsByDate={countdownsByDate}
          selectedDay={selectedDay}
          onSelectDay={setSelectedDay}
          onOpenEvent={openEvent}
          onCountdownTap={(cds) =>
            // One countdown → open it directly; several on the same day → jump to Day
            // view, where each is listed as its own (tappable) chip so all are reachable.
            cds.length > 1 ? jumpToDay(new Date(`${cds[0].date}T12:00:00`)) : openCountdown(cds[0])
          }
          onCreateOnDay={(date) => setModal({ date })}
          onMore={(date) => jumpToDay(new Date(`${date}T12:00:00`))}
        />
      )}
      {view === 'week' && (
        <WeekView
          weekStart={startOfWeek(anchor)}
          events={events}
          tz={tz}
          countdownsByDate={countdownsByDate}
          onOpenEvent={openEvent}
          onOpenCountdown={openCountdown}
          onCreate={(date, time) => setModal({ date, time })}
          onPickDay={(d) => jumpToDay(d)}
        />
      )}
      {view === 'day' && (
        <DayView
          day={anchor}
          events={events}
          tz={tz}
          countdownsByDate={countdownsByDate}
          onOpenEvent={openEvent}
          onOpenCountdown={openCountdown}
          onCreate={(date, time) => setModal({ date, time })}
        />
      )}
      {view === 'agenda' && (
        <AgendaView events={events} tz={tz} onOpenEvent={openEvent} onPickDate={jumpToWeek} onCreate={(date) => setModal({ date })} />
      )}

      {modal && (
        <EventModal date={modal.date} time={modal.time} onClose={() => setModal(null)} onSaved={refetch} />
      )}
      {editCountdown && (
        <CountdownEditModal countdown={editCountdown} onClose={() => setEditCountdown(null)} />
      )}
    </div>
  )
}
