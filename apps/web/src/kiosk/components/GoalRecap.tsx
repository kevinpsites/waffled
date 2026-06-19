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
import { useGoalRecap, useGoalSuggestions, goalCalendarApi, usePersons, type RecapItem, type RecapState, type Suggestion, type SuggestionsState } from '../../lib/api'
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
// One tappable row that opens the Review slide-over. Combines two queues: linked
// events to confirm ("to review") and untagged events that might count ("to
// link"). Renders nothing on a quiet day. Owns both fetches and hands them to the
// drawer so it stays mounted (so a final confirm/link lands without yanking).
export function GoalRecapBar() {
  const recap = useGoalRecap()
  const suggest = useGoalSuggestions()
  const [open, setOpen] = useState(false)
  const nRecap = recap.items.length
  const nSuggest = suggest.items.length
  const total = nRecap + nSuggest
  if (total === 0) return <ReviewDrawer open={false} onClose={() => setOpen(false)} recap={recap} suggest={suggest} />

  // Headline adapts to what's waiting; sub previews the event names.
  const title =
    nRecap && nSuggest
      ? `${nRecap} to review · ${nSuggest} to link`
      : nRecap
        ? `${nRecap} ${nRecap === 1 ? 'event is' : 'events are'} waiting to be logged`
        : `${nSuggest} ${nSuggest === 1 ? 'event' : 'events'} might count toward a goal`
  const names = [...recap.items.map((i) => i.title), ...suggest.items.map((s) => s.title)].slice(0, 3).join(' · ')
  return (
    <>
      <button type="button" className="recap-bar" onClick={() => setOpen(true)}>
        <span className="recap-bar-ico"><Icon name="spark" /></span>
        <span className="recap-bar-txt">
          <span className="recap-bar-title">{title}</span>
          <span className="recap-bar-sub">{names} — each ties to a goal.</span>
        </span>
        <span className="recap-bar-cta">Review &amp; log ›</span>
      </button>
      <ReviewDrawer open={open} onClose={() => setOpen(false)} recap={recap} suggest={suggest} />
    </>
  )
}

// ── Review slide-over ────────────────────────────────────────────────────────
// Opens from the right over Today (scrim + panel). Esc / scrim / "‹ Today" close.
// Two sections: "Did these happen?" (recap) + "Might count toward a goal"
// (suggestions). States are passed in (shared with the entry bar).
function ReviewDrawer({
  open, onClose, recap, suggest,
}: {
  open: boolean
  onClose: () => void
  recap: RecapState
  suggest: SuggestionsState
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  const allClear = recap.items.length === 0 && suggest.items.length === 0
  return (
    <div className="review-scrim" onClick={onClose}>
      <div className="review-drawer" role="dialog" aria-label="Review events" onClick={(e) => e.stopPropagation()}>
        <div className="review-drawer-head">
          <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={onClose}>‹ Today</button>
        </div>
        <div className="review-drawer-body">
          <div className="nk-serif review-title">Review events</div>
          <div className="review-sub">Confirm linked events that have happened, and link any that look like they count.</div>
          <RecapCard state={recap} variant="page" scoped={false} />
          <SuggestionCard state={suggest} />
          {allClear && (
            <div className="card recap-empty">
              <span className="recap-empty-emo">🎉</span>
              <span>You’re all caught up — nothing to review or link.</span>
            </div>
          )}
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

// ── The recap card ─────────────────────────────────────────────────────────
// "Did these happen?" — linked, ended events awaiting confirmation. Takes a recap
// state so the caller owns the fetch (the Today drawer shares one fetch with the
// entry bar; GoalDetail uses the ReviewList wrapper below). Renders null when
// empty/loading — the drawer owns the combined empty state.
// variant 'page' → drawer header copy; 'inline' → goal-detail violet header.
function RecapCard({ state, variant, scoped }: { state: RecapState; variant: 'page' | 'inline'; scoped: boolean }) {
  const { items, loading, refetch } = state
  const { persons } = usePersons()
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [allBusy, setAllBusy] = useState(false)

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

  if (loading || items.length === 0) return null

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
    <div className={`card recap-card recap-card--linked ${variant === 'inline' ? 'recap-inline' : ''}`}>
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

// Self-fetching wrapper — used on a goal's detail (scoped via goalId). The Today
// drawer uses RecapCard directly with the bar's shared state.
export function ReviewList({ goalId, variant }: { goalId?: string | null; variant: 'page' | 'inline' }) {
  const state = useGoalRecap(goalId)
  return <RecapCard state={state} variant={variant} scoped={!!goalId} />
}

// ── The suggestions card ─────────────────────────────────────────────────────
// "Might count toward a goal" — untagged events the matcher thinks fit a goal.
// Link applies it (and a past event then becomes a recap item); ✕ dismisses for
// good. Renders null when empty so the drawer can own the combined empty state.
function SuggestionCard({ state }: { state: SuggestionsState }) {
  const { items, loading, refetch } = state
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  if (loading || items.length === 0) return null

  async function act(s: Suggestion, fn: () => Promise<unknown>) {
    setBusy((b) => ({ ...b, [s.eventId]: true }))
    try {
      await fn()
      refetch()
    } catch {
      setBusy((b) => ({ ...b, [s.eventId]: false }))
    }
  }

  const n = items.length
  return (
    <div className="card recap-card recap-card--maybe">
      <div className="recap-card-top">
        <span className="recap-card-ico"><Icon name="spark" /></span>
        <div className="recap-card-txt">
          <div className="recap-card-title">{n} {n === 1 ? 'event' : 'events'} might count toward a goal</div>
          <div className="recap-card-sub">Link the ones that fit — or dismiss them.</div>
        </div>
      </div>
      <div className="recap-rows">
        {items.map((s) => (
          <div key={s.eventId} className="recap-row">
            <div className="recap-ico">{s.goalEmoji ?? '🎯'}</div>
            <div className="recap-main">
              <div className="recap-name">{s.title}</div>
              <div className="recap-meta">
                <span>{whenLabel({ startsAt: s.startsAt, allDay: s.allDay } as RecapItem)}</span>
                <span className="recap-goalchip">{s.goalEmoji ? `${s.goalEmoji} ` : ''}{s.goalTitle}</span>
              </div>
            </div>
            <div className="recap-act">
              <button
                type="button"
                className="recap-confirm"
                disabled={!!busy[s.eventId]}
                onClick={() => act(s, () => goalCalendarApi.link({ eventId: s.eventId, goalId: s.goalId }))}
              >
                {busy[s.eventId] ? 'Linking…' : '✓ Link'}
              </button>
              <button
                type="button"
                className="recap-didnt"
                disabled={!!busy[s.eventId]}
                onClick={() => act(s, () => goalCalendarApi.dismiss({ eventId: s.eventId }))}
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
