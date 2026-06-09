import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

// Lets the active screen render content into the topbar's right slot (where the
// AI capture bar sits by default), matching the per-screen topbars in the
// handoff (Today = AI bar, Goals = "New goal", etc).
type SlotCtx = { node: ReactNode; set: (n: ReactNode) => void }
const Ctx = createContext<SlotCtx>({ node: null, set: () => {} })

export function TopbarSlotProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<ReactNode>(null)
  return <Ctx.Provider value={{ node, set: setNode }}>{children}</Ctx.Provider>
}

export function useTopbarSlotNode(): ReactNode {
  return useContext(Ctx).node
}

// Screens call this to fill the topbar's right slot. `render` is re-invoked when
// `deps` change; keep handlers stable (router navigate / state setters) so the
// default empty deps stay correct.
export function useTopbarRight(render: () => ReactNode, deps: unknown[]): void {
  const { set } = useContext(Ctx)
  useEffect(() => {
    set(render())
    return () => set(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
