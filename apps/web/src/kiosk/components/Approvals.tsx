// Parent review/approval surfaces. Two kinds of thing wait on a parent's OK:
// chore completions (status 'awaiting') and reward redemptions (status
// 'pending'). Three surfaces share this file:
//   • ApprovalsBar        — the compact "N waiting for your OK" entry bar on Today
//                           (parents only); taps open a slide-over with both lists.
//   • ChoreApprovalsCard  — the "Needs your OK" chores list, reused on the Chores
//                           tab and inside the Today drawer.
//   • RewardApprovalsCard — the matching redemptions list, used inside the drawer
//                           (the Rewards tab keeps its own inline copy).
// Mirrors the calendar GoalRecap entry-bar + ReviewDrawer pattern, and reuses its
// recap-bar / review-drawer / rw-appr styling for a consistent look.
import { useEffect, useState } from 'react'
import {
  choresApi,
  rewardsApi,
  useAwaitingChores,
  usePendingRedemptions,
  useCurrencies,
  useHousehold,
  type ChoreInstance,
  type Redemption,
  type CurrenciesState,
} from '../../lib/api'
import { Icon } from '../icons'
import '../../styles/goals.css'

function Avatar({ emoji, color, name }: { emoji: string | null; color: string | null; name: string | null }) {
  return (
    <span className="rw-av" style={{ background: color ? `${color}22` : 'var(--panel)' }} title={name ?? ''}>
      {emoji ?? '🙂'}
    </span>
  )
}

// The reward's/chore's currency symbol (falls back to ⭐).
function symbolFor(key: string | null, cur: CurrenciesState): string {
  const c = key ? cur.byKey[key] : cur.defaultCurrency
  return c?.symbol ?? '⭐'
}

