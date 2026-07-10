import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react'
import { AgendaCard } from './components/AgendaCard'
import { TonightCardSlot, WeekDinnersCard } from './components/MealsColumn'
import { ChoresCard } from './components/ChoresCard'
import { GroceryCard } from './components/GroceryCard'
import { CountdownsCard } from './components/CountdownsCard'
import { FamilyNightCard } from './components/FamilyNightCard'
import { GoalSpotlightCard } from './components/GoalSpotlightCard'
import { GoalRecapBar } from './components/GoalRecap'
import { ApprovalsBar } from './components/Approvals'
import { CaptureBar } from './components/CaptureBar'
import { GettingStartedBar } from './onboarding/GettingStarted'
import { PantryCard } from './Pantry'
import { useTopbarRight } from './topbar-slot'
import { useTodayLayout, useHousehold, type LayoutScope } from '../lib/api'
import { moduleEnabled, rewardsEnabled } from '../lib/modules'

// The cards that can live on Today, keyed the same as the stored layout. `fill`
// cards are long, scrollable lists (agenda, grocery) — they take the spare room in
// their column and scroll INSIDE the card, so a 30-item grocery list never stretches
// the column. Everything else sizes to its content (never shrinks/clips). The label
// shows in the Customize drag bar (and covers cards that render nothing, like
// Tonight with no dinner planned).
const CARDS: Record<string, { label: string; node: ReactNode; fill?: boolean }> = {
  agenda: { label: 'Agenda', node: <AgendaCard />, fill: true },
  tonight: { label: "Tonight's dinner", node: <TonightCardSlot /> },
  week: { label: "This week's dinners", node: <WeekDinnersCard /> },
  chores: { label: 'Family Chores', node: <ChoresCard /> },
  grocery: { label: 'Grocery', node: <GroceryCard />, fill: true },
  countdowns: { label: 'Countdowns', node: <CountdownsCard /> },
  familyNight: { label: 'Family Night', node: <FamilyNightCard /> },
  goals: { label: 'Goals', node: <GoalSpotlightCard /> },
  pantry: { label: 'Pantry', node: <PantryCard /> },
}

// Layout helpers (pure). A card lives in exactly one column.
function removeCard(layout: string[][], card: string): string[][] {
  return layout.map((col) => col.filter((c) => c !== card))
}

// Reconcile an optional module's card with the saved layout: drop it when the
// module is off/hidden; inject it (into the shortest column) when it's on but the
// saved layout doesn't have it yet. Preserves a user-placed position once saved.
function applyModuleCard(layout: string[][], card: string, show: boolean, preferCol?: number): string[][] {
  const present = layout.some((col) => col.includes(card))
  if (show && !present) {
    const cols = layout.map((c) => [...c])
    // Prefer a specific column when asked (e.g. pantry defaults to the middle),
    // otherwise fall back to the shortest column.
    let target = preferCol != null && preferCol >= 0 && preferCol < cols.length ? preferCol : 0
    if (preferCol == null) for (let i = 1; i < cols.length; i++) if (cols[i].length < cols[target].length) target = i
    cols[target] = [...cols[target], card]
    return cols
  }
  if (!show && present) return removeCard(layout, card)
  return layout
}

// For cards that ship in the default layout (chores/meals/grocery): strip them
// when their module is off, but never inject — so a user who removed the card in
// Customize keeps it removed while the module is on. (Pantry, which isn't in the
// default layout, uses applyModuleCard to appear when enabled.)
function hideModuleCard(layout: string[][], card: string, show: boolean): string[][] {
  return show ? layout : removeCard(layout, card)
}

// Which column + insertion index is under the pointer, read from the live DOM
// (columns carry data-col, cards data-card). The dragged card isn't rendered
// during a drag, so indices map straight into the card's would-be position.
function dropTargetAt(x: number, y: number): { col: number; index: number } | null {
  const el = document.elementFromPoint(x, y)
  const colEl = el && (el as Element).closest('[data-col]')
  if (!colEl) return null
  const col = Number(colEl.getAttribute('data-col'))
  const cards = [...colEl.querySelectorAll('[data-card]')]
  let index = cards.length
  for (let k = 0; k < cards.length; k++) {
    const r = cards[k].getBoundingClientRect()
    if (y < r.top + r.height / 2) {
      index = k
      break
    }
  }
  return { col, index }
}

