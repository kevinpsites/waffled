import { useState, type FormEvent } from 'react'
import { rhythmsApi, cadenceLabel, type RhythmPeriod } from '../../lib/api'

// Book a period: turn "this should happen" into an actual dated event.
//
// This modal is deliberately the smallest thing that can exist. The server fills the
// title and the assignee from the rhythm, so all that's left to decide is WHEN — and
// making someone retype "Temple visit" is exactly the friction that keeps these
// things off the calendar in the first place.

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// The last day still inside the period — periodEnd is the exclusive next boundary,
// so a booking on that date lands in the NEXT period and satisfies the wrong one.
function lastDayOfPeriod(periodEnd: string): string {
  const d = new Date(`${periodEnd}T00:00:00`)
  d.setDate(d.getDate() - 1)
  return ymd(d)
}

export function BookRhythmModal({
  item,
  onClose,
  onBooked,
}: {
  // Any period of any scheduling rhythm — an unscheduled attention item is one,
  // and so is a row from the register whose runway hasn't opened yet.
  item: RhythmPeriod
  onClose: () => void
  onBooked?: () => void
}) {
  const { rhythm, periodStart, periodEnd } = item
  // Only when there is no recurrence left. Booking a period whose series is alive adds
  // one event to that period; the server refuses to clone the rule a second time, and the
  // copy here must not promise otherwise.
  const series = rhythm.autoSchedule && !item.hasSeries
  const last = lastDayOfPeriod(periodEnd)
  const today = ymd(new Date())
  // Default to today when today is inside the period (the common case — the runway
  // only opens near the end), otherwise the first day it could go.
  const [date, setDate] = useState(today >= periodStart && today <= last ? today : periodStart)
  const [time, setTime] = useState('18:00')
  const [allDay, setAllDay] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const outside = date < periodStart || date > last

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || !date) return
    setBusy(true)
    setFailed(false)
    try {
      // An explicit instant, built from the LOCAL date+time. Handing the raw
      // datetime-local string through would leave the timezone to the server and
      // could put a boundary booking in the neighbouring period.
      const startsAt = new Date(allDay ? `${date}T00:00` : `${date}T${time}`).toISOString()
      await rhythmsApi.schedule(rhythm.id, { startsAt, allDay })
      onBooked?.()
      onClose()
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>
          {rhythm.emoji ? `${rhythm.emoji} ` : ''}{rhythm.title}
        </div>
        <div className="tiny muted" style={{ marginBottom: 14 }}>
          {series
            ? `Puts the whole series back on the calendar, ${cadenceLabel(rhythm.every)}.`
            : `Pick a time and it goes on the calendar — ${cadenceLabel(rhythm.every)}.`}
        </div>

        <form onSubmit={submit}>
          <div className="field-row">
            <label className="field" style={{ flex: 2 }}>
              <span>Date</span>
              <input type="date" value={date} min={periodStart} max={last} onChange={(e) => setDate(e.target.value)} autoFocus />
            </label>
            {!allDay && (
              <label className="field" style={{ flex: 1 }}>
                <span>Time</span>
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </label>
            )}
          </div>

          <label
            style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '2px 0 12px', cursor: 'pointer', fontWeight: 600 }}
            onClick={(e) => { e.preventDefault(); setAllDay((v) => !v) }}
          >
            <span className={`toggle ${allDay ? 'on' : ''}`} role="switch" aria-checked={allDay} aria-label="All day" />
            <span className="tiny" style={{ fontWeight: 600 }}>All day</span>
          </label>

          {outside && (
            <div className="tiny muted" style={{ marginBottom: 10 }}>
              That's outside this period — pick a day between {periodStart} and {last} for it to count.
            </div>
          )}
          {failed && <div className="tiny muted" style={{ marginBottom: 10 }}>Couldn't book it — try again.</div>}

          <button type="submit" className="btn btn-primary" disabled={busy || outside} style={{ width: '100%', justifyContent: 'center' }}>
            {busy ? 'Booking…' : series ? 'Put it back on the calendar' : 'Put it on the calendar'}
          </button>
        </form>
      </div>
    </div>
  )
}
