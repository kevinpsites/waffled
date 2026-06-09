import { useState, type FormEvent } from 'react'
import { groceryApi, type ListItem, type Person } from '../../lib/api'

// Add or edit a list item — name, quantity (free text like "1 lb" / "×4"),
// section, and assignee. Touch-friendly (a real form, not a hover affordance).
export function ListItemModal({
  listId,
  item,
  persons,
  sections,
  onClose,
  onSaved,
}: {
  listId: string
  item: ListItem | null
  persons: Person[]
  sections: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const editing = !!item
  const [name, setName] = useState(item?.name ?? '')
  const [quantity, setQuantity] = useState(item?.quantity ?? '')
  const [section, setSection] = useState(item?.section ?? '')
  const [assignedTo, setAssignedTo] = useState<string>(item?.assignee?.personId ?? '')
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    const payload = {
      name: name.trim(),
      quantity: quantity.trim() || null,
      section: section.trim() || null,
      assignedTo: assignedTo || null,
    }
    try {
      if (editing) await groceryApi.patchListItem(item!.id, payload)
      else await groceryApi.addListItem(listId, payload)
      onSaved()
      onClose()
    } catch {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>{editing ? 'Edit item' : 'Add item'}</div>

        <form onSubmit={submit}>
          <div className="field-row">
            <label className="field" style={{ flex: 3 }}>
              <span>Item</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Beach towels" autoFocus />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Quantity</span>
              <input value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="×4 / 1 lb" />
            </label>
          </div>

          <label className="field">
            <span>Section</span>
            <input value={section} onChange={(e) => setSection(e.target.value)} placeholder="e.g. Produce, Gear" list="list-sections" />
            <datalist id="list-sections">
              {sections.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>

          <div className="field">
            <span>Assign to (optional)</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button
                type="button"
                onClick={() => setAssignedTo('')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 999, border: assignedTo === '' ? '1.5px solid var(--ink)' : '1px solid var(--hair)', background: assignedTo === '' ? 'var(--panel)' : 'var(--card-2)', font: 'inherit', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
              >
                👪 Anyone
              </button>
              {persons.map((p) => {
                const on = assignedTo === p.id
                const color = p.colorHex ?? '#6B6B70'
                return (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => setAssignedTo(p.id)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 999, border: on ? `1.5px solid ${color}` : '1px solid var(--hair)', background: on ? `${color}22` : 'var(--card-2)', font: 'inherit', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
                  >
                    {p.avatarEmoji ?? '🙂'} {p.name}
                  </button>
                )
              })}
            </div>
          </div>

          <button type="submit" className="btn btn-primary" disabled={!name.trim() || saving} style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add item'}
          </button>
        </form>
      </div>
    </div>
  )
}
