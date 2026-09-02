import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  rhythmsApi, usePersons, splitCadence, intervalDays, cadenceLabel, nudgeExplainer,
  nudgePlan, addCadence, consequence, type SatisfiedBy, type Rhythm, type Completion,
} from '../../lib/api'
import { ConfirmDialog } from './ConfirmDialog'
import { buildRrule, describeRrule, weekdayCode, NO_REPEAT, type CustomUnit, type MonthlyMode } from './recurrence'
import { WeekdayChips } from './WeekdayChips'

// Create a rhythm by saying it as a sentence:
//
//     🌬 Air filter every 3 months, counted when I mark it done, on Kevin
//
// and then read, underneath, what that sentence will actually do. The form used to
// open with a two-card picker for the shape, which put the most abstract question
// first and asked it in the vocabulary of the schema. The choice hasn't gone
// anywhere — it's the "counted when" clause, phrased as the thing it decides.
//
//   'completion' — you did the thing, and the clock restarts from when you ACTUALLY
//                  did it, so being late shifts the next one instead of stacking misses.
//   'scheduling' — a calendar event exists for the period. We never ask whether it
//                  happened; getting the opportunity onto the calendar IS the outcome.
//
// Every token is a real form control with an aria-label — an input or a select, not a
// span with a click handler — because the sentence has nowhere to hang a visible label
// and a keyboard has to be able to reach all of it. The one exception is the mode
// token, which opens a listbox: both options need their consequence spelled out, and a
// <select> has nowhere to put a second line.
//
// Editing an existing one asks LESS. The shape and the period anchor (`startsOn`,
// `autoSchedule`, `rrule`) are not editable and the server refuses them: moving the
// anchor of a live rhythm would silently re-interpret the periods it has already
// skipped — they are keyed on period_start — and point its bookings at periods that
// no longer exist. So on an edit those clauses of the sentence are stated rather than
// offered, with the boundary named in full and Retire sitting next to it as the way
// through.

type Unit = 'days' | 'weeks' | 'months' | 'years'

const UNITS: { value: Unit; label: string }[] = [
  { value: 'days', label: 'days' },
  { value: 'weeks', label: 'weeks' },
  { value: 'months', label: 'months' },
  { value: 'years', label: 'years' },
]

const CUSTOM_UNIT: Record<Unit, CustomUnit> = { days: 'day', weeks: 'week', months: 'month', years: 'year' }

// Named for what it decides, not for the column it is stored in.
const MODES: { value: SatisfiedBy; label: string; why: string }[] = [
  {
    value: 'completion',
    label: 'I mark it done',
    why: 'The clock restarts the day you actually do it. Late once ≠ late forever.',
  },
  {
    value: 'scheduling',
    label: "it's on the calendar",
    why: 'Getting it booked is the win — nobody asks later whether it happened.',
  },
]

const modeLabel = (m: SatisfiedBy) => MODES.find((o) => o.value === m)!.label

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function longDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

/** Inside the sentence, where the year is noise — "November 19", not "November 19, 2026". */
const dayMonth = (d: Date) => d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })

