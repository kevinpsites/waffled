import { useState, type FormEvent } from 'react'
import { groceryApi } from '../../lib/api'

// Create a new named list (name + emoji) — backs the topbar "New list" action.
export function ListsModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      const list = await groceryApi.createList({ name: name.trim(), emoji: emoji.trim() || null })
      onCreated(list.id)
      onClose()
    } catch {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>New list</div>
        <form onSubmit={submit}>
          <div className="field-row">
            <label className="field" style={{ flex: 3 }}>
              <span>List name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Lake trip packing" autoFocus />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Emoji</span>
              <input value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="🧳" maxLength={4} />
            </label>
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!name.trim() || saving}
            style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
          >
            {saving ? 'Creating…' : 'Create list'}
          </button>
        </form>
      </div>
    </div>
  )
}
