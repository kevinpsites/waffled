import { useCallback, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { useMatch, useNavigate, useParams } from 'react-router'
import { useTopbarFull } from './topbar-slot'
import {
  mealsApi,
  pantryApi,
  useRecipe,
  type RecipeIngredient,
  type RecipeMatch,
  type RecipeStep,
} from '../lib/api'
import { CookConfirm } from './components/CookConfirm'
import { CookTabs, type CookTabInfo } from './components/CookTabs'
import { useCookPlate } from './components/CookDishes'
import './../styles/cookmode.css'

// A running (or fired) per-step countdown shown in the floating dock.
interface CookTimer {
  id: number
  label: string
  stepIndex: number // which step started it — drives "Jump to step"
  totalSeconds: number
  remainingSeconds: number
  running: boolean
  firing: boolean // hit zero; flashes + chimes until dismissed
}

// mm:ss for a duration (clamps negatives to 0).
function fmt(secs: number): string {
  const s = Math.max(0, Math.floor(secs))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

// Full-screen, step-by-step cooking view for the kiosk — large type for across-the-
// kitchen reading, one step at a time, the step's ingredients pulled out, and a
// screen wake-lock so the tablet doesn't sleep mid-recipe.
//
// Two ways in, one screen:
//   /meals/recipe/:id/cook — one recipe, exactly as it has always worked.
//   /meals/meal/:id/cook   — a whole Meal Builder plate, tabbed across its dishes
//                            with independent step progress per dish.
export function CookMode() {
  const { id } = useParams()
  const plate = useMatch('/meals/meal/:id/cook')
  if (plate) return <CookPlate mealId={id ?? null} />
  return <CookRecipe recipeId={id ?? null} />
}

// ── one recipe ────────────────────────────────────────────────────────────────
function CookRecipe({ recipeId }: { recipeId: string | null }) {
  const navigate = useNavigate()
  const { recipe, ingredients, steps, loading, error } = useRecipe(recipeId)
  const [i, setI] = useState(0)
  const [done, setDone] = useState(false)

  const total = steps.length
  // Replace (not push) the cook-mode history entry with the recipe so pressing
  // back from the recipe goes to wherever you came from (Today, the meal plan)
  // instead of bouncing back into cook mode — that round-trip was an endless loop.
  const exit = () => navigate(`/meals/recipe/${recipeId}`, { replace: true })

  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button className="pill" style={{ cursor: 'pointer' }} onClick={exit}>✕ Exit cook mode</button>
        <div className="cm-top-title wf-serif">{recipe?.title ?? ''}</div>
        <div style={{ marginLeft: 'auto' }} className="cm-top-prog tiny muted">
          {total > 0 && !done ? `Step ${i + 1} of ${total}` : ''}
        </div>
      </div>
    ),
    [recipe?.title, i, total, done, recipeId]
  )

  if (loading) return <div className="muted" style={{ padding: 30 }}>Loading…</div>
  if (error || !recipe) return <div className="muted" style={{ padding: 30 }}>This recipe isn’t available.</div>

  return (
    <CookSession
      recipeId={recipe.id}
      title={recipe.title}
      ingredients={ingredients}
      steps={steps}
      i={i}
      setI={setI}
      done={done}
      setDone={setDone}
      onExit={exit}
      exitLabel="Back to recipe"
    />
  )
}

