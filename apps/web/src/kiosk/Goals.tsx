import { useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Icon } from './icons'
import { LogModal } from './components/LogModal'
import { ListModal } from './components/ListModal'
import { api, useGoalLists, useGoals, useHousehold, can, goalDisplayProgress as dispProgress, goalDisplayTarget as dispTarget, fmtGoalNum, type Goal, type GoalList, type GoalListMember, type GoalParticipant } from '../lib/api'
import { CATEGORIES } from './categories'
import '../styles/goals.css'

const TYPE_LABEL: Record<string, string> = { count: 'Count', total: 'Total', habit: 'Habit', checklist: 'Checklist' }

function frac(progress: number, target: number | null): number {
  return target ? Math.min(progress / target, 1) : 0
}
// `dispProgress` / `dispTarget` (the type-aware, per-person-aware progress + target)
// are imported from lib/api so the goals list, goal detail, and the Today card all
// agree — see goalDisplayProgress / goalDisplayTarget there.
const fmtNum = fmtGoalNum
// Shrink the ring's hero number so long/fractional values (e.g. a split-backfill
// "295.99" or "1,234") stay inside the inner circle instead of clipping the ring
// stroke. `base` is the CSS font-size for a short value.
function ringNumFont(s: string, base: number): number {
  const n = s.length
  const scale = n <= 4 ? 1 : n <= 5 ? 0.84 : n <= 6 ? 0.72 : n <= 8 ? 0.6 : 0.5
  return Math.round(base * scale)
}
function fmtDeadline(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
function firstName(name: string): string {
  return name.split(' ')[0]
}

// "Habit · 5× a week", "Count · each logs visits", "Total · add up over time"
function descriptor(g: Goal): string {
  const label = TYPE_LABEL[g.goalType] ?? g.goalType
  let q: string
  if (g.goalType === 'habit') q = `${g.habitTargetPerPeriod ?? ''}× a ${g.habitPeriod ?? 'week'}`.trim()
  else if (g.goalType === 'checklist') q = `${g.stepTotal} step${g.stepTotal === 1 ? '' : 's'}`
  else if (g.trackingMode === 'each_tracks') q = `each logs ${g.unit ?? 'progress'}`
  else if (g.unit) q = `in ${g.unit}`
  else q = 'shared total'
  return `${label} · ${q}`
}
function barColor(g: Goal): string {
  return (g.category && CATEGORIES[g.category]?.color) || 'var(--primary)'
}

function listSub(list: GoalList): string {
  if (list.members.length === 1) return 'Personal'
  if (list.members.length === 2) return list.members.map((m) => firstName(m.name)).join(' & ')
  return `Everyone · ${list.members.length} people`
}

function AvStack({ members }: { members: GoalListMember[] }) {
  return (
    <div className="avstack">
      {members.slice(0, 4).map((m) => (
        <div key={m.personId} className="av sm" style={{ background: `${m.colorHex ?? '#A6A29B'}22` }}>
          {m.avatarEmoji ?? '🙂'}
        </div>
      ))}
    </div>
  )
}

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

function ContribRow({ p, max, unit }: { p: GoalParticipant; max: number; unit: string | null }) {
  const w = max ? Math.round((p.progress / max) * 100) : 0
  return (
    <div className="contrib-row">
      <div className="cn" style={{ color: 'var(--on-accent)' }}>
        {p.avatarEmoji ?? '🙂'} {firstName(p.name)}
      </div>
      <div className="cbar">
        <div style={{ width: `${w}%` }} />
      </div>
      <div className="cv" style={{ whiteSpace: 'nowrap', width: 'auto', minWidth: 56, paddingLeft: 8 }}>
        {fmtNum(p.progress)}
        {unit ? ` ${unit}` : ''}
      </div>
    </div>
  )
}

// Featured goal, green pooled hero (shared_total).
function SharedHero({ goal, onLog, onOpen }: { goal: Goal; onLog: (g: Goal) => void; onOpen: () => void }) {
  const max = Math.max(1, ...goal.participants.map((p) => p.progress))
  return (
    <div className="challenge goal-hero" onClick={onOpen}>
      <div className="ch-row">
        <Ring value={frac(dispProgress(goal), dispTarget(goal))} px={130} stroke="#fff" track="rgba(255,255,255,.25)">
          <div>
            <div className="hero-ring-num" style={{ fontSize: ringNumFont(fmtNum(dispProgress(goal)), 30) }}>{fmtNum(dispProgress(goal))}</div>
            <div className="hero-ring-sub">
              {goal.goalType === 'habit' ? `${goal.habitPeriod === 'day' ? 'today' : `this ${goal.habitPeriod ?? 'week'}`}` : `of ${fmtNum(dispTarget(goal))}${goal.unit ? ` ${goal.unit}` : ''}`}
            </div>
          </div>
        </Ring>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span className="cat-pill hero-pill">🌟 Spotlight · shared total</span>
          <div className="wf-serif hero-title">{goal.title}</div>
          <div className="hero-sub">Everyone contributes to one pool{goal.deadline ? ` · by ${fmtDeadline(goal.deadline)}` : ''}</div>
          {goal.participants.length > 0 && (
            <div className="hero-contribs">
              {goal.participants.map((p) => (
                <ContribRow key={p.personId} p={p} max={max} unit={goal.unit} />
              ))}
            </div>
          )}
        </div>
        <div className="ch-side">
          {goal.streakDays > 0 && <span className="streak-pill hero-streak">🔥 {goal.streakDays}-day streak</span>}
          <button
            className="btn hero-log"
            onClick={(e) => {
              e.stopPropagation()
              onLog(goal)
            }}
          >
            <Icon name="plus" />
            Log {goal.unit ?? 'progress'}
          </button>
        </div>
      </div>
    </div>
  )
}

// Featured goal, orange "each tracks their own" hero.
function EachHero({ goal, onOpen }: { goal: Goal; onOpen: () => void }) {
  const summedTarget = goal.participants.reduce((s, p) => s + (p.target ?? 0), 0) || goal.target || 0
  const sub = [
    goal.target ? `${fmtNum(goal.target)} ${goal.unit ?? ''} each`.trim() : null,
    goal.deadline ? `by ${fmtDeadline(goal.deadline)}` : null,
    ...goal.participants.map((p) => `${firstName(p.name)} ${fmtNum(p.progress)}`),
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="challenge goal-hero hero-each" onClick={onOpen}>
      <div className="ch-row">
        <div className="hero-emoji">{goal.emoji ?? '🎯'}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span className="cat-pill hero-pill">🌟 Spotlight · each tracks their own</span>
          <div className="wf-serif hero-title">{goal.title}</div>
          <div className="hero-sub">{sub}</div>
        </div>
        <div className="ch-side hero-each-side">
          <div className="hero-together-l">TOGETHER</div>
          <div className="hero-together-n">
            {fmtNum(goal.totalProgress)}/{fmtNum(summedTarget)}
          </div>
          <div className="hero-open">tap to open ›</div>
        </div>
      </div>
    </div>
  )
}

function Hero({ goal, onLog, onOpen }: { goal: Goal; onLog: (g: Goal) => void; onOpen: () => void }) {
  if (goal.trackingMode === 'each_tracks') return <EachHero goal={goal} onOpen={onOpen} />
  return <SharedHero goal={goal} onLog={onLog} onOpen={onOpen} />
}

// A small pin/unpin corner button, stopping propagation so it doesn't open the goal.
function PinButton({ goal, onPin }: { goal: Goal; onPin: () => void }) {
  const pinned = goal.isFeatured
  return (
    <button
      type="button"
      className={`goal-pin ${pinned ? 'on' : ''}`}
      title={pinned ? 'Unpin from top' : 'Pin to top'}
      aria-label={pinned ? 'Unpin from top' : 'Pin to top'}
      onClick={(e) => { e.stopPropagation(); onPin() }}
    >📌</button>
  )
}

function MoreGoalCard({ goal, onClick, onPin, canPin }: { goal: Goal; onClick: () => void; onPin?: () => void; canPin?: boolean }) {
  const c = goal.category ? CATEGORIES[goal.category] : null
  return (
    <div className="goal-card clickable more-goal" onClick={onClick}>
      <div className="gc-top">
        <div className="goal-emoji">{goal.emoji ?? c?.emoji ?? '🎯'}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="gc-t">{goal.title}</div>
          <div className="tiny muted goal-desc">{descriptor(goal)}</div>
        </div>
        <div className="goal-num">
          <span className="num">{fmtNum(dispProgress(goal))}</span>
          <span className="tiny muted">/{fmtNum(dispTarget(goal))}</span>
        </div>
        {canPin && onPin && <PinButton goal={goal} onPin={onPin} />}
      </div>
      <div className="gc-bar">
        <div style={{ width: `${(frac(dispProgress(goal), dispTarget(goal)) * 100).toFixed(0)}%`, background: barColor(goal) }} />
      </div>
    </div>
  )
}

// A Pinned card — a touch more prominent than a "More" row, with a Pinned tag. (Internally
// still the `is_featured` flag; "Pinned" is just the clearer user-facing name.)
function PinnedCard({ goal, onClick, onPin, canPin }: { goal: Goal; onClick: () => void; onPin?: () => void; canPin?: boolean }) {
  const c = goal.category ? CATEGORIES[goal.category] : null
  return (
    <div className="goal-card clickable more-goal featured-goal" onClick={onClick}>
      <div className="gc-top">
        <div className="goal-emoji">{goal.emoji ?? c?.emoji ?? '🎯'}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="gc-t">{goal.title} <span className="feat-tag">📌 Pinned</span></div>
          <div className="tiny muted goal-desc">{descriptor(goal)}</div>
        </div>
        <div className="goal-num">
          <span className="num">{fmtNum(dispProgress(goal))}</span>
          <span className="tiny muted">/{fmtNum(dispTarget(goal))}</span>
        </div>
        {canPin && onPin && <PinButton goal={goal} onPin={onPin} />}
      </div>
      <div className="gc-bar">
        <div style={{ width: `${(frac(dispProgress(goal), dispTarget(goal)) * 100).toFixed(0)}%`, background: barColor(goal) }} />
      </div>
    </div>
  )
}

function GlistItem({ list, on, onClick }: { list: GoalList; on: boolean; onClick: () => void }) {
  return (
    <div className={`glist ${on ? 'on' : ''}`} onClick={onClick}>
      <AvStack members={list.members} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="gl-t">{list.name}</div>
        <div className="gl-s">{listSub(list)}</div>
      </div>
      <div className="gl-n">{list.goalCount}</div>
    </div>
  )
}

// Goals home — the goal-lists membership model (matches "Home / Family list").
export function Goals() {
  const navigate = useNavigate()
  // The selected list lives in the URL (?list=<id>) so leaving for a goal and
  // coming back (browser back) keeps you on the same person/list, not the default.
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedId = searchParams.get('list')
  const selectList = (id: string) => setSearchParams({ list: id })
  const { lists, loading: listsLoading, error: listsError, refetch: refetchLists } = useGoalLists()
  const { person } = useHousehold()
  // Managing goals (attributing a log to others, editing/deleting a group list)
  // needs goal.manage; logging your own progress + creating a list stay open.
  const canManageGoals = can(person, 'goal.manage')
  const [filter, setFilter] = useState<'all' | 'shared' | 'each'>('all')
  const [logging, setLogging] = useState<Goal | null>(null)
  const [creatingList, setCreatingList] = useState(false)
  const [editingList, setEditingList] = useState<GoalList | null>(null)

  const shared = lists.filter((l) => l.members.length !== 1)
  const individual = lists.filter((l) => l.members.length === 1)
  const selected = lists.find((l) => l.id === selectedId) ?? lists[0] ?? null
  const { goals, loading: goalsLoading, refetch } = useGoals(selected?.id ?? null)


  // Pinning a goal is a lightweight edit — allowed for goal.manage holders, or the owner of
  // a solo goal. Quick toggle of the Pinned tier (isFeatured) straight from the card.
  const canEditGoal = (g: Goal) => canManageGoals || (g.participants.length === 1 && g.participants[0].personId === person?.id)
  const togglePin = async (g: Goal) => {
    try { await api.updateGoal(g.id, { isFeatured: !g.isFeatured }); refetch() } catch { /* leave as-is on failure */ }
  }

  const isIndividual = (selected?.members.length ?? 0) === 1
  const visible = goals.filter(
    (g) => isIndividual || filter === 'all' || (filter === 'shared' ? g.trackingMode === 'shared_total' : g.trackingMode === 'each_tracks')
  )
  // Three tiers (mirrors the API's derivation): the one Spotlight hero, the Pinned band,
  // then everything else as compact "More" rows. The API already returns goals A–Z, so the
  // Pinned and More bands are alphabetical (manual Pinned drag order is a roadmap item).
  // `isFeatured` is the internal flag behind the user-facing "Pinned" tier.
  const spotlight = visible.find((g) => g.isSpotlight) ?? null
  const pinned = visible.filter((g) => g.isFeatured && !g.isSpotlight)
  const more = visible.filter((g) => !g.isSpotlight && !g.isFeatured)
  // For an individual list, the visible goals ARE that person's, so the best
  // single-goal streak is a free at-a-glance "on a roll" cue. (Distinct from the
  // whole-person chore+goal streak on their profile — labeled as a goal streak.)
  const maxGoalStreak = isIndividual ? Math.max(0, ...visible.map((g) => g.streakDays)) : 0

  if (listsError) {
    return <div className="muted" style={{ padding: 30 }}>Couldn't load goals — try reloading or signing in again.</div>
  }

  return (
    <div className="goals-home">
      <div className="goal-listrail">
        {shared.length > 0 && <div className="flabel">SHARED LISTS</div>}
        {shared.map((l) => (
          <GlistItem key={l.id} list={l} on={l.id === selected?.id} onClick={() => selectList(l.id)} />
        ))}
        {individual.length > 0 && (
          <>
            <div className="rail-div" />
            <div className="flabel">INDIVIDUAL</div>
          </>
        )}
        {individual.map((l) => (
          <GlistItem key={l.id} list={l} on={l.id === selected?.id} onClick={() => selectList(l.id)} />
        ))}
        {!listsLoading && lists.length === 0 && (
          <div className="tiny muted" style={{ padding: '4px 8px', fontWeight: 600 }}>No goal lists yet.</div>
        )}
        <button type="button" className="btn btn-ghost rail-new-list" onClick={() => setCreatingList(true)}>
          <Icon name="plus" />
          New goal list
        </button>
      </div>

      <div className="goal-main">
        <div className="goal-listhead">
          {selected && <AvStack members={selected.members} />}
          <div>
            {isIndividual && selected ? (
              // An individual list IS a person — make the name open their profile.
              <button
                type="button"
                className="wf-serif goal-listhead-t goal-listhead-link"
                onClick={() => navigate(`/person/${selected.members[0].personId}`)}
                title={`View ${selected.name}'s page`}
              >
                {selected.name}
              </button>
            ) : (
              <div className="wf-serif goal-listhead-t">{selected?.name ?? 'All goals'}</div>
            )}
            <div className="tiny muted" style={{ fontWeight: 600 }}>
              {selected ? `${selected.goalCount} goals · ${listSub(selected)}` : `${goals.length} goals`}
              {maxGoalStreak >= 2 && <span title="Longest active goal streak"> · 🔥 {maxGoalStreak}-day goal streak</span>}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
            {/* All/Shared/Each only makes sense for multi-person lists */}
            {(selected?.members.length ?? 0) !== 1 && (
              <div className="seg">
                <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All</button>
                <button className={filter === 'shared' ? 'on' : ''} onClick={() => setFilter('shared')}>Shared</button>
                <button className={filter === 'each' ? 'on' : ''} onClick={() => setFilter('each')}>Each</button>
              </div>
            )}
            {/* "Edit group" only makes sense for multi-person lists — an
                individual isn't a group. */}
            {selected && !isIndividual && canManageGoals && (
              <button type="button" className="pill" style={{ cursor: 'pointer' }} title="Edit group" onClick={() => setEditingList(selected)}>
                ✎ Edit group
              </button>
            )}
            {/* Carry the list prefill only when the user can actually target it —
                goal.manage holders for any list, otherwise just their own self-only
                list. A kid viewing a shared group lands on a clean (self-pickable)
                create form instead of one that would 403 on submit. */}
            <button
              type="button"
              className="pill btn-primary"
              onClick={() => {
                const canTarget =
                  !!selected &&
                  (canManageGoals || (selected.members.length === 1 && selected.members[0].personId === person?.id))
                navigate(`/goals/new${canTarget ? `?list=${selected!.id}` : ''}`)
              }}
            >
              <Icon name="plus" />
              <span>New goal</span>
            </button>
          </div>
        </div>

        {spotlight && (
          <>
            <div className="flabel more-label">SPOTLIGHT</div>
            <Hero goal={spotlight} onLog={setLogging} onOpen={() => navigate(`/goals/${spotlight.id}`)} />
          </>
        )}

        {pinned.length > 0 && (
          <>
            <div className="flabel more-label">PINNED</div>
            <div className="more-grid">
              {pinned.map((g) => (
                <PinnedCard key={g.id} goal={g} onClick={() => navigate(`/goals/${g.id}`)} onPin={() => togglePin(g)} canPin={canEditGoal(g)} />
              ))}
            </div>
          </>
        )}

        {more.length > 0 && (
          <>
            <div className="flabel more-label">MORE {(selected?.name ?? '').toUpperCase()} GOALS <span className="tiny muted" style={{ fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>· A–Z</span></div>
            <div className="more-grid">
              {more.map((g) => (
                <MoreGoalCard key={g.id} goal={g} onClick={() => navigate(`/goals/${g.id}`)} onPin={() => togglePin(g)} canPin={canEditGoal(g)} />
              ))}
            </div>
          </>
        )}

        {!goalsLoading && visible.length === 0 && (
          <div className="muted" style={{ padding: '24px 2px', fontWeight: 600 }}>
            No goals here yet — add one with “New goal”.
          </div>
        )}
      </div>

      {logging && (
        <LogModal
          goal={logging}
          canLogOthers={canManageGoals}
          canDelete={canManageGoals || (logging.participants.length === 1 && logging.participants[0].personId === person?.id)}
          selfPersonId={person?.id ?? null}
          onClose={() => setLogging(null)}
          onSaved={refetch}
          onDeleted={refetch}
        />
      )}
      {creatingList && (
        <ListModal
          onClose={() => setCreatingList(false)}
          onCreated={(listId) => {
            refetchLists()
            selectList(listId)
          }}
        />
      )}
      {editingList && (
        <ListModal
          list={editingList}
          onClose={() => setEditingList(null)}
          onSaved={refetchLists}
        />
      )}
    </div>
  )
}
