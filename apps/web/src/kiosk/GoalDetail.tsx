import { useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router'
import { LogModal } from './components/LogModal'
import { useGoalDetail, api, type GoalParticipant, type GoalMilestone, type GoalLogEntry } from '../lib/api'
import { useTopbarFull } from './topbar-slot'
import { CATEGORIES } from './categories'
import './../styles/goals.css'

function pctOf(progress: number, target: number | null): number {
  return target ? Math.min(Math.round((progress / target) * 100), 100) : 0
}
function fmtNum(n: number | null): string {
  return n == null ? '—' : n.toLocaleString('en-US')
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
  const color = p.colorHex ?? 'var(--kevin)'
  return (
    <div className="detail-hours-row">
      <div className="av sm" style={{ background: `${p.colorHex ?? '#A6A29B'}22` }}>{p.avatarEmoji ?? '🙂'}</div>
      <div className="detail-hours-name">{p.name}</div>
      <div className="detail-hours-bar">
        <div style={{ width: `${w}%`, background: color }} />
      </div>
      <div className="tiny muted detail-hours-val">
        {p.progress}
        {unit ? ` ${unit}` : ''}
      </div>
    </div>
  )
}

export function GoalDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { goal, loading, error, refetch } = useGoalDetail(id ?? null)
  const [logging, setLogging] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)

  const logRef = useRef<() => void>(() => {})
  logRef.current = () => setLogging(true)

  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate('/goals')}>‹ Goals</button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
          <button className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate(`/goals/${id}/edit`)}>Edit goal</button>
          <button className="pill btn-primary" style={{ color: '#fff', border: 0, cursor: 'pointer' }} onClick={() => logRef.current()}>
            ＋ Log time
          </button>
        </div>
      </div>
    ),
    [navigate, id]
  )

  if (loading) return <div className="muted" style={{ padding: 30 }}>Loading…</div>
  if (error || !goal) return <div className="muted" style={{ padding: 30 }}>This goal isn’t available.</div>

  const c = goal.category ? CATEGORIES[goal.category] : null
  const max = Math.max(1, ...goal.participants.map((p) => p.progress))
  const firstUnreached = goal.milestones.findIndex((m) => !m.reached)
  const isHabit = goal.goalType === 'habit'
  const isChecklist = goal.goalType === 'checklist'
  // Each type measures on its own axis (period for habits, steps for checklists).
  const dProg = isHabit ? goal.periodDone : isChecklist ? goal.stepDone : goal.totalProgress
  const dTarget = isHabit ? goal.habitTargetPerPeriod ?? goal.target : isChecklist ? goal.stepTotal || null : goal.target
  const dUnit = isHabit
    ? goal.habitPeriod === 'day' ? 'today' : goal.habitPeriod === 'month' ? 'this month' : 'this week'
    : isChecklist ? 'steps' : goal.unit ?? ''
  // The value a milestone threshold is compared against (matches the API's reached).
  const milestoneAxis = isHabit ? goal.streakDays : isChecklist ? (goal.stepTotal ? (goal.stepDone / goal.stepTotal) * 100 : 0) : goal.totalProgress

  async function toggleStep(stepId: string, done: boolean) {
    await api.toggleStep(goal!.id, stepId, done)
    refetch()
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
          <Ring value={pctOf(dProg, dTarget)}>
            <div>
              <div className="hero-ring-num" style={{ fontSize: 33 }}>{fmtNum(dProg)}</div>
              <div className="hero-ring-sub">{isHabit ? dUnit : `of ${fmtNum(dTarget)}${isChecklist ? ' steps' : goal.unit ? ` ${goal.unit}` : ''}`}</div>
            </div>
          </Ring>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span className="cat-pill hero-pill">{c ? `${c.emoji} ${c.label}` : '⭐ Featured'}</span>
            <div className="nk-serif detail-hero-title">{goal.title}</div>
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
              <div className="card-h" style={{ marginBottom: 12 }}>Steps · {goal.stepDone}/{goal.stepTotal}</div>
              {goal.steps.length === 0 && <div className="tiny muted" style={{ fontWeight: 600 }}>No steps yet — add some with “Edit goal”.</div>}
              <div className="log-steps">
                {goal.steps.map((s) => (
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
          <div className="card detail-card">
            <div className="card-h" style={{ marginBottom: 8 }}>Recent activity</div>
            {goal.recent.length === 0 && <div className="tiny muted" style={{ fontWeight: 600, padding: '8px 0' }}>No activity yet — log some progress.</div>}
            {goal.recent.map((r: GoalLogEntry) => (
              <div key={r.id} className="logrow">
                <div className="lwhen">{fmtDay(r.loggedAt)}</div>
                <div className="av sm" style={{ background: `${r.colorHex ?? '#A6A29B'}22` }}>{r.avatarEmoji ?? '🙂'}</div>
                <div className="lwhat">{r.note || 'Logged progress'}</div>
                <div className="lamt">
                  +{r.amount}
                  {goal.unit ? ` ${goal.unit}` : ''}
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={del}
            style={{ alignSelf: 'flex-start', border: 0, background: 'none', color: confirmDel ? 'var(--primary)' : 'var(--ink-3)', fontSize: 13, fontWeight: 700, cursor: 'pointer', padding: '4px 2px' }}
          >
            {confirmDel ? 'Tap again to delete this goal' : 'Delete goal'}
          </button>
        </div>
      </div>

      {logging && <LogModal goal={goal} onClose={() => setLogging(false)} onSaved={refetch} onDeleted={() => navigate('/goals')} />}
    </div>
  )
}
