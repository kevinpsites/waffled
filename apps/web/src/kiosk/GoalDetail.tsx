import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useLocation } from 'react-router'
import { LogModal } from './components/LogModal'
import { EntryModal } from './components/EntryModal'
import { EventModal } from './components/EventModal'
import { ReviewList } from './components/GoalRecap'
import { useGoalDetail, useHousehold, can, api, fmtGoalNum, type GoalParticipant, type GoalMilestone, type GoalLogEntry } from '../lib/api'
import { useTopbarFull } from './topbar-slot'
import { CATEGORIES } from './categories'
import './../styles/goals.css'

const HOUR_UNITS = new Set(['hour', 'hours', 'hr', 'hrs'])
function pctOf(progress: number, target: number | null): number {
  return target ? Math.min(Math.round((progress / target) * 100), 100) : 0
}
const fmtNum = fmtGoalNum
// Shrink the ring's hero number so long/fractional values (e.g. a split-backfill
// "295.99" or "1,234") stay inside the inner circle instead of clipping the ring
// stroke. `base` is the CSS font-size for a short value.
function ringNumFont(s: string, base: number): number {
  const n = s.length
  const scale = n <= 4 ? 1 : n <= 5 ? 0.84 : n <= 6 ? 0.72 : n <= 8 ? 0.6 : 0.5
  return Math.round(base * scale)
}
function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short' })
}
function fmtMonthDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function Ring({ value, children }: { value: number; children: ReactNode }) {
  const C = 276.5
  const dash = (Math.min(Math.max(value, 0), 1) * C).toFixed(1)
  return (
    <div style={{ position: 'relative', width: 130, height: 130, flex: 'none' }}>
      <svg viewBox="0 0 100 100" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(255,255,255,.25)" strokeWidth="9" />
        <circle cx="50" cy="50" r="44" fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" strokeDasharray={`${dash} ${C}`} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>{children}</div>
    </div>
  )
}

function HoursRow({ p, max, unit }: { p: GoalParticipant; max: number; unit: string | null }) {
  const w = max ? Math.round((p.progress / max) * 100) : 0
  const color = p.colorHex ?? 'var(--person-1)'
  return (
    <div className="detail-hours-row">
      <div className="av sm" style={{ background: `${p.colorHex ?? '#A6A29B'}22` }}>{p.avatarEmoji ?? '🙂'}</div>
      <div className="detail-hours-name">{p.name}</div>
      <div className="detail-hours-bar">
        <div style={{ width: `${w}%`, background: color }} />
      </div>
      <div className="tiny muted detail-hours-val">
        {fmtNum(p.progress)}
        {unit ? ` ${unit}` : ''}
      </div>
    </div>
  )
}

