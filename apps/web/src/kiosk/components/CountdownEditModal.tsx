import { useState, type FormEvent } from 'react'
import { countdownsApi, type Countdown } from '../../lib/api'

// Edit a STANDALONE countdown (the "add anything" kind) straight from the calendar —
// rename it, move its date, or remove it. Event-sourced countdowns are edited through
// the event itself, and birthdays come from a person's profile, so this only handles
// the standalone source (the one with no other editing surface).
export function CountdownEditModal({
  countdown,
  onClose,
  onChanged,
}: {
  countdown: Countdown
  onClose: () => void
  onChanged?: () => void
}) {
  const [title, setTitle] = useState(countdown.title)
  const [date, setDate] = useState(countdown.date)
  const [busy, setBusy] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      await countdownsApi.update(countdown.id, { title: title.trim(), date })
      onChanged?.()
      onClose()
    } catch {
      setBusy(false)
    }
  }

  async function remove() {
    if (busy) return
    setBusy(true)
    try {
      await countdownsApi.remove(countdown.id)
      onChanged?.()
      onClose()
    } catch {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>Edit countdown</div>
        <form onSubmit={save}>
          <label className="field">
            <span>Name</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Disney trip" autoFocus />
          </label>
          <label className="field">
            <span>Counting down to</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button type="button" className="btn btn-ghost" onClick={remove} disabled={busy} style={{ color: 'var(--danger)' }}>Remove</button>
            <button type="submit" className="btn btn-primary" disabled={!title.trim() || busy} style={{ flex: 1, justifyContent: 'center' }}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