// ── a whole plate ─────────────────────────────────────────────────────────────
// Every dish keeps its own step position and its own "cooked" state, held here so
// they survive tab switches. The session below is keyed by dish, so switching tabs
// gives the new dish a clean slate for its own transient state (timers, sheets) —
// timer persistence across dishes is a separate piece of work.
function CookPlate({ mealId }: { mealId: string | null }) {
  const navigate = useNavigate()
  const { name, dishes, loading, error } = useCookPlate(mealId)
  const [active, setActive] = useState(0)
  const [stepByDish, setStepByDish] = useState<Record<string, number>>({})
  const [doneByDish, setDoneByDish] = useState<Record<string, boolean>>({})

  const index = dishes.length > 0 ? Math.min(active, dishes.length - 1) : 0
  const dish = dishes[index] ?? null
  const rid = dish?.recipeId ?? null
  const i = rid ? stepByDish[rid] ?? 0 : 0
  const done = rid ? !!doneByDish[rid] : false
  const total = dish?.steps.length ?? 0

  // Controlled per-dish setters with the same shape as useState's, so the session
  // body can keep using setI((n) => n + 1) without knowing it's on a plate.
  const setI = useCallback<Dispatch<SetStateAction<number>>>(
    (value) => {
      if (!rid) return
      setStepByDish((m) => {
        const cur = m[rid] ?? 0
        const next = typeof value === 'function' ? (value as (p: number) => number)(cur) : value
        return { ...m, [rid]: next }
      })
    },
    [rid]
  )
  const setDone = useCallback<Dispatch<SetStateAction<boolean>>>(
    (value) => {
      if (!rid) return
      setDoneByDish((m) => {
        const cur = !!m[rid]
        const next = typeof value === 'function' ? (value as (p: boolean) => boolean)(cur) : value
        return { ...m, [rid]: next }
      })
    },
    [rid]
  )

  const exit = () => navigate(`/meals/build/${mealId}`, { replace: true })

  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button className="pill" style={{ cursor: 'pointer' }} onClick={exit}>✕ Exit cook mode</button>
        <div className="cm-top-title wf-serif">{name ?? ''}</div>
        <div style={{ marginLeft: 'auto' }} className="cm-top-prog tiny muted">
          {dish && total > 0 && !done ? `${dish.title} · Step ${i + 1} of ${total}` : ''}
        </div>
      </div>
    ),
    [name, dish?.title, i, total, done, mealId]
  )

  if (loading) return <div className="muted" style={{ padding: 30 }}>Loading…</div>
  if (error) return <div className="muted" style={{ padding: 30 }}>This meal isn’t available.</div>
  if (!dish) {
    return (
      <div className="muted" style={{ padding: 30 }}>
        Nothing on this plate yet — add a dish to it and there’ll be something to cook.
      </div>
    )
  }

  const tabs: CookTabInfo[] = dishes.map((d) => ({
    recipeId: d.recipeId,
    title: d.title,
    emoji: d.emoji,
    stepIndex: stepByDish[d.recipeId] ?? 0,
    total: d.steps.length,
    done: !!doneByDish[d.recipeId],
  }))

  return (
    <CookSession
      key={dish.recipeId}
      recipeId={dish.recipeId}
      title={dish.title}
      ingredients={dish.ingredients}
      steps={dish.steps}
      i={i}
      setI={setI}
      done={done}
      setDone={setDone}
      onExit={exit}
      exitLabel="Back to the plate"
      header={<CookTabs tabs={tabs} activeIndex={index} onSelect={setActive} />}
    />
  )
}

