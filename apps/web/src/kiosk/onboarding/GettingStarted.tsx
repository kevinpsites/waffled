import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  personsApi,
  goalsApi,
  mealsApi,
  choresApi,
  calendarsApi,
  usePersons,
  useHousehold,
  emitHouseholdChanged,
  type Person,
  type CalendarStatus,
  type ChoreInstance,
  type Goal,
} from '../../lib/api'
import { PersonModal } from '../components/PersonModal'
import { ChoreModal } from '../components/ChoreModal'
import '../../styles/onboarding.css'

// Post-setup "Getting started" onboarding. Armed by the first-run wizard (the API
// sets households.settings.onboarding.status = 'active' at provision time); this
// renders a slim resumable checklist on Today plus an overlay wizard of 5 optional,
// skippable steps. Everything is derived from live data so the checklist self-heals
// — if the admin completed a step elsewhere, it shows done.
//
// Persistence is server-side (households.settings.onboarding), so onboarding follows
// the admin across devices instead of living in one browser's localStorage:
//   status  'active' | 'dismissed' (absent = inactive)
//   opened  true once the overlay has auto-opened (so a reload doesn't reopen it)
// Admin-only: the steps are admin actions and dismissal writes the household record.

type StepKey = 'family' | 'calendar' | 'chores' | 'goal' | 'recipes'

const STEPS: { key: StepKey; label: string; title: string; blurb: string }[] = [
  { key: 'family', label: 'Add your family', title: 'Add your family', blurb: 'Add the people who share this home so chores, goals, and meals can be theirs.' },
  { key: 'calendar', label: 'Connect calendar', title: 'Connect your calendar', blurb: "Pull your family's events onto Today and the agenda." },
  { key: 'chores', label: 'Set up a chore', title: 'Set up a chore', blurb: 'Create a recurring chore — assign it now or leave it up for grabs.' },
  { key: 'goal', label: 'Set a goal', title: 'Set a goal', blurb: 'Track a family habit or a shared number together.' },
  { key: 'recipes', label: 'Add a recipe', title: 'Add a recipe', blurb: 'Paste a recipe in Markdown, or just jot a name to start your library.' },
]

type Statuses = Record<StepKey, boolean>

const EMPTY_STATUSES: Statuses = { family: false, calendar: false, chores: false, goal: false, recipes: false }

// ── status loading ───────────────────────────────────────────────────────────
// Loads the 5 step statuses from live data. `overrides` lets a step mark itself
// done optimistically (e.g. just created a chore) before the next refetch lands.
function useOnboardingStatuses() {
  const [statuses, setStatuses] = useState<Statuses>(EMPTY_STATUSES)
  const [overrides, setOverrides] = useState<Partial<Statuses>>({})
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    const [persons, calendar, chores, goals, recipes] = await Promise.all([
      personsApi.persons().then((d) => d.persons).catch((): Person[] => []),
      calendarsApi.calendarStatus().catch((): CalendarStatus | null => null),
      choresApi.choresToday().then((d) => d.people).catch(() => []),
      goalsApi.goals().then((d) => d.goals).catch(() => []),
      mealsApi.recipes().then((d) => d.recipes).catch(() => []),
    ])
    setStatuses({
      family: persons.length > 1,
      // Only "done" once a Google account is actually linked — never auto-checked
      // just because the server lacks OAuth (the step still shows, with a note).
      calendar: calendar?.connected === true,
      chores: chores.some((p) => p.total > 0),
      goal: goals.length > 0,
      recipes: recipes.length > 0,
    })
    setLoaded(true)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const markDone = useCallback((key: StepKey) => setOverrides((o) => ({ ...o, [key]: true })), [])

  const merged: Statuses = { ...statuses, ...overrides }
  return { statuses: merged, loaded, refresh, markDone }
}

// ── step bodies ──────────────────────────────────────────────────────────────