export function GoalDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { goal, loading, error, refetch } = useGoalDetail(id ?? null)
  const { person } = useHousehold()
  // Edit/delete is open to goal.manage holders OR to the owner of a goal that's
  // theirs alone (sole participant). Logging your own progress stays open below.
  const canManageGoals = can(person, 'goal.manage')
  const isOwnSoloGoal =
    (goal?.participants?.length ?? 0) === 1 && goal?.participants[0]?.personId === person?.id
  const canEdit = canManageGoals || isOwnSoloGoal
  const [logging, setLogging] = useState(false)
  const [planning, setPlanning] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [editEntry, setEditEntry] = useState<GoalLogEntry | null>(null)
  // Optimistic checklist toggles: stepId -> intended done state. The checkbox
  // flips instantly (no wait for the round-trip) and rapid taps stay consistent;
  // each override is dropped once the server confirms it (or on error).
  const [pendingSteps, setPendingSteps] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (!goal) return
    setPendingSteps((prev) => {
      const next = { ...prev }
      let changed = false
      for (const s of goal.steps ?? []) {
        if (s.id in next && next[s.id] === s.done) {
          delete next[s.id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [goal])

  const logRef = useRef<() => void>(() => {})
  logRef.current = () => setLogging(true)
  const planRef = useRef<() => void>(() => {})
  planRef.current = () => setPlanning(true)

  // Back returns to wherever you came from (a person's profile, the goals hub,
  // etc.) rather than always the goals list. 'default' key = loaded straight
  // here (no in-app history), so fall back to the goals page.
  const backRef = useRef<() => void>(() => {})
  backRef.current = () => (location.key === 'default' ? navigate('/goals') : navigate(-1))
  const backLabel = location.key === 'default' ? '‹ Goals' : '‹ Back'

  // The log action reads differently per type — and checklists log by ticking
  // steps inline (in the Steps card below), so they get no top "log" button.
  // A habit already completed today shows a done, non-clickable button instead
  // of opening a modal you can't act in.
  const gType = goal?.goalType
  const gUnit = goal?.unit
  const habitDoneToday =
    gType === 'habit' && (goal?.participants.length ?? 0) > 0 &&
    (goal?.participants ?? []).every((p) => goal!.loggedTodayBy.includes(p.personId))
  const logLabel =
    gType === 'habit' ? (habitDoneToday ? 'Done for today ✓' : '✓ Mark done')
      : gType === 'count' ? `＋ Add${gUnit ? ` ${gUnit}` : ''}`
        : gUnit && HOUR_UNITS.has(gUnit.toLowerCase()) ? '＋ Log time'
          : '＋ Log progress'
  const showLog = gType !== 'checklist'
  // "Plan time" is only meaningful when the goal accepts calendar contributions
  // (so the scheduled event can actually count) — all four calendar types qualify.
  const canPlan =
    !!goal?.autoFromCalendar &&
    (gType === 'total' || gType === 'count' || gType === 'habit' || gType === 'checklist')
  const planLabel = gUnit && HOUR_UNITS.has(gUnit.toLowerCase()) ? '＋ Plan time' : '＋ Schedule'

  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button className="pill" style={{ cursor: 'pointer' }} onClick={() => backRef.current()}>{backLabel}</button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
          {canEdit && (
            <button className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate(`/goals/${id}/edit`)}>Edit goal</button>
          )}
          {canPlan && (
            <button className="pill" style={{ cursor: 'pointer' }} onClick={() => planRef.current()}>{planLabel}</button>
          )}
          {showLog && (
            <button
              className="pill btn-primary"
              disabled={habitDoneToday}
              style={{ color: 'var(--on-accent)', border: 0, cursor: habitDoneToday ? 'default' : 'pointer', opacity: habitDoneToday ? 0.6 : 1 }}
              onClick={() => { if (!habitDoneToday) logRef.current() }}
            >
              {logLabel}
            </button>
          )}
        </div>
      </div>
    ),
    [navigate, id, logLabel, showLog, backLabel, habitDoneToday, canPlan, planLabel, canEdit]
  )

  if (loading) return <div className="muted" style={{ padding: 30 }}>Loading…</div>
  if (error || !goal) return <div className="muted" style={{ padding: 30 }}>This goal isn’t available.</div>

  const c = goal.category ? CATEGORIES[goal.category] : null
  const max = Math.max(1, ...goal.participants.map((p) => p.progress))
  const firstUnreached = goal.milestones.findIndex((m) => !m.reached)
  const isHabit = goal.goalType === 'habit'
  const isChecklist = goal.goalType === 'checklist'
  // Merge optimistic toggles over the server step state so the UI reflects taps
  // immediately (counts, ring, and percent all use this).
  const stepState = (goal.steps ?? []).map((s) => ({ ...s, done: pendingSteps[s.id] ?? s.done }))
  const stepDone = stepState.filter((s) => s.done).length
  const stepTotal = stepState.length
  // Each type measures on its own axis (period for habits, steps for checklists).
  const dProg = isHabit ? goal.periodDone : isChecklist ? stepDone : goal.totalProgress
  // A per-person target ("read 12 EACH") makes the family ring target grow with the
  // household: 12 × members. A family-basis goal uses the flat target as stored.
  const ringTarget = goal.targetBasis === 'per_person' && goal.target != null
    ? goal.target * Math.max(1, goal.participants.length)
    : goal.target
  const dTarget = isHabit ? goal.habitTargetPerPeriod ?? goal.target : isChecklist ? stepTotal || null : ringTarget
  const dUnit = isHabit
    ? goal.habitPeriod === 'day' ? 'today' : goal.habitPeriod === 'month' ? 'this month' : 'this week'
    : isChecklist ? 'steps' : goal.unit ?? ''
  // The value a milestone threshold is compared against (matches the API's reached).
  const milestoneAxis = isHabit ? goal.streakDays : isChecklist ? (stepTotal ? (stepDone / stepTotal) * 100 : 0) : goal.totalProgress

  async function toggleStep(stepId: string, done: boolean) {
    setPendingSteps((prev) => ({ ...prev, [stepId]: done })) // flip instantly
    try {
      await api.toggleStep(goal!.id, stepId, done)
      refetch() // the reconcile effect clears the override once confirmed
    } catch {
      setPendingSteps((prev) => { const n = { ...prev }; delete n[stepId]; return n }) // revert
    }
  }

  async function del() {
    if (!confirmDel) {
      setConfirmDel(true)
      return
    }
    await api.deleteGoal(goal!.id)
    navigate('/goals')
  }

  return (
    <div className="goal-detail">
      {/* hero banner */}
      <div className="challenge detail-hero">
        <div className="detail-hero-row">
          <Ring value={pctOf(dProg, dTarget) / 100}>
            <div>
              <div className="hero-ring-num" style={{ fontSize: ringNumFont(fmtNum(dProg), 33) }}>{fmtNum(dProg)}</div>
              <div className="hero-ring-sub">{isHabit ? dUnit : `of ${fmtNum(dTarget)}${isChecklist ? ' steps' : goal.unit ? ` ${goal.unit}` : ''}`}</div>
            </div>
          </Ring>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span className="cat-pill hero-pill">{c ? `${c.emoji} ${c.label}` : '⭐ Featured'}</span>
            <div className="wf-serif detail-hero-title">{goal.title}</div>
            <div className="detail-hero-sub">
              Started {fmtMonthDay(goal.createdAt)} · {pctOf(dProg, dTarget)}% complete
              {goal.streakDays > 0 ? ` · 🔥 ${goal.streakDays}-day streak` : ''}
              {goal.deadline ? ` · by ${fmtMonthDay(goal.deadline)}` : ''}
            </div>
          </div>
          <div className="detail-week">
            <div className="detail-week-l">THIS WEEK</div>
            <div className="detail-week-n">
              {fmtNum(goal.thisWeek)}
              {goal.unit ? ` ${goal.unit}` : ''}
            </div>
          </div>
        </div>
      </div>

      <div className="detail-cols">
        <div className="detail-col">
          {isChecklist && (
            <div className="card detail-card">
              <div className="card-h" style={{ marginBottom: 12 }}>Steps · {stepDone}/{stepTotal}</div>
              {stepState.length === 0 && <div className="tiny muted" style={{ fontWeight: 600 }}>No steps yet — add some with “Edit goal”.</div>}
              <div className="log-steps">
                {stepState.map((s) => (
                  <button key={s.id} type="button" className={`log-step-row ${s.done ? 'done' : ''}`} onClick={() => toggleStep(s.id, !s.done)}>
                    <span className="log-step-box">{s.done ? '✓' : ''}</span>
                    <span className="log-step-label">{s.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {goal.milestones.length > 0 && (
            <div className="card detail-card">
              <div className="card-h" style={{ marginBottom: 18 }}>Milestones</div>
              <div className="mtrack">
                {goal.milestones.map((m: GoalMilestone, i: number) => {
                  const state = m.reached ? 'done' : i === firstUnreached ? 'now' : ''
                  const toGo = Math.max(0, m.threshold - milestoneAxis)
                  const toGoLabel = isHabit ? `${fmtNum(toGo)}-day streak to go` : isChecklist ? `${Math.ceil(toGo)}% to go` : `${fmtNum(toGo)} to go`
                  return (
                    <div key={m.id} className={`mnode ${state}`}>
                      <div className="mdot2">{m.emoji ?? '⛳'}</div>
                      <div className="ml">{m.label}</div>
                      <div className="mr">{m.reached ? 'reached' : i === firstUnreached ? toGoLabel : m.rewardText || '—'}</div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {goal.participants.length > 0 && (
            <div className="card detail-card">
              <div className="card-h" style={{ marginBottom: 12 }}>
                {goal.unit ? `${goal.unit[0].toUpperCase()}${goal.unit.slice(1)} by person` : 'By person'}
              </div>
              {goal.participants.map((p) => (
                <HoursRow key={p.personId} p={p} max={max} unit={goal.unit} />
              ))}
            </div>
          )}
        </div>

        <div className="detail-col">
          {goal.autoFromCalendar && <ReviewList goalId={goal.id} variant="inline" />}

          <div className="card detail-card">
            <div className="card-h" style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span>Recent activity</span>
              {canEdit && !isChecklist && goal.recent.length > 0 && <span className="tiny muted" style={{ fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>tap to edit</span>}
            </div>
            {goal.recent.length === 0 && <div className="tiny muted" style={{ fontWeight: 600, padding: '8px 0' }}>No activity yet — log some progress.</div>}
            {goal.recent.map((r: GoalLogEntry) => {
              const editable = canEdit && !isChecklist
              return (
              <div
                key={r.id}
                className="logrow"
                role={editable ? 'button' : undefined}
                tabIndex={editable ? 0 : undefined}
                onClick={editable ? () => setEditEntry(r) : undefined}
                style={editable ? { cursor: 'pointer' } : undefined}
              >
                <div className="lwhen">{fmtDay(r.loggedAt)}</div>
                {r.participants.length > 0 ? (
                  <div className="avstack">
                    {r.participants.map((p) => (
                      <div key={p.personId ?? p.name} className="av sm" style={{ background: `${p.colorHex ?? '#A6A29B'}22` }}>{p.avatarEmoji ?? '🙂'}</div>
                    ))}
                  </div>
                ) : (
                  <div className="av sm" style={{ background: '#A6A29B22' }}>🙂</div>
                )}
                <div className="lwhat">{r.note || 'Logged progress'}</div>
                <div className="lamt">
                  +{fmtNum(r.amount)}
                  {goal.unit ? ` ${goal.unit}` : ''}
                </div>
              </div>
              )
            })}
          </div>

          {canEdit && (
            <button
              type="button"
              onClick={del}
              style={{ alignSelf: 'flex-start', border: 0, background: 'none', color: confirmDel ? 'var(--primary)' : 'var(--ink-3)', fontSize: 13, fontWeight: 700, cursor: 'pointer', padding: '4px 2px' }}
            >
              {confirmDel ? 'Tap again to delete this goal' : 'Delete goal'}
            </button>
          )}
        </div>
      </div>

      {editEntry && <EntryModal goal={goal} entry={editEntry} onClose={() => setEditEntry(null)} onSaved={refetch} />}
      {logging && <LogModal goal={goal} canLogOthers={canManageGoals} selfPersonId={person?.id ?? null} canDelete={canEdit} onClose={() => setLogging(false)} onSaved={refetch} onDeleted={() => navigate('/goals')} />}
      {planning && (
        <EventModal
          prefill={{
            goalId: goal.id,
            participantIds: goal.participants.map((p) => p.personId),
          }}
          onClose={() => setPlanning(false)}
          onSaved={() => {
            setPlanning(false)
            refetch()
          }}
        />
      )}
    </div>
  )
}
