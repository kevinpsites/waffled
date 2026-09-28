import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useTopbarFull } from './topbar-slot'
import { api, useGoalLists, useGoalDetail, useHousehold, can, type GoalList } from '../lib/api'
import { CATEGORIES, CATEGORY_KEYS } from './categories'
import { ListModal } from './components/ListModal'
import './../styles/goals.css'

// The measure type also tells us divisibility: "Total" splits evenly, "Count" is whole things.
const TYPES = [
  { key: 'total', emoji: '⏱️', title: 'Total amount', desc: 'Adds up — can split (hours, miles)' },
  { key: 'count', emoji: '🔢', title: 'Count', desc: 'Whole things (books, parks)' },
  { key: 'habit', emoji: '🔁', title: 'Habit', desc: 'Once a day, on a cadence' },
  { key: 'checklist', emoji: '🪜', title: 'Checklist', desc: 'Named steps you tick off' },
] as const

// How a goal is logged is derived from its type. "Auto-count from calendar" is a separate opt-in.
const CALENDAR_TYPES = new Set(['total', 'count', 'habit'])

// Group counting: this measure-aware follow-up sits BELOW the measure picker, only for a SHARED
// total/count goal with 2+ people. Each choice maps to (trackingMode, participantMode, targetBasis):
//   Each tracks their own      → each_tracks + per_person  (ring = target × members)
//   Shared · everyone's counts → each_tracks + family      (adds up: +2 hrs / +3)
//   Shared · split evenly      → shared_total + split
//   Shared · count once        → shared_total + count_once
const COUNT_RULES = {
  total: [
    { k: 'full', emoji: '👥', title: 'Everyone’s counts fully' },
    { k: 'split', emoji: '➗', title: 'Split across who took part' },
  ],
  count: [
    { k: 'each', emoji: '👥', title: 'Count it for each person' },
    { k: 'once', emoji: '✅', title: 'Count the activity once' },
  ],
} as const

const eachTracksOwn = { trackingMode: 'each_tracks', targetBasis: 'per_person', participantMode: 'count_once' } as const
function sharedDefault(goalType: string) {
  // total/count default to "everyone's counts" (adds up); habit/checklist have no sub-question.
  return goalType === 'total' || goalType === 'count'
    ? { trackingMode: 'each_tracks', targetBasis: 'family', participantMode: 'count_once' } as const
    : { trackingMode: 'shared_total', targetBasis: 'family', participantMode: 'count_once' } as const
}
function eachDefault(goalType: string) {
  return {
    trackingMode: 'each_tracks',
    targetBasis: goalType === 'total' || goalType === 'count' ? 'per_person' : 'family',
    participantMode: 'count_once',
  } as const
}
// Re-normalize the counting fields when the MEASURE changes: the split/each sub-choice is
// measure-specific, so a stale combo would submit fractional data on a whole-number goal.
export function measureCountingFields(
  prev: { goalType: string; trackingMode: string; targetBasis: string },
  nextType: string
) {
  const wasShared =
    prev.goalType === 'total' || prev.goalType === 'count'
      ? !(prev.trackingMode === 'each_tracks' && prev.targetBasis === 'per_person')
      : prev.trackingMode !== 'each_tracks'
  return wasShared ? sharedDefault(nextType) : eachDefault(nextType)
}
// Singular for a "1 <unit>" phrase so examples read "1 hour", not "1 hours".
const singular = (u: string) => (u.length > 1 && u.endsWith('s') ? u.slice(0, -1) : u)
function countChoiceFields(goalType: string, k: string) {
  if (goalType === 'total') {
    return k === 'full'
      ? { trackingMode: 'each_tracks', targetBasis: 'family', participantMode: 'count_once' } as const
      : { trackingMode: 'shared_total', targetBasis: 'family', participantMode: 'split' } as const
  }
  return k === 'each'
    ? { trackingMode: 'each_tracks', targetBasis: 'family', participantMode: 'count_once' } as const
    : { trackingMode: 'shared_total', targetBasis: 'family', participantMode: 'count_once' } as const
}

type Milestone = { threshold: number; emoji: string; label: string; rewardText: string }

