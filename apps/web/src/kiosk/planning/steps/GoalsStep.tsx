import { useEffect, useMemo, useState } from 'react'
import { AvatarStack } from '../../components/Avatar'
import {
  planningGoalsApi,
  planningGoalsDecision,
  useHousehold,
  can,
  goalDisplayProgress,
  goalDisplayTarget,
  goalFraction,
  fmtGoalNum,
  type PlanningGoalGroup,
  type PlanningGoalGoal,
  type PlanningGoalsView,
} from '../../../lib/api'
import { CATEGORIES } from '../../categories'
import { GoalCreate } from '../../GoalCreate'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import '../../../styles/planning-goals.css'

// Step 6 · Goals — "What's each group's focus this week?"
//
// The tabs ARE the `goal_lists` that already exist, so only ONE group is on screen at a
// time and a ★ says that group has settled.
//
// Picking a goal sets the goals module's own `is_featured` flag; there is no second
// "focus" concept. Picking NOTHING is a real answer and settles the group just the same
// — the server records that on the session, and this body mirrors it back through
// `setDecisionData` because pressing the primary REPLACES the step's data.
//
// "＋ New goal for this week" opens the app's own goal editor as a MODAL, never a route:
// navigating to /goals/new abandons the session. The group is fixed to the tab (so it
// cannot be answered for the wrong group) and the goal is created already pinned.

const TYPE_LABEL: Record<string, string> = { count: 'Count', total: 'Total', habit: 'Habit', checklist: 'Checklist' }

const firstName = (name: string) => name.split(' ')[0]

// Matches the shared helper's rule: a habit is this period's count, a checklist is steps,
// everything else the running total.
function axisLabel(g: PlanningGoalGoal): string {
  if (g.goalType === 'habit') return g.habitPeriod === 'day' ? 'today' : `this ${g.habitPeriod ?? 'week'}`
  if (g.goalType === 'checklist') return 'steps done'
  return g.unit ?? 'so far'
}

function goalColor(g: PlanningGoalGoal): string {
  return (g.category && CATEGORIES[g.category]?.color) || 'var(--primary)'
}

// Every clause is a fact the server sent, never a guess: a member with no birthday drops
// the age rather than inventing one.
function groupSub(g: PlanningGoalGroup): string {
  const n = g.members.length
  if (g.isPrivate) {
    if (n === 2) return 'private · just the two of you'
    if (n === 1) return 'private · just you'
    return `private · ${n} people`
  }
  if (n === 1) {
    const age = g.members[0]?.age
    return age != null ? `individual · age ${age}` : 'individual'
  }
  if (g.isEveryone) return 'shared · everyone tracks it'
  if (n === 2) return `shared · ${g.members.map((m) => firstName(m.name)).join(' & ')}`
  return `shared · ${n} people`
}

// Progress ALWAYS comes from the shared helpers, never an inline `totalProgress` (which
// shows a habit's lifetime count). The subtitle is `kind · pace`, in the server's words.
function GoalOption({ goal, checked, disabled, onPick }: {
  goal: PlanningGoalGoal
  checked: boolean
  disabled: boolean
  onPick: () => void
}) {
  const progress = goalDisplayProgress(goal)
  const target = goalDisplayTarget(goal)
  const kind = TYPE_LABEL[goal.goalType] ?? goal.goalType
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      className={`wpg-opt${checked ? ' on' : ''}`}
      onClick={onPick}
    >
      <span className="wpg-opt-e" aria-hidden>{goal.emoji ?? (goal.category ? CATEGORIES[goal.category]?.emoji : null) ?? '🎯'}</span>
      <span className="wpg-opt-main">
        <span className="wpg-opt-t">{goal.title}</span>
        <span className="wpg-opt-s">
          {kind}
          {goal.pace && (
            <>
              {' · '}
              <span className={`wpg-pace ${goal.pace.tone}`} data-tone={goal.pace.tone}>{goal.pace.text}</span>
            </>
          )}
        </span>
        <span className="wpg-opt-bar">
          <span style={{ width: `${(goalFraction(goal) * 100).toFixed(0)}%`, background: goalColor(goal) }} />
        </span>
      </span>
      <span className="wpg-opt-num">
        <span className="wpg-opt-n">{fmtGoalNum(progress)}</span>
        {target != null && <span className="wpg-opt-d">/ {fmtGoalNum(target)}</span>}
        <span className="wpg-opt-w">{axisLabel(goal)}</span>
      </span>
      <span className="wpg-opt-tick" aria-hidden>{checked ? '★' : ''}</span>
    </button>
  )
}

