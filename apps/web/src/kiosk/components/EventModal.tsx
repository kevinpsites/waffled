import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { api, usePersons, calendarsApi, mealsApi, localToday, invalidateGetCache, type AgendaEvent, type CalendarLink } from '../../lib/api'
import { createEventLocal, updateEventLocal, deleteEventLocal, tombstoneEvent } from '../../lib/powersync/events-local'

// Calendars an event can be written to: writable (owner/writer), not read-only.
function isWritable(c: CalendarLink): boolean {
  return c.accessRole === 'owner' || c.accessRole === 'writer'
}

const pad = (n: number) => String(n).padStart(2, '0')

// Build an ISO instant from a local date + time (browser tz = kiosk/household tz).
function toIso(date: string, time: string): string {
  return new Date(`${date}T${time}`).toISOString()
}

const DURATIONS: Array<{ min: number; label: string }> = [
  { min: 15, label: '15 min' },
  { min: 30, label: '30 min' },
  { min: 45, label: '45 min' },
  { min: 60, label: '1 hr' },
  { min: 90, label: '1.5 hr' },
  { min: 120, label: '2 hr' },
  { min: 180, label: '3 hr' },
  { min: 240, label: '4 hr' },
]

function initialForm(event?: AgendaEvent, date?: string, time?: string) {
  if (event) {
    const d = new Date(event.startsAt)
    const participantIds = event.participants.length
      ? event.participants.map((p) => p.id)
      : event.personId
        ? [event.personId]
        : []
    const durationMin =
      event.endsAt && !event.allDay
        ? Math.max(15, Math.round((new Date(event.endsAt).getTime() - d.getTime()) / 60000))
        : 60
    return {
      title: event.title,
      day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
      durationMin,
      allDay: event.allDay,
      participantIds,
      location: event.location ?? '',
    }
  }
  return { title: '', day: date ?? localToday(), time: time ?? '17:00', durationMin: 60, allDay: false, participantIds: [] as string[], location: '' }
}

