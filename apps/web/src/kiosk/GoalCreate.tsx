import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useTopbarFull } from './topbar-slot'
import { api, useGoalLists, useGoalDetail, useHousehold, can, type GoalList } from '../lib/api'
import { CATEGORIES, CATEGORY_KEYS } from './categories'
import { ListModal } from './components/ListModal'
import './../styles/goals.css'

// The measure type is also what tells us divisibility: "Total" accumulates a
// divisible amount (so it splits evenly across people), "Count" is whole things
// (no fractions). The copy here makes that distinction obvious so it's chosen on
// purpose, not by accident.
const TYPES = [
  { key: 'total', emoji: '⏱️', title: 'Total amount', desc: 'Adds up — can split (hours, miles)' },
  { key: 'count', emoji: '🔢', title: 'Count', desc: 'Whole things (books, parks)' },
  { key: 'habit', emoji: '🔁', title: 'Habit', desc: 'Once a day, on a cadence' },
  { key: 'checklist', emoji: '🪜', title: 'Checklist', desc: 'Named steps you tick off' },
] as const

// How a goal is logged is derived entirely from its type — total = enter an
// amount, count = whole-unit stepper, habit = one tap a day, checklist = tick
// steps. There's no manual log-method to pick. "Auto-count from calendar" is a
// separate, independent opt-in (it coexists with manual logging) offered on
// everything except checklists, which complete by ticking named steps.
const CALENDAR_TYPES = new Set(['total', 'count', 'habit'])

type Milestone = { threshold: number; emoji: string; label: string; rewardText: string }

// Sensible auto-milestones DERIVED from the goal's target — for a numeric goal we
// place three checkpoints at a quarter / half / three-quarters of the way (the goal
// itself isn't a milestone), so a target of 300 gives 75 / 150 / 225 rather than a
// fixed 250 / 500 / 1000 that ignores the number. Reward text is left BLANK — the
// editor shows a faint "add a reward" placeholder; a reward is never auto-filled.
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

// iOS-style switch, matching the mock's toggles. Reused for every Extras row.
function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      role="switch"
      aria-checked={on}
      style={{ width: 46, height: 28, borderRadius: 999, flex: 'none', cursor: 'pointer', background: on ? 'var(--wally)' : '#d8d2c8', position: 'relative', transition: 'background .18s' }}
    >
      <div style={{ position: 'absolute', top: 3, left: on ? 21 : 3, width: 22, height: 22, borderRadius: 999, background: '#fff', boxShadow: 'var(--sh-1)', transition: 'left .18s' }} />
    </div>
  )
}

// Serif number field with ▲▼ steppers (the mock's `.num-field`).
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

