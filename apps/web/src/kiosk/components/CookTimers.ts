// Cook-mode timers, hoisted out of the cooking screen.
//
// A timer belongs to a DISH, not just to "step 3". On a Meal Builder plate the
// cooking body is keyed by dish (switch tabs, it remounts), so timer state cannot
// live down there — the chicken's timer has to keep running while you're elbow-deep
// in the potato salad. This hook owns the whole set for a session: one shared 1s
// ticker for every running timer, one chime while any of them is firing.
//
// Single-recipe cook mode uses the exact same hook with one dish's worth of timers.
// Nothing is persisted — timers are RAM-only on both platforms, deliberately.
//
// See docs/product/meal-builder-plan.md → Cook Mode.
import { useCallback, useEffect, useRef, useState } from 'react'

// A running (or fired) per-step countdown shown in the floating dock.
export interface CookTimer {
  id: number
  // Which dish started it — drives the dock's dish line and jump-to-dish.
  recipeId: string
  dishLabel: string
  dishEmoji: string | null
  label: string // "Step 3"
  stepIndex: number // which step started it — drives "Jump to step"
  totalSeconds: number
  remainingSeconds: number
  running: boolean
  firing: boolean // hit zero; flashes + chimes until dismissed
}

// What a caller has to know to start one: the dish it's for and the step it's on.
export interface CookTimerSpec {
  recipeId: string
  dishLabel: string
  dishEmoji: string | null
  stepIndex: number
  totalSeconds: number
}

export interface CookTimersApi {
  // Everything alive, in start order.
  timers: CookTimer[]
  // Split the way the two surfaces want it: the dock lists what's still counting,
  // the alarm takes over for whatever has fired.
  running: CookTimer[]
  firing: CookTimer[]
  start: (spec: CookTimerSpec) => void
  toggle: (id: number) => void
  dismiss: (id: number) => void
  // Restart a fired timer for `secs` more (clears the alarm).
  snooze: (id: number, secs: number) => void
}

// mm:ss for a duration (clamps negatives to 0).
export function fmt(secs: number): string {
  const s = Math.max(0, Math.floor(secs))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export function useCookTimers(): CookTimersApi {
  const [timers, setTimers] = useState<CookTimer[]>([])
  const nextId = useRef(1)

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

  const start = useCallback((spec: CookTimerSpec) => {
    if (spec.totalSeconds <= 0) return
    setTimers((ts) => [
      ...ts,
      {
        id: nextId.current++,
        recipeId: spec.recipeId,
        dishLabel: spec.dishLabel,
        dishEmoji: spec.dishEmoji,
        label: `Step ${spec.stepIndex + 1}`,
        stepIndex: spec.stepIndex,
        totalSeconds: spec.totalSeconds,
        remainingSeconds: spec.totalSeconds,
        running: true,
        firing: false,
      },
    ])
  }, [])
  const toggle = useCallback((id: number) => {
    setTimers((ts) => ts.map((t) => (t.id === id && !t.firing ? { ...t, running: !t.running } : t)))
  }, [])
  const dismiss = useCallback((id: number) => {
    setTimers((ts) => ts.filter((t) => t.id !== id))
  }, [])
  const snooze = useCallback((id: number, secs: number) => {
    setTimers((ts) => ts.map((t) => (t.id === id ? { ...t, remainingSeconds: secs, running: true, firing: false } : t)))
  }, [])

  return {
    timers,
    running: timers.filter((t) => !t.firing),
    firing: timers.filter((t) => t.firing),
    start,
    toggle,
    dismiss,
    snooze,
  }
}
