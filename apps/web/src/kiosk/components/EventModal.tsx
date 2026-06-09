import { useState, type FormEvent } from 'react'
import { api, usePersons } from '../../lib/api'

// Build an ISO instant from a local date + time (browser tz = kiosk/household tz).
function toIso(date: string, time: string): string {
  return new Date(`${date}T${time}`).toISOString()
}

export function EventModal({
  date,
  onClose,
  onCreated,
}: {
  date: string
  onClose: () => void
  onCreated: () => void
}) {
  const { persons } = usePersons()
  const [title, setTitle] = useState('')
  const [day, setDay] = useState(date)
  const [allDay, setAllDay] = useState(false)
  const [time, setTime] = useState('17:00')
  const [personId, setPersonId] = useState('')
  const [location, setLocation] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!title.trim() || saving) return
    setSaving(true)
    try {
      await api.createEvent({
        title: title.trim(),
        startsAt: allDay ? toIso(day, '12:00') : toIso(day, time),
        allDay,
        personId: personId || null,
        location: location.trim() || null,
      })
      onCreated()
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
          New event
        </div>

        <form onSubmit={submit}>
          <label className="field">
            <span>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Soccer practice" autoFocus />
          </label>

          <div className="field-row">
            <label className="field">
              <span>Date</span>
              <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            </label>
            {!allDay && (
              <label className="field">
                <span>Time</span>
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </label>
            )}
          </div>

          <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
              style={{ width: 'auto' }}
            />
            <span style={{ margin: 0 }}>All day</span>
          </label>

          <label className="field">
            <span>Who</span>
            <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
              <option value="">— nobody —</option>
              {persons.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.avatarEmoji ? `${p.avatarEmoji} ` : ''}
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Location (optional)</span>
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Field 3" />
          </label>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={!title.trim() || saving}
            style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
          >
            {saving ? 'Saving…' : 'Add event'}
          </button>
        </form>
      </div>
    </div>
  )
}