export function GoalCreate() {
  const navigate = useNavigate()
  const { id } = useParams()
  const editing = !!id
  const { lists, refetch: refetchLists } = useGoalLists()
  const { goal: editGoal } = useGoalDetail(id ?? null)
  const { person } = useHousehold()
  // Without goal.manage you can still make a goal that's just yours — so the
  // "Who's it for?" picker is limited to lists where you're the sole member
  // (a self-only/unassigned goal). Picking a group = assigning others = needs
  // goal.manage, which 403s server-side; we hide those lists rather than 403.
  const canAssignOthers = can(person, 'goal.manage')
  const pickableLists = canAssignOthers
    ? lists
    : lists.filter((l) => l.members.length === 1 && l.members[0].personId === person?.id)
  // A suggestion tapped on a person profile pre-fills the title (?title=…).
  const [searchParams] = useSearchParams()

  const [form, setForm] = useState({
    title: editing ? '' : (searchParams.get('title') ?? ''),
    // Pre-select the list you came from (?list=) so a goal made while viewing
    // "Kevin" / "Mom & Dad" starts in that group; falls to the picker otherwise.
    goalListId: editing ? '' : (searchParams.get('list') ?? ''),
    category: 'physical',
    trackingMode: 'shared_total' as 'shared_total' | 'each_tracks',
    goalType: 'total' as (typeof TYPES)[number]['key'],
    target: 1000,
    unit: 'hours',
    deadline: '',
    habitPeriod: 'week',
    habitPerPeriod: 5,
    // Auto-count from the calendar is ON by default — most numeric/habit goals
    // benefit from matching events adding progress without extra taps.
    autoFromCalendar: true,
    isFeatured: true,
    hasRewards: false,
    weeklyCheckIn: true,
  })
  const [milestones, setMilestones] = useState<Milestone[]>(DEFAULT_MILESTONES)
  const [steps, setSteps] = useState<Array<{ id?: string; label: string }>>([{ label: '' }, { label: '' }, { label: '' }])
  const [dlOpen, setDlOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showListModal, setShowListModal] = useState(false)
  // Once the user hand-edits a milestone we stop regenerating defaults from the target.
  const msTouched = useRef(false)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))

  // prefill once when editing
  const prefilled = useRef(false)
  useEffect(() => {
    if (!editing || prefilled.current || !editGoal) return
    prefilled.current = true
    setForm((f) => ({
      ...f,
      title: editGoal.title,
      goalListId: editGoal.goalListId ?? '',
      category: editGoal.category ?? 'physical',
      trackingMode: editGoal.trackingMode === 'each_tracks' ? 'each_tracks' : 'shared_total',
      goalType: (editGoal.goalType as (typeof TYPES)[number]['key']) ?? 'total',
      target: editGoal.target ?? 1,
      unit: editGoal.unit ?? '',
      deadline: editGoal.deadline ?? '',
      habitPeriod: editGoal.habitPeriod ?? 'week',
      habitPerPeriod: editGoal.habitTargetPerPeriod ?? 5,
      autoFromCalendar: editGoal.autoFromCalendar ?? false,
      isFeatured: editGoal.isFeatured,
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

  // Regenerate the default milestones from the current type + target until the
  // user hand-edits them — so setting a 300-hour target gives 75/150/225.
  useEffect(() => {
    if (msTouched.current) return
    setMilestones(defaultMilestones(form.goalType, form.target))
  }, [form.goalType, form.target])

  // Editing is gated exactly like GoalDetail: only goal.manage holders, or the
  // owner of a goal that's solely theirs, may edit. GoalDetail hides its "Edit
  // goal" button, but /goals/:id/edit is a deep-linkable route — without this a
  // kid could reach an enabled "Save changes" that 403s. Bounce them back.
  const editBlocked =
    editing && !!editGoal && !canAssignOthers &&
    !(editGoal.participants.length === 1 && editGoal.participants[0].personId === person?.id)
  useEffect(() => {
    if (editBlocked) navigate(`/goals/${id}`, { replace: true })
  }, [editBlocked, id, navigate])

  // Creating: without goal.manage you can only target a self-only list. Neutralize
  // a prefilled ?list=<group> (e.g. arriving from a shared group's "New goal"), or
  // a multi-member group just made via the modal, so Create never enables on a
  // target that would 403 — render-if-capable, not show-then-403.
  useEffect(() => {
    if (editing || canAssignOthers || !form.goalListId || lists.length === 0) return
    const l = lists.find((x) => x.id === form.goalListId)
    const selfOnly = !!l && l.members.length === 1 && l.members[0].personId === person?.id
    if (!selfOnly) setForm((f) => ({ ...f, goalListId: '' }))
  }, [editing, canAssignOthers, form.goalListId, lists, person?.id])

  const selectedList = useMemo(() => lists.find((l) => l.id === form.goalListId) ?? null, [lists, form.goalListId])

  // A goal needs a name, at least one person, and the measurement filled in for
  // its type before it can be saved. The deadline is always optional.
  const participantCount = selectedList ? selectedList.members.length : editing ? editGoal?.participants.length ?? 0 : 0
  const stepCount = steps.filter((s) => s.label.trim()).length
  const isChecklist = form.goalType === 'checklist'
  const typeValid =
    isChecklist ? stepCount >= 1
      : form.goalType === 'habit' ? form.habitPerPeriod > 0
        : Number(form.target) > 0 && form.unit.trim().length > 0 // total | count
  const canSave = form.title.trim().length > 0 && participantCount >= 1 && typeValid && !saving && !editBlocked

  // Return to the list you came from (cancel/back). After CREATE we return to the
  // goal's final list instead (see submit) — so changing it to Wally lands on Wally.
  const cameFromList = searchParams.get('list') ?? ''
  const backToGoals = editing ? `/goals/${id}` : `/goals${cameFromList ? `?list=${cameFromList}` : ''}`

  const submitRef = useRef<() => void>(() => {})
  // Replace the whole topbar (no date/clock/weather) with the editor's own bar:
  // a big "New goal" title (sized to match the Today date) + Cancel + Create.
  useTopbarFull(
    () => (
      <div className="ge-topbar">
        <div className="ge-title">{editing ? 'Edit goal' : 'New goal'}</div>
        <div className="ge-sp" />
        <button type="button" className="ge-cancel" onClick={() => navigate(backToGoals, { replace: true })}>Cancel</button>
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
    ),
    [navigate, editing, canSave, backToGoals]
  )

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
      // Logging style is derived from the type; calendar auto-count is an
      // independent opt-in (never on checklists, which tick steps).
      autoFromCalendar: isChecklist ? false : form.autoFromCalendar,
      deadline: form.deadline || null,
      isFeatured: form.isFeatured,
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
      // Land on the goal's final list — if they retargeted it (e.g. Mom & Dad →
      // Wally), that's where the new goal lives, so that's where we go.
      navigate(editing ? `/goals/${id}` : `/goals${form.goalListId ? `?list=${form.goalListId}` : ''}`, { replace: true })
    } catch {
      setSaving(false)
    }
  }
  submitRef.current = submit

  const setMs = (i: number, patch: Partial<Milestone>) => { msTouched.current = true; setMilestones((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m))) }

  // ── live-preview helpers ─────────────────────────────────────────────────
  const shared = form.trackingMode === 'shared_total'
  const previewName = form.title.trim() || 'Your goal'
  const unit = (form.unit || '').trim()
  const dlLabel = form.deadline
    ? ` · by ${new Date(`${form.deadline}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : ''
  const subLine = (() => {
    const tail = isChecklist || form.goalType === 'habit' ? '' : shared ? ' · shared total' : ' · each their own'
    if (form.goalType === 'total') return `Adds up in ${unit || 'units'}${dlLabel}${tail}`
    if (form.goalType === 'count') return `Count to ${form.target} ${unit || 'units'}${dlLabel}${tail}`
    if (form.goalType === 'habit') return `${form.habitPerPeriod}× a ${form.habitPeriod} · keep the streak going`
    return 'A checklist of steps you tick off'
  })()
  const milestoneHint =
    form.goalType === 'habit' ? 'The number is the streak length, in days.'
      : isChecklist ? 'The number is percent complete — 100 = all steps done.'
        : `The number is the amount reached${unit ? ` in ${unit}` : ''}.`

  return (
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
            <div className="ge-sec-h">Pick a goal list. Share one total, or let each person track their own.</div>
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
            <div className="ge-share">
              <button type="button" className={shared ? 'on' : ''} onClick={() => set('trackingMode', 'shared_total')}>One shared total</button>
              <button type="button" className={!shared ? 'on' : ''} onClick={() => set('trackingMode', 'each_tracks')}>Each tracks their own</button>
            </div>
          </div>

          {/* 3 · measure */}
          <div className="ge-sec">
            <div className="ge-sec-t">How do you measure it?</div>
            <div className="ge-sec-h">This shapes how progress is logged and shown.</div>
            <div className="ge-measure-grid">
              {TYPES.map((t) => (
                <button key={t.key} type="button" className={`ge-mcard ${form.goalType === t.key ? 'on' : ''}`} onClick={() => set('goalType', t.key)}>
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
                  <input className="ge-unit-input" value={form.unit} onChange={(e) => set('unit', e.target.value)} placeholder="unit — hours, books, miles…" />
                </div>
                <div className="ge-deadline">
                  <div className="ge-deadline-tx"><div className="e1">Set a deadline</div><div className="e2">Optional — a target date to reach it by</div></div>
                  <Toggle on={dlOpen} onClick={() => { const n = !dlOpen; setDlOpen(n); if (!n) set('deadline', '') }} />
                </div>
                {dlOpen && <input type="date" className="ge-date-input" value={form.deadline} onChange={(e) => set('deadline', e.target.value)} />}
              </>
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

            <div className="ge-extra">
              <div className="eic">⭐</div>
              <div className="etx"><div className="e1">Feature on the home screen</div><div className="e2">Shows big on the kitchen display</div></div>
              <Toggle on={form.isFeatured} onClick={() => set('isFeatured', !form.isFeatured)} />
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
          {form.isFeatured ? (
            <div className="ge-pv-hero">
              <div className="hrow">
                <div className="hicon">🎯</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span className="htag">★ Featured{shared ? ' · shared' : ' · each tracks'}</span>
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
            {form.isFeatured ? 'Featured big on the home screen' : 'Lives in the goals list'}
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
}
