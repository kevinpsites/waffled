import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useTopbarFull } from './topbar-slot'
import { api, useGoalLists, useGoalDetail, type GoalList } from '../lib/api'
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

// Sensible default milestone thresholds per measure type — the threshold means a
// different thing for each (units / streak days / percent), so the starting
// numbers should match. Swapped in when you change the goal type.
function defaultMilestones(goalType: string): Milestone[] {
  const sets: Record<string, Array<[number, string, string]>> = {
    total: [[250, '🌱', '+25 ★ bonus'], [500, '⛺', 'Family movie night'], [1000, '🏆', 'Big reward']],
    count: [[5, '🌱', '+5 ★ bonus'], [10, '⛺', 'Treat'], [25, '🏆', 'Big reward']],
    habit: [[7, '🌱', '+10 ★ bonus'], [30, '🔥', 'Movie night'], [100, '🏆', 'Big reward']],
    checklist: [[50, '🌱', 'Halfway treat'], [100, '🏆', 'All done — big reward']],
  }
  return (sets[goalType] ?? sets.total).map(([threshold, emoji, rewardText]) => ({
    threshold,
    emoji,
    label: String(threshold),
    rewardText,
  }))
}
const DEFAULT_MILESTONES: Milestone[] = defaultMilestones('total')

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      role="switch"
      aria-checked={on}
      style={{ width: 44, height: 26, borderRadius: 999, flex: 'none', cursor: 'pointer', background: on ? 'var(--wally)' : 'var(--hair)', position: 'relative', transition: 'background .15s' }}
    >
      <div style={{ position: 'absolute', top: 3, left: on ? 21 : 3, width: 20, height: 20, borderRadius: 999, background: '#fff', transition: 'left .15s' }} />
    </div>
  )
}

