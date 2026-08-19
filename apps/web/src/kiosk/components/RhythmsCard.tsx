import { useState } from 'react'
import { Link } from 'react-router'
import { rhythmsApi, useRhythmAttention, cadenceLabel, dueLabel, periodLabel, type AttentionItem } from '../../lib/api'
import { BookRhythmModal } from './BookRhythmModal'
import '../../styles/rhythms.css'

// The Today card for rhythms — the things that should keep happening. It shows only
// what needs attention today and renders NOTHING otherwise (like Tonight with no
// dinner planned): most days a quarterly register is quiet, and an empty card on a
// board every morning is how a board stops being read.
//
// The two shapes get different verbs on purpose:
//   'due'         — you did the thing, so "Mark done" is the honest action.
//   'unscheduled' — a calendar event exists for the period, or it doesn't. The
//                   action is to book it; there is no "done", no streak, and no
//                   "on track", because whether you actually went is deliberately
//                   not a question a rhythm asks.

function sortItems(items: AttentionItem[]): AttentionItem[] {
  // Overdue first — it's the only thing here that's already slipped.
  return [...items].sort((a, b) => {
    const rank = (i: AttentionItem) => (i.kind === 'due' && i.overdue ? 0 : i.kind === 'due' ? 1 : 2)
    const d = rank(a) - rank(b)
    if (d !== 0) return d
    return a.rhythm.title.localeCompare(b.rhythm.title)
  })
}

function DueRow({ item, onChanged }: { item: Extract<AttentionItem, { kind: 'due' }>; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  async function markDone() {
    if (busy) return
    setBusy(true)
    try {
      await rhythmsApi.complete(item.rhythm.id)
      onChanged()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={`rhy-row${item.overdue ? ' overdue' : ''}`}>
      <span className="rhy-emoji" aria-hidden>{item.rhythm.emoji ?? '🔁'}</span>
      <div className="rhy-main">
        <div className="rhy-title">{item.rhythm.title}</div>
        <div className="rhy-sub tiny muted">
          {cadenceLabel(item.rhythm.every)} · <span className={item.overdue ? 'rhy-late' : ''}>{dueLabel(item.dueAt, item.overdue)}</span>
        </div>
      </div>
      <button type="button" className="btn btn-ghost rhy-act" disabled={busy} onClick={markDone}>
        {busy ? '…' : 'Mark done'}
      </button>
    </div>
  )
}

function UnscheduledRow({
  item,
  onBook,
  onChanged,
}: {
  item: Extract<AttentionItem, { kind: 'unscheduled' }>
  onBook: () => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  // An auto_schedule rhythm is normally absent from this list — its recurring event
  // IS the satisfied state. Turning up here means the calendar and the intention
  // have disagreed (the event was deleted, or the recurrence ran out), so the offer
  // is to put the series back rather than to pick a one-off slot.
  const series = item.rhythm.autoSchedule

  async function skip() {
    if (busy) return
    setBusy(true)
    try {
      await rhythmsApi.skip(item.rhythm.id, item.periodStart)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rhy-row">
      <span className="rhy-emoji" aria-hidden>{item.rhythm.emoji ?? '🗓️'}</span>
      <div className="rhy-main">
        <div className="rhy-title">{item.rhythm.title}</div>
        <div className="rhy-sub tiny muted">
          {series ? 'Not on the calendar yet — the series needs putting back' : 'Not on the calendar yet'} · {periodLabel(item.periodEnd)}
        </div>
      </div>
      <div className="rhy-acts">
        <button type="button" className="btn btn-primary rhy-act" onClick={onBook}>
          {series ? 'Put it back on the calendar' : 'Book a time'}
        </button>
        <button
          type="button"
          className="rhy-skip"
          aria-label={`Skip this period for ${item.rhythm.title}`}
          disabled={busy}
          onClick={skip}
        >
          Skip
        </button>
      </div>
    </div>
  )
}

export function RhythmsCard() {
  const { items, loading, error, refetch } = useRhythmAttention()
  const [booking, setBooking] = useState<Extract<AttentionItem, { kind: 'unscheduled' }> | null>(null)

  // Quiet is the normal state — render nothing rather than an empty card. A failed
  // fetch is quiet too: "nothing needs attention" is a claim, and a dropped
  // connection isn't evidence for it either way.
  if (loading || error || items.length === 0) return null

  return (
    <div className="card rhy-card">
      <div className="rhy-head">
        <Link to="/rhythms" className="card-h rhy-h">Rhythms</Link>
        <Link to="/rhythms" className="tiny muted rhy-all">
          {items.length} need{items.length === 1 ? 's' : ''} attention ›
        </Link>
      </div>

      <div className="rhy-list">
        {sortItems(items).map((item) =>
          item.kind === 'due' ? (
            <DueRow key={item.rhythm.id} item={item} onChanged={refetch} />
          ) : (
            <UnscheduledRow key={item.rhythm.id} item={item} onBook={() => setBooking(item)} onChanged={refetch} />
          )
        )}
      </div>

      {booking && <BookRhythmModal item={booking} onClose={() => setBooking(null)} onBooked={refetch} />}
    </div>
  )
}
