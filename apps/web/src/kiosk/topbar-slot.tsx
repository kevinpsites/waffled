import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

// Lets the active screen customize the topbar, matching the per-screen topbars in
// the handoff: most screens keep the date/clock and just fill the right slot
// (Today = AI bar, Goals = "New goal"); a few (create/detail) replace the whole
// bar with a back button + actions.
type SlotCtx = {
  right: ReactNode
  full: ReactNode
  setRight: (n: ReactNode) => void
  setFull: (n: ReactNode) => void
}
const Ctx = createContext<SlotCtx>({ right: null, full: null, setRight: () => {}, setFull: () => {} })

export function TopbarSlotProvider({ children }: { children: ReactNode }) {
  const [right, setRight] = useState<ReactNode>(null)
  const [full, setFull] = useState<ReactNode>(null)
  return <Ctx.Provider value={{ right, full, setRight, setFull }}>{children}</Ctx.Provider>
}

export function useTopbarSlots(): { right: ReactNode; full: ReactNode } {
  const { right, full } = useContext(Ctx)
  return { right, full }
}

// Fill the topbar's right slot (keeps the date/clock). `render` re-runs when
// `deps` change; keep handlers stable (navigate / setters).
export function useTopbarRight(render: () => ReactNode, deps: unknown[]): void {
  const { setRight } = useContext(Ctx)
  useEffect(() => {
    setRight(render())
    return () => setRight(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

// Replace the entire topbar (back button + title + actions screens).
export function useTopbarFull(render: () => ReactNode, deps: unknown[]): void {
  const { setFull } = useContext(Ctx)
  useEffect(() => {
    setFull(render())
    return () => setFull(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