export function GoalCreate() {
  const navigate = useNavigate()
  const { id } = useParams()
  const editing = !!id
  const { lists, refetch: refetchLists } = useGoalLists()
  const { goal: editGoal } = useGoalDetail(id ?? null)
  // A suggestion tapped on a person profile pre-fills the title (?title=…).
  const [searchParams] = useSearchParams()

  const [form, setForm] = useState({
    title: editing ? '' : (searchParams.get('title') ?? ''),
    goalListId: '' as string,
    category: 'physical',
    trackingMode: 'shared_total' as 'shared_total' | 'each_tracks',
    goalType: 'total' as (typeof TYPES)[number]['key'],
    target: 1000,
    unit: 'hours',
    deadline: '',
    habitPeriod: 'week',
    habitPerPeriod: 5,
    autoFromCalendar: false,
    isFeatured: true,
    hasRewards: false,
    weeklyCheckIn: true,
  })
  const [milestones, setMilestones] = useState<Milestone[]>(DEFAULT_MILESTONES)
  const [steps, setSteps] = useState<Array<{ id?: string; label: string }>>([{ label: '' }, { label: '' }, { label: '' }])
  const [saving, setSaving] = useState(false)
  const [showListModal, setShowListModal] = useState(false)
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
    if (editGoal.milestones.length) {
      setMilestones(editGoal.milestones.map((m) => ({ threshold: m.threshold, emoji: m.emoji ?? '⛳', label: m.label ?? String(m.threshold), rewardText: m.rewardText ?? '' })))
    }
    if (editGoal.steps?.length) {
      setSteps(editGoal.steps.map((s) => ({ id: s.id, label: s.label })))
    }
  }, [editing, editGoal])

  const selectedList = useMemo(() => lists.find((l) => l.id === form.goalListId) ?? null, [lists, form.goalListId])

  // A goal needs a name, at least one person, and the measurement filled in for
  // its type before it can be saved. The deadline is always optional.
  const participantCount = selectedList ? selectedList.members.length : editing ? editGoal?.participants.length ?? 0 : 0
  const stepCount = steps.filter((s) => s.label.trim()).length
  const typeValid =
    form.goalType === 'checklist' ? stepCount >= 1
      : form.goalType === 'habit' ? form.habitPerPeriod > 0
        : Number(form.target) > 0 && form.unit.trim().length > 0 // total | count
  const canSave = form.title.trim().length > 0 && participantCount >= 1 && typeValid && !saving

  const submitRef = useRef<() => void>(() => {})
  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate(editing ? `/goals/${id}` : '/goals', { replace: true })}>‹ {editing ? 'Goal' : 'Goals'}</button>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600 }}>{editing ? 'Edit goal' : 'New goal'}</div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
          <button className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate(editing ? `/goals/${id}` : '/goals', { replace: true })}>Cancel</button>
          <button
            className="pill btn-primary create-submit"
            disabled={!canSave}
            title={canSave ? undefined : 'Add a name, pick who it’s for, and fill in the measurement'}
            style={{ color: '#fff', border: 0, cursor: canSave ? 'pointer' : 'not-allowed', opacity: canSave ? 1 : 0.5 }}
            onClick={() => submitRef.current()}
          >
            {editing ? 'Save changes' : 'Create goal'}
          </button>
        </div>
      </div>
    ),
    [navigate, editing, id, canSave]
  )

  async function submit() {
    if (!canSave) return
    setSaving(true)
    const participantIds = selectedList ? selectedList.members.map((m) => m.personId) : editGoal?.participants.map((p) => p.personId) ?? []
    const isChecklist = form.goalType === 'checklist'
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
      navigate(editing ? `/goals/${id}` : '/goals', { replace: true })
    } catch {
      setSaving(false)
    }
  }
  submitRef.current = submit

  const previewColor = form.trackingMode === 'each_tracks'
  const setMs = (i: number, patch: Partial<Milestone>) => setMilestones((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)))

  return (
    <div className="goal-create">
      {/* form */}
      <div className="gc-form">
        <div>
          <div className="flabel">What’s the goal?</div>
          <input className="gc-input gc-input-serif" value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="1,000 Hours Outside" autoFocus />
        </div>

        <div>
          <div className="flabel">
            Who’s it for? <span style={{ color: 'var(--ink-3)', textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}>· pick a goal list</span>
          </div>
          <div className="gc-chips">
            {lists.map((l: GoalList) => {
              const on = form.goalListId === l.id
              return (
                <button key={l.id} type="button" className={`pill gc-chip ${on ? 'on' : ''}`} onClick={() => set('goalListId', l.id)}>
                  {(l.members[0]?.avatarEmoji ?? l.emoji ?? '👥')} {l.name}
                </button>
              )
            })}
            <button type="button" className="pill gc-chip" style={{ borderStyle: 'dashed' }} onClick={() => setShowListModal(true)}>＋ New group</button>
          </div>
        </div>

        <div>
          <div className="flabel">Shared, or each on their own?</div>
          <div className="seg gc-seg">
            <button className={form.trackingMode === 'shared_total' ? 'on' : ''} onClick={() => set('trackingMode', 'shared_total')}>One shared total</button>
            <button className={form.trackingMode === 'each_tracks' ? 'on' : ''} onClick={() => set('trackingMode', 'each_tracks')}>Each tracks their own</button>
          </div>
        </div>

        <div>
          <div className="flabel">How do you measure it?</div>
          <div className="gc-types">
            {TYPES.map((t) => {
              const on = form.goalType === t.key
              return (
                <button key={t.key} type="button" className={`type-pick ${on ? 'on' : ''}`} onClick={() => { set('goalType', t.key); setMilestones(defaultMilestones(t.key)) }}>
                  <div className="tpe">{t.emoji}</div>
                  <div style={{ flex: 1 }}>
                    <div className="tpt">{t.title}</div>
                    <div className="tpd">{t.desc}</div>
                  </div>
                  {on && <span className="gc-check">✓</span>}
                </button>
              )
            })}
          </div>
          {form.goalType === 'checklist' ? (
            <div className="gc-steps">
              {steps.map((s, i) => (
                <div key={i} className="gc-steprow">
                  <span className="gc-stepnum">{i + 1}</span>
                  <input
                    className="gc-input gc-stepinput"
                    value={s.label}
                    placeholder={`Step ${i + 1}`}
                    onChange={(e) => setSteps((ss) => ss.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  />
                  <button type="button" className="gc-mdel" aria-label="remove step" onClick={() => setSteps((ss) => (ss.length > 1 ? ss.filter((_, j) => j !== i) : ss))}>×</button>
                </div>
              ))}
              <div className="gc-measure" style={{ marginTop: 4 }}>
                <button type="button" className="btn btn-ghost gc-addms" onClick={() => setSteps((ss) => [...ss, { label: '' }])}>＋ Add step</button>
                <span className="gc-x" style={{ marginLeft: 'auto' }}>finish by</span>
                <input className="gc-input gc-date" type="date" title="Target date (optional)" value={form.deadline} onChange={(e) => set('deadline', e.target.value)} />
              </div>
            </div>
          ) : (
            <div className="gc-measure">
              {form.goalType === 'habit' ? (
                <>
                  <input className="gc-input gc-input-num" type="number" min={1} value={form.habitPerPeriod} onChange={(e) => set('habitPerPeriod', Number(e.target.value))} />
                  <span className="gc-x">× a</span>
                  <select className="gc-input gc-select" value={form.habitPeriod} onChange={(e) => set('habitPeriod', e.target.value)}>
                    <option value="day">day</option>
                    <option value="week">week</option>
                    <option value="month">month</option>
                  </select>
                </>
              ) : (
                <>
                  <input className="gc-input gc-input-num" type="number" min={1} value={form.target} onChange={(e) => set('target', Number(e.target.value))} />
                  <input className="gc-input gc-select" value={form.unit} onChange={(e) => set('unit', e.target.value)} placeholder="hours" />
                </>
              )}
              <span className="gc-x">{form.goalType === 'habit' ? 'keep up until' : 'reach by'}</span>
              <input className="gc-input gc-date" type="date" title="Target date (optional)" value={form.deadline} onChange={(e) => set('deadline', e.target.value)} />
            </div>
          )}
        </div>

        <div>
          <div className="flabel">Category</div>
          <div className="gc-chips">
            {CATEGORY_KEYS.map((k) => {
              const c = CATEGORIES[k]
              const on = form.category === k
              return (
                <button key={k} type="button" className="cat-pill" style={{ background: on ? c.tint : 'var(--card-2)', color: on ? c.txt : 'var(--ink-2)', border: on ? 0 : '1px solid var(--hair)', cursor: 'pointer' }} onClick={() => set('category', k)}>
                  {c.emoji} {c.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Logging style is derived from the type above. Calendar auto-counting
            is an independent opt-in that coexists with manual logging — offered
            on everything except checklists. */}
        {CALENDAR_TYPES.has(form.goalType) && (
          <div>
            <div className="flabel">How is progress logged?</div>
            <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 8 }}>
              You can always log it yourself, anytime. Optionally let the calendar count too:
            </div>
            <div className="feature-row" onClick={() => set('autoFromCalendar', !form.autoFromCalendar)} style={{ cursor: 'pointer' }}>
              <div style={{ fontSize: 24 }}>📅</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14.5, fontWeight: 700 }}>Also auto-count from calendar ✦</div>
                <div className="tiny muted" style={{ fontWeight: 600 }}>
                  Matching calendar events add progress automatically
                </div>
              </div>
              <Toggle on={form.autoFromCalendar} onClick={() => set('autoFromCalendar', !form.autoFromCalendar)} />
            </div>
            {form.autoFromCalendar && (
              <div className="tiny muted" style={{ fontWeight: 600, marginTop: 8 }}>
                ✦ Auto-counting from the calendar arrives with Google sync — for now this just saves the preference.
              </div>
            )}
          </div>
        )}
      </div>

      {/* live preview + options */}
      <div className="gc-side">
        <div className="flabel" style={{ margin: '2px 0 -2px' }}>Live preview</div>
        <div className={`challenge gc-preview ${previewColor ? 'hero-each' : ''}`}>
          <div className="ch-row" style={{ gap: 18 }}>
            {!previewColor ? (
              <div style={{ position: 'relative', width: 74, height: 74, flex: 'none' }}>
                <svg viewBox="0 0 100 100" style={{ transform: 'rotate(-90deg)' }}>
                  <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(255,255,255,.25)" strokeWidth="9" />
                </svg>
                <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
                  <div>
                    <div style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 600, lineHeight: 1 }}>0</div>
                    <div style={{ fontSize: 8.5, opacity: 0.85, fontWeight: 700 }}>of {form.target.toLocaleString()}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="hero-emoji" style={{ width: 60, height: 60 }}>🎯</div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <span className="cat-pill hero-pill" style={{ fontSize: 10 }}>
                ⭐ Featured · {form.trackingMode === 'each_tracks' ? 'each tracks' : 'shared total'}
              </span>
              <div className="nk-serif" style={{ fontSize: 21, fontWeight: 600, margin: '7px 0 2px' }}>{form.title || 'New goal'}</div>
              <div style={{ fontSize: 11.5, opacity: 0.9, fontWeight: 600 }}>
                {form.trackingMode === 'each_tracks' ? 'Each tracks their own' : 'Everyone contributes'}
                {form.goalType !== 'habit' && form.unit ? ` · tracked in ${form.unit}` : ''}
              </div>
            </div>
          </div>
        </div>

        <div className="feature-row" onClick={() => set('isFeatured', !form.isFeatured)} style={{ cursor: 'pointer' }}>
          <div style={{ fontSize: 24 }}>⭐</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14.5, fontWeight: 700 }}>Feature on the home screen</div>
            <div className="tiny muted" style={{ fontWeight: 600 }}>Shows big on the kitchen display, like above</div>
          </div>
          <Toggle on={form.isFeatured} onClick={() => set('isFeatured', !form.isFeatured)} />
        </div>

        <div className="gc-optcard">
          <div className="gc-optrow" onClick={() => set('hasRewards', !form.hasRewards)}>
            <div className="gc-optic">🏆</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Milestones &amp; rewards</div>
              <div className="tiny muted" style={{ fontWeight: 600 }}>Bonus stars at custom thresholds</div>
            </div>
            <Toggle on={form.hasRewards} onClick={() => set('hasRewards', !form.hasRewards)} />
          </div>
          <div className="gc-optrow" onClick={() => set('weeklyCheckIn', !form.weeklyCheckIn)}>
            <div className="gc-optic">🔔</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Weekly check-in</div>
              <div className="tiny muted" style={{ fontWeight: 600 }}>Sunday recap on the kiosk</div>
            </div>
            <Toggle on={form.weeklyCheckIn} onClick={() => set('weeklyCheckIn', !form.weeklyCheckIn)} />
          </div>
        </div>

        {form.hasRewards && (
          <div className="gc-milestones">
            <div className="flabel" style={{ margin: '2px 0 0' }}>Milestones &amp; rewards</div>
            <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 4 }}>
              {form.goalType === 'habit'
                ? 'Number = 🔥 streak days (e.g. 30 → reward at a 30-day streak)'
                : form.goalType === 'checklist'
                  ? 'Number = % complete — enter 80 for 80% (100 = all steps done)'
                  : `Number = ${form.unit || 'amount'} reached (e.g. 500 → reward at 500${form.unit ? ` ${form.unit}` : ''})`}
            </div>
            {milestones.map((m, i) => (
              <div key={i} className="gc-mrow">
                <input className="gc-input gc-memoji" value={m.emoji} onChange={(e) => setMs(i, { emoji: e.target.value })} maxLength={4} aria-label="emoji" />
                <input className="gc-input gc-mthresh" type="number" value={m.threshold} onChange={(e) => setMs(i, { threshold: Number(e.target.value), label: e.target.value })} aria-label="threshold" />
                <input className="gc-input gc-mreward" value={m.rewardText} onChange={(e) => setMs(i, { rewardText: e.target.value })} placeholder="reward" />
                <button type="button" className="gc-mdel" aria-label="remove milestone" onClick={() => setMilestones((ms) => ms.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button type="button" className="btn btn-ghost gc-addms" onClick={() => setMilestones((ms) => [...ms, { threshold: 0, emoji: '🎯', label: '', rewardText: '' }])}>＋ Add milestone</button>
          </div>
        )}

        <div className="tiny muted" style={{ fontWeight: 600, lineHeight: 1.5, padding: '0 2px' }}>
          Rewards are <b>off by default</b> — goals stay about growth, not points. Turn them on per goal when a little extra motivation helps.
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
