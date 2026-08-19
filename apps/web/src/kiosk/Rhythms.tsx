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
  type Rhythm,
} from '../lib/api'
import { BookRhythmModal } from './components/BookRhythmModal'
import { RhythmModal } from './components/RhythmModal'
import { describeRrule } from './components/recurrence'
import '../styles/rhythms.css'

// The rhythms register — the whole list, what state each one is in, and where new
// ones get made. Kept split by shape because the two answer different questions:
// a maintenance rhythm asks "did you do it?", a booking rhythm asks "is it on the
// calendar?" and deliberately never asks the first.

function shortDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function RhythmItem({
  rhythm,
  attention,
  personName,
  onBook,
  onChanged,
}: {
  rhythm: Rhythm
  attention: AttentionItem | undefined
  personName: string | null
  onBook: (item: Extract<AttentionItem, { kind: 'unscheduled' }>) => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const unscheduled = attention?.kind === 'unscheduled' ? attention : null
  const due = attention?.kind === 'due' ? attention : null

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
    <div className="card rhy-item">
      <div className="rhy-item-head">
        <span className="rhy-emoji" aria-hidden>{rhythm.emoji ?? (rhythm.satisfiedBy === 'scheduling' ? '🗓️' : '🔁')}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="rhy-item-name">{rhythm.title}</div>
          <div className="rhy-item-meta">
            {cadenceLabel(rhythm.every)}
            {personName ? ` · ${personName}` : ''}
          </div>
        </div>
        {!rhythm.isActive && <span className="rhy-badge off">Paused</span>}
        {rhythm.isActive && attention && <span className="rhy-badge attention">Needs attention</span>}
      </div>

      <div className="rhy-item-meta">
        {rhythm.satisfiedBy === 'completion' ? (
          <>
            Last done {rhythm.lastCompletedAt ? shortDate(rhythm.lastCompletedAt) : 'never'} · Next due {shortDate(rhythm.nextDueAt)}
            {due && <> · <span className={due.overdue ? 'rhy-late' : ''}>{dueLabel(due.dueAt, due.overdue)}</span></>}
          </>
        ) : (
          <>
            Periods start {shortDate(rhythm.startsOn)}
            {rhythm.autoSchedule && rhythm.startsOn && <> · {describeRrule(rhythm.rrule, new Date(`${rhythm.startsOn}T00:00:00`))}</>}
            {/* Only stated when it's true right now. The period a rhythm is in is a
                server answer keyed to today's date, so this screen never guesses one. */}
            {unscheduled && <> · Not on the calendar yet · {periodLabel(unscheduled.periodEnd)}</>}
          </>
        )}
      </div>

      {rhythm.notes && <div className="rhy-item-notes">{rhythm.notes}</div>}

      <div className="rhy-item-acts">
        {rhythm.satisfiedBy === 'completion' && (
          <button type="button" className="btn btn-ghost rhy-act" disabled={busy} onClick={() => run(() => rhythmsApi.complete(rhythm.id))}>
            {/* Available whether or not it's due — "I did the filter today" resets the clock. */}
            {due ? 'Mark done' : 'I did this today'}
          </button>
        )}
        {unscheduled && (
          <>
            <button type="button" className="btn btn-primary rhy-act" onClick={() => onBook(unscheduled)}>
              {rhythm.autoSchedule ? 'Put it back on the calendar' : 'Book a time'}
            </button>
            <button
              type="button"
              className="rhy-skip"
              aria-label={`Skip this period for ${rhythm.title}`}
              disabled={busy}
              onClick={() => run(() => rhythmsApi.skip(rhythm.id, unscheduled.periodStart))}
            >
              Skip this period
            </button>
          </>
        )}
        <span className="tiny muted" style={{ marginLeft: 'auto' }}>
          {rhythm.satisfiedBy === 'completion' ? 'nudges' : 'starts nudging'} {formatInterval(rhythm.leadTime)} ahead
        </span>
      </div>
    </div>
  )
}

export function Rhythms() {
  const { rhythms, loading, error, refetch } = useRhythms()
  // Deliberately the same one-day window the Today card uses: `to` is both the
  // horizon AND the date that decides WHICH period a scheduling rhythm reports on,
  // so looking further ahead would answer about a later period.
  const { items, refetch: refetchAttention } = useRhythmAttention()
  const { persons } = usePersons()
  const [creating, setCreating] = useState(false)
  const [booking, setBooking] = useState<Extract<AttentionItem, { kind: 'unscheduled' }> | null>(null)

  const byId = useMemo(() => new Map(items.map((i) => [i.rhythm.id, i])), [items])
  const names = useMemo(() => new Map(persons.map((p) => [p.id, p.name])), [persons])
  const scheduling = rhythms.filter((r) => r.satisfiedBy === 'scheduling')
  const completion = rhythms.filter((r) => r.satisfiedBy === 'completion')

  function changed() {
    refetch()
    refetchAttention()
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
            <div className="rhy-cards">
              {scheduling.map((r) => (
                <RhythmItem
                  key={r.id}
                  rhythm={r}
                  attention={byId.get(r.id)}
                  personName={r.personId ? names.get(r.personId) ?? null : null}
                  onBook={setBooking}
                  onChanged={changed}
                />
              ))}
            </div>
          </section>
        )}

        {completion.length > 0 && (
          <section>
            <div className="rhy-group-h">You do it</div>
            <div className="rhy-group-sub">
              The clock restarts from when you actually did it, so being late shifts the next one instead of stacking misses.
            </div>
            <div className="rhy-cards">
              {completion.map((r) => (
                <RhythmItem
                  key={r.id}
                  rhythm={r}
                  attention={byId.get(r.id)}
                  personName={r.personId ? names.get(r.personId) ?? null : null}
                  onBook={setBooking}
                  onChanged={changed}
                />
              ))}
            </div>
          </section>
        )}
      </div>

      {creating && <RhythmModal onClose={() => setCreating(false)} onCreated={changed} />}
      {booking && <BookRhythmModal item={booking} onClose={() => setBooking(null)} onBooked={changed} />}
    </div>
  )
}
