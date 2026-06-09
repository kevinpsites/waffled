import { useState, type ReactNode } from 'react'
import { Icon } from './icons'
import { GoalModal } from './components/GoalModal'
import { LogModal } from './components/LogModal'
import { useGoals, usePersons, type Goal, type GoalParticipant } from '../lib/api'
import { CATEGORIES } from './categories'

const TRACKING_LABEL: Record<string, string> = {
  shared_total: 'shared total',
  each_tracks: 'each tracks their own',
}

function frac(progress: number, target: number | null): number {
  return target ? Math.min(progress / target, 1) : 0
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function fmtDeadline(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function CatPill({ category }: { category: string | null }) {
  const c = category ? CATEGORIES[category] : null
  if (!c) return null
  return (
    <span className="cat-pill" style={{ background: c.tint, color: c.txt }}>
      {c.emoji} {c.label}
    </span>
  )
}

// SVG progress ring (matches the handoff `ring()` helper).
function Ring({ value, px, stroke, track, children }: { value: number; px: number; stroke: string; track: string; children: ReactNode }) {
  const C = 276.5
  const dash = (Math.min(Math.max(value, 0), 1) * C).toFixed(1)
  return (
    <div style={{ position: 'relative', width: px, height: px, flex: 'none' }}>
      <svg viewBox="0 0 100 100" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="50" cy="50" r="44" fill="none" stroke={track} strokeWidth="9" />
        <circle cx="50" cy="50" r="44" fill="none" stroke={stroke} strokeWidth="9" strokeLinecap="round" strokeDasharray={`${dash} ${C}`} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>{children}</div>
    </div>
  )
}

// One person's contribution bar inside the green challenge hero (white-on-green).
function ContribRow({ p, max, unit }: { p: GoalParticipant; max: number; unit: string | null }) {
  const w = max ? Math.round((p.progress / max) * 100) : 0
  return (
    <div className="contrib-row">
      <div className="cn" style={{ color: '#fff' }}>
        {p.avatarEmoji ?? '🙂'} {p.name}
      </div>
      <div className="cbar">
        <div style={{ width: `${w}%` }} />
      </div>
      <div className="cv" style={{ whiteSpace: 'nowrap', width: 'auto', minWidth: 56, paddingLeft: 8 }}>
        {p.progress}
        {unit ? ` ${unit}` : ''}
      </div>
    </div>
  )
}

// The featured goal, rendered big like the kitchen-display hero.
function ChallengeHero({ goal, onLog }: { goal: Goal; onLog: (g: Goal) => void }) {
  const maxContrib = Math.max(1, ...goal.participants.map((p) => p.progress))
  const sub =
    goal.trackingMode === 'shared_total'
      ? 'Everyone contributes to one pool'
      : 'Each person tracks their own'
  return (
    <div className="challenge">
      <div className="ch-row">
        <Ring value={frac(goal.totalProgress, goal.target)} px={120} stroke="#fff" track="rgba(255,255,255,.25)">
          <div>
            <div style={{ fontFamily: 'var(--serif)', fontSize: 30, fontWeight: 600, lineHeight: 1 }}>{goal.totalProgress}</div>
            <div style={{ fontSize: 10.5, opacity: 0.85, fontWeight: 700, marginTop: 2 }}>
              of {goal.target ?? '—'}
              {goal.unit ? ` ${goal.unit}` : ''}
            </div>
          </div>
        </Ring>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span className="cat-pill" style={{ background: 'rgba(255,255,255,.2)', color: '#fff' }}>
            ⭐ Featured · {TRACKING_LABEL[goal.trackingMode] ?? goal.trackingMode}
          </span>
          <div className="nk-serif" style={{ fontSize: 29, fontWeight: 600, margin: '9px 0 3px' }}>{goal.title}</div>
          <div style={{ fontSize: 13, opacity: 0.9, fontWeight: 600, marginBottom: 11 }}>
            {sub}
            {goal.deadline ? ` · by ${fmtDeadline(goal.deadline)}` : ''}
          </div>
          {goal.participants.length > 0 && (
            <div style={{ maxWidth: 400 }}>
              {goal.participants.map((p) => (
                <ContribRow key={p.personId} p={p} max={maxContrib} unit={goal.unit} />
              ))}
            </div>
          )}
        </div>
        <div className="ch-side">
          <button className="btn" style={{ background: '#fff', color: '#2f7d4f' }} onClick={() => onLog(goal)}>
            <Icon name="plus" />
            Log {goal.unit ?? 'progress'}
          </button>
        </div>
      </div>
    </div>
  )
}

// A family goal (shared or group): emoji tile + pooled progress bar.
function FamilyGoalCard({ goal, onClick }: { goal: Goal; onClick: (g: Goal) => void }) {
  const c = goal.category ? CATEGORIES[goal.category] : null
  const color = c?.color ?? 'var(--primary)'
  const sub = c?.label ?? cap(TRACKING_LABEL[goal.trackingMode] ?? goal.trackingMode)
  return (
    <div className="goal-card clickable" style={{ padding: '16px 18px', gap: 11 }} onClick={() => onClick(goal)}>
      <div className="gc-top">
        <div className="goal-emoji">{goal.emoji ?? c?.emoji ?? '🎯'}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="gc-t" style={{ fontSize: 16 }}>{goal.title}</div>
          <div className="tiny muted" style={{ marginTop: 2, fontWeight: 600 }}>{sub}</div>
        </div>
        <div style={{ textAlign: 'right', flex: 'none' }}>
          <span style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 600 }}>{goal.totalProgress}</span>
          <span className="tiny muted" style={{ fontWeight: 700 }}>/{goal.target ?? '—'}</span>
        </div>
      </div>
      <div className="gc-bar">
        <div style={{ width: `${(frac(goal.totalProgress, goal.target) * 100).toFixed(0)}%`, background: color }} />
      </div>
    </div>
  )
}

