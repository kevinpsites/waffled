import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useGoals, useGoalLists, useHousehold, usePersons, type Goal, type GoalList } from '../../lib/api'

// Today card: a chosen goal's progress — the web counterpart of the iOS Today goal card.
// A selector picks My spotlight (auto), Family spotlight (auto), or a specific pinned goal.
// Choice is a per-device preference; falls back gracefully if the pinned goal is gone.
const PICK_KEY = 'waffled.todayGoalPick'

function frac(g: Goal): number {
  const t = g.target ?? 0
  return t > 0 ? Math.min(g.totalProgress / t, 1) : 0
}
function fmtNum(n: number | null): string {
  return n == null ? '—' : n.toLocaleString('en-US')
}

// Resolve the goal to show for the current pick. `pick` is 'mine' | 'family' | a goal id.
function resolveGoal(goals: Goal[], pick: string, me: string | undefined, everyone: Set<string>): Goal | null {
  if (pick !== 'mine' && pick !== 'family') {
    const chosen = goals.find((g) => g.id === pick)
    if (chosen) return chosen
  }
  const mine = (g: Goal) => !!me && g.participants.length > 0 && new Set(g.participants.map((p) => p.personId)).size === 1 && g.participants[0].personId === me
  const family = (g: Goal) => everyone.size > 1 && everyone.size <= new Set(g.participants.map((p) => p.personId)).size && [...everyone].every((id) => g.participants.some((p) => p.personId === id))
  const spot = (g: Goal) => g.isSpotlight
  const feat = (g: Goal) => g.isFeatured
  const inScope = pick === 'family' ? family : mine
  return (
    goals.find((g) => inScope(g) && spot(g)) ??
    goals.find((g) => inScope(g) && feat(g)) ??
    goals.find(inScope) ??
    goals.find(spot) ??
    goals.find(feat) ??
    goals[0] ??
    null
  )
}

// Goals grouped by list (My goals first, then groups I'm in, then the rest) for the picker.
function groupGoals(goals: Goal[], lists: GoalList[], me: string | undefined): { key: string; label: string; goals: Goal[] }[] {
  const byId = new Map(lists.map((l) => [l.id, l]))
  const rank = (key: string): number => {
    if (key === '__none__') return 3
    const l = byId.get(key)
    if (!l) return 3
    const ids = new Set(l.members.map((m) => m.personId))
    if (me && ids.size === 1 && ids.has(me)) return 0
    if (me && ids.size > 1 && ids.has(me)) return 1
    return 2
  }
  const buckets = new Map<string, Goal[]>()
  for (const g of goals) {
    const k = g.goalListId ?? '__none__'
    ;(buckets.get(k) ?? buckets.set(k, []).get(k)!).push(g)
  }
  return [...buckets.keys()]
    .sort((a, b) => rank(a) - rank(b) || (byId.get(a)?.name ?? 'Other').localeCompare(byId.get(b)?.name ?? 'Other'))
    .map((key) => ({
      key,
      label: key === '__none__' ? 'Other goals' : rank(key) === 0 ? 'My goals' : byId.get(key)?.name ?? 'Goals',
      goals: buckets.get(key)!,
    }))
}

export function GoalSpotlightCard() {
  const navigate = useNavigate()
  const { goals, loading } = useGoals(null)
  const { lists } = useGoalLists()
  const { person } = useHousehold()
  const { persons } = usePersons()
  const me = person?.id
  const everyone = new Set(persons.map((p) => p.id))
  const [pick, setPick] = useState<string>(() => localStorage.getItem(PICK_KEY) || 'mine')
  const updatePick = (v: string) => {
    setPick(v)
    localStorage.setItem(PICK_KEY, v)
  }

  const g = resolveGoal(goals, pick, me, everyone)
  const tag = g?.isSpotlight ? '🌟 Spotlight' : g?.isFeatured ? '📌 Pinned' : 'Goal'
  const groups = groupGoals(goals, lists, me)

  return (
    <div className="card gs-card" style={{ padding: '22px 22px 18px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div className="card-h" style={{ fontSize: 23 }}>Goals</div>
        {goals.length > 1 && (
          <select className="sel gs-pick" value={pick} onChange={(e) => updatePick(e.target.value)} style={{ fontSize: 12, fontWeight: 700, padding: '3px 8px' }}>
            <option value="mine">My spotlight</option>
            <option value="family">Family spotlight</option>
            {groups.map((grp) => (
              <optgroup key={grp.key} label={grp.label}>
                {grp.goals.map((go) => (
                  <option key={go.id} value={go.id}>{go.emoji ? `${go.emoji} ` : ''}{go.title}</option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
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
            <span style={{ fontSize: 26, width: 52, height: 52, display: 'grid', placeItems: 'center', borderRadius: 15, background: 'var(--panel)', flex: 'none' }}>
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
