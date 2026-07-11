import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useGoals, useGoalLists, useHousehold, usePersons, goalDisplayProgress, goalDisplayTarget, goalFraction, type Goal, type GoalList, type GoalListMember } from '../../lib/api'

// Today card: a chosen goal's progress — the web counterpart of the iOS Today goal card.
// A modal picker (grouped by goal list, like iOS) chooses My spotlight, Family spotlight,
// or a specific goal. Per-device preference; falls back gracefully if the goal is gone.
const PICK_KEY = 'waffled.todayGoalPick'

function fmtNum(n: number | null): string {
  return n == null ? '—' : n.toLocaleString('en-US')
}
// Type-aware progress line, matching the goals list + detail: a checklist counts
// steps, a habit counts this period vs its cadence, and a numeric goal shows the
// amount against its (per-person-aware) target — so the Today card never disagrees
// with the other surfaces.
function goalMeta(g: Goal): string {
  const p = fmtNum(goalDisplayProgress(g))
  const t = fmtNum(goalDisplayTarget(g))
  if (g.goalType === 'checklist') return `${p} of ${t} steps`
  if (g.goalType === 'habit') return `${p} of ${t} this ${g.habitPeriod ?? 'week'}`
  return `${p} of ${t}${g.unit ? ` ${g.unit}` : ''}`
}

function resolveGoal(goals: Goal[], pick: string, me: string | undefined, everyone: Set<string>): Goal | null {
  if (pick !== 'mine' && pick !== 'family') {
    const chosen = goals.find((g) => g.id === pick)
    if (chosen) return chosen
  }
  const mine = (g: Goal) => !!me && g.participants.length > 0 && new Set(g.participants.map((p) => p.personId)).size === 1 && g.participants[0].personId === me
  const family = (g: Goal) => everyone.size > 1 && [...everyone].every((id) => g.participants.some((p) => p.personId === id))
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

type Group = { key: string; label: string; members: GoalListMember[]; goals: Goal[] }
function groupGoals(goals: Goal[], lists: GoalList[], me: string | undefined): Group[] {
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
      members: byId.get(key)?.members ?? [],
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
  const [picking, setPicking] = useState(false)
  // Collapsible groups (like iOS). Default: only the first group (My goals) is open, so a
  // long list opens compact. An override flips a group.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  const toggleGroup = (k: string, cur: boolean) => setOpenGroups((prev) => ({ ...prev, [k]: !cur }))

  const grouped = groupGoals(goals, lists, me)
  const g = resolveGoal(goals, pick, me, everyone)
  const tag = g?.isSpotlight ? '🌟 Spotlight' : g?.isFeatured ? '📌 Pinned' : 'Goal'
  const pickLabel = pick === 'mine' ? 'My spotlight' : pick === 'family' ? 'Family spotlight' : goals.find((x) => x.id === pick)?.title ?? 'My spotlight'

  const choose = (v: string) => {
    setPick(v)
    localStorage.setItem(PICK_KEY, v)
    setPicking(false)
  }

  return (
    <div className="card gs-card" style={{ padding: '22px 22px 18px', display: 'flex', flexDirection: 'column' }}>
      <div className="gs-head">
        <div className="card-h" style={{ fontSize: 23 }}>Goals</div>
        {goals.length > 1 && (
          <button type="button" className="gs-pick-btn" onClick={() => setPicking(true)} title="Choose which goal to show">
            <span className="gs-pick-label">{pickLabel}</span>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
        )}
        <button type="button" className="pill gs-seeall" onClick={() => navigate('/goals')}>See all ›</button>
      </div>

      {g ? (
        <button type="button" onClick={() => navigate(`/goals/${g.id}`)} className="gs-goal-btn">
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <span style={{ fontSize: 26, width: 52, height: 52, display: 'grid', placeItems: 'center', borderRadius: 15, background: 'var(--panel)', flex: 'none' }}>{g.emoji ?? '🎯'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="tiny" style={{ fontWeight: 800, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.03em' }}>{tag}</div>
              <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.12, marginTop: 2 }}>{g.title}</div>
            </div>
          </div>
          <div style={{ height: 9, borderRadius: 99, background: 'var(--panel)', overflow: 'hidden', marginTop: 16 }}>
            <div style={{ height: '100%', borderRadius: 99, background: 'var(--primary)', width: `${(goalFraction(g) * 100).toFixed(0)}%` }} />
          </div>
          <div className="tiny" style={{ color: 'var(--ink-2)', fontWeight: 650, marginTop: 9 }}>{goalMeta(g)}</div>
        </button>
      ) : (
        <button type="button" onClick={() => navigate('/goals')} className="tiny muted" style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', fontWeight: 600, textAlign: 'left' }}>
          {loading ? 'Loading…' : 'Set a family goal →'}
        </button>
      )}

      {picking && (
        <div className="modal-overlay" onClick={() => setPicking(false)}>
          <div className="modal-card gs-modal" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="modal-close" aria-label="Close" onClick={() => setPicking(false)}>×</button>
            <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>Show on Today</div>
            <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 14 }}>Pick the goal this card follows.</div>
            <div className="gs-picklist">
              <PickRow emoji="✨" title="My spotlight" sub="Follows your spotlighted goal" on={pick === 'mine'} onClick={() => choose('mine')} />
              <PickRow emoji="👪" title="Family spotlight" sub="Follows the family's spotlight" on={pick === 'family'} onClick={() => choose('family')} />
              {grouped.map((grp, i) => {
                const open = openGroups[grp.key] ?? i === 0
                return (
                  <div key={grp.key} className="gs-group">
                    <button type="button" className="gs-group-h" onClick={() => toggleGroup(grp.key, open)} aria-expanded={open}>
                      <svg className={`gs-group-chev ${open ? 'open' : ''}`} viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 6 15 12 9 18" /></svg>
                      {grp.members.length > 0 && (
                        <span className="gs-group-avs">
                          {grp.members.slice(0, 4).map((m) => (
                            <span key={m.personId} className="gs-group-av">{m.avatarEmoji ?? '🙂'}</span>
                          ))}
                        </span>
                      )}
                      <span>{grp.label}</span>
                      <span className="gs-group-n">{grp.goals.length}</span>
                    </button>
                    {open && grp.goals.map((go) => (
                      <PickRow key={go.id} emoji={go.emoji ?? '🎯'} title={go.title} sub={goalMeta(go)} on={pick === go.id} onClick={() => choose(go.id)} />
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PickRow({ emoji, title, sub, on, onClick }: { emoji: string; title: string; sub: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`gs-pickrow ${on ? 'on' : ''}`} onClick={onClick}>
      <span className="gs-pickrow-emoji">{emoji}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="gs-pickrow-t">{title}</div>
        <div className="tiny muted" style={{ fontWeight: 600 }}>{sub}</div>
      </div>
      {on && <span className="gs-pickrow-check">✓</span>}
    </button>
  )
}
