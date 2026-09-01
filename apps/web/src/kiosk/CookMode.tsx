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
import { CHECK } from './components/CheckGlyph'
import { CookConfirm } from './components/CookConfirm'
import { CookTabs, type CookTabInfo } from './components/CookTabs'
import { useCookPlate } from './components/CookDishes'
import { fmt, useCookTimers, type CookTimer } from './components/CookTimers'
import './../styles/cookmode.css'

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

// Ticked ingredients are a set of keys. A step names its ingredients as free text
// ("4 cloves garlic") while the recipe's list holds rows with ids, so the two views
// are tied together by the longest ingredient name the chip actually contains — the
// same longest-name-wins rule the editor uses to parse a pasted recipe. A chip that
// matches no row ("a pinch of salt") keys off its own text: still tickable, just not
// tied to a row. Ticks are for the session only — like step position, nothing is
// written to the server.
// Does `name` appear in `text` starting where a word starts? Plain containment was
// too eager: it matched a name buried inside a longer word — "oil" inside "boiling",
// "ice" inside "rice" — so a step chip struck an ingredient the step never named.
// The END is deliberately left unchecked, which is what keeps a plural matching its
// singular ("onion" in "2 onions"). Both sides are already lowercased.
// Mirrored by `namesWordIn` in CookSession.swift — keep the two in step.
function nameStartsAWord(text: string, name: string): boolean {
  for (let i = text.indexOf(name); i !== -1; i = text.indexOf(name, i + 1)) {
    if (i === 0 || !/[\p{L}\p{N}]/u.test(text[i - 1])) return true
  }
  return false
}

export function ingredientKey(chip: string, ingredients: RecipeIngredient[]): string {
  const lc = chip.trim().toLowerCase()
  const match = ingredients
    .map((ing) => ({ ing, name: ing.name.trim().toLowerCase() }))
    .filter(({ name }) => name && nameStartsAWord(lc, name))
    .sort((a, b) => b.name.length - a.name.length)[0]
  return match ? match.ing.id : `text:${lc}`
}

const toggleKey = (keys: Set<string>, key: string): Set<string> => {
  const next = new Set(keys)
  if (!next.delete(key)) next.add(key)
  return next
}

// Stable empty set so a dish with nothing ticked doesn't re-render on every pass.
const NO_TICKS: ReadonlySet<string> = new Set<string>()

// ── one recipe ────────────────────────────────────────────────────────────────
function CookRecipe({ recipeId }: { recipeId: string | null }) {
  const navigate = useNavigate()
  const { recipe, ingredients, steps, loading, error } = useRecipe(recipeId)
  const [i, setI] = useState(0)
  const [done, setDone] = useState(false)
  const [ticked, setTicked] = useState<ReadonlySet<string>>(NO_TICKS)
  const toggleTick = useCallback((key: string) => setTicked((s) => toggleKey(s as Set<string>, key)), [])
  // Timers live above the cooking body here too, so both routes share one store —
  // with a single dish there's nothing to switch between, so this is invisible.
  const timers = useCookTimers()

  const total = steps.length
  // Dock (still-running timer): return to its step but KEEP it running.
  const jumpToStep = useCallback((t: CookTimer) => {
    setDone(false)
    setI(Math.max(0, Math.min(t.stepIndex, total - 1)))
  }, [total])
  // Alarm (fired timer): jump to the step and clear the finished alarm.
  const jumpFromAlarm = useCallback((t: CookTimer) => {
    jumpToStep(t)
    timers.dismiss(t.id)
  }, [jumpToStep, timers])
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
    <>
      <CookSession
        recipeId={recipe.id}
        title={recipe.title}
        ingredients={ingredients}
        steps={steps}
        i={i}
        setI={setI}
        done={done}
        setDone={setDone}
        ticked={ticked}
        onTick={toggleTick}
        onExit={exit}
        exitLabel="Back to recipe"
        onStartTimer={(stepIndex, totalSeconds) =>
          timers.start({ recipeId: recipe.id, dishLabel: recipe.title, dishEmoji: null, stepIndex, totalSeconds })
        }
      />
      {/* One dish, so no dish line — the dock and alarm read exactly as they always have. */}
      <TimerDock timers={timers.running} onToggle={timers.toggle} onDismiss={timers.dismiss} onJump={jumpToStep} />
      <TimerAlarm firing={timers.firing} onDismiss={timers.dismiss} onSnooze={timers.snooze} onJump={jumpFromAlarm} />
    </>
  )
}

