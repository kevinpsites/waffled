import { useEffect, useMemo, useRef, useState } from 'react'
import {
  rhythmsApi,
  useRhythms,
  useRhythmAttention,
  usePersons,
  cadenceLabel,
  countdown,
  daysToGo,
  periodProgress,
  urgencyOf,
  type RhythmPeriod,
  type RhythmWithPeriod,
  type Urgency,
} from '../lib/api'
import { BookRhythmModal } from './components/BookRhythmModal'
import { RhythmModal } from './components/RhythmModal'
import '../styles/rhythms.css'

// The rhythms register — the whole list, what state each one is in, and where new
// ones get made.
//
// Grouped by WHEN, not by kind. It used to be two sections named after the two shapes
// ("It gets scheduled" / "You do it"), which sorts a household's rhythms by a
// distinction only the schema cares about: asked "what do I owe this week" you had to
// read both sections and merge them yourself. One axis — urgency — answers that in a
// single pass down the page.
//
// The shapes did not go away; they stopped being furniture. A booking rhythm still
// never gets asked whether it happened, and that shows up exactly where it changes
// what you do: the meta line reads "not on the calendar yet" instead of "last done
// May 12", and the button says "Book a time" instead of "I did it". Naming the
// taxonomy on top of that was the redundant part.
//
// Where a row's band comes from lives in `urgencyOf` (lib/api/rhythms.ts) — notably
// "Needs you now" is the server's own /attention list and nothing else, so this screen
// and the Today card can never disagree about one rhythm.

function shortDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Today as YYYY-MM-DD on the viewer's clock — the `max` a completion may carry. */
function todayKey(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, '0')}`
}

// Whether a completion rhythm was already done today, on the VIEWER's clock.
//
// This is what lets the row acknowledge a tap. Completing something already completed
// today recomputes the row to the byte-identical string, so without this the button was
// indistinguishable from a dead one — and got pressed again, and again.
function completedToday(iso: string | null): boolean {
  if (!iso) return false
  const done = new Date(iso)
  if (Number.isNaN(done.getTime())) return false
  const now = new Date()
  return done.getFullYear() === now.getFullYear()
    && done.getMonth() === now.getMonth()
    && done.getDate() === now.getDate()
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

interface Band {
  key: Exclude<Urgency, 'paused'>
  title: string
  hint: string
}

// Three bands, and the hint under each says what earns a place in it. "Needs you now"
// is deliberately not defined by a number here — it is whatever the server is already
// nudging about, which is why the hint describes the situation rather than a threshold.
const BANDS: Band[] = [
  { key: 'now', title: 'Needs you now', hint: 'late, or the window is closing' },
  { key: 'soon', title: 'Coming up', hint: 'the next two weeks' },
  { key: 'steady', title: 'Steady', hint: 'nothing to do yet' },
]

function RhythmRow({
  rhythm,
  urgency,
  personName,
  personColor,
  onBook,
  onEdit,
  onChanged,
}: {
  rhythm: RhythmWithPeriod
  urgency: Urgency
  personName: string | null
  personColor: string | null
  onBook: (period: RhythmPeriod) => void
  onEdit: () => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState(false)
  // The backdating row, opened from the menu. Closed by default: the common case is
  // "I just did it", and putting a date picker in front of that every time would be
  // friction on the path people actually take.
  const [backdate, setBackdate] = useState<string | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)

  const paused = urgency === 'paused'
  const scheduling = rhythm.satisfiedBy === 'scheduling'
  const doneToday = !scheduling && completedToday(rhythm.lastCompletedAt)
  const needsBooking = !paused && scheduling && !rhythm.satisfied
  const cd = paused ? null : countdown(rhythm, urgency, new Date())
  const pct = paused ? null : periodProgress(rhythm)
  const period: RhythmPeriod | null =
    rhythm.currentPeriodStart && rhythm.currentPeriodEnd
      ? { rhythm, periodStart: rhythm.currentPeriodStart, periodEnd: rhythm.currentPeriodEnd }
      : null

  // Only Needs-you-now and Coming-up carry a button. Most of a healthy register is
  // Steady, and a page of buttons for things with nothing to do reads as a page of
  // chores — which is the opposite of what a rhythm is.
  //
  // `doneToday` is the exception, and it earns it: completing something already done
  // today recomputes the row to the identical string, so the button looked dead and
  // got pressed again — the demo database ended up with four rows for one air-filter
  // change. Finishing it also drops the row into Steady, so without this the
  // acknowledgement would vanish in the same tick the tap landed.
  const showAction = !paused && (urgency === 'now' || urgency === 'soon' || doneToday)
  const primary = urgency === 'now'

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if (!rowRef.current?.contains(e.target as Node)) setMenu(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])

  async function run(fn: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setMenu(false)
    try {
      await fn()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`rhy-row${urgency === 'now' ? ' now' : ''}${paused ? ' off' : ''}`} ref={rowRef}>
      <div className="rhy-tile" aria-hidden>{rhythm.emoji ?? (scheduling ? '🗓️' : '🔁')}</div>

      <div className="rhy-main">
        <div className="rhy-name">
          {rhythm.title}
          {/* A booked period is settled. The tick says so without a badge saying
              "Handled", which was a label for a state the countdown already shows. */}
          {scheduling && rhythm.satisfied && !paused && (
            <span className="rhy-tick" aria-label="on the calendar">✓</span>
          )}
          {personColor && <i className="rhy-dot" style={{ background: personColor }} aria-hidden />}
        </div>
        <div className="rhy-meta">
          {capitalize(cadenceLabel(rhythm.every))}
          {/* A paused rhythm says only that it is paused. Its period state is still
              computed by the list, but nothing nudges about it and nothing can be done
              with it — so "not on the calendar yet" would be a complaint about a
              situation we have deliberately stopped caring about. */}
          {paused ? <> · <b>paused</b></> : scheduling ? (
            rhythm.satisfied
              ? <> · on the calendar for this one</>
              // One node, not "<b>not on the calendar</b> yet" as the mock has it: a
              // phrase split across elements is unfindable by the text people actually
              // read, which is how a screen reader and a test both see the page.
              : <> · <b>not on the calendar yet</b></>
          ) : (
            rhythm.lastCompletedAt
              ? <> · last done <b>{shortDate(rhythm.lastCompletedAt)}</b></>
              : <> · <b>never done</b></>
          )}
          {personName ? ` · ${personName}` : ''}
          {rhythm.notes ? ` · ${rhythm.notes}` : ''}
        </div>
        {pct !== null && (
          <div className="rhy-track"><div style={{ width: `${pct}%` }} /></div>
        )}
      </div>

      {cd ? (
        <div className={`rhy-cd ${cd.tone}`}>
          <b>{cd.num}</b>
          <span>{cd.unit}</span>
        </div>
      ) : <div />}

      <div className="rhy-actcell">
        {showAction && !scheduling && (
          <button
            type="button"
            className={`btn ${doneToday ? 'btn-ghost rhy-done' : primary ? 'btn-primary' : 'btn-ghost'}`}
            disabled={busy || doneToday}
            onClick={() => { if (!doneToday) run(() => rhythmsApi.complete(rhythm.id)) }}
          >
            {doneToday ? 'Done today ✓' : 'I did it'}
          </button>
        )}
        {showAction && needsBooking && period && (
          <button
            type="button"
            className={`btn ${primary ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => onBook(period)}
          >
            {rhythm.autoSchedule ? 'Put it back' : 'Book a time'}
          </button>
        )}
      </div>

      <button
        type="button"
        className="rhy-more"
        aria-label={`More for ${rhythm.title}`}
        aria-expanded={menu}
        onClick={() => setMenu((m) => !m)}
      >
        ···
      </button>

      {menu && (
        <div className="rhy-menu" role="menu">
          {!scheduling && (
            <button
              type="button"
              aria-label={`Mark ${rhythm.title} done on another day`}
              onClick={() => { setBackdate(todayKey()); setMenu(false) }}
            >
              Mark done on another day
            </button>
          )}
          {/* A period can be booked long before its runway opens — that is the case
              /attention structurally cannot report, and the reason the list carries
              period bounds at all. Losing it to "Steady rows get no button" would
              quietly remove the capability rather than just quieten it, so it moves
              in here instead of disappearing. */}
          {needsBooking && period && !showAction && (
            <button
              type="button"
              aria-label={`Book a time for ${rhythm.title}`}
              onClick={() => { setMenu(false); onBook(period) }}
            >
              {rhythm.autoSchedule ? 'Put it back on the calendar' : 'Book a time'}
            </button>
          )}
          {needsBooking && period && (
            <button
              type="button"
              aria-label={`Skip this period for ${rhythm.title}`}
              disabled={busy}
              onClick={() => run(() => rhythmsApi.skip(rhythm.id, period.periodStart))}
            >
              Skip this period
            </button>
          )}
          <button type="button" aria-label={`Edit ${rhythm.title}`} onClick={() => { setMenu(false); onEdit() }}>
            Edit rhythm
          </button>
          <hr />
          <button
            type="button"
            className="warn"
            aria-label={`${paused ? 'Resume' : 'Pause'} ${rhythm.title}`}
            disabled={busy}
            onClick={() => run(() => rhythmsApi.update(rhythm.id, { isActive: paused }))}
          >
            {paused ? 'Resume this rhythm' : 'Pause this rhythm'}
          </button>
        </div>
      )}

      {/* Backdating. The completion shape's whole premise is that the clock restarts
          from when you ACTUALLY did it, so "I changed the filter last Tuesday" has to
          be sayable — otherwise being late silently re-anchors everything to today and
          the register's one useful fact ("it last happened on…") becomes a guess. */}
      {backdate !== null && (
        <div className="rhy-backdate">
          <label className="field rhy-backdate-f">
            <span>When did you do it?</span>
            <input
              type="date"
              value={backdate}
              max={todayKey()}
              onChange={(e) => setBackdate(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !backdate || backdate > todayKey()}
            onClick={() => {
              // Midday, not midnight: a date-only value read as local midnight can land
              // on the previous day once it's an instant in a western timezone, which
              // would file the completion under the wrong date.
              const at = new Date(`${backdate}T12:00:00`).toISOString()
              run(() => rhythmsApi.complete(rhythm.id, { completedAt: at }))
              setBackdate(null)
            }}
          >
            Log it
          </button>
          <button type="button" className="rhy-skip" onClick={() => setBackdate(null)}>Cancel</button>
        </div>
      )}
    </div>
  )
}