// The kiosk "Today" dashboard. Cards are arranged from a saved layout (family
// default + optional per-person override) and can be rearranged in a Customize
// mode via drag-and-drop, then saved for just you or the whole family.
export function Today() {
  const { resolved, source, loading, save, reset } = useTodayLayout()
  const { household } = useHousehold()
  // Optional-module cards: shown when the module is enabled and not hidden from Today.
  // Pantry appears when on (not in the default layout); chores/meals/grocery cards
  // ship in the default layout, so we only strip them when their module is off.
  const showPantry = moduleEnabled(household, 'pantry') && household?.settings?.pantry?.showOnToday !== false
  const showChores = moduleEnabled(household, 'chores')
  const showMeals = moduleEnabled(household, 'meals')
  const showGrocery = moduleEnabled(household, 'lists')
  const showFamilyNight = moduleEnabled(household, 'familyNight') && household?.settings?.familyNight?.showOnToday !== false
  const showGoals = moduleEnabled(household, 'goals')
  const effectiveResolved = useMemo(() => {
    let l = applyModuleCard(resolved, 'pantry', showPantry, 1) // pantry → middle column by default
    l = applyModuleCard(l, 'familyNight', showFamilyNight)
    l = applyModuleCard(l, 'goals', showGoals, 0) // goals → left column by default
    l = hideModuleCard(l, 'chores', showChores)
    l = hideModuleCard(l, 'tonight', showMeals)
    l = hideModuleCard(l, 'week', showMeals)
    l = hideModuleCard(l, 'grocery', showGrocery)
    return l
  }, [resolved, showPantry, showFamilyNight, showGoals, showChores, showMeals, showGrocery])
  const [editing, setEditing] = useState(false)
  const [layout, setLayout] = useState<string[][]>(effectiveResolved)
  const [saving, setSaving] = useState(false)

  // Pointer drag state (edit mode only). `drag` is set once per drag so the
  // listener effect subscribes once; `pos` drives the ghost, `target` the drop
  // indicator (read live via ref on drop).
  const [drag, setDrag] = useState<{ card: string } | null>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [target, setTarget] = useState<{ col: number; index: number } | null>(null)
  const targetRef = useRef<{ col: number; index: number } | null>(null)
  targetRef.current = target

  // Keep the working copy in sync with the server layout (+ module cards) when not editing.
  useEffect(() => {
    if (!editing) setLayout(effectiveResolved)
  }, [effectiveResolved, editing])

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      setPos({ x: e.clientX, y: e.clientY })
      setTarget(dropTargetAt(e.clientX, e.clientY))
    }
    const up = () => {
      const t = targetRef.current
      if (t) {
        setLayout((prev) => {
          const base = removeCard(prev, drag.card).map((c) => [...c])
          ;(base[t.col] ?? base[base.length - 1]).splice(t.index, 0, drag.card)
          return base
        })
      }
      setDrag(null)
      setTarget(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
    }
  }, [drag])

  // Customize button lives in the topbar, to the left of the "Add anything" bar.
  // Only shown in view mode; the edit toolbar below handles save/cancel. (layout
  // is kept synced to resolved while not editing, so entering edit needs no snapshot.)
  useTopbarRight(
    () =>
      editing ? (
        <CaptureBar />
      ) : (
        <div className="tb-today-actions">
          <button type="button" className="pill today-customize" disabled={loading} onClick={() => setEditing(true)}>
            ⠿ Customize
            {source === 'user' && <span className="today-src-tag">personal</span>}
          </button>
          <CaptureBar />
        </div>
      ),
    [editing, source, loading]
  )

  function startDrag(e: ReactPointerEvent, card: string) {
    e.preventDefault()
    setPos({ x: e.clientX, y: e.clientY })
    setTarget(null)
    setDrag({ card })
  }

  function cancel() {
    setEditing(false)
    setDrag(null)
    setLayout(resolved)
  }
  async function persist(scope: LayoutScope) {
    setSaving(true)
    try {
      await save(scope, layout)
      setEditing(false)
      setDrag(null)
    } finally {
      setSaving(false)
    }
  }
  async function resetDefault() {
    setSaving(true)
    try {
      await reset('user')
      setEditing(false)
      setDrag(null)
    } finally {
      setSaving(false)
    }
  }

  // During a drag, render the layout without the dragged card so the drop
  // indicator and indices line up; otherwise render the working/resolved layout.
  const cols = editing ? layout : effectiveResolved
  const display = drag ? removeCard(cols, drag.card) : cols

  return (
    <div className={`today-wrap ${editing ? 'today-editing' : ''}`}>
      <GettingStartedBar />
      {(showChores || rewardsEnabled(household)) && <ApprovalsBar />}
      {moduleEnabled(household, 'goals') && <GoalRecapBar />}

      {editing && (
        <div className="today-toolbar">
          <span className="tiny muted today-toolbar-hint">Drag a card by its bar to rearrange</span>
          <button type="button" className="pill" style={{ cursor: 'pointer' }} disabled={saving} onClick={cancel}>Cancel</button>
          <button type="button" className="pill" style={{ cursor: 'pointer' }} disabled={saving} onClick={resetDefault}>Reset to defaults</button>
          <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0, cursor: 'pointer' }} disabled={saving} onClick={() => persist('user')}>Save for me</button>
        </div>
      )}

      <div className={`today-board ${editing ? 'editing' : ''}`}>
        {display.map((col, ci) => (
          <div className="today-col" data-col={ci} key={ci}>
            {col.map((card, idx) => {
              const def = CARDS[card]
              if (!def) return null
              return (
                <Fragment key={card}>
                  {editing && drag && target?.col === ci && target?.index === idx && <div className="today-drop-line" />}
                  {editing ? (
                    <div className="today-card-wrap" data-card={card}>
                      <div className="today-card-bar" onPointerDown={(e) => startDrag(e, card)}>
                        <span className="today-card-grip">⠿</span>
                        <span className="today-card-name">{def.label}</span>
                      </div>
                      <div className="today-card-inner">{def.node}</div>
                    </div>
                  ) : (
                    <div className={`today-slot ${def.fill ? 'fill' : ''}`}>{def.node}</div>
                  )}
                </Fragment>
              )
            })}
            {editing && drag && target?.col === ci && target?.index === col.length && <div className="today-drop-line" />}
            {editing && col.length === 0 && <div className="today-col-empty">Drop a card here</div>}
          </div>
        ))}
      </div>

      {drag && (
        <div className="today-drag-ghost" style={{ left: pos.x, top: pos.y }}>
          ⠿ {CARDS[drag.card]?.label}
        </div>
      )}
    </div>
  )
}
