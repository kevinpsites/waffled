import { useState, type FormEvent } from 'react'
import { groceryApi, useTemplates } from '../../lib/api'

// Create OR rename a named list (name + emoji). Pass `list` to edit; omit to create.
export function ListsModal({
  list,
  onClose,
  onCreated,
  onSaved,
}: {
  list?: { id: string; name: string; emoji: string | null }
  onClose: () => void
  onCreated?: (id: string) => void
  onSaved?: () => void
}) {
  const editing = !!list
  const [name, setName] = useState(list?.name ?? '')
  const [emoji, setEmoji] = useState(list?.emoji ?? '')
  const [saving, setSaving] = useState(false)
  // Saved templates to start a fresh list from (create flow only).
  const { templates } = useTemplates()

  // Apply a template → a fresh list with everything unchecked, then select it.
  async function applyTemplate(id: string) {
    if (saving) return
    setSaving(true)
    try {
      const created = await groceryApi.applyTemplate(id, name.trim() || undefined)
      onCreated?.(created.id)
      onClose()
    } catch {
      setSaving(false)
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      if (editing) {
        await groceryApi.renameList(list.id, { name: name.trim(), emoji: emoji.trim() || null })
        onSaved?.()
      } else {
        const created = await groceryApi.createList({ name: name.trim(), emoji: emoji.trim() || null })
        onCreated?.(created.id)
      }
      onClose()
    } catch {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>{editing ? 'Rename list' : 'New list'}</div>
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
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create list'}
          </button>
        </form>

        {!editing && templates.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 8 }}>Or apply a template</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="pill"
                  style={{ cursor: 'pointer' }}
                  disabled={saving}
                  onClick={() => applyTemplate(t.id)}
                >
                  <span>{t.emoji ?? '📑'}</span> {t.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