// The day a chore was finished, relative where it reads naturally ("yesterday"),
// otherwise a short date — shown so a parent knows which day they're OK'ing.
// Returns null for a missing/unparseable date (e.g. an older cached payload from
// before the field existed) so the row never renders "(Invalid Date)".
function dayLabel(d: string | null | undefined): string | null {
  if (!d) return null
  const dt = new Date(`${d}T00:00:00`)
  if (Number.isNaN(dt.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diff = Math.round((dt.getTime() - today.getTime()) / 86_400_000)
  if (diff === 0) return 'today'
  if (diff === -1) return 'yesterday'
  if (diff === 1) return 'tomorrow'
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// ── Chore photo-proof review modal ───────────────────────────────────────────
// A centered card with the large proof photo, who-finished-what context, and the
// Approve / Not-yet actions in one place — so a parent can actually look at the
// proof before deciding, instead of the photo opening raw in a new tab.
export function ChoreProofModal({
  instance,
  cur,
  busy,
  onApprove,
  onReject,
  onClose,
}: {
  instance: ChoreInstance
  cur: CurrenciesState
  busy: string | null
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onClose: () => void
}) {
  const c = instance
  const when = dayLabel(c.dueOn)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const acting = busy === c.id
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card chore-proof-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="cpm-head">
          <Avatar emoji={c.personAvatar} color={c.personColor} name={c.personName} />
          <div className="cpm-head-tx">
            <div className="cpm-title">
              <span className="rw-appr-name">{c.personName ?? 'Someone'}</span> finished{' '}
              <span className="rw-appr-reward">{c.emoji ? `${c.emoji} ` : ''}{c.choreTitle}</span>
            </div>
            <div className="cpm-sub">
              {when ? `Completed ${when}` : 'Completed'}
              <span className="rw-appr-cost">{symbolFor(c.rewardCurrency, cur)} {c.rewardAmount ?? 0}</span>
            </div>
          </div>
        </div>
        <div className="cpm-stage">
          {c.proofUrl
            ? <img src={c.proofUrl} alt={`Photo proof for ${c.choreTitle}`} />
            : <div className="cpm-noimg">{c.hadProof ? '📷 A photo was attached but is no longer saved.' : 'No photo was attached.'}</div>}
        </div>
        <div className="cpm-actions">
          <button type="button" className="pill" disabled={acting} onClick={() => { onReject(c.id); onClose() }}>Not yet</button>
          <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} disabled={acting} onClick={() => { onApprove(c.id); onClose() }}>Approve</button>
        </div>
      </div>
    </div>
  )
}

// ── Chores awaiting a parent's OK ────────────────────────────────────────────
// Renders null when empty so callers can own a combined empty state.
export function ChoreApprovalsCard({
  chores,
  cur,
  busy,
  onApprove,
  onReject,
  title = 'Needs your OK',
}: {
  chores: ChoreInstance[]
  cur: CurrenciesState
  busy: string | null
  onApprove: (id: string) => void
  onReject: (id: string) => void
  title?: string
}) {
  const [review, setReview] = useState<ChoreInstance | null>(null)
  if (chores.length === 0) return null
  // Keep the reviewed instance fresh as the queue refetches (else a stale snapshot lingers).
  const reviewing = review ? chores.find((c) => c.id === review.id) ?? null : null
  return (
    <div className="card rw-approvals">
      <div className="card-h" style={{ marginBottom: 10 }}>{title}</div>
      {chores.map((c) => {
        const when = dayLabel(c.dueOn)
        return (
        <div key={c.id} className="rw-appr">
          <Avatar emoji={c.personAvatar} color={c.personColor} name={c.personName} />
          <div className="rw-appr-txt">
            <span className="rw-appr-name">{c.personName ?? 'Someone'}</span> finished{' '}
            <span className="rw-appr-reward">{c.emoji ? `${c.emoji} ` : ''}{c.choreTitle}</span>
            {when && <> <span className="rw-appr-when">({when})</span></>}
            <span className="rw-appr-cost">{symbolFor(c.rewardCurrency, cur)} {c.rewardAmount ?? 0}</span>
          </div>
          {c.proofUrl && (
            <button type="button" className="chore-proof-thumb" title="Review photo proof" onClick={() => setReview(c)}>
              <img src={c.proofUrl} alt={`Proof for ${c.choreTitle}`} />
            </button>
          )}
          <div className="rw-appr-actions">
            <button type="button" className="pill" disabled={busy === c.id} onClick={() => onReject(c.id)}>Not yet</button>
            <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} disabled={busy === c.id} onClick={() => onApprove(c.id)}>Approve</button>
          </div>
        </div>
        )
      })}
      {reviewing && (
        <ChoreProofModal
          instance={reviewing}
          cur={cur}
          busy={busy}
          onApprove={onApprove}
          onReject={onReject}
          onClose={() => setReview(null)}
        />
      )}
    </div>
  )
}

