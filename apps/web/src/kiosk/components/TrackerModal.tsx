import { useState, type FormEvent } from 'react'
import { trackersApi, type Tracker } from '../../lib/api/trackers'

export function TrackerModal({ tracker, onClose, onSaved }: { tracker?: Tracker; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(tracker?.title ?? '')
  const [emoji, setEmoji] = useState(tracker?.emoji ?? '')
  const [askPerson, setAskPerson] = useState(tracker?.askPerson ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    setError(null)
    const body = { title: title.trim(), emoji: emoji.trim() || null, askPerson }
    try {
      if (tracker) await trackersApi.update(tracker.id, body)
      else await trackersApi.create(body)
      onSaved()
      onClose()
    } catch {
      setError("Couldn't save that — try again.")
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit} style={{ maxWidth: 420 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="wf-serif" style={{ fontSize: 22, fontWeight: 600, marginBottom: 14 }}>
          {tracker ? 'Edit tracker' : 'New tracker'}
        </div>
        {error && <div role="alert" className="tiny" style={{ color: 'var(--primary)', fontWeight: 700, marginBottom: 12 }}>{error}</div>}
        <div className="field-row">
          <label className="field" style={{ flex: 3 }}>
            <span>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Tylenol" autoFocus />
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>Emoji</span>
            <input value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="💊" maxLength={16} />
          </label>
        </div>
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <input type="checkbox" className="set-check" checked={askPerson} onChange={(e) => setAskPerson(e.target.checked)} />
          <span>Ask who it was for</span>
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!title.trim() || busy}>Save</button>
        </div>
      </form>
    </div>
  )
}
