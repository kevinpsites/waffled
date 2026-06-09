import { useState, type FormEvent } from 'react'
import { api, usePersons } from '../../lib/api'
import { CATEGORIES, CATEGORY_KEYS } from '../categories'

// Create a goal (MVP: count toward a numeric target; shared or per-person).
export function GoalModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { persons } = usePersons()
  const [form, setForm] = useState({
    title: '',
    emoji: '',
    category: 'physical',
    unit: '',
    target: 10,
    trackingMode: 'shared_total',
    participantIds: [] as string[],
  })
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!form.title.trim() || saving) return
    setSaving(true)
    try {
      await api.createGoal({
        title: form.title.trim(),
        emoji: form.emoji.trim() || null,
        category: form.category,
        goalType: 'count',
        unit: form.unit.trim() || null,
        targetValue: Number(form.target) || null,
        trackingMode: form.trackingMode,
        participantIds: form.participantIds,
      })
      onSaved()
      onClose()
    } catch {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <div className="nk-serif" style={{ fontSize: 22, fontWeight: 600, marginBottom: 14 }}>
          New goal
        </div>

        <form onSubmit={submit}>
          <div className="field-row">
            <label className="field" style={{ flex: 3 }}>
              <span>Title</span>
              <input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Read 20 books" autoFocus />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Emoji</span>
              <input value={form.emoji} onChange={(e) => set('emoji', e.target.value)} placeholder="📚" maxLength={4} />
            </label>
          </div>

          <div className="field">
            <span>Category</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {CATEGORY_KEYS.map((k) => {
                const c = CATEGORIES[k]
                const on = form.category === k
                return (
                  <button
                    type="button"
                    key={k}
                    onClick={() => set('category', k)}
                    className="cat-pill"
                    style={{ background: on ? c.tint : 'var(--card-2)', color: on ? c.txt : 'var(--ink-2)', border: on ? 0 : '1px solid var(--hair)', cursor: 'pointer' }}
                  >
                    {c.emoji} {c.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="field-row">
            <label className="field">
              <span>Target</span>
              <input type="number" min={1} value={form.target} onChange={(e) => set('target', Number(e.target.value))} />
            </label>
            <label className="field">
              <span>Unit (optional)</span>
              <input value={form.unit} onChange={(e) => set('unit', e.target.value)} placeholder="books" />
            </label>
          </div>

          <label className="field">
            <span>Tracking</span>
            <select value={form.trackingMode} onChange={(e) => set('trackingMode', e.target.value)}>
              <option value="shared_total">Shared total (everyone pools toward it)</option>
              <option value="each_tracks">Each person tracks their own</option>
            </select>
          </label>

          <div className="field">
            <span>Who</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {persons.map((p) => {
                const on = form.participantIds.includes(p.id)
                const color = p.colorHex ?? '#6B6B70'
                return (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => set('participantIds', on ? form.participantIds.filter((x) => x !== p.id) : [...form.participantIds, p.id])}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 999, border: on ? `1.5px solid ${color}` : '1px solid var(--hair)', background: on ? `${color}22` : 'var(--card-2)', color: 'var(--ink)', font: 'inherit', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
                  >
                    {p.avatarEmoji ?? '🙂'} {p.name}
                  </button>
                )
              })}
            </div>
          </div>

          <button type="submit" className="btn btn-primary" disabled={!form.title.trim() || saving} style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}>
            {saving ? 'Saving…' : 'Add goal'}
          </button>
        </form>
      </div>
    </div>
  )
}
