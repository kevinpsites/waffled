import { useEffect, useState, type FormEvent } from 'react'
import { api, localToday, type Goal, type GoalStep } from '../../lib/api'

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

// The amount you log is always what the GOAL gains — the people you tap are who
// took part, never a multiplier. So the "Who?" picker adapts to the goal:
//   • Divisible shared goals (one shared pool, continuous unit like hours) keep
//     multi-select and SPLIT the amount evenly across the people you tap.
//   • Whole-unit goals (books, parks, counts) use SINGLE-select — pick one
//     person, or "Family" (no one in particular) for "we all did it together" —
//     so the pool gains the whole amount with no fractions or doubling.
//   • each_tracks goals keep multi-select; each person gets the full amount.
const FAMILY = '__family__'

// Log progress — quick-amount chips, a "who" picker that matches the goal, and
// an optional note, matching the handoff "Log time" capture sheet.
export function LogModal({
  goal,
  canLogOthers = true,
  canDelete = true,
  selfPersonId,
  onClose,
  onSaved,
  onDeleted,
}: {
  goal: Goal
  // Without goal.manage, restrict the "who took part" picker to self (a
  // family/shared log stays open) — logging for another person 403s server-side.
  canLogOthers?: boolean
  // Deleting a goal follows the edit/delete rule (manage, or your own solo goal);
  // hide the inline "Delete goal" affordance otherwise.
  canDelete?: boolean
  selfPersonId?: string | null
  onClose: () => void
  onSaved: () => void
  onDeleted?: () => void
}) {
  const chips = quickChips(goal.unit)
  const isChecklist = goal.goalType === 'checklist'
  const isHabit = goal.goalType === 'habit'
  // Logging style is derived purely from the goal type: total = amount entry,
  // count = whole-unit stepper, habit = one tap per day, checklist = tick steps.
  const oneTap = isHabit
  const isCount = goal.goalType === 'count'
  const [amount, setAmount] = useState<number>(oneTap ? 1 : isCount ? 1 : chips[1]?.value ?? 1)
  const isShared = goal.trackingMode === 'shared_total'
  const divisible = goal.goalType === 'total'
  // The four participant types (see GoalCreate.PARTICIPANT_TYPES), decoded for the
  // "who" copy + preview:
  //   • eachAdds  (each_tracks: "individually"/"we all chip in") — every person tapped
  //     gets the FULL amount and the total sums (+amount × people).
  //   • isSplit   (shared_total + split) — the amount is divided evenly across them.
  //   • count-once (shared_total + count_once) — counts once; the people are attendance
  //     (the implicit else branch of the two flags below).
  const eachAdds = goal.trackingMode === 'each_tracks'
  const isSplit = isShared && (goal.participantMode ?? 'count_once') === 'split'

  // Habit display: completions in the current period vs the cadence target.
  const period = goal.habitPeriod ?? 'week'
  const periodLabel = period === 'day' ? 'today' : period === 'month' ? 'this month' : 'this week'
  const habitTarget = goal.habitTargetPerPeriod ?? goal.target ?? 0
  // Tapping several people is now meaningful for every shared goal — the goal's
  // participant mode decides what it means (attendance / full-each / split), so
  // the "who" picker is multi-select throughout (checklists return early above).
  const multi = true
  // Restricted users (no goal.manage) can only attribute progress to themselves
  // or a family/shared log — never to another person. Show only self in the
  // picker and default the selection to self.
  const pickable = canLogOthers ? goal.participants : goal.participants.filter((p) => p.personId === selfPersonId)
  const [who, setWho] = useState<string[]>(
    !canLogOthers && pickable.length === 1
      ? [pickable[0].personId]
      : goal.participants.length === 1
        ? [goal.participants[0].personId]
        : multi ? [] : [FAMILY]
  )
  // A single participant is always credited; no picker (and no "Family") needed.
  // Restricted users with exactly themselves on the goal also skip the picker.
  const showWho = pickable.length > 1 || (canLogOthers && goal.participants.length > 1)
  // A habit can only be marked done once per day per person (the server enforces
  // it too). It's "done" when everyone currently selected already logged today.
  const doneToday = isHabit && who.length > 0 && who.every((id) => goal.loggedTodayBy.includes(id))
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Backdate a forgotten log (e.g. catch up yesterday to keep a streak). Defaults
  // to today; only sent when it differs so normal logs keep their real timestamp.
  const today = localToday()
  const [loggedOn, setLoggedOn] = useState<string>(today)
  // "Already done today" only blocks logging FOR today — you can still backdate.
  const blocked = doneToday && loggedOn === today

  const toggleWho = (id: string) =>
    setWho((w) => (multi ? (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]) : [id]))

  // Divisible shared pool in SPLIT mode, more than one tapped → preview the even split.
  const splitN = isSplit && divisible ? who.filter((id) => id !== FAMILY).length : 0
  const perEach = splitN > 1 ? Math.round((amount / splitN) * 100) / 100 : null

  // One-tap (habit / check-off) = 1; count = whole units; total = entered amount.
  const logAmount = oneTap ? 1 : isCount ? Math.max(1, Math.round(amount)) : Number(amount)

  // "Who?" copy + preview adapt to the goal's participant type.
  const nSel = who.filter((id) => id !== FAMILY).length
  const whoLabel = eachAdds ? 'Who took part?' : isSplit ? 'Split between' : 'Who was there?'
  const unitSuffix = goal.unit ? ` ${goal.unit}` : ''
  const modeHint =
    nSel === 0 ? null
      : eachAdds ? `Each of the ${nSel} gets the full ${logAmount}${unitSuffix} · total +${Math.round(logAmount * nSel * 100) / 100}${unitSuffix}.`
        : isSplit ? (perEach != null ? `Shared together → ${perEach}${unitSuffix} each, ${amount}${unitSuffix} total.` : null)
          : `Counts once for the family · records who was there${nSel > 0 ? ` (${nSel})` : ''}.`

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!logAmount || saving || blocked) return
    setSaving(true)
    try {
      // "Family" is a shared (no-person) log; strip the sentinel before sending.
      const personIds = who.filter((id) => id !== FAMILY)
      await api.logGoal(goal.id, { amount: logAmount, personIds, note: note.trim() || null, loggedOn: loggedOn !== today ? loggedOn : null })
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

  // Checklist goals log by ticking steps. The Goal handed in has only step COUNTS,
  // so fetch the detail to get the step list, then toggle each in place.
  const [steps, setSteps] = useState<GoalStep[] | null>(null)
  useEffect(() => {
    if (!isChecklist) return
    let live = true
    api.goal(goal.id).then((r) => { if (live) setSteps(r.goal.steps) }).catch(() => { if (live) setSteps([]) })
    return () => { live = false }
  }, [isChecklist, goal.id])

  async function toggleStep(step: GoalStep) {
    const next = !step.done
    setSteps((ss) => ss?.map((s) => (s.id === step.id ? { ...s, done: next } : s)) ?? null)
    try {
      await api.toggleStep(goal.id, step.id, next)
      onSaved()
    } catch {
      setSteps((ss) => ss?.map((s) => (s.id === step.id ? { ...s, done: step.done } : s)) ?? null) // revert
    }
  }

  if (isChecklist) {
    const done = steps?.filter((s) => s.done).length ?? 0
    const total = steps?.length ?? 0
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
          <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 2 }}>Checklist</div>
          <div className="muted" style={{ fontSize: 14, marginBottom: 14 }}>{goal.title} · {done}/{total} steps</div>
          {steps == null && <div className="muted tiny" style={{ fontWeight: 600 }}>Loading…</div>}
          {steps != null && steps.length === 0 && <div className="muted tiny" style={{ fontWeight: 600 }}>No steps yet — add some by editing this goal.</div>}
          <div className="log-steps">
            {steps?.map((s) => (
              <button key={s.id} type="button" className={`log-step-row ${s.done ? 'done' : ''}`} onClick={() => toggleStep(s)}>
                <span className="log-step-box">{s.done ? '✓' : ''}</span>
                <span className="log-step-label">{s.label}</span>
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-primary" onClick={onClose} style={{ width: '100%', justifyContent: 'center', marginTop: 18 }}>Done</button>
          {canDelete && (
            <button
              type="button"
              onClick={del}
              style={{ display: 'block', margin: '14px auto 0', border: 0, background: 'none', color: confirmDelete ? 'var(--primary)' : 'var(--ink-3)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
            >
              {confirmDelete ? 'Tap again to delete this goal' : 'Delete goal'}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 2 }}>Log progress</div>
        <div className="muted" style={{ fontSize: 14, marginBottom: 16 }}>{goal.title}</div>

        <form onSubmit={submit}>
          {isHabit ? (
            // Habit: no amount — one tap = one completion. Show the cadence so far.
            <>
              <div className="flabel">Consistency · {periodLabel}</div>
              <div className="log-habit">
                <span className="log-habit-prog">{goal.periodDone}{habitTarget ? ` / ${habitTarget}` : ''}</span>
                <span className="tiny muted" style={{ fontWeight: 600 }}>
                  {doneToday ? '✓ Already marked done today' : `times ${periodLabel}`}
                </span>
              </div>
            </>
          ) : isCount ? (
            // Whole-unit count: integer stepper, no fractions.
            <>
              <div className="flabel">How many?</div>
              <div className="log-stepper">
                <button type="button" className="log-step" aria-label="Less" disabled={amount <= 1} onClick={() => setAmount((a) => Math.max(1, Math.round(a) - 1))}>−</button>
                <span className="log-step-val">{Math.max(1, Math.round(amount))}{goal.unit ? ` ${goal.unit}` : ''}</span>
                <button type="button" className="log-step" aria-label="More" onClick={() => setAmount((a) => Math.round(a) + 1)}>＋</button>
              </div>
            </>
          ) : (
            // Total amount: quick chips + free entry (fractions allowed).
            <>
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
            </>
          )}

          {showWho && (
            <>
              <div className="flabel" style={{ marginTop: 16 }}>{whoLabel}</div>
              <div className="log-who">
                {!multi && (
                  <button type="button" className={`log-person ${who.includes(FAMILY) ? 'on' : ''}`} onClick={() => toggleWho(FAMILY)}>
                    <div className="av md" style={{ background: 'var(--panel)' }}>👪</div>
                    <span className="log-check" style={{ background: who.includes(FAMILY) ? 'var(--wally)' : '#fff', borderColor: who.includes(FAMILY) ? 'var(--wally)' : 'var(--hair)' }}>
                      {who.includes(FAMILY) ? '✓' : ''}
                    </span>
                    <span className="tiny" style={{ fontWeight: 700, color: 'var(--ink-2)' }}>Family</span>
                  </button>
                )}
                {pickable.map((p) => {
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
              {modeHint && (
                <div className="tiny muted" style={{ fontWeight: 600, marginTop: 8 }}>{modeHint}</div>
              )}
            </>
          )}

          <div className="flabel" style={{ marginTop: 16 }}>When?{loggedOn !== today && <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 600, color: 'var(--primary)' }}> · catching up</span>}</div>
          <input
            className="log-note"
            type="date"
            max={today}
            value={loggedOn}
            onChange={(e) => setLoggedOn(e.target.value || today)}
            aria-label="Date this happened"
          />

          <div className="flabel" style={{ marginTop: 16 }}>What did you do? <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 600, color: 'var(--ink-3)' }}>· optional</span></div>
          <input className="log-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Creek hike + fort building" />
          <div className="log-acts">
            {ACTIVITY_CHIPS.map((a) => (
              <button key={a} type="button" className="log-act" onClick={() => setNote(a.replace(/^\S+\s/, ''))}>{a}</button>
            ))}
          </div>

          <button type="submit" className="btn btn-primary" disabled={!logAmount || saving || blocked} style={{ width: '100%', justifyContent: 'center', marginTop: 18 }}>
            {saving
              ? 'Saving…'
              : isHabit
                ? blocked ? 'Done for today ✓' : loggedOn !== today ? '✓ Mark done' : '✓ Mark done for today'
                : `Log ${logAmount}${goal.unit ? ` ${goal.unit}` : ''}`}
          </button>
        </form>
        {canDelete && (
          <button
            type="button"
            onClick={del}
            style={{ display: 'block', margin: '14px auto 0', border: 0, background: 'none', color: confirmDelete ? 'var(--primary)' : 'var(--ink-3)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
          >
            {confirmDelete ? 'Tap again to delete this goal' : 'Delete goal'}
          </button>
        )}
      </div>
    </div>
  )
}