// Auto-milestones DERIVED from the target: a quarter / half / three-quarters of the way. Reward
// text is left BLANK — a reward is never auto-filled.
function defaultMilestones(goalType: string, target: number): Milestone[] {
  const E = ['🌱', '⭐', '🏆']
  const mk = (vals: number[]) => vals.map((v, i) => ({ threshold: v, emoji: E[i] ?? '🎖️', label: String(v), rewardText: '' }))
  if (goalType === 'habit') return mk([7, 30, 100]) // streak length in days
  if (goalType === 'checklist') return mk([25, 50, 75]) // percent complete
  // total | count: 25% / 50% / 75% of the target, rounded to a tidy step.
  const t = Math.max(1, Math.round(target) || 0)
  const round = (v: number) => (t >= 40 ? Math.round(v / 5) * 5 : Math.round(v))
  return mk([0.25, 0.5, 0.75].map((f) => Math.max(1, round(t * f))))
}
const DEFAULT_MILESTONES: Milestone[] = defaultMilestones('total', 1000)

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      role="switch"
      aria-checked={on}
      style={{ width: 46, height: 28, borderRadius: 999, flex: 'none', cursor: 'pointer', background: on ? 'var(--person-3)' : 'var(--control-track)', position: 'relative', transition: 'background .18s' }}
    >
      <div style={{ position: 'absolute', top: 3, left: on ? 21 : 3, width: 22, height: 22, borderRadius: 999, background: 'var(--on-accent)', boxShadow: 'var(--sh-1)', transition: 'left .18s' }} />
    </div>
  )
}

function NumField({ value, step, onChange }: { value: number; step: number; onChange: (v: number) => void }) {
  const set = (v: number) => onChange(Math.max(0, v))
  return (
    <div className="ge-num">
      <input value={value} inputMode="numeric" onChange={(e) => set(parseInt(e.target.value, 10) || 0)} aria-label="target" />
      <div className="ge-num-steps">
        <button type="button" aria-label="increase" onClick={() => set(value + step)}>▲</button>
        <button type="button" aria-label="decrease" onClick={() => set(value - step)}>▼</button>
      </div>
    </div>
  )
}

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round"><path d="M4 12l5 5L20 6" /></svg>
)

  // Render the editor INSIDE something else — what Weekly Planning's Goals step does. Purely
  // additive: route behaviour is unchanged when `embed` is absent.
export interface GoalCreateEmbed {
  // The group the goal belongs to. Fixed, and shown rather than offered — the host already asked.
  listId: string
  // Start on the Pinned tier, the same thing `?featured=1` means on the route.
  featured?: boolean
  // Created and saved. No `onCancel` twin: embedded, "cancel" is the host's own control.
  onCreated: () => void
}

