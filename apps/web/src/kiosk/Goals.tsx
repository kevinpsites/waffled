import { useState } from 'react'
import { Icon } from './icons'
import { GoalModal } from './components/GoalModal'
import { LogModal } from './components/LogModal'
import { api, useGoals, type Goal } from '../lib/api'
import { CATEGORIES } from './categories'

function pct(progress: number, target: number | null): number {
  return target ? Math.min(progress / target, 1) : 0
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

function GoalCard({ goal, onLog, onDelete }: { goal: Goal; onLog: (g: Goal) => void; onDelete: (id: string) => void }) {
  const color = (goal.category && CATEGORIES[goal.category]?.color) || 'var(--kevin)'
  const eachTracks = goal.trackingMode === 'each_tracks'
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <div className="goal-card" style={{ gap: 12 }}>
      <div className="gc-top">
        <div style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--panel)', display: 'grid', placeItems: 'center', fontSize: 21, flex: 'none' }}>
          {goal.emoji ?? '🎯'}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="gc-t">{goal.title}</div>
          <div style={{ marginTop: 6 }}>
            <CatPill category={goal.category} />
          </div>
        </div>
        {!eachTracks && (
          <div style={{ textAlign: 'right', flex: 'none' }}>
            <span style={{ fontFamily: 'var(--serif)', fontSize: 23, fontWeight: 600 }}>{goal.totalProgress}</span>
            <span className="tiny muted" style={{ fontWeight: 700 }}>
              /{goal.target}
              {goal.unit ? ` ${goal.unit}` : ''}
            </span>
          </div>
        )}
      </div>

      {!eachTracks ? (
        <div className="gc-bar">
          <div style={{ width: `${(pct(goal.totalProgress, goal.target) * 100).toFixed(0)}%`, background: color }} />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {goal.participants.map((p) => (
            <div key={p.personId} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="av sm" style={{ background: `${p.colorHex ?? '#A6A29B'}22` }}>{p.avatarEmoji ?? '🙂'}</div>
              <div style={{ flex: 1 }}>
                <div className="gc-bar">
                  <div style={{ width: `${(pct(p.progress, p.target) * 100).toFixed(0)}%`, background: p.colorHex ?? color }} />
                </div>
              </div>
              <div className="tiny muted" style={{ fontWeight: 700, width: 64, textAlign: 'right' }}>
                {p.progress}/{p.target ?? '–'}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button className="btn btn-ghost" onClick={() => onLog(goal)} style={{ fontSize: 14, padding: '8px 16px' }}>
          <Icon name="plus" />
          Log
        </button>
        <button
          type="button"
          onClick={() => (confirmDelete ? onDelete(goal.id) : setConfirmDelete(true))}
          style={{ marginLeft: 'auto', border: 0, background: 'none', color: 'var(--ink-3)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
        >
          {confirmDelete ? 'Tap again to delete' : 'Delete'}
        </button>
      </div>
    </div>
  )
}

export function Goals() {
  const { goals, loading, error, refetch } = useGoals()
  const [creating, setCreating] = useState(false)
  const [logging, setLogging] = useState<Goal | null>(null)

  async function del(id: string) {
    await api.deleteGoal(id)
    refetch()
  }

  return (
    <div className="goals-page">
      <div className="goals-head">
        <div className="card-h nk-serif" style={{ fontSize: 20 }}>
          Goals
        </div>
        <button type="button" className="pill" style={{ marginLeft: 'auto', cursor: 'pointer' }} onClick={() => setCreating(true)}>
          <Icon name="plus" />
          <span>New goal</span>
        </button>
      </div>

      <div className="goals-grid">
        {loading && <div className="muted" style={{ padding: 20 }}>Loading…</div>}
        {error && <div className="muted" style={{ padding: 20 }}>Sign this kiosk in to see goals.</div>}
        {!loading && !error && goals.length === 0 && (
          <div className="muted" style={{ padding: 20 }}>No goals yet — add one with “New goal”.</div>
        )}
        {goals.map((g) => (
          <GoalCard key={g.id} goal={g} onLog={setLogging} onDelete={del} />
        ))}
      </div>

      {creating && <GoalModal onClose={() => setCreating(false)} onSaved={refetch} />}
      {logging && <LogModal goal={logging} onClose={() => setLogging(null)} onSaved={refetch} />}
    </div>
  )
}
