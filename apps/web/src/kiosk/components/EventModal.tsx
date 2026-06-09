import { useState, type FormEvent } from 'react'
import { api, usePersons, localToday, type AgendaEvent } from '../../lib/api'

const pad = (n: number) => String(n).padStart(2, '0')

// Build an ISO instant from a local date + time (browser tz = kiosk/household tz).
function toIso(date: string, time: string): string {
  return new Date(`${date}T${time}`).toISOString()
}

function initialForm(event?: AgendaEvent, date?: string) {
  if (event) {
    const d = new Date(event.startsAt)
    return {
      title: event.title,
      day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
      allDay: event.allDay,
      personId: event.personId ?? '',
      location: event.location ?? '',
    }
  }
  return { title: '', day: date ?? localToday(), time: '17:00', allDay: false, personId: '', location: '' }
}

// Create (pass `date`) or edit (pass `event`) a calendar event.
export function EventModal({
  event,
  date,
  onClose,
  onSaved,
}: {
  event?: AgendaEvent
  date?: string
  onClose: () => void
  onSaved: () => void
}) {
  const editing = !!event
  const { persons } = usePersons()
  const [form, setForm] = useState(() => initialForm(event, date))
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!form.title.trim() || saving) return
    setSaving(true)
    const payload = {
      title: form.title.trim(),
      startsAt: form.allDay ? toIso(form.day, '12:00') : toIso(form.day, form.time),
      allDay: form.allDay,
      personId: form.personId || null,
      location: form.location.trim() || null,
    }
    try {
      if (editing) await api.updateEvent(event!.id, payload)
      else await api.createEvent(payload)
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
      await api.deleteEvent(event!.id)
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
          {editing ? 'Edit event' : 'New event'}
        </div>

        <form onSubmit={submit}>
          <label className="field">
            <span>Title</span>
            <input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Soccer practice" autoFocus />
          </label>

          <div className="field-row">
            <label className="field">
              <span>Date</span>
              <input type="date" value={form.day} onChange={(e) => set('day', e.target.value)} />
            </label>
            {!form.allDay && (
              <label className="field">
                <span>Time</span>
                <input type="time" value={form.time} onChange={(e) => set('time', e.target.value)} />
              </label>
            )}
          </div>

          <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={form.allDay} onChange={(e) => set('allDay', e.target.checked)} style={{ width: 'auto' }} />
            <span style={{ margin: 0 }}>All day</span>
          </label>

          <label className="field">
            <span>Who</span>
            <select value={form.personId} onChange={(e) => set('personId', e.target.value)}>
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
            <input value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="Field 3" />
          </label>

          <div style={{ display: 'flex', gap: 9, marginTop: 6, alignItems: 'center' }}>
            {editing && (
              <button
                type="button"
                onClick={del}
                disabled={saving}
                style={{
                  border: 0,
                  background: 'none',
                  font: 'inherit',
                  fontWeight: 700,
                  fontSize: 14,
                  color: 'var(--primary)',
                  cursor: 'pointer',
                  padding: '10px 4px',
                }}
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
              {saving ? 'Saving…' : editing ? 'Save' : 'Add event'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
