import { useMemo, useState } from 'react'
import {
  rhythmsApi,
  useRhythms,
  useRhythmAttention,
  usePersons,
  cadenceLabel,
  dueLabel,
  periodLabel,
  formatInterval,
  type AttentionItem,
  type RhythmPeriod,
  type RhythmWithPeriod,
} from '../lib/api'
import { BookRhythmModal } from './components/BookRhythmModal'
import { RhythmModal } from './components/RhythmModal'
import { describeRrule } from './components/recurrence'
import '../styles/rhythms.css'

// The rhythms register — the whole list, what state each one is in, and where new
// ones get made. Kept split by shape because the two answer different questions:
// a maintenance rhythm asks "did you do it?", a booking rhythm asks "is it on the
// calendar?" and deliberately never asks the first.
//
// Where a row's state comes from, in order of precedence:
//   1. paused        — nothing about its period is stated or actionable. It is off.
//   2. /attention    — it needs doing or booking NOW; this outranks `satisfied`,
//                      because for the completion shape `satisfied` only means "not
//                      yet due" while attention fires a whole lead time earlier, so
//                      a filter due in three days is legitimately both.
//   3. `satisfied`   — from GET /api/rhythms. This is what lets the screen answer
//                      "is this handled?" for a quarterly rhythm two months from its
//                      runway, which /attention deliberately can't say anything about.

function shortDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// Whether a completion rhythm was already done today, on the VIEWER's clock.
//
// This is what lets the row acknowledge a tap. Completing something already completed
// today recomputes "Last done <date> · Next due <date>" to the byte-identical string, so
// without this the button was indistinguishable from a dead one — and got pressed again,
// and again. Same idea (and near enough the same words) as a habit goal's
// "Done for today ✓".
function completedToday(iso: string | null): boolean {
  if (!iso) return false
  const done = new Date(iso)
  if (Number.isNaN(done.getTime())) return false
  const now = new Date()
  return done.getFullYear() === now.getFullYear()
    && done.getMonth() === now.getMonth()
    && done.getDate() === now.getDate()
}

