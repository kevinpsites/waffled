import { useRef, useState } from 'react'
import { ApiSendError } from '../../lib/api/client'
import { rewardsApi, type OverviewLedgerEntry, type PersonRedemption } from '../../lib/api'

export type LedgerCorrectionTarget =
  | { kind: 'entry'; entry: OverviewLedgerEntry }
  | { kind: 'refund'; redemption: PersonRedemption }

function correctionKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.floor(Math.random() * 16)
    return (c === 'x' ? r : (r & 3) | 8).toString(16)
  })
}


export function LedgerCorrectionModal({ target, onClose, onSaved }: {
  target: LedgerCorrectionTarget
  onClose: () => void
  onSaved: () => void
}) {
  const [mode, setMode] = useState<'reverse' | 'replace'>('reverse')
  const original = target.kind === 'entry' ? target.entry.amount : -target.redemption.cost
  const [magnitude, setMagnitude] = useState(String(Math.abs(original)))
  const [reason, setReason] = useState('')
  const request = useRef<{ payload: string; key: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isRefund = target.kind === 'refund'

  async function submit() {
    const cleanReason = reason.trim()
    if (cleanReason.length < 3 || saving) return
    const n = Number(magnitude)
    if (!isRefund && mode === 'replace' && (!Number.isInteger(n) || n <= 0 || n >= Math.abs(original))) {
      setError('Enter a smaller positive whole-number amount; use Reverse entirely to remove it.')
      return
    }
    const replacement = !isRefund && mode === 'replace' ? (original < 0 ? -n : n) : undefined
    const payload = JSON.stringify([target.kind, target.kind === 'entry' ? target.entry.id : target.redemption.id, cleanReason, replacement])
    if (request.current?.payload !== payload) request.current = { payload, key: correctionKey() }
    const requestKey = request.current.key
    setSaving(true)
    setError(null)
    try {
      if (target.kind === 'refund') {
        await rewardsApi.refundRedemption(target.redemption.id, cleanReason, requestKey)
      } else {
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
          The original activity stays in the history. Corrections can only reduce an amount when the available balance covers the change. Restore any balance already used before retrying; refund a redemption when applicable.
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
            <input disabled={saving} type="number" min={1} max={Math.max(0, Math.abs(original) - 1)} step={1} value={magnitude} onChange={(e) => setMagnitude(e.target.value)} />
            <span className="tiny muted">Keep this as a {original >= 0 ? 'credit' : 'debit'}; use Reverse entirely to remove it.</span>
          </label>
        )}

        <label className="field" style={{ marginBottom: 12 }}>
          <span>Reason <span className="tiny muted">· required for the audit trail</span></span>
          <textarea disabled={saving} value={reason} maxLength={500} rows={3} onChange={(e) => setReason(e.target.value)} placeholder={isRefund ? 'Why is this reward being refunded?' : 'What was wrong with the original entry?'} />
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
