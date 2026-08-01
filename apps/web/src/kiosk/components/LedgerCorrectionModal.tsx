import { useState } from 'react'
import { ApiSendError } from '../../lib/api/client'
import { rewardsApi, type OverviewLedgerEntry, type PersonRedemption } from '../../lib/api'

export type LedgerCorrectionTarget =
  | { kind: 'entry'; entry: OverviewLedgerEntry }
  | { kind: 'refund'; redemption: PersonRedemption }

function correctionKey(): string {
  return globalThis.crypto.randomUUID()
}

const PG_INT_MAX = 2_147_483_647

export function LedgerCorrectionModal({ target, onClose, onSaved }: {
  target: LedgerCorrectionTarget
  onClose: () => void
  onSaved: () => void
}) {
  const [mode, setMode] = useState<'reverse' | 'replace'>('reverse')
  const original = target.kind === 'entry' ? target.entry.amount : -target.redemption.cost
  const [magnitude, setMagnitude] = useState(String(Math.abs(original)))
  const [reason, setReason] = useState('')
  const [requestKey] = useState(correctionKey)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isRefund = target.kind === 'refund'

  async function submit() {
    const cleanReason = reason.trim()
    if (cleanReason.length < 3 || saving) return
    setSaving(true)
    setError(null)
    try {
      if (target.kind === 'refund') {
        await rewardsApi.refundRedemption(target.redemption.id, cleanReason, requestKey)
      } else {
        const n = Math.round(Number(magnitude))
        if (mode === 'replace' && (!Number.isInteger(n) || n <= 0 || n > PG_INT_MAX || n === Math.abs(original))) {
          setError('Enter a different positive whole-number amount up to 2,147,483,647.')
          setSaving(false)
          return
        }
        const replacement = mode === 'replace' ? (original < 0 ? -n : n) : undefined
        await rewardsApi.correctLedgerEntry(target.entry.id, cleanReason, replacement, requestKey)
      }
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof ApiSendError && err.body.message ? err.body.message : 'Couldn’t apply this correction. Please try again.')
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-label={isRefund ? 'Refund redemption' : 'Correct reward history'} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="wf-serif" style={{ fontSize: 22, fontWeight: 600, marginBottom: 6 }}>
          {isRefund ? 'Refund redemption' : 'Correct reward history'}
        </div>
        <p className="tiny muted" style={{ margin: '0 0 14px', lineHeight: 1.5 }}>
          The original activity stays in the audit trail. Waffled adds a linked compensating entry so the balance and history remain explainable.
        </p>

        <div className="wf-field" style={{ padding: 12, marginBottom: 12 }}>
          <b>{target.kind === 'entry' ? (target.entry.detail ?? target.entry.reason.replace(/_/g, ' ')) : target.redemption.title}</b>
          <div className="tiny muted" style={{ marginTop: 3 }}>
            Original amount: {original >= 0 ? '+' : ''}{original}
          </div>
        </div>

        {!isRefund && (
          <div className="field" style={{ marginBottom: 12 }}>
            <span>Correction</span>
            <div className="seg" style={{ width: 'fit-content' }}>
              <button type="button" className={mode === 'reverse' ? 'on' : ''} onClick={() => setMode('reverse')}>Reverse entirely</button>
              <button type="button" className={mode === 'replace' ? 'on' : ''} onClick={() => setMode('replace')}>Replace amount</button>
            </div>
          </div>
        )}

        {!isRefund && mode === 'replace' && (
          <label className="field" style={{ marginBottom: 12 }}>
            <span>Correct amount</span>
            <input type="number" min={1} max={PG_INT_MAX} step={1} value={magnitude} onChange={(e) => setMagnitude(e.target.value)} />
            <span className="tiny muted">Keep this as a {original >= 0 ? 'credit' : 'debit'}; use Reverse entirely to remove it.</span>
          </label>
        )}

        <label className="field" style={{ marginBottom: 12 }}>
          <span>Reason <span className="tiny muted">· required for the audit trail</span></span>
          <textarea value={reason} maxLength={500} rows={3} onChange={(e) => setReason(e.target.value)} placeholder={isRefund ? 'Why is this reward being refunded?' : 'What was wrong with the original entry?'} />
        </label>

        {error && <div role="alert" className="tiny" style={{ color: 'var(--primary)', fontWeight: 700, marginBottom: 10 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-ghost" disabled={saving} onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }} disabled={saving || reason.trim().length < 3} onClick={submit}>
            {saving ? 'Applying…' : isRefund ? 'Refund reward' : 'Apply correction'}
          </button>
        </div>
      </div>
    </div>
  )
}