// ── Reward redemptions awaiting a parent's OK ────────────────────────────────
export function RewardApprovalsCard({
  pending,
  cur,
  busy,
  onDecide,
  title = 'Needs your OK',
}: {
  pending: Redemption[]
  cur: CurrenciesState
  busy: string | null
  onDecide: (id: string, approve: boolean) => void
  title?: string
}) {
  if (pending.length === 0) return null
  return (
    <div className="card rw-approvals">
      <div className="card-h" style={{ marginBottom: 10 }}>{title}</div>
      {pending.map((p) => (
        <div key={p.id} className="rw-appr">
          <Avatar emoji={p.personAvatar} color={p.personColor} name={p.personName} />
          <div className="rw-appr-txt">
            <span className="rw-appr-name">{p.personName}</span> wants{' '}
            <span className="rw-appr-reward">{p.emoji ? `${p.emoji} ` : ''}{p.title}</span>
            <span className="rw-appr-cost">{symbolFor(p.currency, cur)} {p.cost}</span>
          </div>
          <div className="rw-appr-actions">
            <button type="button" className="pill" disabled={busy === p.id} onClick={() => onDecide(p.id, false)}>Deny</button>
            <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} disabled={busy === p.id} onClick={() => onDecide(p.id, true)}>Approve</button>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Today entry bar ──────────────────────────────────────────────────────────
// Parents-only. Combines the two queues into one count; opens a slide-over with
// both lists. Renders nothing for kids or on a quiet day. Owns the data + busy
// state so an action lands even as the queues drain to zero.
export function ApprovalsBar() {
  const { person } = useHousehold()
  const isAdmin = !!person?.isAdmin
  const awaiting = useAwaitingChores()
  const redemptions = usePendingRedemptions()
  const cur = useCurrencies()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const chores = awaiting.chores
  const pending = redemptions.pending
  const nChores = chores.length
  const nReds = pending.length
  const total = nChores + nReds

  async function approveChore(id: string) {
    setBusy(id)
    try {
      await choresApi.approveInstance(id)
      awaiting.refetch()
    } finally {
      setBusy(null)
    }
  }
  async function rejectChore(id: string) {
    setBusy(id)
    try {
      await choresApi.rejectInstance(id)
      awaiting.refetch()
    } finally {
      setBusy(null)
    }
  }
  async function decideReward(id: string, approve: boolean) {
    setBusy(id)
    try {
      await (approve ? rewardsApi.approve(id) : rewardsApi.deny(id))
      redemptions.refetch()
    } finally {
      setBusy(null)
    }
  }

  // Kids never see the queue; the backend also enforces admin on every decision.
  if (!isAdmin) return null

  const title =
    nChores && nReds
      ? `${total} things waiting for your OK`
      : nChores
        ? `${nChores} ${nChores === 1 ? 'chore' : 'chores'} to approve`
        : `${nReds} ${nReds === 1 ? 'reward' : 'rewards'} to approve`
  const names = [...chores.map((c) => c.choreTitle), ...pending.map((p) => p.title)].slice(0, 3).join(' · ')

  return (
    <>
      {total > 0 && (
        <button type="button" className="recap-bar recap-bar--approve" onClick={() => setOpen(true)}>
          <span className="recap-bar-ico"><Icon name="family" /></span>
          <span className="recap-bar-txt">
            <span className="recap-bar-title">{title}</span>
            <span className="recap-bar-sub">{names} — your OK awards the stars.</span>
          </span>
          <span className="recap-bar-cta">Review ›</span>
        </button>
      )}
      <ApprovalsDrawer
        open={open}
        onClose={() => setOpen(false)}
        chores={chores}
        pending={pending}
        cur={cur}
        busy={busy}
        onApproveChore={approveChore}
        onRejectChore={rejectChore}
        onDecideReward={decideReward}
      />
    </>
  )
}

// ── Review slide-over ────────────────────────────────────────────────────────
// Opens from the right over Today (scrim + panel). Esc / scrim / "‹ Today" close.
function ApprovalsDrawer({
  open,
  onClose,
  chores,
  pending,
  cur,
  busy,
  onApproveChore,
  onRejectChore,
  onDecideReward,
}: {
  open: boolean
  onClose: () => void
  chores: ChoreInstance[]
  pending: Redemption[]
  cur: CurrenciesState
  busy: string | null
  onApproveChore: (id: string) => void
  onRejectChore: (id: string) => void
  onDecideReward: (id: string, approve: boolean) => void
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
  const allClear = chores.length === 0 && pending.length === 0
  return (
    <div className="review-scrim" onClick={onClose}>
      <div className="review-drawer" role="dialog" aria-label="Review approvals" onClick={(e) => e.stopPropagation()}>
        <div className="review-drawer-head">
          <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={onClose}>‹ Today</button>
        </div>
        <div className="review-drawer-body">
          <div className="nk-serif review-title">Needs your OK</div>
          <div className="review-sub">Approve finished chores to award their stars, and approve or deny reward requests.</div>
          <ChoreApprovalsCard chores={chores} cur={cur} busy={busy} onApprove={onApproveChore} onReject={onRejectChore} title="Chores to approve" />
          <RewardApprovalsCard pending={pending} cur={cur} busy={busy} onDecide={onDecideReward} title="Rewards to approve" />
          {allClear && (
            <div className="card recap-empty">
              <span className="recap-empty-emo">🎉</span>
              <span>You’re all caught up — nothing waiting for your OK.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
