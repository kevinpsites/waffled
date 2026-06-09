import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTopbarFull } from './topbar-slot'
import { api, useGoalLists, type GoalList } from '../lib/api'
import { CATEGORIES, CATEGORY_KEYS } from './categories'
import './../styles/goals.css'

const TYPES = [
  { key: 'count', emoji: '🔢', title: 'Count', desc: 'Reach a number' },
  { key: 'total', emoji: '⏱️', title: 'Total amount', desc: 'Add up over time' },
  { key: 'habit', emoji: '🔁', title: 'Habit', desc: 'Repeat on a cadence' },
  { key: 'checklist', emoji: '🪜', title: 'Milestones', desc: 'A checklist of steps' },
] as const

const LOG_METHODS = [
  { key: 'quick_log', label: '⚡ Quick log', tone: 'on' },
  { key: 'auto_calendar', label: '📅 Auto from calendar ✦', tone: 'ai' },
  { key: 'check_off', label: '✅ Check off', tone: '' },
] as const

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
  const { lists } = useGoalLists()
  const [form, setForm] = useState({
    title: '',
    goalListId: '' as string,
    category: 'physical',
    trackingMode: 'shared_total' as 'shared_total' | 'each_tracks',
    goalType: 'total' as (typeof TYPES)[number]['key'],
    target: 1000,
    unit: 'hours',
    deadline: '',
    habitPeriod: 'week',
    habitPerPeriod: 5,
    logMethod: 'quick_log' as (typeof LOG_METHODS)[number]['key'],
    isFeatured: true,
    hasRewards: false,
    weeklyCheckIn: true,
  })
  const [milestones, setMilestones] = useState<Array<{ threshold: number; emoji: string; label: string; rewardText: string }>>([
    { threshold: 250, emoji: '🌱', label: '250', rewardText: '+25 ★ bonus' },
    { threshold: 500, emoji: '⛺', label: '500', rewardText: 'Family movie night' },
    { threshold: 1000, emoji: '🏆', label: '1,000', rewardText: 'Big reward' },
  ])
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))

  const selectedList = useMemo(() => lists.find((l) => l.id === form.goalListId) ?? null, [lists, form.goalListId])
  const canSave = form.title.trim().length > 0 && !saving

  // The "Create goal" button lives in the topbar (a separate subtree); call the
  // latest submit through a ref so the stable topbar node always sees fresh state.
  const submitRef = useRef<() => void>(() => {})

  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate('/goals')}>‹ Goals</button>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600 }}>New goal</div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
          <button className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate('/goals')}>Cancel</button>
          <button className="pill btn-primary create-submit" style={{ color: '#fff', border: 0, cursor: 'pointer' }} onClick={() => submitRef.current()}>Create goal</button>
        </div>
      </div>
    ),
    [navigate]
  )

  async function submit() {
    if (!canSave) return
    setSaving(true)
    try {
      await api.createGoal({
        title: form.title.trim(),
        goalListId: form.goalListId || null,
        category: form.category,
        goalType: form.goalType,
        unit: form.goalType === 'habit' ? null : form.unit.trim() || null,
        targetValue: form.goalType === 'habit' ? form.habitPerPeriod : Number(form.target) || null,
        habitPeriod: form.goalType === 'habit' ? form.habitPeriod : null,
        habitTargetPerPeriod: form.goalType === 'habit' ? form.habitPerPeriod : null,
        trackingMode: form.trackingMode,
        logMethod: form.logMethod,
        deadline: form.deadline || null,
        isFeatured: form.isFeatured,
        hasRewards: form.hasRewards,
        participantIds: selectedList?.members.map((m) => m.personId) ?? [],
        milestones: form.hasRewards ? milestones.map((m) => ({ threshold: m.threshold, emoji: m.emoji, label: m.label, rewardText: m.rewardText })) : [],
      })
      navigate('/goals')
    } catch {
      setSaving(false)
    }
  }
  submitRef.current = submit

  const previewColor = form.trackingMode === 'each_tracks'
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
            <button type="button" className="pill gc-chip" style={{ borderStyle: 'dashed' }} onClick={() => navigate('/goals')}>＋ New group</button>
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
                <button key={t.key} type="button" className={`type-pick ${on ? 'on' : ''}`} onClick={() => set('goalType', t.key)}>
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
            <input className="gc-input gc-date" type="date" value={form.deadline} onChange={(e) => set('deadline', e.target.value)} />
          </div>
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

        <div>
          <div className="flabel">How is progress logged?</div>
          <div className="gc-chips">
            {LOG_METHODS.map((m) => {
              const on = form.logMethod === m.key
              const style: React.CSSProperties = on
                ? m.tone === 'ai'
                  ? { background: '#efeafc', color: 'var(--ai)', borderColor: '#ddd2f5' }
                  : { background: 'var(--ink)', color: '#fff', borderColor: 'var(--ink)' }
                : {}
              return (
                <button key={m.key} type="button" className="pill gc-chip" style={{ cursor: 'pointer', ...style }} onClick={() => set('logMethod', m.key)}>
                  {m.label}
                </button>
              )
            })}
          </div>
          {form.logMethod === 'auto_calendar' && (
            <div className="tiny muted" style={{ fontWeight: 600, marginTop: 8 }}>
              ✦ Auto-counting from the calendar is coming with Google sync — for now it logs like Quick log.
            </div>
          )}
        </div>
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
              <div className="tiny muted" style={{ fontWeight: 600 }}>Bonus stars at {milestones.map((m) => m.label).join(' / ')}</div>
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
            {milestones.map((m, i) => (
              <div key={i} className="gc-mrow">
                <div className="gc-optic">{m.emoji}</div>
                <input className="gc-input gc-mlabel" value={m.label} onChange={(e) => setMilestones((ms) => ms.map((x, j) => (j === i ? { ...x, label: e.target.value, threshold: Number(e.target.value.replace(/[^0-9]/g, '')) || x.threshold } : x)))} />
                <input className="gc-input gc-mreward" value={m.rewardText} onChange={(e) => setMilestones((ms) => ms.map((x, j) => (j === i ? { ...x, rewardText: e.target.value } : x)))} />
              </div>
            ))}
          </div>
        )}

        <div className="tiny muted" style={{ fontWeight: 600, lineHeight: 1.5, padding: '0 2px' }}>
          Rewards are <b>off by default</b> — goals stay about growth, not points. Turn them on per goal when a little extra motivation helps.
        </div>
      </div>
    </div>
  )
}