function RhythmItem({
  rhythm,
  attention,
  personName,
  onBook,
  onEdit,
  onChanged,
}: {
  rhythm: RhythmWithPeriod
  attention: AttentionItem | undefined
  personName: string | null
  onBook: (period: RhythmPeriod) => void
  onEdit: () => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const paused = !rhythm.isActive
  // A paused rhythm is absent from /attention already, but the list still computes
  // its period — so state and actions are suppressed here rather than half-shown.
  // Offering "Book a time" on something deliberately switched off would work, which
  // is exactly why it must not be offered.
  const att = paused ? undefined : attention
  const due = att?.kind === 'due' ? att : null
  const scheduling = rhythm.satisfiedBy === 'scheduling'
  const doneToday = !scheduling && completedToday(rhythm.lastCompletedAt)
  const needsBooking = !paused && scheduling && !rhythm.satisfied
  const period: RhythmPeriod | null =
    rhythm.currentPeriodStart && rhythm.currentPeriodEnd
      ? { rhythm, periodStart: rhythm.currentPeriodStart, periodEnd: rhythm.currentPeriodEnd }
      : null

  async function run(fn: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    try {
      await fn()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`card rhy-item${paused ? ' paused' : ''}`}>
      <div className="rhy-item-head">
        <span className="rhy-emoji" aria-hidden>{rhythm.emoji ?? (scheduling ? '🗓️' : '🔁')}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="rhy-item-name">{rhythm.title}</div>
          <div className="rhy-item-meta">
            {cadenceLabel(rhythm.every)}
            {personName ? ` · ${personName}` : ''}
          </div>
        </div>
        {paused ? (
          <span className="rhy-badge off">Paused</span>
        ) : att ? (
          <span className="rhy-badge attention">Needs attention</span>
        ) : rhythm.satisfied ? (
          <span className="rhy-badge">Handled</span>
        ) : null}
      </div>

      <div className="rhy-item-meta">
        {scheduling ? (
          <>
            Periods start {shortDate(rhythm.startsOn)}
            {rhythm.autoSchedule && rhythm.startsOn && <> · {describeRrule(rhythm.rrule, new Date(`${rhythm.startsOn}T00:00:00`))}</>}
            {/* "Handled" covers both a booking and a deliberate skip — the server
                answers those with one flag, and inventing a distinction the data
                doesn't carry would be a guess. */}
            {!paused && rhythm.satisfied && <> · Handled for this period</>}
            {needsBooking && period && <> · Not on the calendar yet · {periodLabel(period.periodEnd)}</>}
          </>
        ) : (
          <>
            Last done {rhythm.lastCompletedAt ? shortDate(rhythm.lastCompletedAt) : 'never'} · Next due {shortDate(rhythm.nextDueAt)}
            {due && <> · <span className={due.overdue ? 'rhy-late' : ''}>{dueLabel(due.dueAt, due.overdue)}</span></>}
            {/* `satisfied` is next_due_at > now(), so an unsatisfied one is past due.
                Attention normally carries it, but the row must not go silent while
                that call is in flight or has failed. */}
            {!due && !paused && !rhythm.satisfied && rhythm.nextDueAt && (
              <> · <span className="rhy-late">{dueLabel(rhythm.nextDueAt, false)}</span></>
            )}
          </>
        )}
      </div>

      {rhythm.notes && <div className="rhy-item-notes">{rhythm.notes}</div>}

      <div className="rhy-item-acts">
        {!scheduling && !paused && (
          <button
            type="button"
            className={`btn rhy-act ${doneToday ? 'btn-ghost rhy-done' : 'btn-ghost'}`}
            disabled={busy || doneToday}
            onClick={() => { if (!doneToday) run(() => rhythmsApi.complete(rhythm.id)) }}
          >
            {/* Available whether or not it's due — "I did the filter today" resets the
                clock. Once it IS done today the button states that instead of offering
                the same action again: the meta line above cannot show the difference, so
                this is the only place the tap can be seen to have landed. */}
            {doneToday ? 'Done today ✓' : due ? 'Mark done' : 'I did this today'}
          </button>
        )}
        {needsBooking && period && (
          <>
            <button type="button" className="btn btn-primary rhy-act" onClick={() => onBook(period)}>
              {rhythm.autoSchedule ? 'Put it back on the calendar' : 'Book a time'}
            </button>
            <button
              type="button"
              className="rhy-skip"
              aria-label={`Skip this period for ${rhythm.title}`}
              disabled={busy}
              onClick={() => run(() => rhythmsApi.skip(rhythm.id, period.periodStart))}
            >
              Skip this period
            </button>
          </>
        )}
        <button
          type="button"
          className="rhy-skip"
          aria-label={`${paused ? 'Resume' : 'Pause'} ${rhythm.title}`}
          disabled={busy}
          onClick={() => run(() => rhythmsApi.update(rhythm.id, { isActive: paused }))}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button type="button" className="rhy-skip" aria-label={`Edit ${rhythm.title}`} onClick={onEdit}>
          Edit
        </button>
        {/* Nothing nudges about a paused rhythm — listAttention filters on is_active —
            so saying it would be the same dead-control smell as the badge above. */}
        {!paused && (
          <span className="tiny muted" style={{ marginLeft: 'auto' }}>
            {scheduling ? 'starts nudging' : 'nudges'} {formatInterval(rhythm.leadTime)} ahead
          </span>
        )}
      </div>
    </div>
  )
}

export function Rhythms() {
  const { rhythms, loading, error, refetch } = useRhythms()
  // The horizon is today, deliberately: `to` is both how far ahead we look AND the
  // date that picks WHICH period a scheduling rhythm reports on, so asking further
  // out would quietly describe a later one. Everything the screen needs beyond
  // "right now" comes from the list's own period state instead.
  const { items, refetch: refetchAttention } = useRhythmAttention()
  const { persons } = usePersons()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<RhythmWithPeriod | null>(null)
  const [booking, setBooking] = useState<RhythmPeriod | null>(null)

  const byId = useMemo(() => new Map(items.map((i) => [i.rhythm.id, i])), [items])
  const names = useMemo(() => new Map(persons.map((p) => [p.id, p.name])), [persons])
  const scheduling = rhythms.filter((r) => r.satisfiedBy === 'scheduling')
  const completion = rhythms.filter((r) => r.satisfiedBy === 'completion')

  function changed() {
    refetch()
    refetchAttention()
  }

  function row(r: RhythmWithPeriod) {
    return (
      <RhythmItem
        key={r.id}
        rhythm={r}
        attention={byId.get(r.id)}
        personName={r.personId ? names.get(r.personId) ?? null : null}
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
            The things that should keep happening — and a place to confirm they actually will.
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

      <div className="rhy-groups">
        {scheduling.length > 0 && (
          <section>
            <div className="rhy-group-h">It gets scheduled</div>
            <div className="rhy-group-sub">
              A period is closed by a calendar event existing for it. Whether it happened is deliberately not tracked —
              getting the opportunity onto the calendar is the outcome.
            </div>
            <div className="rhy-cards">{scheduling.map(row)}</div>
          </section>
        )}

        {completion.length > 0 && (
          <section>
            <div className="rhy-group-h">You do it</div>
            <div className="rhy-group-sub">
              The clock restarts from when you actually did it, so being late shifts the next one instead of stacking misses.
            </div>
            <div className="rhy-cards">{completion.map(row)}</div>
          </section>
        )}
      </div>

      {creating && <RhythmModal onClose={() => setCreating(false)} onSaved={changed} />}
      {editing && <RhythmModal rhythm={editing} onClose={() => setEditing(null)} onSaved={changed} />}
      {booking && <BookRhythmModal item={booking} onClose={() => setBooking(null)} onBooked={changed} />}
    </div>
  )
}
