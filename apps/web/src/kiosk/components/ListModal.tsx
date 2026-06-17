import { useState, type FormEvent } from 'react'
import { api, usePersons, type GoalList } from '../../lib/api'

// Create OR edit a goal list (membership group) — name, emoji, members, privacy.
// Pass `list` to edit an existing one; omit it to create a new one.
export function ListModal({
  list,
  onClose,
  onCreated,
  onSaved,
}: {
  list?: GoalList
  onClose: () => void
  onCreated?: (id: string) => void
  onSaved?: () => void
}) {
  const { persons } = usePersons()
  const editing = !!list
  const [name, setName] = useState(list?.name ?? '')
  const [emoji, setEmoji] = useState(list?.emoji ?? '')
  const [memberIds, setMemberIds] = useState<string[]>(list?.members.map((m) => m.personId) ?? [])
  const [isPrivate, setIsPrivate] = useState(list?.isPrivate ?? false)
  const [saving, setSaving] = useState(false)

  const toggle = (id: string) => setMemberIds((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]))

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      if (editing) {
        await api.updateGoalList(list.id, { name: name.trim(), emoji: emoji.trim() || null, memberIds, isPrivate })
        onSaved?.()
      } else {
        const { list: created } = await api.createGoalList({ name: name.trim(), emoji: emoji.trim() || null, memberIds, isPrivate })
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
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>{editing ? 'Edit group' : 'New goal list'}</div>
        <form onSubmit={submit}>
          <div className="field-row">
            <label className="field" style={{ flex: 3 }}>
              <span>List name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mom & Dad" autoFocus />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Emoji</span>
              <input value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="💑" maxLength={4} />
            </label>
          </div>

          <div className="field">
            <span>Who’s on this list?</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {persons.map((p) => {
                const on = memberIds.includes(p.id)
                const color = p.colorHex ?? '#6B6B70'
                return (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => toggle(p.id)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 999, border: on ? `1.5px solid ${color}` : '1px solid var(--hair)', background: on ? `${color}22` : 'var(--card-2)', color: 'var(--ink)', font: 'inherit', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
                  >
                    {p.avatarEmoji ?? '🙂'} {p.name}
                  </button>
                )
              })}
            </div>
          </div>

          <label className="field" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} style={{ width: 'auto' }} />
            <span style={{ margin: 0 }}>Private — only these members see it</span>
          </label>

          <button type="submit" className="btn btn-primary" disabled={!name.trim() || saving} style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create list'}
          </button>
        </form>
      </div>
    </div>
  )
}