function Body({ sessionId, setDecisionData, refresh, busy }: StepBodyProps) {
  const { person } = useHousehold()
  const canManageGoals = can(person, 'goal.manage')
  const [view, setView] = useState<PlanningGoalsView | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [tabId, setTabId] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  // Holding the LIST ID, not the group object, keeps this right across a refetch that
  // replaces every group.
  const [newForId, setNewForId] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    planningGoalsApi.get(sessionId)
      .then((v) => { if (alive) { setView(v); setFailed(false); setLoading(false) } })
      .catch(() => { if (alive) { setFailed(true); setLoading(false) } })
    return () => { alive = false }
  }, [sessionId])

  // Mirror the session's own answers onto the crumb after EVERY read, not only after a
  // click: the shell resets the crumb on step change and replaces the step's data when
  // the primary is pressed, so a click-handler-only body erases its record on a remount.
  useEffect(() => { if (view) setDecisionData(planningGoalsDecision(view)) }, [view, setDecisionData])

  useEffect(() => {
    if (!view || tabId) return
    setTabId((view.groups.find((g) => !g.settled) ?? view.groups[0])?.listId ?? null)
  }, [view, tabId])

  const groups = view?.groups ?? []
  const active: PlanningGoalGroup | null = useMemo(
    () => groups.find((g) => g.listId === tabId) ?? groups[0] ?? null,
    [groups, tabId]
  )
  const settledCount = groups.filter((g) => g.settled).length

  async function pick(listId: string, goalId: string | null) {
    if (busy || saving) return
    setSaving(listId)
    try {
      setView(await planningGoalsApi.setFocus(sessionId, listId, goalId))
      refresh()
    } catch {
      /* leave the last good answer on screen rather than a half-applied one */
    } finally {
      setSaving(null)
    }
  }

  // The goals module's own rule: `goal.manage` holders for any group, everyone else only
  // a group that is just them. Offering the editor otherwise is show-then-403.
  const canTarget = (g: PlanningGoalGroup) =>
    canManageGoals || (g.members.length === 1 && g.members[0].personId === person?.id)

  // The new goal is created already pinned, so a re-read brings it back as the group's
  // focus (the server adopts a lone pin). Deliberately NOT a `setFocus` call: creating a
  // goal is not the family confirming it for the week.
  async function goalCreated() {
    setNewForId(null)
    try {
      setView(await planningGoalsApi.get(sessionId))
    } catch {
      /* keep the last good answer on screen; the goal itself was saved */
    }
    refresh()
  }

  // Esc closes the editor; clicking the scrim deliberately does NOT — it holds a
  // half-typed goal.
  useEffect(() => {
    if (!newForId) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNewForId(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newForId])

  if (loading) return <div className="wpg-note">Reading your goal groups…</div>
  if (failed) return <div className="wpg-note">Couldn’t read your goals — reload, or skip this step.</div>
  if (!groups.length) {
    return (
      <div className="wpg-note">
        There are no goal groups yet. Make one on the Goals screen and this step will have
        something to ask about — skipping is a real answer in the meantime.
      </div>
    )
  }

  const frozen = busy || saving !== null
  const focusGoal = active?.goals.find((g) => g.id === active.focusGoalId) ?? null

  return (
    <div className="wpg">
      <div className="wpg-tabs" role="tablist" aria-label="Goal groups">
        {groups.map((g) => (
          <button
            key={g.listId}
            type="button"
            role="tab"
            id={`wpg-tab-${g.listId}`}
            aria-selected={g.listId === active?.listId}
            aria-controls="wpg-panel"
            data-settled={g.settled ? 'true' : undefined}
            data-private={g.isPrivate ? 'true' : undefined}
            className={`wpg-tab${g.listId === active?.listId ? ' on' : ''}${g.settled ? ' settled' : ''}`}
            onClick={() => setTabId(g.listId)}
          >
            <span className="wpg-tab-e" aria-hidden>{g.emoji ?? '🎯'}</span>
            <span className="wpg-tab-n">{g.name}</span>
            {/* The lock is the list's own privacy showing through — the server never
                sent this tab to anyone outside the group in the first place. */}
            {g.isPrivate && <span className="wpg-tab-lock" title="Private to its members">🔒</span>}
            <span className="wpg-tab-star" aria-hidden>{g.settled ? '★' : ''}</span>
          </button>
        ))}
        <span className="wpg-tally">{settledCount} of {groups.length} settled</span>
      </div>

      {active && (
        <div className="wpg-card" id="wpg-panel" role="tabpanel" aria-labelledby={`wpg-tab-${active.listId}`}>
          <div className="wpg-card-h">
            <div className="wpg-card-tile" aria-hidden>{active.emoji ?? '🎯'}</div>
            <div className="wpg-card-id">
              <div className="wpg-card-n">
                {active.name}
                {active.isPrivate && <span className="wpg-card-lock" title="Private to its members">🔒</span>}
              </div>
              <div className="wpg-card-s">{groupSub(active)}</div>
            </div>
            <AvatarStack members={active.members} max={4} />
          </div>

          <div className="wpg-opts" role="radiogroup" aria-label={`${active.name}’s focus this week`}>
            {active.goals.map((g) => (
              <GoalOption
                key={g.id}
                goal={g}
                checked={active.focusGoalId === g.id}
                disabled={frozen}
                onPick={() => pick(active.listId, g.id)}
              />
            ))}
            {/* Not a "clear" button — an option, so choosing it is as much of an answer
                as choosing a goal, and the tab gets its ★ either way. */}
            <button
              type="button"
              role="radio"
              aria-checked={active.settled && active.focusGoalId === null}
              disabled={frozen}
              className={`wpg-opt wpg-none${active.settled && active.focusGoalId === null ? ' on' : ''}`}
              onClick={() => pick(active.listId, null)}
            >
              <span className="wpg-opt-e" aria-hidden>🤍</span>
              <span className="wpg-opt-main">
                <span className="wpg-opt-t">Nothing this week</span>
                <span className="wpg-opt-s">
                  {active.goals.length ? 'No goal needs the spotlight — leave the week clear.' : 'This group has no goals yet.'}
                </span>
              </span>
              <span className="wpg-opt-tick" aria-hidden>{active.settled && active.focusGoalId === null ? '★' : ''}</span>
            </button>
          </div>

          {/* Where the group stands, in one line, right above the escape hatch. Three
              states, because "already pinned" and "we decided" are not the same claim:
              a goal that arrives featured (from ＋ New goal for this week, or pinned on
              the goals screen) shows as the focus but still waits to be confirmed. */}
          <div className={`wpg-verdict${focusGoal && active.settled ? ' has' : ''}`}>
            {focusGoal
              ? active.settled
                ? <><span className="wpg-verdict-s" aria-hidden>★</span> This week · {focusGoal.title}</>
                : <>Pinned already · {focusGoal.title} — keep it, or pick another</>
              : 'No focus this week — that’s allowed'}
          </div>

          <button
            type="button"
            className="btn btn-ghost wpg-new"
            disabled={busy || !canTarget(active)}
            title={canTarget(active) ? undefined : `Adding a goal to ${active.name} needs permission to manage goals`}
            onClick={() => setNewForId(active.listId)}
          >
            ＋ New goal for this week
          </button>
        </div>
      )}

      {/* The app's real goal editor, over the week rather than instead of it. The group
          is fixed to the tab they were on and the goal is pinned on the way in. */}
      {newForId && (
        <div className="modal-overlay wpg-modal" data-testid="wpg-modal">
          <div className="modal-card wpg-modal-card" role="dialog" aria-modal="true" aria-label="New goal for this week">
            <button type="button" className="modal-close" aria-label="Close" onClick={() => setNewForId(null)}>×</button>
            <GoalCreate embed={{ listId: newForId, featured: true, onCreated: goalCreated }} />
          </div>
        </div>
      )}
    </div>
  )
}

const mod: PlanningStepModule = { Body }
export default mod