const chev = (
  <svg className="rhy-chev" viewBox="0 0 24 24" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
)

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
  // Editable on a completion rhythm — that just moves the next due date. Not on a
  // scheduling one, whose periods are generated from it.
  const cadenceFixed = editing && rhythm!.satisfiedBy === 'scheduling'

  // The history this rhythm has actually kept.
  //
  // `GET /:id/completions` and its `averageIntervalDays` have existed since the migration
  // and were reachable from no client at all — so the register kept a record it could not
  // show, and the one fact it is kept FOR ("how often does this really happen?") had
  // nowhere to appear. A nominal 3 months that runs at 5 is the cadence telling you it is
  // wrong; only the server can say so, because the average is computed over every
  // completion rather than the page we fetched.
  //
  // Completion shape only: a scheduling rhythm has no completions by design — whether it
  // happened is the question that shape refuses to ask — so it is never even requested.
  const [history, setHistory] = useState<{ completions: Completion[]; total: number; averageIntervalDays: number | null } | null>(null)
  useEffect(() => {
    if (!editing || !rhythm || rhythm.satisfiedBy !== 'completion') return
    let alive = true
    rhythmsApi.completions(rhythm.id, 5)
      .then((d) => { if (alive) setHistory(d) })
      .catch(() => { /* a missing history is not worth a message; the row still edits */ })
    return () => { alive = false }
  }, [editing, rhythm])
  const seed = splitCadence(rhythm?.every ?? '')
  const { persons } = usePersons()
  const [shape, setShape] = useState<SatisfiedBy>(rhythm?.satisfiedBy ?? 'completion')
  const [title, setTitle] = useState(rhythm?.title ?? '')
  const [emoji, setEmoji] = useState(rhythm?.emoji ?? '')
  const [notes, setNotes] = useState(rhythm?.notes ?? '')
  const [personId, setPersonId] = useState(rhythm?.personId ?? '')
  const [count, setCount] = useState(editing ? String(seed.count) : '1')
  const [unit, setUnit] = useState<Unit>(editing ? seed.unit : 'weeks')
  // `null` means "still following the cadence", the same as `nextDue` below.
  const [leadDays, setLeadDays] = useState<string | null>(
    editing ? String(intervalDays(rhythm!.leadTime)) : null
  )
  const [retiring, setRetiring] = useState(false)
  const today = ymd(new Date())
  // `null` means "still following the cadence" — see the derivation below.
  const [nextDue, setNextDue] = useState<string | null>(null)
  const [startsOn, setStartsOn] = useState(today)
  const [autoSchedule, setAutoSchedule] = useState(false)
  const [monthlyMode, setMonthlyMode] = useState<MonthlyMode>('day')
  // How many days from the start of each period a booking still counts. Empty string is
  // the default and means the whole period — which is what `every` meant on its own, so
  // an untouched form creates exactly what it used to.
  const [windowDays, setWindowDays] = useState(
    editing && rhythm?.bookWithin ? String(intervalDays(rhythm.bookWithin)) : ''
  )
  const [customRule, setCustomRule] = useState('')
  const [modeOpen, setModeOpen] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  // Which weekday inside a weekly cadence. Empty means "whatever day the anchor
  // falls on", which is what buildRrule already assumes.
  const [byday, setByday] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const modeRef = useRef<HTMLDivElement | null>(null)

  const n = Math.max(1, Math.round(Number(count) || 1))
  const every = `${n} ${unit}`

  // A window and "put it on the calendar automatically" answer the same question — when
  // inside the period does this happen — and the rule wins, because it is what creates
  // the event. The server refuses the pair; the form simply stops offering it.
  // "each month" / "each week" / "every 2 weeks" — the sentence below reads as the rhythm
  // being described rather than as a setting, so it has to name the cadence the person
  // just chose instead of falling back on "period", which was fairly answered with "what
  // period? I'm scheduling it every week."
  const cycleNoun = n === 1 ? `each ${unit.replace(/s$/, '')}` : `every ${n} ${unit}`

  const booksItself = editing ? !!rhythm?.autoSchedule : autoSchedule
  const windowNum = Math.max(0, Math.round(Number(windowDays) || 0))
  const showWindow = shape === 'scheduling' && !booksItself
  const bookWithin = showWindow && windowNum > 0 ? `${windowNum} days` : null

  // A fixed 14-day default runway is wrong for most cadences: on anything up to a
  // fortnight the server trims it to half the cycle, so an untouched form would open
  // already promising a nudge on a day nothing happens, and explaining a clamp nobody
  // asked for. Follow the cadence until someone actually sets a number.
  const lead = leadDays ?? String(Math.min(14, Math.floor(intervalDays(every) / 2)))
  const leadNum = Math.max(0, Math.round(Number(lead) || 0))

  // A brand-new rhythm is due one full cadence out, not today. Anchoring it at today
  // makes "every 3 months" mean "and the first one is overdue right now", so every
  // rhythm anyone creates arrives already shouting from Needs you now. Still an open
  // field under More options — adding something you're already behind on is a real
  // case — but it follows the cadence until it's actually touched.
  const firstDue = nextDue ?? ymd(addCadence(new Date(), every))

  // "The third Saturday of the month" asks `startsOn` to do two jobs that disagree.
  //
  // It anchors the period grid — boundaries are startsOn + n × every — and it is also
  // where the rule reads its ordinal from. Anchored on a third Saturday, the periods run
  // 19th to 19th while third Saturdays wander over the 15th to the 21st: [Sep 19, Oct 19)
  // holds two of them and [Oct 19, Nov 19) holds none. A period with nothing in it can
  // never be satisfied, so the register asks you to book it while the series sits on the
  // calendar in plain sight, and it asks forever. (The server refuses this outright now;
  // this is what keeps the friendly path from building it in the first place.)
  //
  // So the two jobs are split: the grid anchors on the first of the month, which makes
  // every period a calendar month and every calendar month hold exactly one of any nth
  // weekday, while the rule keeps reading its ordinal off the date actually picked.
  const monthlyNthWeekday = shape === 'scheduling' && autoSchedule && unit === 'months' && monthlyMode !== 'day'
  const periodAnchor = monthlyNthWeekday ? `${startsOn.slice(0, 7)}-01` : startsOn

  // The runway to send.
  //
  // A day count is exact for days and weeks and wrong for anything longer: "30 days" is a
  // month only in a 30-day month, so a monthly rhythm asked to open on the 1st opened on
  // the 2nd in a 31-day one and a day early in February. When the ask covers the whole
  // cycle, send the cadence itself and let Postgres do real calendar arithmetic — that is
  // what makes "from the first day of each period" land on the first day of every period.
  const wantsWholeCycle = shape === 'scheduling' && !bookWithin && leadNum >= intervalDays(every)
  const leadTimeToSend = wantsWholeCycle ? every : `${leadNum} days`

  const anchor = shape === 'scheduling' ? periodAnchor : firstDue
  const plan = consequence({ satisfiedBy: shape, every, leadDays: leadNum, anchor })
  const clamp = nudgePlan(every, leadNum, shape, bookWithin)

  // The rule is DERIVED from the cadence rather than asked for again: an rrule that
  // disagrees with `every` would put the generated event outside the period it is
  // supposed to satisfy. The raw field is the escape hatch, not the normal path.
  const rrule = buildRrule(
    { ...NO_REPEAT, freq: 'custom', interval: n, unit: CUSTOM_UNIT[unit], monthlyMode, custom: customRule, byday },
    new Date(`${startsOn}T00:00:00`)
  )

  // A popover that only closes on its own trigger is a popover you have to hunt for
  // the way out of.
  useEffect(() => {
    if (!modeOpen) return
    const away = (e: MouseEvent) => {
      if (!modeRef.current?.contains(e.target as Node)) setModeOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [modeOpen])

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
          every,
          leadTime: leadTimeToSend,
          // Sent as an explicit null when cleared: an absent key means "leave it alone",
          // so widening back to the whole period has to be stated. Only for the shape
          // that can carry one at all.
          ...(shape === 'scheduling' && !booksItself ? { bookWithin } : {}),
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
        every,
        leadTime: leadTimeToSend,
        // A completion rhythm has no period grid and a scheduling one has no due
        // date; the server's shape constraint rejects a row carrying both.
        ...(shape === 'completion'
          ? { nextDueAt: new Date(`${firstDue}T09:00`).toISOString() }
          : {
              startsOn: periodAnchor,
              autoSchedule,
              rrule: autoSchedule ? rrule : null,
              ...(bookWithin ? { bookWithin } : {}),
            }),
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
    try {
      await rhythmsApi.remove(rhythm.id)
    } catch {
      // The confirm dialog re-enables its own button in a `finally`, so an escaping
      // rejection left "Retire it" looking live after the delete had already failed —
      // a dialog that appears to be waiting for a press it has already had.
      setFailed("Couldn't retire that one — try again.")
      setRetiring(false)
      return
    }
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
          Say it as a sentence. Everything else has a sane default.
        </div>

        <form onSubmit={submit}>
          <div className="rhy-sent">
            <input
              className="rhy-tok rhy-tok-emoji"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              placeholder="🔁"
              maxLength={4}
              aria-label="Emoji"
            />
            {/* The placeholder is the first example anyone reads, so it should be the
                most ordinary rhythm there is, not the most exotic one. */}
            <input
              className="rhy-tok rhy-tok-name"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Take the trash out"
              size={Math.max(12, title.length || 17)}
              aria-label="What"
              autoFocus
            />
            <br />
            <span className="rhy-fix">every</span>
            {cadenceFixed ? (
              // A scheduling rhythm's cadence IS its period grid: periods are tiled from
              // the anchor by this interval, so a new one re-reads every period it has
              // already skipped or booked. Same reason the shape below is fixed, and said
              // the same way rather than left to fail on save.
              <span className="rhy-tok rhy-tok-fixed">{count} {UNITS.find((u) => u.value === unit)?.label ?? unit}</span>
            ) : (
              <>
                <input
                  className="rhy-tok rhy-tok-num"
                  type="number"
                  min={1}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  aria-label="How often"
                />
                <span className="rhy-tok rhy-tok-sel">
                  <select value={unit} onChange={(e) => setUnit(e.target.value as Unit)} aria-label="Unit">
                    {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                  </select>
                  {chev}
                </span>
              </>
            )}
            <span className="rhy-fix">,</span>
            <br />
            <span className="rhy-fix">counted when</span>
            {editing ? (
              // Not offered: re-shaping a live rhythm would re-read every period it
              // has already skipped or booked. Said plainly instead of hidden.
              <span className="rhy-tok rhy-tok-fixed">{modeLabel(shape)}</span>
            ) : (
              <span className="rhy-tok-mode" ref={modeRef}>
                <button
                  type="button"
                  className={`rhy-tok rhy-tok-btn${modeOpen ? ' on' : ''}`}
                  aria-label="counted when"
                  aria-haspopup="listbox"
                  aria-expanded={modeOpen}
                  onClick={() => setModeOpen((v) => !v)}
                >
                  {modeLabel(shape)}{chev}
                </button>
                {modeOpen && (
                  <div className="rhy-drop" role="listbox" aria-label="What counts as done">
                    {MODES.map((o) => (
                      <div
                        key={o.value}
                        role="option"
                        aria-selected={shape === o.value}
                        tabIndex={0}
                        className={`rhy-opt${shape === o.value ? ' on' : ''}`}
                        onClick={() => { setShape(o.value); setModeOpen(false) }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShape(o.value); setModeOpen(false) }
                        }}
                      >
                        <span className="rhy-ck" aria-hidden />
                        <span>
                          <span className="rhy-opt-t">{o.label}</span>
                          <span className="rhy-opt-d">{o.why}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </span>
            )}
            <span className="rhy-fix">,</span>
            <br />
            <span className="rhy-fix">on</span>
            <span className="rhy-tok rhy-tok-sel">
              <select value={personId} onChange={(e) => setPersonId(e.target.value)} aria-label="Who">
                <option value="">the whole household</option>
                {persons.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {chev}
            </span>
          </div>

          {/* What the sentence above will actually do, in the two dates that are the
              whole promise. Both are derived through nudgePlan, never from the typed
              runway: the server keeps least(leadTime, every/2), so a weekly rhythm
              asked for 14 days' notice would otherwise be promised a nudge on a day
              nothing is ever going to happen. */}
          {plan && !editing && (
            <div className="rhy-conseq">
              <span className="rhy-conseq-ic" aria-hidden>
                {shape === 'completion' ? (
                  <svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4M16 3v4M3 10h18" /></svg>
                )}
              </span>
              <div>
                {shape === 'completion' ? (
                  <>
                    Next one lands around <b>{dayMonth(plan.landsOn)}</b>. It'll be on your Today
                    card from <b>{dayMonth(plan.nudgeFrom)}</b>. If you do it late the next one
                    moves with it — misses never stack up.
                  </>
                ) : (
                  <>
                    Booking it is the win — we'll never ask whether it happened. A fresh window
                    opens {cadenceLabel(every)}, and if nothing's on the calendar
                    by <b>{dayMonth(plan.nudgeFrom)}</b> it moves to Needs you now.
                  </>
                )}
                {plan.capped && (
                  <div className="rhy-conseq-cap">
                    {`${leadNum} days' notice won't fit in ${bookWithin ? 'that booking window' : cadenceLabel(every).replace(/^every /, 'a ')}, so it's trimmed to ${clamp.effectiveDays} — a runway longer than the stretch it belongs to never goes quiet.`}
                  </div>
                )}
              </div>
            </div>
          )}

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

          {history && history.total > 0 && (
            <div className="rhy-anchor">
              <b>{history.total === 1 ? 'Done once' : `Done ${history.total} times`}</b>
              {/* Rounded: a household needs "about every 123 days", not a decimal place.
                  Absent below two completions, because one date is not an interval — the
                  server returns null there rather than inventing one, and this must not
                  fill that in with a number of its own. */}
              {history.averageIntervalDays !== null && (
                <> · about every <b>{Math.round(history.averageIntervalDays)} days</b>, against {cadenceLabel(rhythm!.every)}</>
              )}
              <div className="tiny muted" style={{ marginTop: 6 }}>
                {history.completions.map((c) => dayMonth(new Date(c.completedAt))).join(' · ')}
              </div>
            </div>
          )}

          <button type="button" className="rhy-more-row" onClick={() => setAdvanced((v) => !v)}>
            <span className={`rhy-more-chev${advanced ? ' on' : ''}`}>{chev}</span>
            {advanced ? 'Fewer options' : 'More options — notes, how early to nudge, auto-add to calendar'}
          </button>

          {advanced && (
            <div className="rhy-adv">
              <label className="field">
                <span>
                  {shape === 'completion'
                    ? 'Start nudging me this many days early'
                    : 'Start nudging me this many days before the window closes'}
                </span>
                <input type="number" min={0} value={lead} onChange={(e) => setLeadDays(e.target.value)} />
              </label>
              {/* Spelled out against THIS rhythm's cadence rather than left as "the period",
                  which was reasonably read as "what period? I'm scheduling it every week".
                  It also states the clamp's effect in days — the server stores
                  least(leadTime, every/2), so a weekly rhythm that asks for 14 days' notice
                  quietly gets 3, and nothing said so. */}
              <div className="tiny muted" style={{ marginTop: -6, marginBottom: 12 }}>
                {shape === 'completion'
                  ? 'Capped at half the cadence — a rhythm you mark done keeps asking however late it is, so a longer runway would never let it go quiet.'
                  : nudgeExplainer(every, leadNum, bookWithin)}
              </div>

              {/* The anchors are create-only: see the note at the top of this file. */}
              {editing ? null : shape === 'completion' ? (
                <label className="field">
                  <span>First one due</span>
                  <input type="date" value={firstDue} onChange={(e) => setNextDue(e.target.value)} />
                </label>
              ) : (
                <>
                  <label className="field">
                    <span>First period starts</span>
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
                      {monthlyNthWeekday && (
                        <div className="tiny muted" style={{ marginTop: -6, marginBottom: 10 }}>
                          Periods run in calendar months so exactly one of these falls in each — the
                          date above just picks which weekday it is.
                        </div>
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

              {/* The booking window — the one part of WHEN that is editable in place, so it
                  sits outside the create-only anchor block above. The cadence and the
                  anchor ARE the period grid, and moving either re-reads every boundary
                  (skips stop matching, bookings get re-attributed). A window moves no
                  boundary and re-keys no skip; narrowing one can put a period back to
                  asking, which is visible and undone by widening it again.

                  Not offered when the rhythm books itself: the rule already decides which
                  day inside the period, so there is nothing left to pick, and the server
                  refuses the pair. */}
              {showWindow && (
                <>
                  {/* Said as a sentence, like the rest of this form. The label used to read
                      "Only the first … days of each period count", which stated the rule
                      inside-out and leaned on a word ("period") the form never taught. */}
                  <div className="field">
                    <span>Deadline inside each cycle</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontWeight: 600 }}>
                      <span>It must be booked in the first</span>
                      <input
                        type="number"
                        min={1}
                        value={windowDays}
                        placeholder="—"
                        aria-label={`It must be booked in the first how many days of ${cycleNoun}`}
                        onChange={(e) => setWindowDays(e.target.value)}
                        style={{ width: 72 }}
                      />
                      <span>days of {cycleNoun}.</span>
                    </div>
                  </div>
                  <div className="tiny muted" style={{ marginTop: -6, marginBottom: 12 }}>
                    {bookWithin
                      ? `Leave it blank and any day counts. Set to ${windowNum}, a booking later than that leaves ${cycleNoun.replace(/^each |^every /, '')} unbooked.`
                      : `Leave it blank and any day in ${cycleNoun.replace(/^each /, 'the ')} counts — most rhythms want that.`}
                  </div>
                </>
              )}

              <label className="field">
                <span>Notes</span>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Furnace, 20x25x1" />
              </label>
            </div>
          )}

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
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()} style={{ flex: 1, justifyContent: 'center' }}>
                {busy ? 'Saving…' : 'Add rhythm'}
              </button>
            </div>
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