// ── a whole plate ─────────────────────────────────────────────────────────────
// Every dish keeps its own step position, its own "cooked" state and — crucially —
// its timers, all held here so they survive tab switches. The session below is keyed
// by dish and remounts when you switch, so anything that has to outlive a tab switch
// lives at this level: the chicken's timer keeps counting down while you're making
// the potato salad.
function CookPlate({ mealId }: { mealId: string | null }) {
  const navigate = useNavigate()
  const { name, dishes, loading, error } = useCookPlate(mealId)
  const [active, setActive] = useState(0)
  const [stepByDish, setStepByDish] = useState<Record<string, number>>({})
  const [doneByDish, setDoneByDish] = useState<Record<string, boolean>>({})
  const [tickedByDish, setTickedByDish] = useState<Record<string, ReadonlySet<string>>>({})
  const timers = useCookTimers()

  // Tapping a timer anywhere on the plate takes you to ITS dish and ITS step —
  // clamped against that dish's own step count, not the one you're looking at.
  const jumpToDish = useCallback((t: CookTimer) => {
    const k = dishes.findIndex((d) => d.recipeId === t.recipeId)
    if (k < 0) return
    const at = Math.max(0, Math.min(t.stepIndex, dishes[k].steps.length - 1))
    setActive(k)
    setStepByDish((m) => ({ ...m, [t.recipeId]: at }))
    setDoneByDish((m) => ({ ...m, [t.recipeId]: false }))
  }, [dishes])
  const jumpFromAlarm = useCallback((t: CookTimer) => {
    jumpToDish(t)
    timers.dismiss(t.id)
  }, [jumpToDish, timers])

  const index = dishes.length > 0 ? Math.min(active, dishes.length - 1) : 0
  const dish = dishes[index] ?? null
  const rid = dish?.recipeId ?? null
  const i = rid ? stepByDish[rid] ?? 0 : 0
  const done = rid ? !!doneByDish[rid] : false
  const ticked = (rid ? tickedByDish[rid] : null) ?? NO_TICKS
  const total = dish?.steps.length ?? 0

  // Ticked ingredients are per dish and belong up here for the same reason the step
  // position does: the session below remounts on every tab switch.
  const toggleTick = useCallback(
    (key: string) => {
      if (!rid) return
      setTickedByDish((m) => ({ ...m, [rid]: toggleKey((m[rid] ?? NO_TICKS) as Set<string>, key) }))
    },
    [rid]
  )

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
    <>
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
        ticked={ticked}
        onTick={toggleTick}
        onExit={exit}
        exitLabel="Back to the plate"
        header={<CookTabs tabs={tabs} activeIndex={index} onSelect={setActive} />}
        onStartTimer={(stepIndex, totalSeconds) =>
          timers.start({ recipeId: dish.recipeId, dishLabel: dish.title, dishEmoji: dish.emoji, stepIndex, totalSeconds })
        }
      />
      {/* Everything running across the whole plate, each entry naming its dish. */}
      <TimerDock timers={timers.running} showDish onToggle={timers.toggle} onDismiss={timers.dismiss} onJump={jumpToDish} />
      <TimerAlarm firing={timers.firing} showDish onDismiss={timers.dismiss} onSnooze={timers.snooze} onJump={jumpFromAlarm} />
    </>
  )
}