function FamilyStep({ onChanged }: { onChanged: () => void }) {
  const [people, setPeople] = useState<Person[]>([])
  const [adding, setAdding] = useState(false)

  const load = useCallback(() => {
    personsApi.persons().then((d) => setPeople(d.persons)).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <div>
      {people.length === 0 ? (
        <div className="ob-empty">No one added yet.</div>
      ) : (
        <div className="ob-list">
          {people.map((p) => (
            <div className="ob-row" key={p.id}>
              <div className="ob-row-avatar" style={{ background: p.colorHex ?? 'var(--ink-3)' }}>{p.avatarEmoji ?? '🙂'}</div>
              <div className="ob-row-name">{p.name}</div>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="ob-btn" onClick={() => setAdding(true)}>+ Add a member</button>
      {adding && (
        <PersonModal
          person={null}
          onClose={() => setAdding(false)}
          onSaved={() => { load(); onChanged() }}
        />
      )}
    </div>
  )
}

function CalendarStep() {
  const [status, setStatus] = useState<CalendarStatus | null>(null)
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    calendarsApi.calendarStatus().then(setStatus).catch(() => setStatus(null))
  }, [])

  async function connect() {
    setConnecting(true)
    try {
      const { url } = await calendarsApi.connectCalendar(window.location.href)
      window.location.assign(url)
    } catch {
      setConnecting(false)
    }
  }

  if (!status) return <div className="ob-empty">Checking calendar status…</div>
  if (status.connected) return <div className="ob-connected">✓ Connected</div>
  if (!status.configured) {
    return <div className="ob-note">Google Calendar isn't set up on this server yet — you can add it later in Settings.</div>
  }
  return (
    <button type="button" className="ob-btn primary" disabled={connecting} onClick={connect}>
      {connecting ? 'Connecting…' : 'Connect Google Calendar'}
    </button>
  )
}

function ChoresStep({ onCreated }: { onCreated: () => void }) {
  const [adding, setAdding] = useState(false)
  const [chores, setChores] = useState<ChoreInstance[]>([])

  const load = useCallback(() => {
    choresApi.choreInstancesForDate().then((d) => setChores(d.instances)).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <div>
      {chores.length === 0 ? (
        <div className="ob-empty">No chores yet.</div>
      ) : (
        <div className="ob-list">
          {chores.map((c) => (
            <div className="ob-row" key={c.id}>
              <div className="ob-row-avatar" style={{ background: c.personColor ?? 'var(--ink-3)' }}>{c.emoji ?? '🧹'}</div>
              <div className="ob-row-name">
                {c.choreTitle}
                {c.personName && <span className="ob-row-sub"> · {c.personName}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="ob-btn" onClick={() => setAdding(true)}>+ Add a chore</button>
      {adding && (
        <ChoreModal
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load(); onCreated() }}
        />
      )}
    </div>
  )
}

const TRACKING_MODES: { key: string; label: string }[] = [
  { key: 'shared_total', label: 'Whole family together' },
  { key: 'each_tracks', label: 'Each person tracks their own' },
]
const GOAL_TYPES: { key: string; label: string }[] = [
  { key: 'habit', label: 'Habit' },
  { key: 'count', label: 'Count' },
  { key: 'total', label: 'Total' },
  { key: 'checklist', label: 'Checklist' },
]
const GOAL_TYPE_LABEL: Record<string, string> = { habit: 'Habit', count: 'Count', total: 'Total', checklist: 'Checklist' }

function GoalStep({ onCreated, onNavigateAway }: { onCreated: () => void; onNavigateAway: () => void }) {
  const navigate = useNavigate()
  const { persons } = usePersons()
  const [goals, setGoals] = useState<Goal[]>([])
  const [title, setTitle] = useState('')
  const [goalType, setGoalType] = useState('habit')
  const [target, setTarget] = useState('') // number for habit/count/total
  const [checklist, setChecklist] = useState('') // one item per line for checklist
  const [trackingMode, setTrackingMode] = useState('each_tracks')
  const [participantIds, setParticipantIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    goalsApi.goals().then((d) => setGoals(d.goals)).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  const toggleParticipant = (id: string) =>
    setParticipantIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))

  const items = checklist.split('\n').map((s) => s.trim()).filter(Boolean)
  const targetNum = Number(target)
  const targetValid = Number.isFinite(targetNum) && targetNum >= 1
  const canCreate =
    !!title.trim() && (goalType === 'checklist' ? items.length > 0 : targetValid)

  // A goal MUST belong to a goal list (group) — the full editor enforces this, but
  // the wizard used to skip it, creating orphaned goals that are invisible and
  // uneditable on the list-scoped Goals page. Resolve/create a list whose members
  // exactly match the chosen people, reusing one if it already exists so repeated
  // wizard goals don't spawn duplicate lists. Names it after the people.
  async function ensureGoalList(memberIds: string[]): Promise<string> {
    const key = (ids: string[]) => [...ids].sort().join(',')
    const { lists } = await goalsApi.goalLists()
    const match = lists.find((l) => key(l.members.map((m) => m.personId)) === key(memberIds))
    if (match) return match.id
    const names = memberIds.map((id) => persons.find((p) => p.id === id)?.name).filter(Boolean) as string[]
    const everyone = persons.length > 0 && memberIds.length === persons.length
    const name = everyone ? 'Family goals' : names.length === 1 ? names[0] : names.join(' & ') || 'Family goals'
    const emoji = everyone ? '👪' : names.length === 1 ? persons.find((p) => p.id === memberIds[0])?.avatarEmoji ?? '🎯' : '🎯'
    const { list } = await goalsApi.createGoalList({ name, emoji, memberIds, isPrivate: false })
    return list.id
  }

  async function submit() {
    if (!canCreate || saving) return
    setSaving(true)
    setErr(null)
    // "Everyone" (no individuals picked) means the whole family; otherwise the
    // chosen people. These become both the list members and the goal participants.
    const memberIds = participantIds.length > 0 ? participantIds : persons.map((p) => p.id)
    const base: Record<string, unknown> = { title: title.trim(), goalType, trackingMode, participantIds: memberIds }
    if (goalType === 'habit') { base.habitPeriod = 'week'; base.habitTargetPerPeriod = targetNum }
    else if (goalType === 'count' || goalType === 'total') { base.targetValue = targetNum }
    else if (goalType === 'checklist') { base.steps = items.map((label) => ({ label })) }
    try {
      base.goalListId = await ensureGoalList(memberIds)
      await goalsApi.createGoal(base)
      onCreated()
      load()
      setTitle(''); setTarget(''); setChecklist(''); setParticipantIds([])
    } catch {
      setErr('Could not create that goal — please try again.')
    } finally {
      setSaving(false)
    }
  }

  // The target field adapts to the chosen type; checklist collects line items instead.
  const targetLabel =
    goalType === 'habit' ? 'How many times per week?' : goalType === 'count' ? 'Target count' : 'Target total'
  const targetPlaceholder = goalType === 'habit' ? '5' : goalType === 'count' ? '10' : '100'

  return (
    <div>
      {goals.length > 0 && (
        <div className="ob-list">
          {goals.map((g) => (
            <div className="ob-row" key={g.id}>
              <div className="ob-row-avatar" style={{ background: 'var(--ink-3)' }}>{g.emoji ?? '🎯'}</div>
              <div className="ob-row-name">
                {g.title}
                <span className="ob-row-sub"> · {GOAL_TYPE_LABEL[g.goalType] ?? g.goalType}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <label className="ob-field">
        <span>Title</span>
        <input className="ob-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Read every day" autoFocus />
      </label>
      <div className="ob-field">
        <span>Type</span>
        <div className="ob-seg">
          {GOAL_TYPES.map((t) => (
            <button type="button" key={t.key} className={`ob-seg-btn${goalType === t.key ? ' on' : ''}`} onClick={() => setGoalType(t.key)}>{t.label}</button>
          ))}
        </div>
      </div>
      {goalType === 'checklist' ? (
        <label className="ob-field">
          <span>Checklist items (one per line)</span>
          <textarea className="ob-textarea" value={checklist} onChange={(e) => setChecklist(e.target.value)} placeholder={'Pack backpack\nBrush teeth\nMake bed'} rows={4} />
        </label>
      ) : (
        <label className="ob-field">
          <span>{targetLabel}</span>
          <input className="ob-input" type="number" min={1} value={target} onChange={(e) => setTarget(e.target.value)} placeholder={targetPlaceholder} />
        </label>
      )}
      <div className="ob-field">
        <span>Tracking</span>
        <div className="ob-seg">
          {TRACKING_MODES.map((t) => (
            <button type="button" key={t.key} className={`ob-seg-btn${trackingMode === t.key ? ' on' : ''}`} onClick={() => setTrackingMode(t.key)}>{t.label}</button>
          ))}
        </div>
      </div>
      <div className="ob-field">
        <span>Who's it for?</span>
        <div className="ob-seg">
          {/* "Everyone" is the default (empty participant list = a family goal); it's
              on whenever no individuals are picked, and picking it clears them. */}
          <button type="button" className={`ob-seg-btn${participantIds.length === 0 ? ' on' : ''}`} onClick={() => setParticipantIds([])}>👪 Everyone</button>
          {persons.map((p) => (
            <button type="button" key={p.id} className={`ob-seg-btn${participantIds.includes(p.id) ? ' on' : ''}`} onClick={() => toggleParticipant(p.id)}>
              {p.avatarEmoji ?? '🙂'} {p.name}
            </button>
          ))}
        </div>
        <div className="ob-hint">Tracked by the whole family, or pick specific people.</div>
      </div>
      {err && <div className="ob-err">{err}</div>}
      <button type="button" className="ob-btn primary" disabled={!canCreate || saving} onClick={submit}>
        {saving ? 'Creating…' : 'Create goal'}
      </button>
      <div className="ob-or">or</div>
      <button type="button" className="ob-btn" onClick={() => { onNavigateAway(); navigate('/goals/new') }}>Open the full goal editor →</button>
      <div className="ob-hint">For milestones, rewards, or a deadline, build it in the full editor.</div>
    </div>
  )
}

function RecipeStep({ onCreated, onNavigateAway }: { onCreated: () => void; onNavigateAway: () => void }) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Quick add: a title-only stub the family can flesh out later in Meals. The full
  // editor (with ingredients, steps, and Markdown paste) is one click away for
  // anyone who wants to add a complete recipe now.
  async function quickAdd() {
    if (!name.trim() || saving) return
    setSaving(true)
    setErr(null)
    try {
      await mealsApi.createRecipe({ title: name.trim() })
      setDone(true)
      onCreated()
    } catch {
      setErr('Could not add that recipe — please try again.')
    } finally {
      setSaving(false)
    }
  }

  function openFullEditor() {
    onNavigateAway()
    navigate('/meals/recipe/new')
  }

  if (done) return <div className="ob-saved">✓ Recipe added — open it in Meals to fill in the details.</div>

  return (
    <div>
      <label className="ob-field">
        <span>Quick add — just a name</span>
        <input className="ob-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Weeknight tacos" />
      </label>
      {err && <div className="ob-err">{err}</div>}
      <button type="button" className="ob-btn primary" disabled={saving || !name.trim()} onClick={quickAdd}>
        {saving ? 'Adding…' : 'Add recipe'}
      </button>
      <div className="ob-or">or</div>
      <button type="button" className="ob-btn" onClick={openFullEditor}>Open the full recipe editor →</button>
      <div className="ob-hint">Add ingredients, steps, and photos — or paste a recipe in Markdown there.</div>
    </div>
  )
}

// ── overlay wizard ───────────────────────────────────────────────────────────
function OverlayWizard({
  steps,
  statuses,
  initialStep,
  onChanged,
  onClose,
  onFinish,
}: {
  steps: typeof STEPS
  statuses: Statuses
  initialStep: number
  onChanged: (key: StepKey) => void
  onClose: () => void
  onFinish: () => void
}) {
  // Open where there's still work to do (e.g. Resume jumps to the first unfinished
  // step), not always back at step 1.
  const [i, setI] = useState(initialStep)
  const step = steps[Math.min(i, steps.length - 1)]
  const isLast = i >= steps.length - 1

  function next() {
    if (isLast) onFinish()
    else setI((n) => Math.min(n + 1, steps.length - 1))
  }
  function back() { setI((n) => Math.max(n - 1, 0)) }

  function body() {
    switch (step.key) {
      case 'family': return <FamilyStep onChanged={() => onChanged('family')} />
      case 'calendar': return <CalendarStep />
      case 'chores': return <ChoresStep onCreated={() => onChanged('chores')} />
      case 'goal': return <GoalStep onCreated={() => onChanged('goal')} onNavigateAway={onClose} />
      case 'recipes': return <RecipeStep onCreated={() => onChanged('recipes')} onNavigateAway={onClose} />
    }
  }

  return (
    <div className="ob-overlay" onClick={onClose}>
      <div className="ob-card" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="ob-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="ob-eyebrow">Getting started · Step {i + 1} of {steps.length}</div>
        <div className="ob-step-title wf-serif">{step.title}</div>
        <div className="ob-step-blurb">{step.blurb}</div>
        <div className="ob-body">{body()}</div>
        <div className="ob-footer">
          <div className="ob-dots">
            {steps.map((s, idx) => (
              <span key={s.key} className={`ob-dot${idx === i ? ' active' : ''}${statuses[s.key] ? ' done' : ''}`} />
            ))}
          </div>
          <div className="ob-nav">
            {i > 0 && <button type="button" className="ob-btn ghost" onClick={back}>Back</button>}
            {!isLast && <button type="button" className="ob-btn ghost" onClick={next}>Skip</button>}
            <button type="button" className="ob-btn primary" onClick={next}>
              {isLast ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── public bar + lifecycle host ──────────────────────────────────────────────
export function GettingStartedBar() {
  // Onboarding state is server-authoritative (households.settings.onboarding) and
  // admin-only. `dismissed` mirrors the dismiss locally so the bar disappears the
  // instant it's clicked, without waiting on the household refetch.
  const { household, person } = useHousehold()
  const onboarding = household?.settings?.onboarding ?? null
  const isAdmin = person?.isAdmin ?? false
  const [dismissed, setDismissed] = useState(false)
  const [overlayOpen, setOverlayOpen] = useState(false)
  const { statuses, loaded, refresh, markDone } = useOnboardingStatuses()
  // Guard so the one-time auto-open + its PATCH fire at most once per mount.
  const openedRef = useRef(false)

  const steps = STEPS
  const allDone = steps.every((s) => statuses[s.key])
  const active = isAdmin && onboarding?.status === 'active' && !dismissed

  // Auto-open the overlay the first time onboarding is active — once, tracked on the
  // household (settings.onboarding.opened) so a page reload doesn't reopen it.
  useEffect(() => {
    if (!active || onboarding?.opened || openedRef.current) return
    openedRef.current = true
    setOverlayOpen(true)
    personsApi.setOnboarding({ opened: true }).then(emitHouseholdChanged).catch(() => {})
  }, [active, onboarding?.opened])

  const dismiss = useCallback(() => {
    setDismissed(true)
    setOverlayOpen(false)
    personsApi.setOnboarding({ status: 'dismissed' }).then(emitHouseholdChanged).catch(() => {})
  }, [])

  // All five complete → quietly retire the onboarding for good.
  useEffect(() => {
    if (active && loaded && allDone) dismiss()
  }, [active, loaded, allDone, dismiss])

  if (!active) return null

  const doneCount = steps.filter((s) => statuses[s.key]).length

  return (
    <>
      <div className="ob-bar">
        <div className="ob-bar-main">
          <div className="ob-bar-title">Getting started</div>
          <div className="ob-bar-sub">{doneCount} of {steps.length} done — finish setting up your Waffled.</div>
          <div className="ob-bar-steps">
            {steps.map((s) => (
              <span key={s.key} className={`ob-chip${statuses[s.key] ? ' done' : ''}`}>
                <span className="ob-chip-mark">{statuses[s.key] ? '✓' : '○'}</span>
                {s.label}
              </span>
            ))}
          </div>
        </div>
        <div className="ob-bar-actions">
          <button type="button" className="ob-btn primary" onClick={() => setOverlayOpen(true)}>Resume</button>
          <button type="button" className="ob-bar-dismiss" aria-label="Dismiss" onClick={dismiss}>×</button>
        </div>
      </div>

      {overlayOpen && (
        <OverlayWizard
          steps={steps}
          statuses={statuses}
          initialStep={Math.max(0, steps.findIndex((s) => !statuses[s.key]))}
          onChanged={(key) => { markDone(key); void refresh() }}
          onClose={() => { setOverlayOpen(false); void refresh() }}
          onFinish={dismiss}
        />
      )}
    </>
  )
}
