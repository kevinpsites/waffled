import { useState, type FormEvent } from 'react'
import { rhythmsApi, usePersons, splitCadence, intervalDays, cadenceLabel, nudgeExplainer, type SatisfiedBy, type Rhythm } from '../../lib/api'
import { ConfirmDialog } from './ConfirmDialog'
import { buildRrule, describeRrule, weekdayCode, NO_REPEAT, type CustomUnit, type MonthlyMode } from './recurrence'
import { WeekdayChips } from './WeekdayChips'

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
//
// Editing an existing one asks LESS. The shape and the period anchor (`startsOn`,
// `autoSchedule`, `rrule`) are not editable and the server refuses them: moving the
// anchor of a live rhythm would silently re-interpret the periods it has already
// skipped — they are keyed on period_start — and point its bookings at periods that
// no longer exist. That boundary is stated in the form rather than hidden, with
// Retire sitting right next to it as the way through.

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

function longDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

export function RhythmModal({
  rhythm,
  onClose,
  onSaved,
}: {
  /** Omit to create; pass one to edit it in place. */
  rhythm?: Rhythm
  onClose: () => void
  onSaved?: () => void
}) {
  const editing = !!rhythm
  const seed = splitCadence(rhythm?.every ?? '')
  const { persons } = usePersons()
  const [shape, setShape] = useState<SatisfiedBy>(rhythm?.satisfiedBy ?? 'scheduling')
  const [title, setTitle] = useState(rhythm?.title ?? '')
  const [emoji, setEmoji] = useState(rhythm?.emoji ?? '')
  const [notes, setNotes] = useState(rhythm?.notes ?? '')
  const [personId, setPersonId] = useState(rhythm?.personId ?? '')
  const [count, setCount] = useState(editing ? String(seed.count) : '1')
  const [unit, setUnit] = useState<Unit>(editing ? seed.unit : 'weeks')
  const [leadDays, setLeadDays] = useState(editing ? String(intervalDays(rhythm!.leadTime)) : '14')
  const [retiring, setRetiring] = useState(false)
  const today = ymd(new Date())
  const [nextDue, setNextDue] = useState(today)
  const [startsOn, setStartsOn] = useState(today)
  const [autoSchedule, setAutoSchedule] = useState(false)
  const [monthlyMode, setMonthlyMode] = useState<MonthlyMode>('day')
  const [customRule, setCustomRule] = useState('')
  // Which weekday inside a weekly cadence. Empty means "whatever day the anchor
  // falls on", which is what buildRrule already assumes.
  const [byday, setByday] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const n = Math.max(1, Math.round(Number(count) || 1))
  // The rule is DERIVED from the cadence rather than asked for again: an rrule that
  // disagrees with `every` would put the generated event outside the period it is
  // supposed to satisfy. The raw field is the escape hatch, not the normal path.
  const rrule = buildRrule(
    { ...NO_REPEAT, freq: 'custom', interval: n, unit: CUSTOM_UNIT[unit], monthlyMode, custom: customRule, byday },
    new Date(`${startsOn}T00:00:00`)
  )

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || !title.trim()) return
    setBusy(true)
    setFailed(null)
    try {
      if (rhythm) {
        // Only the safe-to-change fields. `personId` goes as null rather than '' —
        // the server casts it straight to uuid, so an empty string is a 500.
        await rhythmsApi.update(rhythm.id, {
          title: title.trim(),
          emoji: emoji.trim() || null,
          notes: notes.trim() || null,
          personId: personId || null,
          every: `${n} ${unit}`,
          leadTime: `${Math.max(0, Math.round(Number(leadDays) || 0))} days`,
        })
        onSaved?.()
        onClose()
        return
      }
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
      onSaved?.()
      onClose()
    } catch {
      setFailed("Couldn't save that — check the cadence and try again.")
      setBusy(false)
    }
  }

  async function retire() {
    if (!rhythm) return
    await rhythmsApi.remove(rhythm.id)
    onSaved?.()
    setRetiring(false)
    onClose()
  }

  return (
    <>
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={editing ? 'Edit rhythm' : 'New rhythm'} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>{editing ? 'Edit rhythm' : 'New rhythm'}</div>
        <div className="tiny muted" style={{ marginBottom: 14 }}>
          Something that should keep happening, and a place to confirm that it will.
        </div>

        {!editing && <div className="rhy-shape-pick">
          <button type="button" className={`rhy-shape${shape === 'scheduling' ? ' on' : ''}`} onClick={() => setShape('scheduling')}>
            <div className="rhy-shape-t">It gets scheduled</div>
            <div className="rhy-shape-d">Done when it's on the calendar. We never ask whether it happened.</div>
          </button>
          <button type="button" className={`rhy-shape${shape === 'completion' ? ' on' : ''}`} onClick={() => setShape('completion')}>
            <div className="rhy-shape-t">You do it</div>
            <div className="rhy-shape-d">The clock restarts from when you actually did it.</div>
          </button>
        </div>}

        {editing && rhythm && (
          <div className="rhy-anchor">
            {rhythm.satisfiedBy === 'scheduling' ? (
              <>
                Periods are anchored to {longDate(rhythm.startsOn)}, {cadenceLabel(rhythm.every)}
                {rhythm.autoSchedule ? ', booked automatically' : ''}. Moving the anchor would re-interpret
                the periods you've already skipped or booked, so it can't change here — retire this one and
                make a new one instead.
              </>
            ) : (
              <>
                Next due {longDate(rhythm.nextDueAt)}. The clock isn't set by hand — marking it done restarts
                it from when you actually did it. Moving the anchor would mean a different rhythm, so retire
                this one and make a new one instead.
              </>
            )}
          </div>
        )}

        <form onSubmit={submit}>
          <div className="field-row">
            <label className="field" style={{ flex: 3 }}>
              <span>What</span>
              {/* The placeholder is the first example anyone reads, so it should be the
                  most ordinary rhythm there is, not the most exotic one. */}
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Take the trash out" autoFocus />
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
              <select value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
                {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
              </select>
            </label>
            <label className="field" style={{ flex: 2 }}>
              <span>Who</span>
              <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
                <option value="">Whole household</option>
                {persons.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          </div>

          {/* The anchors are create-only: see the note above the shape picker. */}
          {editing ? null : shape === 'completion' ? (
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
                  {/* Which day WITHIN the cadence — the only part of the rule that's an
                      open question. How OFTEN it repeats is derived from "every N units"
                      above and deliberately not asked again here: a rule that disagreed
                      with the cadence would put the event outside the period it exists to
                      satisfy. Same control the calendar uses, in single-select: "every
                      week" plus BYDAY=MO,WE would fire twice a period. */}
                  {unit === 'weeks' && (
                    <div className="field">
                      <span>On this day</span>
                      <WeekdayChips
                        value={byday}
                        weekday={weekdayCode(new Date(`${startsOn}T00:00:00`))}
                        onChange={setByday}
                        single
                      />
                    </div>
                  )}
                  {unit === 'months' && (
                    <label className="field">
                      <span>Which day of the month</span>
                      <select value={monthlyMode} onChange={(e) => setMonthlyMode(e.target.value as MonthlyMode)}>
                        <option value="day">The same date</option>
                        <option value="weekday">The same weekday (e.g. the third Saturday)</option>
                        <option value="lastWeekday">The last of that weekday</option>
                      </select>
                    </label>
                  )}
                  {/* Kept for imported rules and cadences the builder can't express, but
                      behind a disclosure and named exactly as it is on the calendar —
                      an RRULE text box is not a reasonable first thing to ask anyone. */}
                  <details style={{ marginBottom: 10 }}>
                    <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--ink-2)' }}>Advanced (raw RRULE)</summary>
                    <input
                      style={{ marginTop: 8 }}
                      value={customRule}
                      onChange={(e) => setCustomRule(e.target.value)}
                      placeholder="FREQ=MONTHLY;BYDAY=3SA"
                      aria-label="Custom RRULE"
                    />
                  </details>
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
              <span>
                {shape === 'completion'
                  ? 'Warn me this many days before it’s due'
                  : 'How many days’ warning before the booking window closes'}
              </span>
              <input type="number" min={0} value={leadDays} onChange={(e) => setLeadDays(e.target.value)} />
            </label>
          </div>
          {/* Spelled out against THIS rhythm's cadence rather than left as "the period",
              which was reasonably read as "what period? I'm scheduling it every week".
              It also states the clamp's effect in days — the server stores
              least(leadTime, every/2), so a weekly rhythm that asks for 14 days' notice
              quietly gets 3, and nothing said so. */}
          <div className="tiny muted" style={{ marginTop: -6, marginBottom: 10 }}>
            {shape === 'completion'
              ? 'Capped at half the cadence — a runway longer than the cycle never closes, so it would never go quiet.'
              : nudgeExplainer(`${n} ${unit}`, Number(leadDays) || 0)}
          </div>

          <label className="field">
            <span>Notes</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Furnace, 20x25x1" />
          </label>

          {failed && <div className="tiny muted" style={{ marginBottom: 10 }}>{failed}</div>}

          {editing ? (
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="btn btn-ghost" style={{ color: 'var(--danger)' }} disabled={busy} onClick={() => setRetiring(true)}>
                Retire
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()} style={{ flex: 1, justifyContent: 'center' }}>
                {busy ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()} style={{ width: '100%', justifyContent: 'center' }}>
              {busy ? 'Saving…' : 'Create rhythm'}
            </button>
          )}
        </form>
      </div>
    </div>

      {/* Outside the editor's overlay: nested, a click on this backdrop would bubble
          up and close the editor underneath it too. */}
      {retiring && rhythm && (
        <ConfirmDialog
          title={`Retire ${rhythm.title}?`}
          message="It stops showing up anywhere. What it has already recorded is kept, but you can't bring it back — pause it instead if you only want it quiet for a while."
          confirmLabel="Retire it"
          danger
          onConfirm={retire}
          onClose={() => setRetiring(false)}
        />
      )}
    </>
  )
}
