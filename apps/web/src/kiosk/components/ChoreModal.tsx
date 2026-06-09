import { useState, type FormEvent } from 'react'
import { api, usePersons } from '../../lib/api'

export interface ChoreDraft {
  id: string
  title: string
  emoji: string | null
  personId: string | null
  rewardAmount: number | null
}

function initialForm(chore?: ChoreDraft, personId?: string | null) {
  return {
    title: chore?.title ?? '',
    emoji: chore?.emoji ?? '',
    personId: chore?.personId ?? personId ?? '',
    rewardAmount: chore?.rewardAmount ?? 1,
  }
}

// Create (optional `personId` prefill) or edit (`chore`) a chore definition.
export function ChoreModal({
  chore,
  personId,
  onClose,
  onSaved,
}: {
  chore?: ChoreDraft
  personId?: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const editing = !!chore
  const { persons } = usePersons()
  const [form, setForm] = useState(() => initialForm(chore, personId))
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!form.title.trim() || saving) return
    setSaving(true)
    const payload = {
      title: form.title.trim(),
      emoji: form.emoji.trim() || null,
      personId: form.personId || null,
      rewardAmount: Number(form.rewardAmount) || 0,
    }
    try {
      if (editing) await api.updateChore(chore!.id, payload)
      else await api.createChore(payload)
      onSaved()
      onClose()
    } catch {
      setSaving(false)
    }
  }

  async function del() {
    if (!editing || saving) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setSaving(true)
    try {
      await api.deleteChore(chore!.id)
      onSaved()
      onClose()
    } catch {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <div className="nk-serif" style={{ fontSize: 22, fontWeight: 600, marginBottom: 14 }}>
          {editing ? 'Edit chore' : 'New chore'}
        </div>

        <form onSubmit={submit}>
          <div className="field-row">
            <label className="field" style={{ flex: 3 }}>
              <span>Title</span>
              <input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Feed the dog" autoFocus />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Emoji</span>
              <input value={form.emoji} onChange={(e) => set('emoji', e.target.value)} placeholder="🐶" maxLength={4} />
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              <span>Who</span>
              <select value={form.personId} onChange={(e) => set('personId', e.target.value)}>
                <option value="">— up for grabs —</option>
                {persons.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.avatarEmoji ? `${p.avatarEmoji} ` : ''}
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Stars</span>
              <input
                type="number"
                min={0}
                value={form.rewardAmount}
                onChange={(e) => set('rewardAmount', Number(e.target.value))}
              />
            </label>
          </div>

          <div style={{ display: 'flex', gap: 9, marginTop: 6, alignItems: 'center' }}>
            {editing && (
              <button
                type="button"
                onClick={del}
                disabled={saving}
                style={{ border: 0, background: 'none', font: 'inherit', fontWeight: 700, fontSize: 14, color: 'var(--primary)', cursor: 'pointer', padding: '10px 4px' }}
              >
                {confirmDelete ? 'Tap again to delete' : 'Delete'}
              </button>
            )}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!form.title.trim() || saving}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              {saving ? 'Saving…' : editing ? 'Save' : 'Add chore'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