// ── the cooking body ──────────────────────────────────────────────────────────
// One dish's worth of cooking: the step stage, the controls and the all-ingredients
// modal. Step position, "cooked" and the timers all live above (per recipe or per
// dish) — on a plate this component is keyed by dish and remounts on every tab
// switch, so nothing that must outlive a switch may be held here.
function CookSession({
  recipeId,
  title,
  ingredients,
  steps,
  i,
  setI,
  done,
  setDone,
  ticked,
  onTick,
  onExit,
  exitLabel,
  header,
  onStartTimer,
}: {
  recipeId: string
  title: string
  ingredients: RecipeIngredient[]
  steps: RecipeStep[]
  i: number
  setI: Dispatch<SetStateAction<number>>
  done: boolean
  setDone: Dispatch<SetStateAction<boolean>>
  ticked: ReadonlySet<string>
  onTick: (key: string) => void
  onExit: () => void
  exitLabel: string
  header?: ReactNode
  onStartTimer: (stepIndex: number, totalSeconds: number) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const [usedMatches, setUsedMatches] = useState<RecipeMatch[]>([])
  const [sheetOpen, setSheetOpen] = useState(false)
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

  const total = steps.length

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
              {step.ingredients.map((ig, k) => {
                const key = ingredientKey(ig, ingredients)
                const on = ticked.has(key)
                return (
                  <button
                    key={k}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    className={`cm-ing-chip ${on ? 'on' : ''}`}
                    onClick={() => onTick(key)}
                  >
                    <span className="cm-ing-box" aria-hidden="true">{on ? CHECK : null}</span>
                    <span>{ig}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {step.note && <div className="cm-note">📝 {step.note}</div>}

        {step.timerSeconds != null && step.timerSeconds > 0 ? (
          <button
            className="cm-timer-start"
            onClick={() => onStartTimer(at, step.timerSeconds!)}
          >
            ⏱ Start {fmt(step.timerSeconds)}
          </button>
        ) : (
          <AddTimer key={at} onStart={(secs) => onStartTimer(at, secs)} />
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
            <div className="cm-all-head">
              <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600 }}>All ingredients</div>
              {ingredients.length > 0 && (
                <div className="tiny muted cm-all-count">
                  {ingredients.filter((ing) => ticked.has(ing.id)).length} of {ingredients.length}
                </div>
              )}
            </div>
            <div className="cm-all-list">
              {ingredients.map((ing) => {
                const on = ticked.has(ing.id)
                return (
                  <button
                    key={ing.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    className={`cm-all-row ${on ? 'done' : ''}`}
                    onClick={() => onTick(ing.id)}
                  >
                    <span className="cm-all-box" aria-hidden="true">{on ? CHECK : null}</span>
                    <span className="cm-all-amt">{ing.amount != null ? `${ing.amount}${ing.unit ? ` ${ing.unit}` : ''}` : '—'}</span>
                    <span className="cm-all-nm">{ing.sub ?? ing.name}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

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
// On a plate every row leads with its dish: an alarm you can't attribute to a dish is
// worse than no alarm at all when three things are on the stove.
function TimerAlarm({
  firing,
  showDish,
  onDismiss,
  onSnooze,
  onJump,
}: {
  firing: CookTimer[]
  showDish?: boolean
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
              <span className="cm-alarm-label">
                {showDish && (
                  <span className="cm-alarm-dish">
                    <span aria-hidden>{t.dishEmoji ?? '🍽️'}</span> {t.dishLabel}
                  </span>
                )}
                {t.label} · {fmt(t.totalSeconds)}
              </span>
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
// On a plate this is the cross-dish view: every timer running anywhere on the plate,
// each naming its dish, and tapping one takes you to that dish's step.
function TimerDock({
  timers,
  showDish,
  onToggle,
  onDismiss,
  onJump,
}: {
  timers: CookTimer[]
  showDish?: boolean
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
            title={showDish ? `Jump to ${t.dishLabel} — ${t.label}` : 'Jump to this step'}
            aria-label={`Jump to this step — ${showDish ? `${t.dishLabel} · ` : ''}${t.label}`}
            onClick={() => onJump(t)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onJump(t)}
          >
            {showDish && (
              <div className="cm-timer-dish">
                <span aria-hidden>{t.dishEmoji ?? '🍽️'}</span> {t.dishLabel}
              </div>
            )}
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