export function GoalCreate({ embed }: { embed?: GoalCreateEmbed } = {}) {
  const navigate = useNavigate()
  const { id } = useParams()
    // Embedded there is no route to read an id from, and the HOST's params must not leak in.
  const editing = !embed && !!id
  const { lists, refetch: refetchLists } = useGoalLists()
  const { goal: editGoal } = useGoalDetail(editing ? id ?? null : null)
  const { household, person } = useHousehold()
  // Without goal.manage you can still make a goal that's just yours, so the picker is limited to
  // lists where you're the sole member. Picking a group needs goal.manage, which 403s server-side.
  const canAssignOthers = can(person, 'goal.manage')
  const pickableLists = canAssignOthers
    ? lists
    : lists.filter((l) => l.members.length === 1 && l.members[0].personId === person?.id)
  // A suggestion tapped on a person profile pre-fills the title (?title=…).
  const [searchParams] = useSearchParams()

  const [form, setForm] = useState({
    // Embedded, the host's URL is not this editor's URL — its params must not leak in.
    title: editing || embed ? '' : (searchParams.get('title') ?? ''),
    // Pre-select the list you came from (?list=); falls to the picker otherwise.
    goalListId: embed ? embed.listId : editing ? '' : (searchParams.get('list') ?? ''),
    category: 'physical',
    // Default is "Each tracks their own" (per-person), so the ring and the toggle start consistent.
    trackingMode: 'each_tracks' as 'shared_total' | 'each_tracks',
    participantMode: 'count_once' as 'count_once' | 'split',
    targetBasis: 'per_person' as 'family' | 'per_person',
    goalType: 'total' as (typeof TYPES)[number]['key'],
    target: 1000,
    unit: 'hours',
    deadline: '',
    habitPeriod: 'week',
    habitPerPeriod: 5,
    // Auto-count from the calendar is ON by default — most numeric/habit goals benefit.
    autoFromCalendar: true,
    // Tier defaults to Normal. `?featured=1` is that choice made upstream by the Goals step.
    isFeatured: embed ? !!embed.featured : !editing && searchParams.get('featured') === '1',
    isSpotlight: false,
    hasRewards: false,
    weeklyCheckIn: true,
  })
  const [milestones, setMilestones] = useState<Milestone[]>(DEFAULT_MILESTONES)
  const [steps, setSteps] = useState<Array<{ id?: string; label: string }>>([{ label: '' }, { label: '' }, { label: '' }])
  const [listSpotlight, setListSpotlight] = useState<{ id: string; title: string } | null>(null)
  const [dlOpen, setDlOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showListModal, setShowListModal] = useState(false)
  // Once the user hand-edits a milestone we stop regenerating defaults from the target.
  const msTouched = useRef(false)
  // Once the user types a unit we stop auto-swapping it, or a Count goal inherits "hours".
  const unitTouched = useRef(false)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))
  // Switch measure: re-normalize the counting fields (see measureCountingFields) and fit the unit.
  const setMeasure = (key: (typeof TYPES)[number]['key']) =>
    setForm((f) => {
      const counting = measureCountingFields(f, key)
      const unit = unitTouched.current || (key !== 'total' && key !== 'count') ? f.unit : key === 'total' ? 'hours' : ''
      return { ...f, goalType: key, unit, ...counting }
    })

  const prefilled = useRef(false)
  useEffect(() => {
    if (!editing || prefilled.current || !editGoal) return
    prefilled.current = true
    unitTouched.current = true // keep the loaded goal's unit; don't auto-swap it
    setForm((f) => ({
      ...f,
      title: editGoal.title,
      goalListId: editGoal.goalListId ?? '',
      category: editGoal.category ?? 'physical',
      trackingMode: editGoal.trackingMode === 'each_tracks' ? 'each_tracks' : 'shared_total',
      participantMode: editGoal.participantMode === 'split' ? 'split' : 'count_once',
      targetBasis: editGoal.targetBasis === 'per_person' ? 'per_person' : 'family',
      goalType: (editGoal.goalType as (typeof TYPES)[number]['key']) ?? 'total',
      target: editGoal.target ?? 1,
      unit: editGoal.unit ?? '',
      deadline: editGoal.deadline ?? '',
      habitPeriod: editGoal.habitPeriod ?? 'week',
      habitPerPeriod: editGoal.habitTargetPerPeriod ?? 5,
      autoFromCalendar: editGoal.autoFromCalendar ?? false,
      isFeatured: editGoal.isFeatured,
      isSpotlight: editGoal.isSpotlight,
      hasRewards: editGoal.hasRewards,
    }))
    setDlOpen(!!editGoal.deadline)
    if (editGoal.milestones.length) {
      msTouched.current = true // keep the goal's saved milestones, don't regenerate
      setMilestones(editGoal.milestones.map((m) => ({ threshold: m.threshold, emoji: m.emoji ?? '⛳', label: m.label ?? String(m.threshold), rewardText: m.rewardText ?? '' })))
    }
    if (editGoal.steps?.length) {
      setSteps(editGoal.steps.map((s) => ({ id: s.id, label: s.label })))
    }
  }, [editing, editGoal])

  // The selected list's current spotlight, so the Spotlight option can say what it replaces.
  useEffect(() => {
    if (!form.goalListId) { setListSpotlight(null); return }
    let live = true
    api.goals(form.goalListId).then((r) => {
      if (!live) return
      const s = r.goals.find((g) => g.isSpotlight && g.id !== id)
      setListSpotlight(s ? { id: s.id, title: s.title } : null)
    }).catch(() => { if (live) setListSpotlight(null) })
    return () => { live = false }
  }, [form.goalListId, id])

  // Regenerate the default milestones from type + target until the user hand-edits them.
  useEffect(() => {
    if (msTouched.current) return
    setMilestones(defaultMilestones(form.goalType, form.target))
  }, [form.goalType, form.target])

  // Editing is gated exactly like GoalDetail. GoalDetail hides its Edit button, but
  // /goals/:id/edit is deep-linkable — so without this a kid reaches a "Save changes" that 403s.
  const editBlocked =
    editing && !!editGoal && !canAssignOthers &&
    !(editGoal.participants.length === 1 && editGoal.participants[0].personId === person?.id)
  useEffect(() => {
    if (editBlocked) navigate(`/goals/${id}`, { replace: true })
  }, [editBlocked, id, navigate])

  // Creating: without goal.manage you can only target a self-only list, so a prefilled
  // ?list=<group> is neutralized and Create never enables on a target that would 403.
  //
  // `!household` is the load-order gate, and it is load-bearing: lists and household are two
  // independent fetches, so until the household answers a capable viewer looks capability-less.
  useEffect(() => {
    if (editing || !household || canAssignOthers || !form.goalListId || lists.length === 0) return
    const l = lists.find((x) => x.id === form.goalListId)
    const selfOnly = !!l && l.members.length === 1 && l.members[0].personId === person?.id
    if (!selfOnly) setForm((f) => ({ ...f, goalListId: '' }))
  }, [editing, household, canAssignOthers, form.goalListId, lists, person?.id])

  const selectedList = useMemo(() => lists.find((l) => l.id === form.goalListId) ?? null, [lists, form.goalListId])

  // A goal needs a name, a person, and its type's measurement filled in. The deadline is optional.
  const participantCount = selectedList ? selectedList.members.length : editing ? editGoal?.participants.length ?? 0 : 0
  const stepCount = steps.filter((s) => s.label.trim()).length
  const isChecklist = form.goalType === 'checklist'
  const typeValid =
    isChecklist ? stepCount >= 1
      : form.goalType === 'habit' ? form.habitPerPeriod > 0
        : Number(form.target) > 0 && form.unit.trim().length > 0 // total | count
  const canSave = form.title.trim().length > 0 && participantCount >= 1 && typeValid && !saving && !editBlocked

  // Return to the list you came from. After CREATE we return to the goal's final list (see submit).
  const cameFromList = searchParams.get('list') ?? ''
  const backToGoals = editing ? `/goals/${id}` : `/goals${cameFromList ? `?list=${cameFromList}` : ''}`

  const submitRef = useRef<() => void>(() => {})
  // Embedded, the bar is the modal's header and drops Cancel — that route isn't the modal's.
  const bar = (
    <div className="ge-topbar">
      <div className="ge-title">{editing ? 'Edit goal' : 'New goal'}</div>
      <div className="ge-sp" />
      {!embed && (
        <button type="button" className="ge-cancel" onClick={() => navigate(backToGoals, { replace: true })}>Cancel</button>
      )}
      <button
        type="button"
        className="ge-create"
        disabled={!canSave}
        title={canSave ? undefined : 'Add a name, pick who it’s for, and fill in the measurement'}
        onClick={() => submitRef.current()}
      >
        {editing ? 'Save changes' : 'Create goal'}
      </button>
    </div>
  )
  // Never when embedded: the host owns its own chrome.
  useTopbarFull(() => (embed ? null : bar), [navigate, editing, canSave, backToGoals, embed])

  async function submit() {
    if (!canSave) return
    setSaving(true)
    const participantIds = selectedList ? selectedList.members.map((m) => m.personId) : editGoal?.participants.map((p) => p.personId) ?? []
    const payload = {
      title: form.title.trim(),
      goalListId: form.goalListId || null,
      category: form.category,
      goalType: form.goalType,
      unit: form.goalType === 'habit' || isChecklist ? null : form.unit.trim() || null,
      targetValue: form.goalType === 'habit' ? form.habitPerPeriod : isChecklist ? null : Number(form.target) || null,
      habitPeriod: form.goalType === 'habit' ? form.habitPeriod : null,
      habitTargetPerPeriod: form.goalType === 'habit' ? form.habitPerPeriod : null,
      trackingMode: form.trackingMode,
      participantMode: form.participantMode,
      targetBasis: form.targetBasis,
      // Logging style is derived from the type; calendar auto-count is an independent opt-in.
      autoFromCalendar: isChecklist ? false : form.autoFromCalendar,
      deadline: form.deadline || null,
      isFeatured: form.isFeatured,
      isSpotlight: form.isSpotlight,
      hasRewards: form.hasRewards,
      participantIds,
      milestones: form.hasRewards
        ? milestones.map((m) => ({ threshold: Number(m.threshold) || 0, emoji: m.emoji, label: m.label || `${m.threshold}${form.unit ? ` ${form.unit}` : ''}`, rewardText: m.rewardText }))
        : [],
      // Checklist steps (with ids when editing so completion is preserved).
      ...(isChecklist
        ? { steps: steps.filter((s) => s.label.trim()).map((s) => ({ id: s.id, label: s.label.trim() })) }
        : {}),
    }
    try {
      if (editing) await api.updateGoal(id!, payload)
      else await api.createGoal(payload)
      // Embedded, going anywhere is the bug: the host owns the page this sits over.
      if (embed) { embed.onCreated(); return }
      // Land on the goal's FINAL list — if they retargeted it, that's where the goal now lives.
      navigate(editing ? `/goals/${id}` : `/goals${form.goalListId ? `?list=${form.goalListId}` : ''}`, { replace: true })
    } catch {
      setSaving(false)
    }
  }
  submitRef.current = submit

  const setMs = (i: number, patch: Partial<Milestone>) => { msTouched.current = true; setMilestones((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m))) }

  // ── live-preview helpers ─────────────────────────────────────────────────
  const previewName = form.title.trim() || 'Your goal'
  const unit = (form.unit || '').trim()

  // DERIVED from the backend fields, so an edited goal lights up the right rows.
  const shareValue: 'shared' | 'each' =
    form.goalType === 'total' || form.goalType === 'count'
      ? (form.trackingMode === 'each_tracks' && form.targetBasis === 'per_person' ? 'each' : 'shared')
      : (form.trackingMode === 'each_tracks' ? 'each' : 'shared')
  const shared = shareValue === 'shared'

  const tier: 'spotlight' | 'featured' | 'normal' = form.isSpotlight ? 'spotlight' : form.isFeatured ? 'featured' : 'normal'
  const setTier = (t: 'spotlight' | 'featured' | 'normal') =>
    setForm((f) => ({ ...f, isSpotlight: t === 'spotlight', isFeatured: t === 'featured' }))
  const tierHint =
    tier === 'spotlight' ? 'The one big hero card for this list — only one goal can be the spotlight.'
      : tier === 'featured' ? 'Pinned to the top of the goals list, above the rest.'
        : 'Lives in the goals list with everything else.'
  const countChoice: string | null =
    form.goalType === 'total' ? (form.trackingMode === 'each_tracks' ? 'full' : 'split')
      : form.goalType === 'count' ? (form.trackingMode === 'each_tracks' ? 'each' : 'once')
        : null

  // A concrete "worked example" using the real members' first names + unit.
  const memberNames = (selectedList?.members ?? editGoal?.participants ?? [])
    .map((m) => (m.name ?? '').split(' ')[0]).filter(Boolean)
  const twoNames = memberNames.slice(0, 2).join(' + ') || 'Two people'
  const someNames = (memberNames.length > 3 ? [...memberNames.slice(0, 3), '…'] : memberNames).join(', ') || 'everyone'
  const workedExample = (): { icon: string; lead: string; delta: string; tail: string } | null => {
    if (form.goalType === 'total') {
      const u = unit || 'hr'
      return countChoice === 'split'
        ? { icon: '🌳', lead: `${twoNames}, 1 ${singular(u)} outside together → total `, delta: `+1 ${singular(u)}`, tail: `, ½ each.` }
        : { icon: '🌳', lead: `${twoNames}, 1 ${singular(u)} each → total `, delta: `+2 ${u}`, tail: `.` }
    }
    if (form.goalType === 'count') {
      const u = unit || 'visit'
      return countChoice === 'once'
        ? { icon: '🏞️', lead: `Log “${someNames}” → the total goes up by `, delta: `1`, tail: ` ${u}.` }
        : { icon: '🏞️', lead: `Log “${someNames}” → the total goes up by `, delta: `${Math.max(2, participantCount)}`, tail: ` (one each).` }
    }
    return null
  }
  const dlLabel = form.deadline
    ? ` · by ${new Date(`${form.deadline}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : ''
  const subLine = (() => {
    const tail = isChecklist || form.goalType === 'habit'
      ? ''
      : participantCount > 1 ? (shared ? ' · shared total' : ' · each their own') : ''
    if (form.goalType === 'total') return `Adds up in ${unit || 'units'}${dlLabel}${tail}`
    if (form.goalType === 'count') return `Count to ${form.target} ${unit || 'units'}${dlLabel}${tail}`
    if (form.goalType === 'habit') return `${form.habitPerPeriod}× a ${form.habitPeriod} · keep the streak going`
    return 'A checklist of steps you tick off'
  })()
  const milestoneHint =
    form.goalType === 'habit' ? 'The number is the streak length, in days.'
      : isChecklist ? 'The number is percent complete — 100 = all steps done.'
        : `The number is the amount reached${unit ? ` in ${unit}` : ''}.`

  const editor = (
    <div className="goal-create ge">
      {/* LEFT · focused form */}
      <div className="ge-formpane">
        <div className="ge-col">

          {/* 1 · name */}
          <div className="ge-sec">
            <div className="ge-sec-t">Name your goal</div>
            <div className="ge-sec-h">A short, motivating title your family will see.</div>
            <input className="ge-name" value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. 750 Hours Outside" autoFocus />
          </div>

          {/* 2 · who */}
          <div className="ge-sec">
            <div className="ge-sec-t">Who’s it for?</div>
            <div className="ge-sec-h">
              {embed
                ? 'The group you’re planning for — this goal joins it.'
                : 'Pick a goal list — the people in it share this goal.'}
            </div>
            {/* Embedded, the host already asked which group this is about, so it is STATED. */}
            {embed ? (
              <div className="ge-who">
                <span className="ge-who-chip on ge-who-locked" data-testid="ge-who-locked">
                  <span className="ge-avstack">
                    {(selectedList?.members ?? []).slice(0, 4).map((m) => (
                      <span key={m.personId} className="ge-av" style={{ background: `${m.colorHex ?? '#8a857c'}22` }}>{m.avatarEmoji ?? '🙂'}</span>
                    ))}
                  </span>
                  {selectedList?.name ?? 'This group'}
                </span>
              </div>
            ) : (
              <div className="ge-who">
                {pickableLists.map((l: GoalList) => (
                  <button key={l.id} type="button" className={`ge-who-chip ${form.goalListId === l.id ? 'on' : ''}`} onClick={() => set('goalListId', l.id)}>
                    <span className="ge-avstack">
                      {l.members.slice(0, 4).map((m) => (
                        <span key={m.personId} className="ge-av" style={{ background: `${m.colorHex ?? '#8a857c'}22` }}>{m.avatarEmoji ?? '🙂'}</span>
                      ))}
                    </span>
                    {l.name}
                  </button>
                ))}
                <button type="button" className="ge-who-chip dashed" onClick={() => setShowListModal(true)}>＋ New group</button>
              </div>
            )}
          </div>

          {/* 3 · measure */}
          <div className="ge-sec">
            <div className="ge-sec-t">How do you measure it?</div>
            <div className="ge-sec-h">This shapes how progress is logged and shown.</div>
            <div className="ge-measure-grid">
              {TYPES.map((t) => (
                <button key={t.key} type="button" className={`ge-mcard ${form.goalType === t.key ? 'on' : ''}`} onClick={() => setMeasure(t.key)}>
                  <div className="me">{t.emoji}</div>
                  <div><div className="mt">{t.title}</div><div className="md">{t.desc}</div></div>
                  <div className="mck">{form.goalType === t.key && <CheckIcon />}</div>
                </button>
              ))}
            </div>

            {isChecklist ? (
              // Checklist: three EMPTY step fields — nothing prefilled.
              <div className="ge-steps">
                {steps.map((s, i) => (
                  <div key={i} className="ge-step">
                    <span className="ge-step-dot" />
                    <input value={s.label} placeholder={`Step ${i + 1}`} onChange={(e) => setSteps((ss) => ss.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                    <button type="button" className="ge-step-x" aria-label="remove step" onClick={() => setSteps((ss) => (ss.length > 1 ? ss.filter((_, j) => j !== i) : ss))}>×</button>
                  </div>
                ))}
                <button type="button" className="ge-add" onClick={() => setSteps((ss) => [...ss, { label: '' }])}>＋ Add step</button>
              </div>
            ) : form.goalType === 'habit' ? (
              <div className="ge-cfg">
                <NumField value={form.habitPerPeriod} step={1} onChange={(v) => set('habitPerPeriod', v)} />
                <div className="ge-unitsel">× per{' '}
                  <select value={form.habitPeriod} onChange={(e) => set('habitPeriod', e.target.value)}>
                    <option value="day">day</option>
                    <option value="week">week</option>
                    <option value="month">month</option>
                  </select>
                </div>
                <span className="ge-lead">keep the streak going</span>
              </div>
            ) : (
              <>
                <div className="ge-cfg">
                  <NumField value={form.target} step={form.goalType === 'total' ? 10 : 1} onChange={(v) => set('target', v)} />
                  <input className="ge-unit-input" value={form.unit} onChange={(e) => { unitTouched.current = true; set('unit', e.target.value) }} placeholder="unit — hours, books, miles…" />
                </div>
                <div className="ge-deadline">
                  <div className="ge-deadline-tx"><div className="e1">Set a deadline</div><div className="e2">Optional — a target date to reach it by</div></div>
                  <Toggle on={dlOpen} onClick={() => { const n = !dlOpen; setDlOpen(n); if (!n) set('deadline', '') }} />
                </div>
                {dlOpen && <input type="date" className="ge-date-input" value={form.deadline} onChange={(e) => set('deadline', e.target.value)} />}
              </>
            )}

            {/* Shared-vs-each only matters once the measure has a per-person dimension, and never
                for a checklist. Only shown with 2+ people. */}
            {participantCount > 1 && form.goalType !== 'checklist' && (
              <div className="ge-share" style={{ marginTop: 18 }}>
                <button type="button" className={shared ? 'on' : ''} onClick={() => setForm((f) => ({ ...f, ...sharedDefault(f.goalType) }))}>{form.goalType === 'habit' ? 'One shared streak' : 'One shared total'}</button>
                <button type="button" className={!shared ? 'on' : ''} onClick={() => setForm((f) => ({ ...f, ...eachTracksOwn, targetBasis: (f.goalType === 'total' || f.goalType === 'count') ? 'per_person' : 'family' }))}>{form.goalType === 'habit' ? 'Each keeps their own' : 'Each tracks their own'}</button>
              </div>
            )}

            {/* Group counting — measure-aware. Only for a SHARED total/count goal with 2+ people. */}
            {shared && participantCount > 1 && (form.goalType === 'total' || form.goalType === 'count') && (
              <div className="ge-count">
                <div className="ge-count-q">When a shared activity includes more than one person…</div>
                <div className="ge-count-h">How should a group entry add up toward the total?</div>
                {COUNT_RULES[form.goalType as 'total' | 'count'].map((o) => {
                  const on = countChoice === o.k
                  const u = unit || (form.goalType === 'total' ? 'hr' : 'visit')
                  const ex =
                    o.k === 'full' ? { pre: `2 people, 1 ${singular(u)} each → `, b: `+2 ${u}`, post: '' }
                      : o.k === 'split' ? { pre: `1 ${singular(u)} together, 2 people → `, b: `+1 ${singular(u)}`, post: ', ½ each' }
                        : o.k === 'each' ? { pre: `${participantCount} at once → `, b: `+${participantCount}`, post: ' (one each)' }
                          : { pre: `${participantCount} at once → `, b: '+1', post: ', they’re just who came' }
                  return (
                    <button key={o.k} type="button" className={`ge-rowopt ${on ? 'on' : ''}`} onClick={() => setForm((f) => ({ ...f, ...countChoiceFields(f.goalType, o.k) }))}>
                      <span className="rem">{o.emoji}</span>
                      <span className="rbd">
                        <span className="rt">{o.title}</span>
                        <span className="rex">{ex.pre}<b>{ex.b}</b>{ex.post}</span>
                      </span>
                      <span className="rrk" />
                    </button>
                  )
                })}
                {(() => {
                  const w = workedExample()
                  return w ? (
                    <div className="ge-worked"><span className="wi">{w.icon}</span><span className="wt">{w.lead}<b>{w.delta}</b>{w.tail}</span></div>
                  ) : null
                })()}
              </div>
            )}
          </div>

          {/* 4 · category */}
          <div className="ge-sec">
            <div className="ge-sec-t">Category</div>
            <div className="ge-sec-h">Where this counts toward a balanced life.</div>
            <div className="ge-cats">
              {CATEGORY_KEYS.map((k) => {
                const c = CATEGORIES[k]
                const on = form.category === k
                return (
                  <button key={k} type="button" className={`ge-cat ${on ? 'on' : ''}`} onClick={() => set('category', k)} style={on ? { color: c.txt, borderColor: c.color, background: c.tint } : undefined}>
                    <span className="cemo">{c.emoji}</span>{c.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* 5 · extras */}
          <div className="ge-sec">
            <div className="ge-sec-t">Extras</div>
            <div className="ge-sec-h">All optional. Turn on only what this goal needs.</div>

            <div className="ge-extra" style={{ display: 'block' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
                <div className="eic">🌟</div>
                <div className="etx"><div className="e1">Spotlight &amp; pinned</div><div className="e2">How prominent this goal is on the home screen and goals list</div></div>
              </div>
              <div className="ge-share ge-share-3" style={{ display: 'flex', marginTop: 12 }}>
                <button type="button" className={tier === 'spotlight' ? 'on' : ''} onClick={() => setTier('spotlight')}>🌟 Spotlight</button>
                <button type="button" className={tier === 'featured' ? 'on' : ''} onClick={() => setTier('featured')}>📌 Pinned</button>
                <button type="button" className={tier === 'normal' ? 'on' : ''} onClick={() => setTier('normal')}>Normal</button>
              </div>
              <div className="ge-sec-h" style={{ marginTop: 6 }}>{tierHint}</div>
              {tier === 'spotlight' && listSpotlight && (
                <div className="ge-sec-h" style={{ marginTop: 4, fontWeight: 650 }}>Replaces “{listSpotlight.title}” as this list’s spotlight (it becomes Pinned).</div>
              )}
            </div>

            <div className="ge-extra">
              <div className="eic">🏆</div>
              <div className="etx"><div className="e1">Milestones &amp; rewards</div><div className="e2">Bonus stars at thresholds you set</div></div>
              <Toggle on={form.hasRewards} onClick={() => set('hasRewards', !form.hasRewards)} />
            </div>
            {form.hasRewards && (
              <div className="ge-ms">
                <div className="ge-ms-hint">{milestoneHint} Rewards are optional — add one only if you want.</div>
                {milestones.map((m, i) => (
                  <div key={i} className="ge-ms-row">
                    <input className="ge-ms-emoji" value={m.emoji} maxLength={4} aria-label="emoji" onChange={(e) => setMs(i, { emoji: e.target.value })} />
                    <span className="ge-ms-n"><input value={m.threshold} aria-label="threshold" onChange={(e) => setMs(i, { threshold: Number(e.target.value) || 0, label: e.target.value })} /></span>
                    <input className="ge-ms-r" value={m.rewardText} placeholder="Add a reward (optional)" onChange={(e) => setMs(i, { rewardText: e.target.value })} />
                    <button type="button" className="ge-ms-x" aria-label="remove milestone" onClick={() => { msTouched.current = true; setMilestones((ms) => ms.filter((_, j) => j !== i)) }}>✕</button>
                  </div>
                ))}
                <button type="button" className="ge-add" onClick={() => { msTouched.current = true; setMilestones((ms) => [...ms, { threshold: 0, emoji: '🎖️', label: '', rewardText: '' }]) }}>＋ Add milestone</button>
              </div>
            )}

            <div className="ge-extra">
              <div className="eic">🔔</div>
              <div className="etx"><div className="e1">Weekly check-in</div><div className="e2">Sunday recap on the kiosk</div></div>
              <Toggle on={form.weeklyCheckIn} onClick={() => set('weeklyCheckIn', !form.weeklyCheckIn)} />
            </div>

            {CALENDAR_TYPES.has(form.goalType) && (
              <div className="ge-extra">
                <div className="eic">📅</div>
                <div className="etx"><div className="e1">Auto-count from calendar</div><div className="e2">Matching events add progress automatically</div></div>
                <Toggle on={form.autoFromCalendar} onClick={() => set('autoFromCalendar', !form.autoFromCalendar)} />
              </div>
            )}

            <div className="ge-foot">Rewards are <b>off by default</b> — goals stay about growth, not points. Turn them on per goal when a little extra motivation helps.</div>
          </div>

        </div>
      </div>

      {/* RIGHT · live preview */}
      <div className="ge-pvpane">
        <div className="ge-pvlabel">Live preview</div>
        <div className="ge-pvcap">How this goal appears on the kitchen display.</div>
        <div className="ge-pvstage">
          {tier !== 'normal' ? (
            <div className="ge-pv-hero">
              <div className="hrow">
                <div className="hicon">🎯</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span className="htag">{tier === 'spotlight' ? '🌟 Spotlight' : '📌 Pinned'}{shared ? ' · shared' : ' · each tracks'}</span>
                  <div className="htitle">{previewName}</div>
                  <div className="hsub">{subLine}</div>
                </div>
                {!isChecklist && (
                  <div className="hring">
                    <svg width={60} height={60} viewBox="0 0 60 60">
                      <circle cx={30} cy={30} r={25} fill="none" stroke="rgba(255,255,255,.25)" strokeWidth={5} />
                      <text x={30} y={29} textAnchor="middle" fontFamily="var(--serif)" fontSize={17} fontWeight={600} fill="#fff">0</text>
                      <text x={30} y={42} textAnchor="middle" fontSize={8.5} fontWeight={700} fill="rgba(255,255,255,.85)">of {form.target}</text>
                    </svg>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="ge-pv-card">
              <div className="crow">
                <div className="cicon">🎯</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="ctag">{shared ? 'Shared goal' : 'Each tracks own'}</div>
                  <div className="ctitle">{previewName}</div>
                  <div className="csub">{subLine}</div>
                </div>
              </div>
              {!isChecklist && (
                <>
                  <div className="cbar"><div style={{ width: 0 }} /></div>
                  <div className="cmeta">0 of {form.target} {unit} · just getting started</div>
                </>
              )}
            </div>
          )}

          {form.hasRewards && milestones.length > 0 && (
            <div className="ge-pv-mtrack">
              <div className="mth">Milestones &amp; rewards</div>
              <div className="ge-pv-track">
                {milestones.slice(0, 4).map((m, i) => (
                  <div key={i} className="ge-pv-node">
                    <div className="nd">{m.emoji}</div>
                    <div className="nl">{m.threshold}</div>
                    <div className="nr">{m.rewardText ? (m.rewardText.length > 16 ? `${m.rewardText.slice(0, 15)}…` : m.rewardText) : '—'}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="ge-pv-where">
            <svg viewBox="0 0 24 24"><rect x={3} y={4} width={18} height={14} rx={2} /><path d="M8 20h8M12 18v2" /></svg>
            {tier === 'spotlight' ? 'The spotlight on the home screen' : tier === 'featured' ? 'Pinned to the top of the goals list' : 'Lives in the goals list'}
          </div>
        </div>
      </div>

      {showListModal && (
        <ListModal
          onClose={() => setShowListModal(false)}
          onCreated={(listId) => {
            refetchLists()
            set('goalListId', listId)
          }}
        />
      )}
    </div>
  )

  // On its own route the bar lives in the app topbar; embedded, the two travel together.
  if (!embed) return editor
  return (
    <div className="ge-embed">
      {bar}
      {editor}
    </div>
  )
}
