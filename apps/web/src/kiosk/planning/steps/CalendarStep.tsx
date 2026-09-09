import { useMemo, useState } from 'react'
import { useEventsRange, useHousehold, type AgendaEvent } from '../../../lib/api'
import { evVars, useEventColor } from '../../../lib/event-color'
import { EventModal } from '../../components/EventModal'
import { DOW, DOW_FULL, MONTHS_SHORT, addDays, localDate, ymd } from '../../components/cal-utils'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import { useHandoffAction } from '../handoff'
import '../../../styles/planning-calendar.css'

// Step 2 · Calendar — the week is the whole screen, and it is the REAL calendar.
//
// SEVEN DAY ROWS in one card, not seven columns. A day with nothing says "Nothing on the calendar"
// and takes a tint, so an open evening reads as an opportunity. The rows are `GET /api/events` over
// the week the server handed us, coloured by owner exactly as the other calendar views colour them.
//
// Four rules this file must not break:
//  1. THE SERVER OWNS THE WEEK. `weekStart` is a prop; the seven days are that date plus 0…6.
//  2. BUSY WEEKS STAY ONE SCREEN. A day over four events collapses behind a "+N more" pill that
//     opens that day IN PLACE — never a scrolling row, never a navigation away.
//  3. ADDING IS THE APP'S OWN EVENT MODAL, which already asks the date, the time AND ITS DURATION,
//     repeats, the location and who it's for, and writes through the local-first path.
//  4. NO INVENTED PRESENCE. The mock's face row is deliberately absent: the session is
//     single-driver and we do not track who is in the room.

// How many chips a row shows before it collapses behind "+N more".
const ROW_MAX = 4

/** "Sep 6 – 12", and "Sep 27 – Oct 3" when the week straddles a month. */
export function weekRangeLabel(weekStart: string): string {
  const a = new Date(`${weekStart}T00:00:00`)
  const b = addDays(a, 6)
  const left = `${MONTHS_SHORT[a.getMonth()]} ${a.getDate()}`
  const right = a.getMonth() === b.getMonth() ? `${b.getDate()}` : `${MONTHS_SHORT[b.getMonth()]} ${b.getDate()}`
  return `${left} – ${right}`
}