// A personal goal (one owner): their avatar + category pill + progress.
function PersonalGoalCard({ goal, onClick }: { goal: Goal; onClick: (g: Goal) => void }) {
  const c = goal.category ? CATEGORIES[goal.category] : null
  const color = c?.color ?? 'var(--kevin)'
  const owner = goal.participants[0]
  return (
    <div className="goal-card clickable" style={{ padding: '15px 16px', gap: 11 }} onClick={() => onClick(goal)}>
      <div className="gc-top">
        <div className="av sm" style={{ background: `${owner?.colorHex ?? '#A6A29B'}22` }}>{owner?.avatarEmoji ?? '🙂'}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="gc-t" style={{ fontSize: 15.5 }}>{goal.title}</div>
          <div style={{ marginTop: 6 }}>
            <CatPill category={goal.category} />
          </div>
        </div>
        <div style={{ textAlign: 'right', flex: 'none' }}>
          <span style={{ fontFamily: 'var(--serif)', fontSize: 23, fontWeight: 600 }}>{goal.totalProgress}</span>
          <span className="tiny muted" style={{ fontWeight: 700 }}>
            /{goal.target ?? '—'}
            {goal.unit ? ` ${goal.unit}` : ''}
          </span>
        </div>
      </div>
      <div className="gc-bar">
        <div style={{ width: `${(frac(goal.totalProgress, goal.target) * 100).toFixed(0)}%`, background: color }} />
      </div>
      {goal.deadline && (
        <div className="goal-meta">
          <span className="tiny muted" style={{ fontWeight: 600 }}>by {fmtDeadline(goal.deadline)}</span>
        </div>
      )}
    </div>
  )
}

// Goals home: FAMILY (featured hero + group cards) on the left, PERSONAL on the
// right, with a person filter. Tap any card (or the hero's Log button) to log.
export function Goals() {
  const { goals, loading, error, refetch } = useGoals()
  const { persons } = usePersons()
  const [filter, setFilter] = useState<string>('all')
  const [creating, setCreating] = useState(false)
  const [logging, setLogging] = useState<Goal | null>(null)

  const visible = filter === 'all' ? goals : goals.filter((g) => g.participants.some((p) => p.personId === filter))
  const featured = visible.find((g) => g.isFeatured) ?? null
  const rest = visible.filter((g) => g !== featured)
  const family = rest.filter((g) => g.participants.length !== 1)
  const personal = rest.filter((g) => g.participants.length === 1)

  return (
    <div className="goals-page">
      <div className="goals-head">
        <div className="card-h nk-serif" style={{ fontSize: 20 }}>Goals</div>
        {persons.length > 0 && (
          <div className="seg" style={{ marginLeft: 8 }}>
            <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
              Everyone
            </button>
            {persons.map((p) => (
              <button key={p.id} className={filter === p.id ? 'on' : ''} onClick={() => setFilter(p.id)}>
                {p.name}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="pill btn-primary"
          style={{ marginLeft: 'auto', color: '#fff', border: 0, cursor: 'pointer' }}
          onClick={() => setCreating(true)}
        >
          <Icon name="plus" />
          <span>New goal</span>
        </button>
      </div>

      {loading && <div className="muted" style={{ padding: '20px 30px' }}>Loading…</div>}
      {error && <div className="muted" style={{ padding: '20px 30px' }}>Sign this kiosk in to see goals.</div>}
      {!loading && !error && goals.length === 0 && (
        <div className="muted" style={{ padding: '20px 30px' }}>No goals yet — add one with “New goal”.</div>
      )}
      {!loading && !error && goals.length > 0 && visible.length === 0 && (
        <div className="muted" style={{ padding: '20px 30px' }}>No goals for this person yet.</div>
      )}

      {!loading && !error && visible.length > 0 && (
        <div className="goals-body">
          <div className="goals-col">
            <div className="goals-sublabel">FAMILY GOALS</div>
            {featured && <ChallengeHero goal={featured} onLog={setLogging} />}
            {family.length > 0 && (
              <div className="fam-grid">
                {family.map((g) => (
                  <FamilyGoalCard key={g.id} goal={g} onClick={setLogging} />
                ))}
              </div>
            )}
            {!featured && family.length === 0 && (
              <div className="muted tiny" style={{ padding: '2px 2px', fontWeight: 600 }}>
                No family goals yet — add one for everyone, or feature a goal to highlight it here.
              </div>
            )}
          </div>

          <div className="goals-col">
            <div className="goals-sublabel" style={{ display: 'flex', alignItems: 'center' }}>
              PERSONAL GOALS
              <span className="tiny muted" style={{ marginLeft: 'auto', fontWeight: 600, letterSpacing: 0 }}>
                {personal.length} active
              </span>
            </div>
            {personal.map((g) => (
              <PersonalGoalCard key={g.id} goal={g} onClick={setLogging} />
            ))}
            {personal.length === 0 && (
              <div className="muted tiny" style={{ padding: '2px 2px', fontWeight: 600 }}>No personal goals yet.</div>
            )}
          </div>
        </div>
      )}

      {creating && <GoalModal onClose={() => setCreating(false)} onSaved={refetch} />}
      {logging && <LogModal goal={logging} onClose={() => setLogging(null)} onSaved={refetch} onDeleted={refetch} />}
    </div>
  )
}
