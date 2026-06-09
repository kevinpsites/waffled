import { useState, type FormEvent } from 'react'
import { api, type Goal } from '../../lib/api'

const HOURS = new Set(['hour', 'hours', 'hr', 'hrs'])
const ACTIVITY_CHIPS = ['🚲 Bike ride', '🏞️ Park', '⚽ Sports', '🌳 Outside play', '📚 Reading', '🎨 Art']

function quickChips(unit: string | null): Array<{ label: string; value: number }> {
  if (unit && HOURS.has(unit.toLowerCase())) {
    return [
      { label: '30m', value: 0.5 },
      { label: '1 hr', value: 1 },
      { label: '1.5 hr', value: 1.5 },
      { label: '2 hr', value: 2 },
    ]
  }
  const u = unit ? ` ${unit}` : ''
  return [1, 2, 3, 5].map((v) => ({ label: `${v}${u}`, value: v }))
}

// Log progress — quick-amount chips, multi-select "who", and an optional note,
// matching the handoff "Log time" capture sheet. One log is written per person.
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
  const chips = quickChips(goal.unit)
  const [amount, setAmount] = useState<number>(chips[1]?.value ?? 1)
  const [who, setWho] = useState<string[]>(goal.participants.length === 1 ? [goal.participants[0].personId] : [])
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const toggleWho = (id: string) => setWho((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]))

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!amount || saving) return
    setSaving(true)
    try {
      await api.logGoal(goal.id, { amount: Number(amount), personIds: who, note: note.trim() || null })
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
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 2 }}>Log progress</div>
        <div className="muted" style={{ fontSize: 14, marginBottom: 16 }}>{goal.title}</div>

        <form onSubmit={submit}>
          <div className="flabel">How {goal.unit && HOURS.has(goal.unit.toLowerCase()) ? 'long' : 'much'}?</div>
          <div className="log-quick">
            {chips.map((c) => (
              <button key={c.label} type="button" className={`log-chip ${amount === c.value ? 'on' : ''}`} onClick={() => setAmount(c.value)}>
                {c.label}
              </button>
            ))}
          </div>
          <div className="log-custom">
            <span className="tiny muted" style={{ fontWeight: 600 }}>or</span>
            <input type="number" step="any" value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label="amount" />
            {goal.unit && <span className="tiny muted" style={{ fontWeight: 600 }}>{goal.unit}</span>}
          </div>

          {goal.participants.length > 0 && (
            <>
              <div className="flabel" style={{ marginTop: 16 }}>Who?</div>
              <div className="log-who">
                {goal.participants.map((p) => {
                  const on = who.includes(p.personId)
                  return (
                    <button key={p.personId} type="button" className={`log-person ${on ? 'on' : ''}`} onClick={() => toggleWho(p.personId)}>
                      <div className="av md" style={{ background: `${p.colorHex ?? '#A6A29B'}22` }}>{p.avatarEmoji ?? '🙂'}</div>
                      <span className="log-check" style={{ background: on ? 'var(--wally)' : '#fff', borderColor: on ? 'var(--wally)' : 'var(--hair)' }}>
                        {on ? '✓' : ''}
                      </span>
                      <span className="tiny" style={{ fontWeight: 700, color: 'var(--ink-2)' }}>{p.name.split(' ')[0]}</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}

          <div className="flabel" style={{ marginTop: 16 }}>What did you do? <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 600, color: 'var(--ink-3)' }}>· optional</span></div>
          <input className="log-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Creek hike + fort building" />
          <div className="log-acts">
            {ACTIVITY_CHIPS.map((a) => (
              <button key={a} type="button" className="log-act" onClick={() => setNote(a.replace(/^\S+\s/, ''))}>{a}</button>
            ))}
          </div>

          <button type="submit" className="btn btn-primary" disabled={!amount || saving} style={{ width: '100%', justifyContent: 'center', marginTop: 18 }}>
            {saving ? 'Saving…' : `Log ${amount}${goal.unit ? ` ${goal.unit}` : ''}`}
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
