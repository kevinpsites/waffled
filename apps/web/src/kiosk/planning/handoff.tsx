import { createContext, useContext, useEffect, useRef } from 'react'

/**
 * The step-relevant action on the shell's parked-note banner.
 *
 * The banner belongs to the shell — identical on every step, and the shell refetches
 * after a write, so a note dealt with anywhere stops being offered everywhere. Its own
 * answers are bookkeeping, so each step lends it ONE verb ("Make a task", "Make an
 * event"); this context is that loan. A STEP WITHOUT A COMPOSER REGISTERS NOTHING, and
 * the banner keeps saying "Handled" — a button that only ticks the note off promises an
 * action it does not perform.
 */
export interface HandoffAction {
  /** The verb of the step you are standing on — "Make a task", "Make an event". */
  label: string
  /** Open the step's OWN composer, seeded with the note's words. */
  run: (note: string) => void
}

interface HandoffCtxValue {
  register: (action: HandoffAction | null) => void
  /**
   * The step reporting back once its composer closes. TRUE only if something was
   * actually created — settling a note on a cancel throws away the one record that it
   * still needs doing.
   */
  finish: (created: boolean) => void
}

export const HandoffCtx = createContext<HandoffCtxValue>({ register: () => {}, finish: () => {} })

/** Lend the banner this step's verb while the step is on screen. Returns the `finish` the step
 * must call when its composer closes. */
export function useHandoffAction(label: string, run: (note: string) => void): (created: boolean) => void {
  const { register, finish } = useContext(HandoffCtx)
  // The run closure changes on every render (it captures the step's own state); the
  // registration must not, or the banner would re-register in a loop.
  const latest = useRef(run)
  latest.current = run
  useEffect(() => {
    register({ label, run: (note) => latest.current(note) })
    return () => register(null)
  }, [label, register])
  return finish
}
