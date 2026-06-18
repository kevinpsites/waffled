import { useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Icon } from './icons'
import { LogModal } from './components/LogModal'
import { ListModal } from './components/ListModal'
import { useGoalLists, useGoals, type Goal, type GoalList, type GoalListMember, type GoalParticipant } from '../lib/api'
import { CATEGORIES } from './categories'
import '../styles/goals.css'

const TYPE_LABEL: Record<string, string> = { count: 'Count', total: 'Total', habit: 'Habit', checklist: 'Checklist' }

function frac(progress: number, target: number | null): number {
  return target ? Math.min(progress / target, 1) : 0
}
// What a goal shows depends on its type: habits show completions THIS PERIOD vs
// the cadence (not a lifetime total), milestones show steps done, everything
// else shows the cumulative amount.
function dispProgress(g: Goal): number {
  if (g.goalType === 'habit') return g.periodDone
  if (g.goalType === 'checklist') return g.stepDone
  return g.totalProgress
}
function dispTarget(g: Goal): number | null {
  if (g.goalType === 'habit') return g.habitTargetPerPeriod ?? g.target
  if (g.goalType === 'checklist') return g.stepTotal || null
  return g.target
}
function fmtNum(n: number | null): string {
  return n == null ? '—' : n.toLocaleString('en-US')
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
      <div className="cn" style={{ color: '#fff' }}>
        {p.avatarEmoji ?? '🙂'} {firstName(p.name)}
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

// Featured goal, green pooled hero (shared_total).
function SharedHero({ goal, onLog, onOpen }: { goal: Goal; onLog: (g: Goal) => void; onOpen: () => void }) {
  const max = Math.max(1, ...goal.participants.map((p) => p.progress))
  return (
    <div className="challenge goal-hero" onClick={onOpen}>
      <div className="ch-row">
        <Ring value={frac(dispProgress(goal), dispTarget(goal))} px={130} stroke="#fff" track="rgba(255,255,255,.25)">
          <div>
            <div className="hero-ring-num">{fmtNum(dispProgress(goal))}</div>
            <div className="hero-ring-sub">
              {goal.goalType === 'habit' ? `${goal.habitPeriod === 'day' ? 'today' : `this ${goal.habitPeriod ?? 'week'}`}` : `of ${fmtNum(dispTarget(goal))}${goal.unit ? ` ${goal.unit}` : ''}`}
            </div>
          </div>
        </Ring>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span className="cat-pill hero-pill">⭐ Featured · shared total</span>
          <div className="nk-serif hero-title">{goal.title}</div>
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
    ...goal.participants.map((p) => `${firstName(p.name)} ${p.progress}`),
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="challenge goal-hero hero-each" onClick={onOpen}>
      <div className="ch-row">
        <div className="hero-emoji">{goal.emoji ?? '🎯'}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span className="cat-pill hero-pill">⭐ Featured · each tracks their own</span>
          <div className="nk-serif hero-title">{goal.title}</div>
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

function MoreGoalCard({ goal, onClick }: { goal: Goal; onClick: () => void }) {
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
  const [filter, setFilter] = useState<'all' | 'shared' | 'each'>('all')
  const [logging, setLogging] = useState<Goal | null>(null)
  const [creatingList, setCreatingList] = useState(false)
  const [editingList, setEditingList] = useState<GoalList | null>(null)

  const shared = lists.filter((l) => l.members.length !== 1)
  const individual = lists.filter((l) => l.members.length === 1)
  const selected = lists.find((l) => l.id === selectedId) ?? lists[0] ?? null
  const { goals, loading: goalsLoading, refetch } = useGoals(selected?.id ?? null)


  const isIndividual = (selected?.members.length ?? 0) === 1
  const visible = goals.filter(
    (g) => isIndividual || filter === 'all' || (filter === 'shared' ? g.trackingMode === 'shared_total' : g.trackingMode === 'each_tracks')
  )
  const featured = visible.find((g) => g.isFeatured) ?? null
  const more = visible.filter((g) => g !== featured)

  if (listsError) {
    return <div className="muted" style={{ padding: 30 }}>Sign this kiosk in to see goals.</div>
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
                className="nk-serif goal-listhead-t goal-listhead-link"
                onClick={() => navigate(`/person/${selected.members[0].personId}`)}
                title={`View ${selected.name}'s page`}
              >
                {selected.name}
              </button>
            ) : (
              <div className="nk-serif goal-listhead-t">{selected?.name ?? 'All goals'}</div>
            )}
            <div className="tiny muted" style={{ fontWeight: 600 }}>
              {selected ? `${selected.goalCount} goals · ${listSub(selected)}` : `${goals.length} goals`}
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
            {selected && !isIndividual && (
              <button type="button" className="pill" style={{ cursor: 'pointer' }} title="Edit group" onClick={() => setEditingList(selected)}>
                ✎ Edit group
              </button>
            )}
            <button type="button" className="pill btn-primary" onClick={() => navigate('/goals/new')}>
              <Icon name="plus" />
              <span>New goal</span>
            </button>
          </div>
        </div>

        {featured && <Hero goal={featured} onLog={setLogging} onOpen={() => navigate(`/goals/${featured.id}`)} />}

        {more.length > 0 && (
          <>
            <div className="flabel more-label">MORE {(selected?.name ?? '').toUpperCase()} GOALS</div>
            <div className="more-grid">
              {more.map((g) => (
                <MoreGoalCard key={g.id} goal={g} onClick={() => navigate(`/goals/${g.id}`)} />
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

      {logging && <LogModal goal={logging} onClose={() => setLogging(null)} onSaved={refetch} onDeleted={refetch} />}
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
