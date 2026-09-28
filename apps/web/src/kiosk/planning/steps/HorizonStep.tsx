import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  horizonApi,
  looseEndsApi,
  useCountdowns,
  useEventsRange,
  useHousehold,
  type AgendaEvent,
  type Countdown,
  type HorizonNote,
  type HorizonTag,
} from '../../../lib/api'
// Not re-exported from lib/api — a refused park's message is the useful half of the failure.
import { ApiSendError } from '../../../lib/api/client'
import { EventModal } from '../../components/EventModal'
import { MonthView } from '../../components/MonthView'
import { MONTHS, addDays, monthGridStart, ymd } from '../../components/cal-utils'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import { ParkedNoteEditor } from '../ParkedNoteEditor'
import '../../../styles/planning-horizon.css'

// Step 3 · Horizon scan — THE MONTH YOU ALREADY SHIP, PLUS ONE BAR.
//
// This file renders `MonthView`; it does not draw a calendar. The 42-cell grid, the owner-colour
// resolution (`lib/event-color.ts`), the ↻ on a repeat, the dashed edge on a meal-plan dinner, the
// countdown badges and the day panel all come for free and stay identical to the calendar the
// family already knows. A second month grid here would drift from that one.
//
// Three rules this file must not break:
//  1. THE ＋ AND THE BAR ARE DIFFERENT THINGS. ＋ writes a REAL EVENT through `EventModal`; the bar
//     parks a NOTE, never written onto the calendar, tagged with the step that will look at it.
//  2. NOTHING NAVIGATES — the shell owns where the session is.
//  3. THE SERVER OWNS THE WEEK. `weekStart` is a prop; nothing here asks the device.

  // Read back from `planning_parked_items` rather than kept on the session: `setDecisionData`
  // only reaches the server when the step is ANSWERED.
function useHorizon(sessionId: string) {
  const [tags, setTags] = useState<HorizonTag[]>([])
  const [parked, setParked] = useState<HorizonNote[]>([])
  // A failed read must SAY so rather than leaving `parked` empty: an empty board and an
  // unreadable one look identical, so notes written a moment earlier would silently vanish.
  const [readFailed, setReadFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setReadFailed(false)
    horizonApi.get(sessionId)
      .then((v) => {
        if (!alive) return
        setTags(v.tags ?? [])
        setParked(v.parked ?? [])
      })
      .catch(() => { if (alive) setReadFailed(true) })
    return () => {
      alive = false
    }
  }, [sessionId])
  return { tags, parked, setParked, readFailed }
}