/** "Sunday, Thursday and Friday" — an Oxford-comma-free list a person would say. */
function names(list: string[]): string {
  if (list.length <= 1) return list[0] ?? ''
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/**
 * The one line under the week range. The open days are the POINT of the step — a week with room in
 * it is the thing a family can still decide about — so they are named, not counted.
 */
export function weekSummary(total: number, openDays: string[]): string {
  const count = total === 0 ? 'Nothing on the week yet' : total === 1 ? '1 event' : `${total} events`
  const open =
    openDays.length === 0
      ? 'every day has something'
      : openDays.length === 7
        ? 'every day is still open'
        : `${names(openDays)} ${openDays.length === 1 ? 'is' : 'are'} still open`
  return `${count} · ${open}`
}

// Deliberately not `fmtTime`: that renders a lowercase "all day", and the chip's leading cell is
// a real label.
function chipWhen(e: AgendaEvent): string {
  if (e.allDay) return 'All day'
  const d = new Date(e.startsAt)
  const h = d.getHours()
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

interface Day {
  key: string
  /** "SUN" */
  dow: string
  /** "Sunday" */
  full: string
  /** "Sep 6" */
  date: string
  today: boolean
}

// One event, as the week draws it. `.ev-tint` + `evVars` is the same chip painting every other
// calendar surface uses, so the unassigned/household case falls out of `useEventColor`.
function Chip({ e, color }: { e: AgendaEvent; color: string }) {
  const avatar = e.personEmoji ?? (e.personName ? e.personName.slice(0, 1).toUpperCase() : null)
  return (
    <span className={`wpc-chip ev-tint${avatar ? '' : ' bare'}`} style={evVars(color)}>
      <span className="wpc-chip-w">{chipWhen(e)}</span>
      <span className="wpc-chip-t">{e.title}</span>
      {avatar && (
        <i className="wpc-chip-av" role="img" aria-label={e.personName ?? undefined}>
          {avatar}
        </i>
      )}
    </span>
  )
}

function Body({ weekStart, setDecisionData, refresh, busy }: StepBodyProps) {
  const { household } = useHousehold()
  const tz = household?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const colorOf = useEventColor()

  // The server's `weekStart` plus 0…6. Local parse (no trailing Z) so the rows are the right days.
  const days = useMemo<Day[]>(() => {
    const start = new Date(`${weekStart}T00:00:00`)
    const todayKey = ymd(new Date())
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDays(start, i)
      const key = ymd(d)
      return {
        key,
        dow: DOW[d.getDay()].toUpperCase(),
        full: DOW_FULL[d.getDay()],
        date: `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`,
        today: key === todayKey,
      }
    })
  }, [weekStart])

  const { events, loading, refetch } = useEventsRange(days[0].key, days[6].key)

  // Bucketed by the HOUSEHOLD's zone (localDate), not the device's — an 8pm event on an
  // out-of-zone kiosk belongs to the evening it happens in, not to tomorrow.
  const byDay = useMemo(() => {
    const map: Record<string, AgendaEvent[]> = {}
    for (const e of events) (map[localDate(e.startsAt, tz)] ??= []).push(e)
    for (const k of Object.keys(map)) {
      map[k].sort((a, b) =>
        a.allDay === b.allDay
          ? new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
          : a.allDay ? -1 : 1
      )
    }
    return map
  }, [events, tz])

  // Which day the event modal is open on. The header's button preselects today when today is
  // inside the week being planned, else the week's first day.
  const [addOn, setAddOn] = useState<string | null>(null)
  // Per day, and never reset by a refetch: a row that collapsed under someone mid-read is worse.
  const [opened, setOpened] = useState<Set<string>>(() => new Set())
  // The crumb, and only ever a count: the recap reads through to the calendar itself.
  const [added, setAdded] = useState(0)
  // A parked note being turned INTO an event: its words seed the title, so it is not retyped.
  const [fromNote, setFromNote] = useState<string | null>(null)

  // The verb this step lends the shell's parked-note banner — the same modal the `＋` opens.
  const finishHandoff = useHandoffAction('Make an event', (note) => {
    setFromNote(note)
    setAddOn(headerDay)
  })

  const todayKey = ymd(new Date())
  const headerDay = days.some((d) => d.key === todayKey) ? todayKey : days[0].key
  const openDays = days.filter((d) => !(byDay[d.key] ?? []).length).map((d) => d.full)

  function onSaved() {
    const n = added + 1
    setAdded(n)
    setDecisionData({ added: n })
    // Something was really created, so a note that opened this modal is settled.
    if (fromNote !== null) { setFromNote(null); finishHandoff(true) }
    refetch()
    refresh()
  }

  function onCloseModal() {
    setAddOn(null)
    // Closed without saving: the note stays on the banner, still needing doing.
    if (fromNote !== null) { setFromNote(null); finishHandoff(false) }
  }

  return (
    <div className="wpc">
      <header className="wpc-head">
        <div className="wpc-head-l">
          <div className="wpc-range wf-serif">{weekRangeLabel(weekStart)}</div>
          <p className="wpc-sum">
            {loading && !events.length ? 'Reading your calendars…' : weekSummary(events.length, openDays)}
          </p>
        </div>
        <button type="button" className="btn wpc-new" disabled={busy} onClick={() => setAddOn(headerDay)}>
          <span aria-hidden>+</span> Add an event
        </button>
      </header>

      <div className="wpc-week">
        {days.map((d) => {
          const list = byDay[d.key] ?? []
          const shown = opened.has(d.key) || list.length <= ROW_MAX ? list : list.slice(0, ROW_MAX)
          const hidden = list.length - shown.length
          return (
            <div
              key={d.key}
              className={`wpc-row${list.length ? '' : ' free'}${d.today ? ' today' : ''}`}
              data-testid={`wpc-day-${d.key}`}
            >
              <div className="wpc-when">
                <span className="wpc-dow">{d.dow}</span>
                <span className="wpc-date wf-serif">{d.date}</span>
              </div>

              <div className="wpc-evs">
                {shown.map((e) => (
                  <Chip key={`${e.id}-${e.occurrenceStart ?? ''}`} e={e} color={colorOf(e)} />
                ))}
                {hidden > 0 && (
                  <button
                    type="button"
                    className="wpc-more"
                    onClick={() => setOpened((cur) => new Set(cur).add(d.key))}
                  >
                    +{hidden} more
                  </button>
                )}
                {!list.length && !loading && <span className="wpc-none">Nothing on the calendar</span>}
              </div>

              <button
                type="button"
                className="wpc-add"
                disabled={busy}
                aria-label={`Add an event on ${d.full}, ${d.date}`}
                onClick={() => setAddOn(d.key)}
              >
                <span aria-hidden>+</span>
              </button>
            </div>
          )
        })}
      </div>

      <p className="wpc-note">This is everything your calendars already have. Add what isn&rsquo;t here yet.</p>
      <p className="wpc-note wpc-note-q">
        Busy weeks stay one screen &mdash; a day over four events shows &ldquo;+N more&rdquo;, which opens that day.
      </p>

      {/* The app's own event modal — NOT a second event form. It owns the time and the write. */}
      {addOn && (
        <EventModal
          date={addOn}
          {...(fromNote !== null ? { prefill: { title: fromNote } } : {})}
          onClose={onCloseModal}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}

// No FooterExtra: the shell already owns the single primary ("Looks right").
const mod: PlanningStepModule = { Body }
export default mod
