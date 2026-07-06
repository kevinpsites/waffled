import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useTopbarFull } from './topbar-slot'
import { mealsApi, pantryApi, useRecipe, type RecipeMatch } from '../lib/api'
import { CookConfirm } from './components/CookConfirm'
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
export function CookMode() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { recipe, ingredients, steps, loading, error } = useRecipe(id ?? null)
  const [i, setI] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const [done, setDone] = useState(false)
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

  const firingTimers = timers.filter((t) => t.firing)
  const runningTimers = timers.filter((t) => !t.firing)
  // "Jump to step" from the alarm: leave the done screen, go to that step, clear it.
  const jumpToTimer = useCallback((t: CookTimer) => {
    setDone(false)
    setI(Math.max(0, Math.min(t.stepIndex, steps.length - 1)))
    dismissTimer(t.id)
  }, [steps.length, dismissTimer])

  const total = steps.length
  // Replace (not push) the cook-mode history entry with the recipe so pressing
  // back from the recipe goes to wherever you came from (Today, the meal plan)
  // instead of bouncing back into cook mode — that round-trip was an endless loop.
  const exit = () => navigate(`/meals/recipe/${id}`, { replace: true })

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
    [recipe?.title, i, total, done, id]
  )

  if (loading) return <div className="muted" style={{ padding: 30 }}>Loading…</div>
  if (error || !recipe) return <div className="muted" style={{ padding: 30 }}>This recipe isn’t available.</div>
  if (total === 0) return <div className="muted" style={{ padding: 30 }}>No steps recorded for this recipe — nothing to cook through.</div>

  function finish() {
    setDone(true)
    if (recipe) {
      mealsApi.markCooked(recipe.id).catch(() => {})
      // Offer to update the pantry with what this recipe likely used.
      pantryApi.forRecipe(recipe.id).then((m) => { if (m.length) { setUsedMatches(m); setSheetOpen(true) } }).catch(() => {})
    }
  }

  if (done) {
    return (
      <div className="cookmode cm-done">
        <div className="cm-done-emoji">🎉</div>
        <div className="wf-serif cm-done-h">Nicely done.</div>
        <div className="muted cm-done-sub">“{recipe.title}” is marked as cooked.</div>
        <div className="cm-done-actions">
          <button className="btn btn-ghost" onClick={() => { setDone(false); setI(0) }}>↻ Start over</button>
          {usedMatches.length > 0 && (
            <button className="btn btn-ghost" onClick={() => setSheetOpen(true)}>🧺 Update pantry</button>
          )}
          <button className="btn btn-primary" onClick={exit}>Back to recipe</button>
        </div>
        <TimerDock timers={runningTimers} onToggle={toggleTimer} onDismiss={dismissTimer} />
        <TimerAlarm firing={firingTimers} onDismiss={dismissTimer} onSnooze={snoozeTimer} onJump={jumpToTimer} />
        {sheetOpen && (
          <CookConfirm title={recipe.title} matches={usedMatches} onClose={() => setSheetOpen(false)} />
        )}
      </div>
    )
  }

  const step = steps[i]
  const pct = Math.round(((i + 1) / total) * 100)

  return (
    <div className="cookmode">
      <div className="cm-progress"><span style={{ width: `${pct}%` }} /></div>

      <div className="cm-stage">
        <div className="cm-step-n">Step {i + 1}</div>
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
            onClick={() => startTimer(`Step ${i + 1}`, step.timerSeconds!, i)}
          >
            ⏱ Start {fmt(step.timerSeconds)}
          </button>
        ) : (
          <AddTimer
            key={i}
            onStart={(secs) => startTimer(`Step ${i + 1}`, secs, i)}
          />
        )}
      </div>

      <div className="cm-controls">
        <button className="cm-nav" disabled={i === 0} onClick={() => setI((n) => Math.max(0, n - 1))}>‹ Back</button>
        <button className="cm-allbtn" onClick={() => setShowAll(true)}>All ingredients</button>
        {i < total - 1 ? (
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

      <TimerDock timers={runningTimers} onToggle={toggleTimer} onDismiss={dismissTimer} />
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
      <button className="cm-timer-start cm-timer-add" onClick={() => setOpen(true)}>
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

  return (
    <div className="cm-timer-add-form">
      <label className="cm-timer-add-field">
        <span className="cm-timer-add-lbl">Minutes</span>
        <input
          type="number"
          min={0}
          inputMode="numeric"
          aria-label="Minutes"
          value={min}
          autoFocus
          onChange={(e) => setMin(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && start()}
        />
      </label>
      <label className="cm-timer-add-field">
        <span className="cm-timer-add-lbl">Seconds</span>
        <input
          type="number"
          min={0}
          max={59}
          inputMode="numeric"
          aria-label="Seconds"
          value={sec}
          onChange={(e) => setSec(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && start()}
        />
      </label>
      <button className="cm-timer-add-go" disabled={secs <= 0} onClick={start}>Start</button>
      <button className="cm-timer-add-cancel" onClick={() => setOpen(false)}>Cancel</button>
    </div>
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
}: {
  timers: CookTimer[]
  onToggle: (id: number) => void
  onDismiss: (id: number) => void
}) {
  if (timers.length === 0) return null
  return (
    <div className="cm-timers" role="status" aria-live="polite">
      {timers.map((t) => (
        <div key={t.id} className={`cm-timer${t.firing ? ' cm-timer-firing' : ''}`}>
          <div className="cm-timer-info">
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
