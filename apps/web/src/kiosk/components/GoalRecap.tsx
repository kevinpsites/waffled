// Calendar → goal recap. A linked event is a *plan*, so when its occurrence has
// ended we ask before recording anything. Three surfaces share this file:
//   • GoalRecapBar  — the compact "N events waiting" entry bar on Today; it just
//                     links to the Review screen (no inline list).
//   • ReviewList    — the actual list of editable rows (amount stepper + who),
//                     used full-page on the Review screen and inline on a goal's
//                     detail ("Event to be reviewed").
// Nothing is written until a row is confirmed. Colors follow the palette: coral
// for Confirm, violet for the recap accent — no green.
import { useEffect, useState } from 'react'
import { useGoalRecap, goalCalendarApi, usePersons, type RecapItem } from '../../lib/api'
import type { Person } from '../../lib/api'
import { Icon } from '../icons'
import '../../styles/goals.css'

const KEY = (it: RecapItem) => `${it.eventId}:${it.occurrenceDate}`
const HOUR_UNITS = new Set(['hour', 'hours', 'hr', 'hrs'])
const MIN_UNITS = new Set(['minute', 'minutes', 'min', 'mins'])

// The +/- stepper moves in units that make sense for what's being logged: half
// hours, five-minute blocks, otherwise whole counts.
function stepFor(item: RecapItem): number {
  const u = item.unit?.toLowerCase()
  if (u && HOUR_UNITS.has(u)) return 0.5
  if (u && MIN_UNITS.has(u)) return 5
  return 1
}

// Habits and checklists carry no amount — confirming a habit ticks today, a
// checklist ticks the linked step. So the stepper is hidden and we send 1.
const noAmount = (goalType: string) => goalType === 'habit' || goalType === 'checklist'

