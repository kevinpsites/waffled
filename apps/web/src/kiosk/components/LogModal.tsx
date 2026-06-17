import { useEffect, useState, type FormEvent } from 'react'
import { api, type Goal, type GoalStep } from '../../lib/api'

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
  onClose,
  onSaved,
  onDeleted,
}: {
  goal: Goal
  onClose: () => void
  onSaved: () => void
  onDeleted?: () => void
}) {
  const chips = quickChips(goal.unit)
  const isChecklist = goal.goalType === 'checklist'
  const isHabit = goal.goalType === 'habit'
  // "Check off" is a one-tap +1 on any goal that opted into it (habits are always
  // one-tap). Count is whole-unit (no fractions) → a stepper.
  const checkOff = !isHabit && !isChecklist && goal.logMethod === 'check_off'
  const oneTap = isHabit || checkOff
  const isCount = !oneTap && goal.goalType === 'count'
  const [amount, setAmount] = useState<number>(oneTap ? 1 : isCount ? 1 : chips[1]?.value ?? 1)
  const isShared = goal.trackingMode === 'shared_total'
  const divisible = goal.goalType === 'total'

  // Habit display: completions in the current period vs the cadence target.
  const period = goal.habitPeriod ?? 'week'
  const periodLabel = period === 'day' ? 'today' : period === 'month' ? 'this month' : 'this week'
  const habitTarget = goal.habitTargetPerPeriod ?? goal.target ?? 0
  // A daily habit already logged today can't be logged again (server enforces it too).
  const doneToday = isHabit && period === 'day' && goal.periodDone >= 1
  // Multi-select only makes sense when tapping several people changes the math
  // in a way we can represent cleanly: a divisible shared pool (split) or
  // each-tracks (full amount each). Whole-unit goals credit a single party.
  const multi = divisible || !isShared
  const [who, setWho] = useState<string[]>(
    goal.participants.length === 1 ? [goal.participants[0].personId] : multi ? [] : [FAMILY]
  )
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const toggleWho = (id: string) =>
    setWho((w) => (multi ? (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]) : [id]))

  // Divisible shared pool, more than one person tapped → preview the even split.
  const splitN = isShared && divisible ? who.length : 0
  const perEach = splitN > 1 ? Math.round((amount / splitN) * 100) / 100 : null

  // One-tap (habit / check-off) = 1; count = whole units; total = entered amount.
  const logAmount = oneTap ? 1 : isCount ? Math.max(1, Math.round(amount)) : Number(amount)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!logAmount || saving || doneToday) return
    setSaving(true)
    try {
      // "Family" is a shared (no-person) log; strip the sentinel before sending.
      const personIds = who.filter((id) => id !== FAMILY)
      await api.logGoal(goal.id, { amount: logAmount, personIds, note: note.trim() || null })
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
          <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 2 }}>Checklist</div>
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
          <button
            type="button"
            onClick={del}
            style={{ display: 'block', margin: '14px auto 0', border: 0, background: 'none', color: confirmDelete ? 'var(--primary)' : 'var(--ink-3)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
          >
            {confirmDelete ? 'Tap again to delete this goal' : 'Delete goal'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 2 }}>Log progress</div>
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
          ) : checkOff ? (
            // Check-off goal: a single tap counts as one. No amount to enter.
            <div className="log-habit">
              <span className="log-habit-prog">{goal.totalProgress.toLocaleString()}{goal.target ? ` / ${goal.target.toLocaleString()}` : ''}</span>
              <span className="tiny muted" style={{ fontWeight: 600 }}>so far{goal.unit ? ` · ${goal.unit}` : ''}</span>
            </div>
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

          {goal.participants.length > 0 && (
            <>
              <div className="flabel" style={{ marginTop: 16 }}>Who?{!multi && <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 600, color: 'var(--ink-3)' }}> · one</span>}</div>
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
                {goal.participants.map((p) => {
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
              {perEach != null && (
                <div className="tiny muted" style={{ fontWeight: 600, marginTop: 8 }}>
                  Shared together → {perEach}{goal.unit ? ` ${goal.unit}` : ''} each, {amount}{goal.unit ? ` ${goal.unit}` : ''} total.
                </div>
              )}
            </>
          )}

          <div className="flabel" style={{ marginTop: 16 }}>What did you do? <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 600, color: 'var(--ink-3)' }}>· optional</span></div>
          <input className="log-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Creek hike + fort building" />
          <div className="log-acts">
            {ACTIVITY_CHIPS.map((a) => (
              <button key={a} type="button" className="log-act" onClick={() => setNote(a.replace(/^\S+\s/, ''))}>{a}</button>
            ))}
          </div>

          <button type="submit" className="btn btn-primary" disabled={!logAmount || saving || doneToday} style={{ width: '100%', justifyContent: 'center', marginTop: 18 }}>
            {saving
              ? 'Saving…'
              : isHabit
                ? doneToday ? 'Done for today ✓' : '✓ Mark done for today'
                : checkOff
                  ? '✓ Mark done'
                  : `Log ${logAmount}${goal.unit ? ` ${goal.unit}` : ''}`}
          </button>
        </form>
        <button
          type="button"
          onClick={del}
          style={{ display: 'block', margin: '14px auto 0', border: 0, background: 'none', color: confirmDelete ? 'var(--primary)' : 'var(--ink-3)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
        >
          {confirmDelete ? 'Tap again to delete this goal' : 'Delete goal'}
        </button>
      </div>
    </div>
  )
}
