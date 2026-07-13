import { useState, type FormEvent } from 'react'
import { api, type Goal, type GoalLogEntry } from '../../lib/api'

// Edit or remove a single logged entry from a goal's Recent activity. Amount is
// editable for numeric goals (total/count); habits just carry a note + date. A
// derived entry (calendar/Health) is refused server-side — we surface that.
export function EntryModal({
  goal,
  entry,
  onClose,
  onSaved,
}: {
  goal: Goal
  entry: GoalLogEntry
  onClose: () => void
  onSaved: () => void
}) {
  const isCount = goal.goalType === 'count'
  const numeric = goal.goalType === 'total' || isCount
  const [amount, setAmount] = useState<number>(entry.amount)
  const [note, setNote] = useState(entry.note ?? '')
  const [loggedOn, setLoggedOn] = useState<string>(new Date(entry.loggedAt).toISOString().slice(0, 10))
  // Who took part — editable when the goal has more than one member. Prefilled from the
  // people this entry currently credits.
  const showWho = goal.participants.length > 1
  const [who, setWho] = useState<string[]>((entry.participants ?? []).map((p) => p.personId).filter((id): id is string => !!id))
  const toggleWho = (id: string) => setWho((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]))
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const logAmount = isCount ? Math.max(1, Math.round(amount)) : Number(amount)

  async function save(e: FormEvent) {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await api.editGoalLog(goal.id, entry.id, {
        ...(numeric ? { amount: logAmount } : {}),
        ...(showWho ? { personIds: who } : {}),
        note: note.trim() || null,
        loggedOn,
      })
      onSaved()
      onClose()
    } catch (err) {
      setSaving(false)
      setError((err as { body?: { message?: string } })?.body?.message ?? 'Could not save this change.')
    }
  }

  async function del() {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.deleteGoalLog(goal.id, entry.id)
      onSaved()
      onClose()
    } catch (err) {
      setSaving(false)
      setConfirmDelete(false)
      setError((err as { body?: { message?: string } })?.body?.message ?? 'Could not delete this entry.')
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 2 }}>Edit entry</div>
        <div className="muted" style={{ fontSize: 14, marginBottom: 16 }}>{goal.title}</div>

        <form onSubmit={save}>
          {numeric && (
            <>
              <div className="flabel">Amount</div>
              {isCount ? (
                <div className="log-stepper">
                  <button type="button" className="log-step" aria-label="Less" disabled={logAmount <= 1} onClick={() => setAmount((a) => Math.max(1, Math.round(a) - 1))}>−</button>
                  <span className="log-step-val">{logAmount}{goal.unit ? ` ${goal.unit}` : ''}</span>
                  <button type="button" className="log-step" aria-label="More" onClick={() => setAmount((a) => Math.round(a) + 1)}>＋</button>
                </div>
              ) : (
                <div className="log-custom">
                  <input type="number" step="any" value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label="amount" />
                  {goal.unit && <span className="tiny muted" style={{ fontWeight: 600 }}>{goal.unit}</span>}
                </div>
              )}
            </>
          )}

          {showWho && (
            <>
              <div className="flabel" style={{ marginTop: 16 }}>Who took part?</div>
              <div className="log-who">
                {goal.participants.map((p) => {
                  const on = who.includes(p.personId)
                  return (
                    <button key={p.personId} type="button" className={`log-person ${on ? 'on' : ''}`} onClick={() => toggleWho(p.personId)}>
                      <div className="av md" style={{ background: `${p.colorHex ?? '#A6A29B'}22` }}>{p.avatarEmoji ?? '🙂'}</div>
                      <span className="log-check" style={{ background: on ? 'var(--wally)' : 'var(--card)', borderColor: on ? 'var(--wally)' : 'var(--hair)' }}>{on ? '✓' : ''}</span>
                      <span className="tiny" style={{ fontWeight: 700, color: 'var(--ink-2)' }}>{p.name.split(' ')[0]}</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}

          <div className="flabel" style={{ marginTop: 16 }}>When?</div>
          <input className="log-note" type="date" value={loggedOn} onChange={(e) => setLoggedOn(e.target.value)} aria-label="Date this happened" />

          <div className="flabel" style={{ marginTop: 16 }}>Note <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 600, color: 'var(--ink-3)' }}>· optional</span></div>
          <input className="log-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened" />

          {error && <div className="tiny" style={{ fontWeight: 700, color: 'var(--primary)', marginTop: 10 }}>{error}</div>}

          <button type="submit" className="btn btn-primary" disabled={saving} style={{ width: '100%', justifyContent: 'center', marginTop: 18 }}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </form>
        <button
          type="button"
          onClick={del}
          disabled={saving}
          style={{ display: 'block', margin: '14px auto 0', border: 0, background: 'none', color: confirmDelete ? 'var(--primary)' : 'var(--ink-3)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
        >
          {confirmDelete ? 'Tap again to delete this entry' : 'Delete entry'}
        </button>
      </div>
    </div>
  )
}