function whenLabel(item: RecapItem): string {
  const d = new Date(item.startsAt)
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  if (item.allDay) return day
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${day} · ${t}`
}

interface Draft {
  amount: string
  who: string[]
}

// ── Today entry bar ────────────────────────────────────────────────────────
// One tappable row that opens the Review slide-over. Renders nothing on a quiet
// day. The drawer stays mounted while open so "confirm all" can land on its
// celebratory empty state instead of yanking the panel away.
export function GoalRecapBar() {
  const { items, loading } = useGoalRecap()
  const [open, setOpen] = useState(false)
  const has = !loading && items.length > 0
  const n = items.length
  const titles = items.slice(0, 3).map((i) => i.title).join(' · ')
  return (
    <>
      {has && (
        <button type="button" className="recap-bar" onClick={() => setOpen(true)}>
          <span className="recap-bar-ico"><Icon name="spark" /></span>
          <span className="recap-bar-txt">
            <span className="recap-bar-title">
              {n} {n === 1 ? 'event is' : 'events are'} waiting to be logged
            </span>
            <span className="recap-bar-sub">{titles} — each adds to a goal.</span>
          </span>
          <span className="recap-bar-cta">Review &amp; log ›</span>
        </button>
      )}
      <ReviewDrawer open={open} onClose={() => setOpen(false)} />
    </>
  )
}

// ── Review slide-over ────────────────────────────────────────────────────────
// Opens from the right over Today (scrim + panel). Esc / scrim / "‹ Today" close.
export function ReviewDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="review-scrim" onClick={onClose}>
      <div className="review-drawer" role="dialog" aria-label="Review events" onClick={(e) => e.stopPropagation()}>
        <div className="review-drawer-head">
          <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={onClose}>‹ Today</button>
        </div>
        <div className="review-drawer-body">
          <div className="nk-serif review-title">Review events</div>
          <div className="review-sub">Events from the last few days that are linked to goals. Confirm what happened.</div>
          <ReviewList variant="page" />
        </div>
      </div>
    </div>
  )
}

// ── A single review row ──────────────────────────────────────────────────────
function RecapRow({
  item, draft, persons, busy, scoped, onAmount, onWho, onConfirm, onSkip,
}: {
  item: RecapItem
  draft: Draft
  persons: Person[]
  busy: boolean
  scoped: boolean
  onAmount: (v: string) => void
  onWho: (w: string[]) => void
  onConfirm: () => void
  onSkip: () => void
}) {
  const [editWho, setEditWho] = useState(false)
  const noAmt = noAmount(item.goalType)
  const isChecklist = item.goalType === 'checklist'
  const amt = noAmt ? 1 : Number(draft.amount)
  const step = stepFor(item)
  const canConfirm = !busy && (noAmt || (Number.isFinite(amt) && amt !== 0))

  // The pickable set is the goal's participants, never the whole household. A
  // solo goal just notes whose it is; a multi-person goal can re-pick on tap.
  const pickable = persons.filter((p) => item.goalParticipantIds.includes(p.id))
  const multi = pickable.length > 1
  const chosen = pickable.filter((p) => draft.who.includes(p.id))

  const unitLabel = item.unit && amt === 1 && item.unit.endsWith('s') ? item.unit.slice(0, -1) : item.unit

  function bump(delta: number) {
    const cur = Number(draft.amount) || 0
    onAmount(String(Math.max(0, +(cur + delta).toFixed(2))))
  }

  // How the amount lands on multiple people mirrors the server (logProgress):
  // a shared-total goal SPLITS the amount across them; an each-tracks goal gives
  // every person the full amount. Only label the multi-person case.
  const willSplit = item.trackingMode === 'shared_total' && item.goalType === 'total'
  const suffix = chosen.length > 1 ? (willSplit ? ' · split' : item.trackingMode === 'each_tracks' ? ' · each' : '') : ''
  const whoText =
    chosen.length === 0
      ? 'the family'
      : chosen.length === 1
        ? `${chosen[0].avatarEmoji ?? '🙂'} ${chosen[0].name}`
        : `${chosen.map((p) => p.avatarEmoji ?? '🙂').join(' ')} ${chosen.map((p) => p.name).join(' & ')}${suffix}`

  return (
    <div className="recap-row">
      <div className="recap-ico">{item.goalEmoji ?? '🎯'}</div>
      <div className="recap-main">
        <div className="recap-name">{item.title}</div>
        <div className="recap-meta">
          <span>{whenLabel(item)}</span>
          {/* A checklist recap ticks a specific step — name it so it's clear what
              "Confirm" will check off. */}
          {isChecklist && item.stepLabel && (
            <span className="recap-stepchip">✓ {item.stepLabel}</span>
          )}
          {!scoped && (
            <span className="recap-goalchip">
              {item.goalEmoji ?? '🎯'} {item.goalTitle}
            </span>
          )}
        </div>
      </div>

      <div className="recap-input">
        {!noAmt && (
          <div className="recap-step">
            <button type="button" onClick={() => bump(-step)} disabled={busy} aria-label="Decrease">−</button>
            <input
              type="number"
              step="any"
              inputMode="decimal"
              value={draft.amount}
              onChange={(e) => onAmount(e.target.value)}
            />
            <button type="button" onClick={() => bump(step)} disabled={busy} aria-label="Increase">+</button>
            {item.unit && <span className="recap-unit">{unitLabel}</span>}
          </div>
        )}
        {multi ? (
          <button type="button" className="recap-who-btn" onClick={() => setEditWho((v) => !v)}>
            to {whoText} <span className="recap-who-caret">▾</span>
          </button>
        ) : (
          <div className="recap-to">to {whoText}</div>
        )}
        {multi && editWho && (
          <div className="recap-who-pop">
            {pickable.map((p) => {
              const on = draft.who.includes(p.id)
              return (
                <button
                  type="button"
                  key={p.id}
                  className={`recap-chip ${on ? 'on' : ''}`}
                  onClick={() => onWho(on ? draft.who.filter((x) => x !== p.id) : [...draft.who, p.id])}
                >
                  {p.avatarEmoji ?? '🙂'} {p.name} {on ? '✓' : ''}
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="recap-act">
        <button type="button" className="recap-confirm" disabled={!canConfirm} onClick={onConfirm}>
          {busy ? 'Saving…' : '✓ Confirm'}
        </button>
        <button type="button" className="recap-didnt" disabled={busy} onClick={onSkip}>
          Didn’t happen
        </button>
      </div>
    </div>
  )
}

// ── The review list ──────────────────────────────────────────────────────────
// variant 'page'   → full Review screen (header card + "Confirm all", empty state)
// variant 'inline' → on a goal's detail ("Event to be reviewed", violet header)
export function ReviewList({ goalId, variant }: { goalId?: string | null; variant: 'page' | 'inline' }) {
  const { items, loading, refetch } = useGoalRecap(goalId)
  const { persons } = usePersons()
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [allBusy, setAllBusy] = useState(false)
  const scoped = !!goalId

  // Seed a draft for each new item; drop drafts for items that were resolved.
  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev }
      const live = new Set(items.map(KEY))
      let changed = false
      for (const it of items) {
        const k = KEY(it)
        if (!next[k]) {
          const countish = it.goalType === 'habit' || it.goalType === 'count'
          next[k] = { amount: String(it.suggestedAmount || (countish ? 1 : '')), who: it.defaultPersonIds }
          changed = true
        }
      }
      for (const k of Object.keys(next)) {
        if (!live.has(k)) {
          delete next[k]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [items])

  async function confirmOne(it: RecapItem) {
    const k = KEY(it)
    const d = drafts[k]
    if (!d) return
    const amt = noAmount(it.goalType) ? 1 : Number(d.amount)
    if (!Number.isFinite(amt) || amt === 0) return
    setBusy((b) => ({ ...b, [k]: true }))
    try {
      await goalCalendarApi.confirm({ eventId: it.eventId, occurrenceDate: it.occurrenceDate, amount: amt, personIds: d.who })
      refetch()
    } catch {
      setBusy((b) => ({ ...b, [k]: false }))
    }
  }

  async function skipOne(it: RecapItem) {
    const k = KEY(it)
    setBusy((b) => ({ ...b, [k]: true }))
    try {
      await goalCalendarApi.skip({ eventId: it.eventId, occurrenceDate: it.occurrenceDate })
      refetch()
    } catch {
      setBusy((b) => ({ ...b, [k]: false }))
    }
  }

  async function confirmAll() {
    setAllBusy(true)
    for (const it of items) {
      const d = drafts[KEY(it)]
      if (!d) continue
      const amt = noAmount(it.goalType) ? 1 : Number(d.amount)
      if (!Number.isFinite(amt) || amt === 0) continue
      try {
        await goalCalendarApi.confirm({ eventId: it.eventId, occurrenceDate: it.occurrenceDate, amount: amt, personIds: d.who })
      } catch {
        /* keep going — a failed row stays in the queue */
      }
    }
    setAllBusy(false)
    refetch()
  }

  if (loading) return variant === 'page' ? <div className="muted" style={{ padding: 30 }}>Loading…</div> : null
  if (items.length === 0) {
    if (variant !== 'page') return null
    return (
      <div className="card recap-empty">
        <span className="recap-empty-emo">🎉</span>
        <span>You’re all caught up — no events waiting to be reviewed.</span>
      </div>
    )
  }

  const n = items.length
  const headTitle =
    variant === 'inline'
      ? n === 1 ? 'Event to be reviewed' : `${n} events to be reviewed`
      : `${n} ${n === 1 ? 'event is' : 'events are'} linked to goals`
  const headSub =
    variant === 'inline'
      ? 'Confirm to log its progress — or mark it as skipped.'
      : 'Confirm each one to log its progress — or mark it as skipped.'

  return (
    <div className={`card recap-card ${variant === 'inline' ? 'recap-inline' : ''}`}>
      <div className="recap-card-top">
        <span className="recap-card-ico"><Icon name="spark" /></span>
        <div className="recap-card-txt">
          <div className="recap-card-title">{headTitle}</div>
          <div className="recap-card-sub">{headSub}</div>
        </div>
        {n > 1 && (
          <button type="button" className="recap-all" disabled={allBusy} onClick={confirmAll}>
            {allBusy ? 'Confirming…' : 'Confirm all'}
          </button>
        )}
      </div>
      <div className="recap-rows">
        {items.map((it) => {
          const k = KEY(it)
          const d = drafts[k]
          if (!d) return null
          return (
            <RecapRow
              key={k}
              item={it}
              draft={d}
              persons={persons}
              busy={!!busy[k] || allBusy}
              scoped={scoped}
              onAmount={(v) => setDrafts((s) => ({ ...s, [k]: { ...s[k], amount: v } }))}
              onWho={(w) => setDrafts((s) => ({ ...s, [k]: { ...s[k], who: w } }))}
              onConfirm={() => confirmOne(it)}
              onSkip={() => skipOne(it)}
            />
          )
        })}
      </div>
    </div>
  )
}