/** "September 2026" — the label between the month arrows. */
export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month]} ${year}`
}

function Body({ weekStart, sessionId, setDecisionData, refresh, busy }: StepBodyProps) {
  const { household } = useHousehold()
  // Which day starts the week, so the grid is cut the way this household cuts one. Never Monday.
  const firstDay = household?.weekStart === 'monday' ? 1 : 0
  const tz = household?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

  // The month the planned week falls in, and the floor for scanning: a horizon is what is AHEAD.
  const floor = useMemo(() => {
    const d = new Date(`${weekStart}T00:00:00`)
    return { year: d.getFullYear(), month: d.getMonth() }
  }, [weekStart])
  const [ahead, setAhead] = useState(0)
  const anchor = useMemo(() => new Date(floor.year, floor.month + ahead, 1), [floor, ahead])
  const year = anchor.getFullYear()
  const month = anchor.getMonth()

  // The fetch window is the 42 cells the grid draws, via the SAME `monthGridStart` the grid uses.
  const gridStart = useMemo(() => monthGridStart(year, month, firstDay), [year, month, firstDay])
  const { events, refetch } = useEventsRange(ymd(gridStart), ymd(addDays(gridStart, 41)))

  const { countdowns } = useCountdowns()
  const countdownsByDate = useMemo(() => {
    const m: Record<string, Countdown[]> = {}
    for (const c of countdowns) (m[c.date] ??= []).push(c)
    return m
  }, [countdowns])

  // The panel focuses the first day of the planned week on its own month, else the 1st.
  const [selectedDay, setSelectedDay] = useState(weekStart)
  useEffect(() => {
    setSelectedDay(ahead === 0 ? weekStart : ymd(new Date(year, month, 1)))
  }, [ahead, weekStart, year, month])

  // The shared event modal: `{ date }` creates on that day, `{ event }` edits in place.
  const [modal, setModal] = useState<{ date?: string; event?: AgendaEvent } | null>(null)

  const { tags, parked, setParked, readFailed } = useHorizon(sessionId)
  const [note, setNote] = useState('')
  // Which step this note is for. THREE states, not two: `undefined` is "nobody has chosen", which
  // resolves to the server's primary tag, while `null` is the deliberate answer "No tag".
  const [tag, setTag] = useState<string | null | undefined>(undefined)
  const chosen = tag === undefined ? (tags.find((t) => t.primary)?.stepKey ?? null) : tag
  const [parking, setParking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState(0)
  const [editing, setEditing] = useState<string | null>(null)
  // Parking is a BURST, so the cursor goes back after each note rather than making you re-aim.
  const inputRef = useRef<HTMLInputElement>(null)
  const wantFocus = useRef(false)

  // The crumb: two counts, and only counts. The recap reads through to the calendar and the table.
  useEffect(() => {
    setDecisionData({ added, parked: parked.length })
  }, [added, parked.length, setDecisionData])

  function onSaved() {
    setAdded((n) => n + 1)
    refetch()
    refresh()
  }

  function park(e: FormEvent) {
    e.preventDefault()
    const text = note.trim()
    if (!text || parking) return
    setParking(true)
    setError(null)
    // Step 1's writer, on purpose: `parkItem()` was written general, so this bar needed no migration.
    looseEndsApi
      .park(text, { ...(chosen ? { stepKey: chosen } : {}), sessionId })
      .then((r) => {
        setParked((cur) => [
          ...cur,
          {
            id: r.item.id,
            note: text,
            stepKey: chosen,
            stepLabel: tags.find((t) => t.stepKey === chosen)?.label ?? null,
            createdAt: new Date().toISOString(),
          },
        ])
        setNote('')
        setTag(undefined)
        wantFocus.current = true
        refresh()
      })
      // KEEP THE SENTENCE. `parkItem` caps a note at 500 characters, so a refusal is reachable.
      .catch((err: unknown) =>
        setError(
          err instanceof ApiSendError && typeof err.body?.message === 'string'
            ? err.body.message
            : "That didn't go through — try again."
        )
      )
      .finally(() => setParking(false))
  }

  const disabled = busy || parking

  // Restored in an EFFECT rather than in the `.then`, because the bar is still `disabled` while
  // the write is in flight and `focus()` on a disabled input does nothing at all — silently.
  useEffect(() => {
    if (!wantFocus.current || disabled) return
    wantFocus.current = false
    inputRef.current?.focus()
  }, [disabled])

  return (
    <div className="wph">
      {readFailed && (
        <div className="wp-err" role="alert">
          Couldn’t read what’s parked in this session. The month above is fine — anything you
          parked is still there; this board just couldn’t be fetched.
        </div>
      )}
      <header className="wph-head">
        <button
          type="button"
          className="wph-nav"
          aria-label="Previous month"
          disabled={ahead === 0 || busy}
          onClick={() => setAhead((n) => Math.max(0, n - 1))}
        >
          ‹
        </button>
        <div className="wph-month wf-serif">{monthLabel(year, month)}</div>
        <button
          type="button"
          className="wph-nav"
          aria-label="Next month"
          disabled={busy}
          onClick={() => setAhead((n) => n + 1)}
        >
          ›
        </button>
      </header>

      <div className="wph-cal">
        <MonthView
          year={year}
          month={month}
          firstDay={firstDay}
          // Two, not three: the parked board underneath has to stay on screen and a chip is never
          // allowed to shrink to make room.
          maxChips={2}
          events={events}
          tz={tz}
          countdownsByDate={countdownsByDate}
          selectedDay={selectedDay}
          onSelectDay={setSelectedDay}
          // In place, both of them: the shell owns where the session is.
          onOpenEvent={(e) => setModal({ event: e })}
          onMore={setSelectedDay}
          onCreateOnDay={(date) => setModal({ date })}
        />
      </div>

      <form className="wph-park" onSubmit={park}>
        <span className="wph-park-pin" aria-hidden>
          📌
        </span>
        <input
          ref={inputRef}
          className="wph-park-in"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={disabled}
          // The server's own cap (`parkItem`'s MAX_NOTE), so a long note is stopped here, not by a 400.
          maxLength={500}
          placeholder={'Park a note — “we’re going camping, we need to pack”'}
          aria-label="Park a note"
        />
        {note.trim() ? (
          <button type="submit" className="btn btn-primary wph-park-go" disabled={disabled || !note.trim()}>
            Park it
          </button>
        ) : (
          <span className="wph-park-hint">a note, not a calendar entry</span>
        )}
      </form>

      {/* BELOW the pill, not inside it: five-to-seven chips plus a button cramped the capture line. */}
      {note.trim() && (
        <div className="wph-park-tagrow">
          <div className="wph-tags" role="group" aria-label="Which step should look at this?">
            {tags.map((t) => (
              <button
                key={t.stepKey}
                type="button"
                className={`wph-tag${chosen === t.stepKey ? ' on' : ''}`}
                title={t.hint}
                disabled={disabled}
                onClick={() => setTag(t.stepKey)}
              >
                {t.label}
              </button>
            ))}
            <button
              type="button"
              className={`wph-tag${chosen === null ? ' on' : ''}`}
              disabled={disabled}
              onClick={() => setTag(null)}
            >
              No tag
            </button>
          </div>
          {/* Both outcomes stated: a tag is a DESTINATION, so that step's handoff banner raises the
              note; with no tag no step raises it and it stays on the board. */}
          <p className="wph-park-says" data-testid="wph-park-says">
            {chosen ? (
              <>
                Comes back at <b>{tags.find((t) => t.stepKey === chosen)?.label}</b>, later in this
                session.
              </>
            ) : (
              <>
                <b>No step will raise it.</b> It stays on the board — in tonight&rsquo;s recap, and
                waiting at Loose ends next session.
              </>
            )}
          </p>
        </div>
      )}

      {error && (
        <p className="wph-err" role="alert">
          {error}
        </p>
      )}

      <p className="wph-note">
        <b>Know the day it lands?</b> Tap that day on the month above and add it — you get a real
        calendar event. <b>Only know it&rsquo;s coming?</b> Park it in the bar: it stays off the
        calendar, and comes back at whichever step you tag it for &mdash; all of them still ahead
        of you tonight.
      </p>

      {parked.length > 0 && (
        <>
          {/* Named, because the read returns every note parked this session whichever bar wrote it. */}
          <h3 className="wph-board-h">Parked in this session</h3>
          <ul className="wph-board" data-testid="wph-board">
            {parked.map((n) => (
              <li key={n.id} className="wph-parked">
                {editing === n.id ? (
                  // The same editor the shell's gold box uses, offering the SAME tags the bar did.
                  <ParkedNoteEditor
                    id={n.id}
                    note={n.note}
                    stepKey={n.stepKey}
                    tags={tags}
                    sessionId={sessionId}
                    busy={busy}
                    onCancel={() => setEditing(null)}
                    onSaved={(next) => {
                      setEditing(null)
                      setParked((cur) =>
                        cur.map((p) =>
                          p.id !== next.id
                            ? p
                            : {
                                ...p,
                                note: next.note,
                                stepKey: next.stepKey,
                                // The label is joined from the catalog, never stored.
                                stepLabel: tags.find((t) => t.stepKey === next.stepKey)?.label ?? null,
                              }
                        )
                      )
                      refresh()
                    }}
                  />
                ) : (
                  <>
                    <span className="wph-parked-note">{n.note}</span>
                    {n.stepLabel ? (
                      <span className="wph-parked-tag">{n.stepLabel}</span>
                    ) : (
                      <span className="wph-parked-tag is-unset">No tag</span>
                    )}
                    <button
                      type="button"
                      className="wph-parked-edit"
                      disabled={disabled}
                      onClick={() => setEditing(n.id)}
                      aria-label={`Edit “${n.note}”`}
                    >
                      Edit
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* The app's own event modal — NOT a second event form. Creating carries the day's ＋. */}
      {modal && (
        <EventModal
          date={modal.date}
          event={modal.event}
          onClose={() => setModal(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}

// No FooterExtra: the shell already owns Skip and the affirmative.
const mod: PlanningStepModule = { Body }
export default mod
