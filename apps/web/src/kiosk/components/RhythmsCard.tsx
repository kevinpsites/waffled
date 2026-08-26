import { useState } from 'react'
import { Link } from 'react-router'
import {
  rhythmsApi, useRhythmAttention, useRhythms, cadenceLabel, dueLabel, periodLabel,
  type AttentionItem,
} from '../../lib/api'
import { BookRhythmModal } from './BookRhythmModal'
import '../../styles/rhythms.css'

// The Today card for rhythms — the things that should keep happening. It shows only
// what needs attention today and renders NOTHING otherwise (like Tonight with no
// dinner planned): most days a quarterly register is quiet, and an empty card on a
// board every morning is how a board stops being read.
//
// Each row leads with the countdown and follows with the cadence — "2 days late ·
// every 3 months" — because on a board read from the other side of a kitchen the
// first half is the part worth seeing, and it used to be the second.
//
// The two shapes get different verbs on purpose:
//   'due'         — you did the thing, so "I did it" is the honest action.
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

/** Whole calendar days from now until a date-only period end. */
function daysLeft(periodEnd: string): number {
  const end = new Date(`${periodEnd}T00:00:00`)
  const a = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate())
  const now = new Date()
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((a - b) / 86400000)
}

// Everything on this card wants attention, so making every button primary makes none
// of them mean anything. The emphasis is kept for late, or genuinely out of time.
const verbClass = (urgent: boolean) => `btn ${urgent ? 'btn-primary' : 'btn-ghost'} rhy-act`

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
          <span className={item.overdue ? 'rhy-late' : ''}>{dueLabel(item.dueAt, item.overdue)}</span>
          {' · '}{cadenceLabel(item.rhythm.every)}
        </div>
      </div>
      <button
        type="button"
        className={verbClass(item.overdue)}
        aria-label={`I did it for ${item.rhythm.title}`}
        disabled={busy}
        onClick={markDone}
      >
        {busy ? '…' : 'I did it'}
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
  // An auto_schedule rhythm is normally absent from this list — its recurring event IS
  // the satisfied state. Turning up here means the calendar and the intention have
  // disagreed, and there are two ways that happens. If nothing recurring is left the
  // series itself is what went missing, and putting one back is the offer. If the series
  // is alive and only this period is empty, it is one event that is missing — and
  // offering to put back a series that is already there built a SECOND one beside it,
  // doubling every future occurrence, permanently.
  const series = item.rhythm.autoSchedule && !item.hasSeries
  const left = daysLeft(item.periodEnd)

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
        {/* "Not on the calendar yet" was true of every row on this card, so it
            distinguished nothing. The deadline is what differs — and for the series
            anomaly, the explanation is worth the words. */}
        <div className="rhy-sub tiny muted">
          <span className={left <= 1 ? 'rhy-late' : ''}>{periodLabel(item.periodEnd)}</span>
          {series ? ' · the series needs putting back' : ''}
        </div>
      </div>
      <div className="rhy-acts">
        <button
          type="button"
          className={verbClass(left <= 1)}
          aria-label={`${series ? 'Put the series back on the calendar' : 'Book a time'} for ${item.rhythm.title}`}
          onClick={onBook}
        >
          {series ? 'Put it back' : 'Book'}
        </button>
        {/* Not in the redesign's sketch of this card, and kept anyway: skipping is
            the one thing here you can't otherwise do without leaving Today. */}
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

/**
 * The card proper. Split from the wrapper below so that `useRhythms` — which exists
 * only to say "all 10" in the header — is never called on a quiet day. Hooks can't be
 * conditional, so the only way to skip that request is to not mount the component
 * that makes it, and a quarterly register is quiet most mornings.
 */
function RhythmsBlock({ items, refetch }: { items: AttentionItem[]; refetch: () => void }) {
  const { rhythms } = useRhythms()
  const [booking, setBooking] = useState<Extract<AttentionItem, { kind: 'unscheduled' }> | null>(null)
  const total = rhythms.length

  return (
    <div className="card rhy-card">
      <div className="rhy-head">
        <Link to="/rhythms" className="card-h rhy-h">Rhythms</Link>
        <span className="tiny muted rhy-n">
          {items.length} want{items.length === 1 ? 's' : ''} attention
        </span>
        {/* The reassuring half of the header: the other seven are handled. Held back
            until the count has actually arrived rather than flashing "All 0". */}
        <Link to="/rhythms" className="tiny muted rhy-all">
          {total ? `All ${total}` : 'All'} →
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

export function RhythmsCard() {
  const { items, loading, error, refetch } = useRhythmAttention()

  // Quiet is the normal state — render nothing rather than an empty card. A failed
  // fetch is quiet too: "nothing needs attention" is a claim, and a dropped
  // connection isn't evidence for it either way.
  if (loading || error || items.length === 0) return null

  return <RhythmsBlock items={items} refetch={refetch} />
}
