import { useState, type FormEvent } from 'react'
import { rhythmsApi, usePersons, type SatisfiedBy } from '../../lib/api'
import { buildRrule, describeRrule, NO_REPEAT, type CustomUnit, type MonthlyMode } from './recurrence'

// Create a rhythm. The first thing this asks is the only thing that really matters:
// what closes out a period?
//
//   'completion' — you did the thing, and the clock restarts from when you ACTUALLY
//                  did it, so being late shifts the next one instead of stacking misses.
//   'scheduling' — a calendar event exists for the period. We never ask whether it
//                  happened; getting the opportunity onto the calendar IS the outcome.
//
// Everything below the shape picker follows from that choice, which is why the two
// branches ask for different anchors (a first due date vs. a period start).

type Unit = 'days' | 'weeks' | 'months' | 'years'

const UNITS: { value: Unit; label: string }[] = [
  { value: 'days', label: 'days' },
  { value: 'weeks', label: 'weeks' },
  { value: 'months', label: 'months' },
  { value: 'years', label: 'years' },
]

const CUSTOM_UNIT: Record<Unit, CustomUnit> = { days: 'day', weeks: 'week', months: 'month', years: 'year' }

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function RhythmModal({ onClose, onCreated }: { onClose: () => void; onCreated?: () => void }) {
  const { persons } = usePersons()
  const [shape, setShape] = useState<SatisfiedBy>('scheduling')
  const [title, setTitle] = useState('')
  const [emoji, setEmoji] = useState('')
  const [notes, setNotes] = useState('')
  const [personId, setPersonId] = useState('')
  const [count, setCount] = useState('1')
  const [unit, setUnit] = useState<Unit>('weeks')
  const [leadDays, setLeadDays] = useState('14')
  const today = ymd(new Date())
  const [nextDue, setNextDue] = useState(today)
  const [startsOn, setStartsOn] = useState(today)
  const [autoSchedule, setAutoSchedule] = useState(false)
  const [monthlyMode, setMonthlyMode] = useState<MonthlyMode>('day')
  const [customRule, setCustomRule] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const n = Math.max(1, Math.round(Number(count) || 1))
  // The rule is DERIVED from the cadence rather than asked for again: an rrule that
  // disagrees with `every` would put the generated event outside the period it is
  // supposed to satisfy. The raw field is the escape hatch, not the normal path.
  const rrule = buildRrule(
    { ...NO_REPEAT, freq: 'custom', interval: n, unit: CUSTOM_UNIT[unit], monthlyMode, custom: customRule },
    new Date(`${startsOn}T00:00:00`)
  )

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || !title.trim()) return
    setBusy(true)
    setFailed(null)
    try {
      await rhythmsApi.create({
        title: title.trim(),
        emoji: emoji.trim() || null,
        notes: notes.trim() || null,
        personId: personId || null,
        satisfiedBy: shape,
        every: `${n} ${unit}`,
        leadTime: `${Math.max(0, Math.round(Number(leadDays) || 0))} days`,
        // A completion rhythm has no period grid and a scheduling one has no due
        // date; the server's shape constraint rejects a row carrying both.
        ...(shape === 'completion'
          ? { nextDueAt: new Date(`${nextDue}T09:00`).toISOString() }
          : { startsOn, autoSchedule, rrule: autoSchedule ? rrule : null }),
      })
      onCreated?.()
      onClose()
    } catch {
      setFailed("Couldn't save that — check the cadence and try again.")
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="New rhythm" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>New rhythm</div>
        <div className="tiny muted" style={{ marginBottom: 14 }}>
          Something that should keep happening, and a place to confirm that it will.
        </div>

        <div className="rhy-shape-pick">
          <button type="button" className={`rhy-shape${shape === 'scheduling' ? ' on' : ''}`} onClick={() => setShape('scheduling')}>
            <div className="rhy-shape-t">It gets scheduled</div>
            <div className="rhy-shape-d">Done when it's on the calendar. We never ask whether it happened.</div>
          </button>
          <button type="button" className={`rhy-shape${shape === 'completion' ? ' on' : ''}`} onClick={() => setShape('completion')}>
            <div className="rhy-shape-t">You do it</div>
            <div className="rhy-shape-d">The clock restarts from when you actually did it.</div>
          </button>
        </div>

        <form onSubmit={submit}>
          <div className="field-row">
            <label className="field" style={{ flex: 3 }}>
              <span>What</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Temple visit" autoFocus />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Emoji</span>
              <input value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="🛕" maxLength={4} />
            </label>
          </div>

          <div className="field-row">
            <label className="field" style={{ flex: 1 }}>
              <span>Every</span>
              <input type="number" min={1} value={count} onChange={(e) => setCount(e.target.value)} />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Unit</span>
              <select className="sel" value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
                {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
              </select>
            </label>
            <label className="field" style={{ flex: 2 }}>
              <span>Who</span>
              <select className="sel" value={personId} onChange={(e) => setPersonId(e.target.value)}>
                <option value="">Whole household</option>
                {persons.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          </div>

          {shape === 'completion' ? (
            <label className="field">
              <span>First due</span>
              <input type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} />
            </label>
          ) : (
            <>
              <label className="field">
                <span>Periods start</span>
                <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
              </label>

              <label
                style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '2px 0 10px', cursor: 'pointer', fontWeight: 600 }}
                onClick={(e) => { e.preventDefault(); setAutoSchedule((v) => !v) }}
              >
                <span
                  className={`toggle ${autoSchedule ? 'on' : ''}`}
                  role="switch"
                  aria-checked={autoSchedule}
                  aria-label="Put it on the calendar automatically"
                />
                <span className="tiny" style={{ fontWeight: 600 }}>Put it on the calendar automatically</span>
              </label>

              {autoSchedule ? (
                <>
                  <div className="tiny muted" style={{ marginBottom: 10 }}>
                    {describeRrule(rrule, new Date(`${startsOn}T00:00:00`))} — booked once, then it just stays there.
                  </div>
                  {unit === 'months' && (
                    <label className="field">
                      <span>Which day of the month</span>
                      <select className="sel" value={monthlyMode} onChange={(e) => setMonthlyMode(e.target.value as MonthlyMode)}>
                        <option value="day">The same date</option>
                        <option value="weekday">The same weekday (e.g. the third Saturday)</option>
                        <option value="lastWeekday">The last of that weekday</option>
                      </select>
                    </label>
                  )}
                  <label className="field">
                    <span>Advanced repeat rule</span>
                    <input value={customRule} onChange={(e) => setCustomRule(e.target.value)} placeholder="FREQ=MONTHLY;BYDAY=3SA" />
                  </label>
                </>
              ) : (
                <div className="tiny muted" style={{ marginBottom: 10 }}>
                  When it happens is an open decision every period, so it'll ask you to pick a time.
                </div>
              )}
            </>
          )}

          <div className="field-row">
            <label className="field" style={{ flex: 1 }}>
              <span>{shape === 'completion' ? 'Warn me this many days ahead' : 'Start nudging me this many days before the period ends'}</span>
              <input type="number" min={0} value={leadDays} onChange={(e) => setLeadDays(e.target.value)} />
            </label>
          </div>
          <div className="tiny muted" style={{ marginTop: -6, marginBottom: 10 }}>
            Capped at half the cadence — a runway longer than the cycle never closes, so it would never go quiet.
          </div>

          <label className="field">
            <span>Notes</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Furnace, 20x25x1" />
          </label>

          {failed && <div className="tiny muted" style={{ marginBottom: 10 }}>{failed}</div>}

          <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()} style={{ width: '100%', justifyContent: 'center' }}>
            {busy ? 'Saving…' : 'Create rhythm'}
          </button>
        </form>
      </div>
    </div>
  )
}
