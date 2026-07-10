import { useNavigate } from 'react-router'
import { useGoals, type Goal } from '../../lib/api'

// Today card: the household's Spotlight goal (falling back to a Pinned goal, then any) —
// the web counterpart of the iOS Today goal card. Taps into the goal; "See all" → Goals.
function pickGoal(goals: Goal[]): Goal | null {
  return goals.find((g) => g.isSpotlight) ?? goals.find((g) => g.isFeatured) ?? goals[0] ?? null
}
function frac(g: Goal): number {
  const t = g.target ?? 0
  return t > 0 ? Math.min(g.totalProgress / t, 1) : 0
}
function fmtNum(n: number | null): string {
  return n == null ? '—' : n.toLocaleString('en-US')
}

export function GoalSpotlightCard() {
  const navigate = useNavigate()
  const { goals, loading } = useGoals(null)
  const g = pickGoal(goals)
  const tag = g?.isSpotlight ? '🌟 Spotlight' : g?.isFeatured ? '📌 Pinned' : 'Goal'

  return (
    <div className="card gs-card" style={{ padding: '22px 22px 18px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
        <div className="card-h" style={{ fontSize: 23 }}>Goals</div>
        <button type="button" className="pill" style={{ marginLeft: 'auto', cursor: 'pointer' }} onClick={() => navigate('/goals')}>
          See all ›
        </button>
      </div>

      {g ? (
        <button
          type="button"
          onClick={() => navigate(`/goals/${g.id}`)}
          style={{ border: 0, background: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', width: '100%' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <span
              className="gs-emoji"
              style={{ fontSize: 26, width: 52, height: 52, display: 'grid', placeItems: 'center', borderRadius: 15, background: 'var(--panel)', flex: 'none' }}
            >
              {g.emoji ?? '🎯'}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="tiny" style={{ fontWeight: 800, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.03em' }}>{tag}</div>
              <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.12, marginTop: 2 }}>{g.title}</div>
            </div>
          </div>
          <div style={{ height: 9, borderRadius: 99, background: 'var(--panel)', overflow: 'hidden', marginTop: 16 }}>
            <div style={{ height: '100%', borderRadius: 99, background: 'var(--primary)', width: `${(frac(g) * 100).toFixed(0)}%` }} />
          </div>
          <div className="tiny" style={{ color: 'var(--ink-2)', fontWeight: 650, marginTop: 9 }}>
            {fmtNum(g.totalProgress)} of {fmtNum(g.target)} {g.unit ?? ''}
          </div>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => navigate('/goals')}
          className="tiny muted"
          style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', fontWeight: 600, textAlign: 'left' }}
        >
          {loading ? 'Loading…' : 'Set a family goal →'}
        </button>
      )}
    </div>
  )
}
