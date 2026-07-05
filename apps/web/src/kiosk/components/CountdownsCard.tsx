import { useState } from 'react'
import { useCountdowns, countdownsApi, countdownLabel, type Countdown } from '../../lib/api'

// Today card: everything the family is counting down to, soonest first. Standalone
// items are addable/removable here; event-flagged and birthday countdowns are derived
// (managed on the event / member profile) and shown read-only.

function fmtDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function Row({ c, sleeps, onRemove }: { c: Countdown; sleeps: boolean; onRemove?: () => void }) {
  const soon = c.daysLeft <= 7
  return (
    <div className="cd-row">
      <span className="cd-emoji" style={c.color ? { background: `${c.color}22` } : undefined}>{c.emoji ?? '📅'}</span>
      <div className="cd-main">
        <div className="cd-title">{c.title}</div>
        <div className="tiny muted">{fmtDate(c.date)}</div>
      </div>
      <div className={`cd-days${soon ? ' soon' : ''}`}>{countdownLabel(c.daysLeft, sleeps)}</div>
      {onRemove && <button type="button" className="cd-x" aria-label={`Remove ${c.title}`} onClick={onRemove}>×</button>}
    </div>
  )
}

export function CountdownsCard() {
  const { countdowns, sleeps, loading } = useCountdowns()
  const [adding, setAdding] = useState(false)

  return (
    <div className="card cd-card" style={{ padding: '22px 22px 12px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <div className="card-h" style={{ fontSize: 23 }}>Countdowns</div>
        <div className="muted" style={{ fontWeight: 600 }}>{countdowns.length}</div>
        <button type="button" className="pill" style={{ marginLeft: 'auto', cursor: 'pointer' }} onClick={() => setAdding(true)}>+ Add</button>
      </div>

      {loading && <div className="muted" style={{ padding: '14px 4px' }}>Loading…</div>}
      {!loading && countdowns.length === 0 && (
        <div className="muted" style={{ padding: '14px 4px' }}>Nothing to count down to yet — add a trip, a birthday's automatic.</div>
      )}
      {!loading && countdowns.map((c) => (
        <Row
          key={c.id}
          c={c}
          sleeps={sleeps}
          onRemove={c.source === 'standalone' ? () => countdownsApi.remove(c.id) : undefined}
        />
      ))}

      {adding && <AddCountdown onClose={() => setAdding(false)} />}
    </div>
  )
}

function AddCountdown({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [date, setDate] = useState('')
  const [emoji, setEmoji] = useState('')
  const [saving, setSaving] = useState(false)
  const canSave = title.trim() && /^\d{4}-\d{2}-\d{2}$/.test(date)

  async function save() {
    if (!canSave) return
    setSaving(true)
    try { await countdownsApi.create({ title: title.trim(), date, emoji: emoji.trim() || null }) } finally { setSaving(false) }
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>New countdown</div>
        <div className="cd-form">
          <label><span>What</span><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Hawaii trip" /></label>
          <div className="cd-form-row">
            <label style={{ flex: 1 }}><span>Date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <label style={{ width: 96 }}><span>Emoji</span><input value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="🏝️" maxLength={4} /></label>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" className="pill" onClick={onClose}>Cancel</button>
          <button type="button" className="pill primary" disabled={!canSave || saving} onClick={save}>{saving ? 'Saving…' : 'Add'}</button>
        </div>
      </div>
    </div>
  )
}