// Create (pass `date`, optional `time`) or edit (pass `event`) a calendar event.
export function EventModal({
  event,
  date,
  time,
  onClose,
  onSaved,
}: {
  event?: AgendaEvent
  date?: string
  time?: string
  onClose: () => void
  onSaved: () => void
}) {
  const editing = !!event
  const navigate = useNavigate()
  const { persons } = usePersons()
  const [form, setForm] = useState(() => initialForm(event, date, time))
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))

  // For a planned-meal event, resolve its recipe so we can offer "View recipe".
  const isMeal = event?.origin === 'meal_plan'
  const [recipeId, setRecipeId] = useState<string | null>(null)
  useEffect(() => {
    if (!isMeal || !event?.originRefId) return
    let alive = true
    mealsApi.entry(event.originRefId).then((r) => alive && setRecipeId(r.recipeId)).catch(() => {})
    return () => { alive = false }
  }, [isMeal, event?.originRefId])

  // Calendar picker (create only): which Google calendar the event is written to.
  // '' = Nook only. Defaults to the owner's ★ calendar and follows the owner until
  // the user picks manually. Editing keeps the event on its existing calendar.
  const [writableCals, setWritableCals] = useState<CalendarLink[]>([])
  const [calendarId, setCalendarId] = useState('')
  const [calTouched, setCalTouched] = useState(false)
  const primary = form.participantIds[0] ?? null

  useEffect(() => {
    if (editing) return
    let alive = true
    calendarsApi
      .calendarStatus()
      .then((s) => alive && setWritableCals(s.calendars.filter(isWritable)))
      .catch(() => {}) // no Google / not signed in → no picker
    return () => {
      alive = false
    }
  }, [editing])

  // The calendars offered for an event: the owner's (first-selected person's) own
  // writable calendars that are syncing — plus their ★ target even if sync is off.
  const ownerCals = primary
    ? writableCals.filter((c) => c.personId === primary && (c.selected || c.isWriteTarget))
    : []

  // Default to the owner's ★ target (then any of their calendars), re-following
  // when the owner changes — until the user picks manually.
  useEffect(() => {
    if (editing || calTouched) return
    const target = ownerCals.find((c) => c.isWriteTarget) ?? ownerCals[0]
    setCalendarId(target?.id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, calTouched, primary, writableCals])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!form.title.trim() || saving) return
    setSaving(true)
    const startsAt = form.allDay ? toIso(form.day, '12:00') : toIso(form.day, form.time)
    // Timed events get start + duration; all-day events have no end.
    const endsAt = form.allDay ? null : new Date(new Date(startsAt).getTime() + form.durationMin * 60000).toISOString()
    // Calendar choice only when the picker was shown (owner has >1); else auto-route.
    const chosenCal = !editing && ownerCals.length > 1 ? calendarId || null : null
    const draft = {
      title: form.title.trim(),
      startsAt,
      endsAt,
      allDay: form.allDay,
      location: form.location.trim() || null,
      personIds: form.participantIds,
    }
    const restPayload = { ...draft, participantIds: draft.personIds }
    try {
      // Prefer the local DB (instant, offline-capable); fall back to REST when
      // PowerSync isn't running.
      if (editing) {
        if (!(await updateEventLocal(event!.id, draft))) await api.updateEvent(event!.id, restPayload)
        invalidateGetCache(`/api/events/${event!.id}/insight`)
      } else {
        if (!(await createEventLocal({ ...draft, calendarId: chosenCal }))) {
          await api.createEvent(ownerCals.length > 1 ? { ...restPayload, calendarId: chosenCal } : restPayload)
        }
      }
      // The week digest reflects this event — refresh it next time it's shown.
      invalidateGetCache('/api/calendar/heads-up')
      onSaved()
      onClose()
    } catch (err) {
      console.error('event save failed', err)
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
      // Prefer the local delete (instant, offline); when the row isn't in the local
      // DB yet it returns false and we delete via REST, tombstoning on success so
      // the UI hides it through the refetch/replication window.
      if (!(await deleteEventLocal(event!.id))) {
        await api.deleteEvent(event!.id)
        tombstoneEvent(event!.id)
      }
      invalidateGetCache('/api/calendar/heads-up')
      onSaved()
      onClose()
    } catch (err) {
      console.error('event delete failed', err)
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
          {editing ? (isMeal ? 'Planned meal' : 'Edit event') : 'New event'}
        </div>

        {isMeal && recipeId && (
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center', marginBottom: 14 }}
            onClick={() => { onClose(); navigate(`/meals/recipe/${recipeId}`) }}
          >
            📖 View recipe
          </button>
        )}

        <form onSubmit={submit}>
          <label className="field">
            <span>Title</span>
            <input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Soccer practice" autoFocus />
          </label>

          <label className="field">
            <span>Date</span>
            <input type="date" value={form.day} onChange={(e) => set('day', e.target.value)} />
          </label>
          {!form.allDay && (
            <div className="field-row">
              <label className="field">
                <span>Time</span>
                <input type="time" value={form.time} onChange={(e) => set('time', e.target.value)} />
              </label>
              <label className="field">
                <span>Duration</span>
                <select value={form.durationMin} onChange={(e) => set('durationMin', Number(e.target.value))}>
                  {DURATIONS.map((d) => (
                    <option key={d.min} value={d.min}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={form.allDay} onChange={(e) => set('allDay', e.target.checked)} style={{ width: 'auto' }} />
            <span style={{ margin: 0 }}>All day</span>
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
                    onClick={() =>
                      set(
                        'participantIds',
                        on ? form.participantIds.filter((x) => x !== p.id) : [...form.participantIds, p.id]
                      )
                    }
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 12px',
                      borderRadius: 999,
                      // Always 1.5px so toggling only swaps the color — no size shift.
                      border: `1.5px solid ${on ? color : 'transparent'}`,
                      background: on ? `${color}22` : 'var(--card-2)',
                      color: 'var(--ink)',
                      font: 'inherit',
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {p.avatarEmoji ?? '🙂'} {p.name}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Only worth choosing when the owner has more than one calendar; with
              a single one we just use it. */}
          {!editing && ownerCals.length > 1 && (
            <label className="field">
              <span>Calendar</span>
              <select
                value={calendarId}
                onChange={(e) => {
                  setCalendarId(e.target.value)
                  setCalTouched(true)
                }}
                style={{ width: '100%' }}
              >
                {ownerCals.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.summary ?? 'Calendar'}
                    {c.isWriteTarget ? ' ★' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

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