// ── the cooking body ──────────────────────────────────────────────────────────
// One dish's worth of cooking: the step stage, the controls, the all-ingredients
// modal and the timers. Step position and "cooked" live above (per recipe or per
// dish); everything transient lives here.
function CookSession({
  recipeId,
  title,
  ingredients,
  steps,
  i,
  setI,
  done,
  setDone,
  onExit,
  exitLabel,
  header,
}: {
  recipeId: string
  title: string
  ingredients: RecipeIngredient[]
  steps: RecipeStep[]
  i: number
  setI: Dispatch<SetStateAction<number>>
  done: boolean
  setDone: Dispatch<SetStateAction<boolean>>
  onExit: () => void
  exitLabel: string
  header?: ReactNode
}) {
  const [showAll, setShowAll] = useState(false)
  const [usedMatches, setUsedMatches] = useState<RecipeMatch[]>([])
  const [sheetOpen, setSheetOpen] = useState(false)
  // Background timers — survive step navigation (the component never remounts) and
  // render in a floating dock above every step + the done screen.
  const [timers, setTimers] = useState<CookTimer[]>([])
  const nextTimerId = useRef(1)
  const wakeRef = useRef<{ release: () => void } | null>(null)

  // Keep the kiosk awake while cooking; release on unmount.
  useEffect(() => {
    let cancelled = false
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => void }> } }
    nav.wakeLock?.request('screen').then((s) => {
      if (cancelled) s.release()
      else wakeRef.current = s
    }).catch(() => {})
    return () => {
      cancelled = true
      wakeRef.current?.release()
    }
  }, [])

  // One ticker drives every running timer (decrement once/second; flag `firing` at 0).
  const anyRunning = timers.some((t) => t.running)
  useEffect(() => {
    if (!anyRunning) return
    const handle = setInterval(() => {
      setTimers((ts) =>
        ts.map((t) => {
          if (!t.running) return t
          const next = t.remainingSeconds - 1
          if (next <= 0) return { ...t, remainingSeconds: 0, running: false, firing: true }
          return { ...t, remainingSeconds: next }
        })
      )
    }, 1000)
    return () => clearInterval(handle)
  }, [anyRunning])

  // Dependency-free chime: a repeating short oscillator beep while any timer is firing.
  const anyFiring = timers.some((t) => t.firing)
  useEffect(() => {
    if (!anyFiring) return
    const Ctx = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
    if (!Ctx) return
    const ctx = new Ctx()
    const beep = () => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.0001, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45)
      osc.connect(gain).connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.5)
    }
    beep()
    const handle = setInterval(beep, 1400)
    return () => {
      clearInterval(handle)
      ctx.close().catch(() => {})
    }
  }, [anyFiring])

  const startTimer = useCallback((label: string, totalSeconds: number, stepIndex: number) => {
    if (totalSeconds <= 0) return
    setTimers((ts) => [
      ...ts,
      { id: nextTimerId.current++, label, stepIndex, totalSeconds, remainingSeconds: totalSeconds, running: true, firing: false },
    ])
  }, [])
  const toggleTimer = useCallback((tid: number) => {
    setTimers((ts) => ts.map((t) => (t.id === tid && !t.firing ? { ...t, running: !t.running } : t)))
  }, [])
  const dismissTimer = useCallback((tid: number) => {
    setTimers((ts) => ts.filter((t) => t.id !== tid))
  }, [])
  // Snooze a fired timer: restart it for `secs` more (clears the alarm).
  const snoozeTimer = useCallback((tid: number, secs: number) => {
    setTimers((ts) => ts.map((t) => (t.id === tid ? { ...t, remainingSeconds: secs, running: true, firing: false } : t)))
  }, [])

  const total = steps.length
  const firingTimers = timers.filter((t) => t.firing)
  const runningTimers = timers.filter((t) => !t.firing)
  // "Jump to step" from the alarm: leave the done screen, go to that step, clear it.
  // Dock (still-running timer): return to its step but KEEP the timer running.
  const jumpToStep = useCallback((t: CookTimer) => {
    setDone(false)
    setI(Math.max(0, Math.min(t.stepIndex, total - 1)))
  }, [total, setDone, setI])
  // Alarm (fired timer): jump to the step and clear the finished alarm.
  const jumpToTimer = useCallback((t: CookTimer) => {
    jumpToStep(t)
    dismissTimer(t.id)
  }, [jumpToStep, dismissTimer])

  if (total === 0) {
    const empty = <div className="muted" style={{ padding: 30 }}>No steps recorded for this recipe — nothing to cook through.</div>
    return header ? <div className="cookmode">{header}{empty}</div> : empty
  }

  function finish() {
    setDone(true)
    mealsApi.markCooked(recipeId).catch(() => {})
    // Offer to update the pantry with what this recipe likely used.
    pantryApi.forRecipe(recipeId).then((m) => { if (m.length) { setUsedMatches(m); setSheetOpen(true) } }).catch(() => {})
  }

  if (done) {
    return (
      <div className="cookmode cm-done">
        {header}
        <div className="cm-done-emoji">🎉</div>
        <div className="wf-serif cm-done-h">Nicely done.</div>
        <div className="muted cm-done-sub">“{title}” is marked as cooked.</div>
        <div className="cm-done-actions">
          <button className="btn btn-ghost" onClick={() => { setDone(false); setI(0) }}>↻ Start over</button>
          {usedMatches.length > 0 && (
            <button className="btn btn-ghost" onClick={() => setSheetOpen(true)}>🧺 Update pantry</button>
          )}
          <button className="btn btn-primary" onClick={onExit}>{exitLabel}</button>
        </div>
        <TimerDock timers={runningTimers} onToggle={toggleTimer} onDismiss={dismissTimer} onJump={jumpToStep} />
        <TimerAlarm firing={firingTimers} onDismiss={dismissTimer} onSnooze={snoozeTimer} onJump={jumpToTimer} />
        {sheetOpen && (
          <CookConfirm title={title} matches={usedMatches} onClose={() => setSheetOpen(false)} />
        )}
      </div>
    )
  }

  const at = Math.max(0, Math.min(i, total - 1))
  const step = steps[at]
  const pct = Math.round(((at + 1) / total) * 100)

  return (
    <div className="cookmode">
      {header}
      <div className="cm-progress"><span style={{ width: `${pct}%` }} /></div>

      <div className="cm-stage">
        <div className="cm-step-n">Step {at + 1}</div>
        <div className="cm-instruction wf-serif">{step.instruction}</div>

        {step.ingredients.length > 0 && (
          <div className="cm-ings">
            <div className="cm-ings-label">For this step</div>
            <div className="cm-ings-row">
              {step.ingredients.map((ig, k) => (
                <span key={k} className="cm-ing-chip">{ig}</span>
              ))}
            </div>
          </div>
        )}

        {step.note && <div className="cm-note">📝 {step.note}</div>}

        {step.timerSeconds != null && step.timerSeconds > 0 ? (
          <button
            className="cm-timer-start"
            onClick={() => startTimer(`Step ${at + 1}`, step.timerSeconds!, at)}
          >
            ⏱ Start {fmt(step.timerSeconds)}
          </button>
        ) : (
          <AddTimer
            key={at}
            onStart={(secs) => startTimer(`Step ${at + 1}`, secs, at)}
          />
        )}
      </div>

      <div className="cm-controls">
        <button className="cm-nav" disabled={at === 0} onClick={() => setI((n) => Math.max(0, n - 1))}>‹ Back</button>
        <button className="cm-allbtn" onClick={() => setShowAll(true)}>All ingredients</button>
        {at < total - 1 ? (
          <button className="cm-nav cm-next" onClick={() => setI((n) => Math.min(total - 1, n + 1))}>Next ›</button>
        ) : (
          <button className="cm-nav cm-finish" onClick={finish}>✓ Finish &amp; mark cooked</button>
        )}
      </div>

      {showAll && (
        <div className="modal-overlay" onClick={() => setShowAll(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <button type="button" className="modal-close" aria-label="Close" onClick={() => setShowAll(false)}>×</button>
            <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 12 }}>All ingredients</div>
            <div className="cm-all-list">
              {ingredients.map((ing) => (
                <div key={ing.id} className="cm-all-row">
                  <span className="cm-all-amt">{ing.amount != null ? `${ing.amount}${ing.unit ? ` ${ing.unit}` : ''}` : '—'}</span>
                  <span>{ing.sub ?? ing.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <TimerDock timers={runningTimers} onToggle={toggleTimer} onDismiss={dismissTimer} onJump={jumpToStep} />
      <TimerAlarm firing={firingTimers} onDismiss={dismissTimer} onSnooze={snoozeTimer} onJump={jumpToTimer} />
    </div>
  )
}

// On-the-spot timer for a step the author never gave one. Collapsed to a single
// "Add timer" button; expands to minute + optional second inputs and starts an
// ephemeral (runtime-only) timer via the same startTimer path as built-in ones —
// so it lives in the dock, chimes, and stays tied to its step. `key={i}` resets it
// per step. No backend: the added timer is never persisted to step.timerSeconds.
function AddTimer({ onStart }: { onStart: (secs: number) => void }) {
  const [open, setOpen] = useState(false)
  const [min, setMin] = useState('')
  const [sec, setSec] = useState('')

  if (!open) {
    return (
      <button type="button" className="re-timer-add cm-timer-add" onClick={() => setOpen(true)}>
        ⏱ Add timer
      </button>
    )
  }

  const secs = Math.max(0, Math.floor(Number(min) || 0)) * 60 + Math.max(0, Math.floor(Number(sec) || 0))
  const start = () => {
    if (secs <= 0) return
    onStart(secs)
    setOpen(false)
    setMin('')
    setSec('')
  }

  // Mirrors StepTimerControl's expanded look (recipe.css .re-timer-edit row) so the
  // on-the-spot timer matches the shared timer component instead of raw HTML.
  return (
    <span className="re-timer-edit cm-timer-add-edit">
      <span className="re-timer-ic" aria-hidden>⏱</span>
      <input
        type="number"
        min={0}
        inputMode="numeric"
        className="re-timer-num"
        aria-label="Minutes"
        placeholder="0"
        value={min}
        autoFocus
        onChange={(e) => setMin(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && start()}
      />
      <span className="re-timer-unit">min</span>
      <input
        type="number"
        min={0}
        max={59}
        inputMode="numeric"
        className="re-timer-num"
        aria-label="Seconds"
        placeholder="0"
        value={sec}
        onChange={(e) => setSec(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && start()}
      />
      <span className="re-timer-unit">sec</span>
      <button type="button" className="re-timer-done" aria-label="Start timer" disabled={secs <= 0} onClick={start}>✓</button>
      <button type="button" className="re-timer-cancel" aria-label="Cancel" onClick={() => setOpen(false)}>×</button>
    </span>
  )
}

// Full-screen takeover when one or more timers hit zero — large, centered, and
// flashing so it grabs attention across the kitchen (the corner dock didn't). Each
// fired timer can be snoozed (+1:00) or dismissed; the chime repeats until cleared.
function TimerAlarm({
  firing,
  onDismiss,
  onSnooze,
  onJump,
}: {
  firing: CookTimer[]
  onDismiss: (id: number) => void
  onSnooze: (id: number, secs: number) => void
  onJump: (t: CookTimer) => void
}) {
  if (firing.length === 0) return null
  return (
    <div className="cm-alarm" role="alertdialog" aria-label="Timer finished">
      <div className="cm-alarm-card">
        <div className="cm-alarm-ic" aria-hidden>⏱</div>
        <div className="cm-alarm-h wf-serif">{firing.length > 1 ? `${firing.length} timers done` : 'Timer done'}</div>
        <div className="cm-alarm-list">
          {firing.map((t) => (
            <div key={t.id} className="cm-alarm-row">
              <span className="cm-alarm-label">{t.label} · {fmt(t.totalSeconds)}</span>
              <div className="cm-alarm-actions">
                <button className="cm-alarm-jump" onClick={() => onJump(t)}>Jump to step</button>
                <button className="cm-alarm-snooze" onClick={() => onSnooze(t.id, 60)}>+1:00</button>
                <button className="cm-alarm-dismiss" onClick={() => onDismiss(t.id)}>Dismiss</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// Fixed-position dock listing every active timer above the whole view. Multiple
// concurrent timers stack; a fired one flashes (.cm-timer-firing) until dismissed.
function TimerDock({
  timers,
  onToggle,
  onDismiss,
  onJump,
}: {
  timers: CookTimer[]
  onToggle: (id: number) => void
  onDismiss: (id: number) => void
  onJump: (t: CookTimer) => void
}) {
  if (timers.length === 0) return null
  return (
    <div className="cm-timers" role="status" aria-live="polite">
      {timers.map((t) => (
        <div key={t.id} className={`cm-timer${t.firing ? ' cm-timer-firing' : ''}`}>
          <div
            className="cm-timer-info"
            role="button"
            tabIndex={0}
            title="Jump to this step"
            aria-label={`Jump to this step — ${t.label}`}
            onClick={() => onJump(t)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onJump(t)}
          >
            <div className="cm-timer-label">{t.label}</div>
            <div className="cm-timer-time">{t.firing ? 'Done!' : fmt(t.remainingSeconds)}</div>
          </div>
          {!t.firing && (
            <button
              className="cm-timer-btn"
              aria-label={t.running ? 'Pause timer' : 'Resume timer'}
              onClick={() => onToggle(t.id)}
            >
              {t.running ? '❚❚' : '►'}
            </button>
          )}
          <button className="cm-timer-btn cm-timer-x" aria-label="Dismiss timer" onClick={() => onDismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  )
}