export function Rhythms() {
  const { rhythms, loading, error, refetch } = useRhythms()
  // The horizon is today, deliberately: `to` is both how far ahead we look AND the
  // date that picks WHICH period a scheduling rhythm reports on, so asking further
  // out would quietly describe a later one.
  const { items, refetch: refetchAttention } = useRhythmAttention()
  const { persons } = usePersons()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<RhythmWithPeriod | null>(null)
  const [booking, setBooking] = useState<RhythmPeriod | null>(null)
  const [showPaused, setShowPaused] = useState(false)

  const byId = useMemo(() => new Map(items.map((i) => [i.rhythm.id, i])), [items])
  const people = useMemo(() => new Map(persons.map((p) => [p.id, p])), [persons])

  // Banded and sorted in one pass. Soonest-first inside each band is what makes the
  // page subtitle true — without it a quarterly rhythm with a long runway can lead
  // "Needs you now" over something a week late, purely by fetch order.
  const bands = useMemo(() => {
    const now = new Date()
    const out = new Map<Urgency, RhythmWithPeriod[]>()
    for (const r of rhythms) {
      const band = urgencyOf(r, byId.get(r.id), now)
      const list = out.get(band)
      if (list) list.push(r)
      else out.set(band, [r])
    }
    for (const list of out.values()) {
      list.sort((a, b) => (daysToGo(a, now) ?? Infinity) - (daysToGo(b, now) ?? Infinity))
    }
    return out
  }, [rhythms, byId])

  const paused = bands.get('paused') ?? []

  function changed() {
    refetch()
    refetchAttention()
  }

  function row(r: RhythmWithPeriod, urgency: Urgency) {
    const person = r.personId ? people.get(r.personId) : undefined
    return (
      <RhythmRow
        key={r.id}
        rhythm={r}
        urgency={urgency}
        personName={person?.name ?? null}
        personColor={person?.colorHex ?? null}
        onBook={setBooking}
        onEdit={() => setEditing(r)}
        onChanged={changed}
      />
    )
  }

  return (
    <div className="rhy-screen">
      <div className="rhy-screen-head">
        <div>
          <div className="rhy-screen-title wf-serif">Rhythms</div>
          <div className="rhy-screen-sub">
            Things that should keep happening. Soonest first.
          </div>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>New rhythm</button>
      </div>

      {loading && <div className="rhy-empty">Loading…</div>}
      {error && <div className="rhy-empty">Couldn't load your rhythms — reload or sign in again.</div>}

      {!loading && !error && rhythms.length === 0 && (
        <div className="rhy-empty">
          Nothing here yet. A rhythm is a standing intention with a cadence — trash weekly, the air
          filter every three months, a temple visit each quarter.
        </div>
      )}

      {BANDS.map((band) => {
        const rows = bands.get(band.key) ?? []
        // An empty band is not a band. A bare "Coming up · 0" heading is a page telling
        // you about its own structure rather than about your household.
        if (rows.length === 0) return null
        return (
          <section key={band.key}>
            <div className="rhy-band">
              <h2 className="wf-serif">{band.title}</h2>
              <span className="n">{rows.length}</span>
              <span className="hint">{band.hint}</span>
            </div>
            <div className="rhy-rows">{rows.map((r) => row(r, band.key))}</div>
          </section>
        )
      })}

      {paused.length > 0 && (
        <div className="rhy-rows rhy-paused-card">
          <button type="button" className="rhy-paused-toggle" onClick={() => setShowPaused((s) => !s)}>
            {/* Named rather than counted — "2 paused" makes you open it to find out
                which, every single time. */}
            {paused.length} paused — {paused.map((r) => r.title).join(', ')}
            <span aria-hidden>{showPaused ? '⌃' : '⌄'}</span>
          </button>
          {showPaused && paused.map((r) => row(r, 'paused'))}
        </div>
      )}

      {creating && <RhythmModal onClose={() => setCreating(false)} onSaved={changed} />}
      {editing && <RhythmModal rhythm={editing} onClose={() => setEditing(null)} onSaved={changed} />}
      {booking && <BookRhythmModal item={booking} onClose={() => setBooking(null)} onBooked={changed} />}
    </div>
  )
}
