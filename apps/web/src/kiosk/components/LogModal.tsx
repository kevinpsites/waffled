import { useState, type FormEvent } from 'react'
import { api, type Goal } from '../../lib/api'

export function LogModal({
  goal,
  onClose,
  onSaved,
  onDeleted,
}: {
  goal: Goal
  onClose: () => void
  onSaved: () => void
  onDeleted?: () => void
}) {
  const eachTracks = goal.trackingMode === 'each_tracks'
  const [amount, setAmount] = useState(1)
  const [personId, setPersonId] = useState(eachTracks ? (goal.participants[0]?.personId ?? '') : '')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!amount || saving) return
    setSaving(true)
    try {
      await api.logGoal(goal.id, Number(amount), personId || null)
      onSaved()
      onClose()
    } catch {
      setSaving(false)
    }
  }

  async function del() {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    await api.deleteGoal(goal.id)
    onDeleted?.()
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 380 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 12 }}>
          Log progress
        </div>
        <div className="muted" style={{ fontSize: 14, marginBottom: 12 }}>{goal.title}</div>
        <form onSubmit={submit}>
          <div className="field-row">
            <label className="field">
              <span>Amount{goal.unit ? ` (${goal.unit})` : ''}</span>
              <input type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} autoFocus />
            </label>
            {goal.participants.length > 0 && (
              <label className="field">
                <span>Who</span>
                <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
                  {!eachTracks && <option value="">— anyone —</option>}
                  {goal.participants.map((p) => (
                    <option key={p.personId} value={p.personId}>
                      {p.avatarEmoji ? `${p.avatarEmoji} ` : ''}
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!amount || saving}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {saving ? 'Saving…' : 'Log it'}
          </button>
        </form>
        <button
          type="button"
          onClick={del}
          style={{ display: 'block', margin: '14px auto 0', border: 0, background: 'none', color: confirmDelete ? 'var(--primary)' : 'var(--ink-3)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
        >
          {confirmDelete ? 'Tap again to delete this goal' : 'Delete goal'}
        </button>
      </div>
    </div>
  )
}
