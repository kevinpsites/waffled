// Meal Builder — compose a named, multi-recipe plate, then schedule it or send it to the grocery
// list. See docs/product/meal-builder-plan.md. Every mutation returns the whole updated plate.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { mealBuilderApi, useMeal, usePersons, type Meal } from '../lib/api'
import { MealBuilderPlate, type DragPayload, type PlateRole } from './components/MealBuilderPlate'
import { MealBuilderLibrary } from './components/MealBuilderLibrary'
import { MealBuilderBar } from './components/MealBuilderBar'
import { MealBuilderScheduleModal } from './components/MealBuilderScheduleModal'
import '../styles/mealbuilder.css'

const NEW_NAME = 'New meal'

type Toast = { text: string; link?: { to: string; label: string } }

// The Meal Builder SCREEN: the body below, wired to the router. Everything that knows about URLs
// lives here, which is what lets the body be embedded with no URL of its own.
export function MealBuilder() {
  const { id: routeId } = useParams()
  const navigate = useNavigate()
  return (
    <MealBuilderBody
      mealId={routeId ?? null}
      onIdChange={(mealId) => navigate(`/meals/build/${mealId}`, { replace: true })}
      onOpenDish={(recipeId) => navigate(`/meals/recipe/${recipeId}`)}
      onCook={(mealId) => navigate(`/meals/meal/${mealId}/cook`)}
      onBack={() => navigate('/meals')}
    />
  )
}

// The builder itself, router-free.
//
// Every optional callback here is a RENDER CONTRACT, not a passive hook: each controls whether its
// affordance exists at all, because each is a place to GO and an embedded builder has nowhere to
// send you. Supply `onUse` and the two "now what?" actions come off the bar.
export function MealBuilderBody({
  mealId: initialId,
  startSaved,
  onIdChange,
  onOpenDish,
  onCook,
  onBack,
  onUse,
  useLabel,
}: {
  mealId?: string | null
  // Create the plate straight into the library — what "＋ New meal" means. `is_saved` is also what
  // makes scheduling COPY it, so editing the night later can't rewrite the plate.
  startSaved?: boolean
  onIdChange?: (mealId: string) => void
  onOpenDish?: (recipeId: string) => void
  onCook?: (mealId: string) => void
  onBack?: () => void
  onUse?: (meal: Meal) => void
  useLabel?: string
}) {
  const routeId = initialId

  // `/meals/build` starts with no id: the plate is created lazily, then the URL swaps.
  const [id, setId] = useState<string | null>(routeId ?? null)
  // Mirrors `id` so an async write can check it without reading stale closure state.
  const idStateRef = useRef<string | null>(routeId ?? null)
  useEffect(() => {
    idStateRef.current = id
  }, [id])
  useEffect(() => {
    if (routeId && routeId !== idStateRef.current) setId(routeId)
  }, [routeId])

  const { meal, loading, error, set } = useMeal(id)
  const { persons } = usePersons()

  // Locally-owned bits of the plate so typing/stepping paints instantly, synced only when a
  // DIFFERENT plate loads. Starts blank so the placeholder invites a name.
  const [name, setName] = useState('')
  const [servings, setServings] = useState(4)
  const [isSaved, setIsSaved] = useState(startSaved ?? false)
  // Adopt a newly-loaded plate's own values DURING render, not in an effect: as an effect it
  // landed a paint late and a stepper tap inside that window was thrown away. Guarded on the id.
  const syncedRef = useRef<string | null>(null)
  if (meal && syncedRef.current !== meal.id) {
    syncedRef.current = meal.id
    setName(meal.name)
    setServings(meal.servings)
    setIsSaved(meal.isSaved)
  }

  const [addingRole, setAddingRole] = useState<PlateRole | null>(null)
  const [scheduling, setScheduling] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 7000)
    return () => clearTimeout(t)
  }, [toast])

  // ── lazy create ───────────────────────────────────────────────────────────
  // One create, ever: a fast rename-then-add must not fire two POSTs, so the promise is shared.
  const idRef = useRef<string | null>(routeId ?? null)
  const createRef = useRef<Promise<string> | null>(null)
  const nameRef = useRef(name)
  nameRef.current = name
  const servingsRef = useRef(servings)
  servingsRef.current = servings
  const seqRef = useRef(0)

  const ensureId = useCallback(async (): Promise<string> => {
    if (idRef.current) return idRef.current
    if (!createRef.current) {
      createRef.current = mealBuilderApi
        .create({ name: nameRef.current.trim() || NEW_NAME, servings: servingsRef.current, isSaved: startSaved ?? false })
        .then((m) => {
          idRef.current = m.id
          return m.id
        })
        .catch((e) => {
          createRef.current = null
          throw e
        })
    }
    return createRef.current
  }, [])

  // Run a write, repaint from the response, and only then adopt the new URL — so the refetch the
  // id change triggers can't hand back a pre-write plate. `rollback` restores what the caller
  // painted BEFORE the request, or the screen keeps showing a value the server rejected.
  const run = useCallback(
    async (fn: (mealId: string) => Promise<Meal>, rollback?: () => void) => {
      const seq = ++seqRef.current
      setBusy(true)
      try {
        const mealId = await ensureId()
        const updated = await fn(mealId)
        // Every write answers with the WHOLE plate as of its own commit. If a newer write has gone
        // out since, repainting from this snapshot would drop a dish added after it — and it never
        // self-heals, because useMeal only refetches on an id change.
        if (seq !== seqRef.current) return
        set(updated)
        if (idStateRef.current !== mealId) {
          idStateRef.current = mealId
          setId(mealId)
          onIdChange?.(mealId)
        }
      } catch {
        // Deliberately NOT gated on `seq`: a write that failed still failed.
        rollback?.()
        setToast({ text: 'Couldn’t save that — check your connection and try again.' })
      } finally {
        if (seq === seqRef.current) setBusy(false)
      }
    },
    [ensureId, onIdChange, set, startSaved],
  )

  // ── name ──────────────────────────────────────────────────────────────────
  const renamedRef = useRef(false)
  useEffect(() => {
    if (!renamedRef.current) return
    const t = setTimeout(() => {
      const next = name.trim()
      if (!next || (meal && meal.name === next)) return
      // Restoring the name re-runs this effect, but `name` then matches the plate's own.
      const prev = meal?.name ?? ''
      void run(
        (mealId) => mealBuilderApi.update(mealId, { name: next }),
        () => setName(prev),
      )
    }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

  // ── plate mutations ───────────────────────────────────────────────────────
  const dishes = meal?.recipes ?? []
  const onPlate = useMemo(() => new Set(dishes.map((d) => d.recipeId)), [dishes])

  function addRecipe(recipeId: string, role: PlateRole) {
    setAddingRole(null)
    void run((mealId) => mealBuilderApi.addDish(mealId, { recipeId, role }))
  }
  // A saved meal added here FLATTENS: its dishes come in individually. Meals never nest.
  function addMeal(mealId: string) {
    setAddingRole(null)
    void run((plateId) => mealBuilderApi.flattenInto(plateId, mealId))
  }
  function removeDish(recipeId: string) {
    void run((mealId) => mealBuilderApi.removeDish(mealId, recipeId))
  }
  function assignCook(recipeId: string, cookPersonId: string | null) {
    void run((mealId) => mealBuilderApi.patchDish(mealId, recipeId, { cookPersonId }))
  }
  function changeServings(next: number) {
    const n = Math.max(1, next)
    if (n === servings) return
    const prev = servings
    setServings(n)
    // On a plate that doesn't exist yet this rides along on the lazy create.
    if (!idRef.current) return
    void run(
      (mealId) => mealBuilderApi.update(mealId, { servings: n }),
      () => setServings(prev),
    )
  }
  function toggleSaved() {
    const next = !isSaved
    const prev = isSaved
    setIsSaved(next)
    void run(
      (mealId) => mealBuilderApi.update(mealId, { isSaved: next }),
      () => setIsSaved(prev),
    )
  }

  async function addToList() {
    if (!idRef.current || busy) return
    setBusy(true)
    try {
      const r = await mealBuilderApi.addToList(idRef.current)
      setToast({
        text: `Added ${r.added} ${r.added === 1 ? 'item' : 'items'} to the grocery list`,
        link: { to: '/lists', label: 'View grocery' },
      })
    } catch {
      setToast({ text: 'Couldn’t add this plate to the list.' })
    } finally {
      setBusy(false)
    }
  }

  // ── drag & drop (web/iPad only — iPhone taps to add) ──────────────────────
  const dragRef = useRef<DragPayload | null>(null)
  function dropOnRole(role: PlateRole) {
    const item = dragRef.current
    dragRef.current = null
    if (!item) return
    if (item.kind === 'meal') addMeal(item.id)
    else if (item.kind === 'dish') {
      // Already on the plate: a move, so an UPDATE. A drop back where it started must not write.
      if (item.from === role) return
      void run((mealId) => mealBuilderApi.patchDish(mealId, item.id, { role }))
    } else addRecipe(item.id, role)
  }

  if (error) return <div className="mb-shell mb-empty">Couldn’t load that meal.</div>
  if (loading && !meal) return <div className="mb-shell" />

  return (
    <div className="mb-shell">
      <header className="mb-head">
        {onBack && (
          <button type="button" className="pill mb-back" onClick={onBack}>
            ‹ Meals
          </button>
        )}
        <div className="mb-head-b">
          <input
            className="mb-name"
            aria-label="Meal name"
            value={name}
            placeholder={NEW_NAME}
            onChange={(e) => {
              renamedRef.current = true
              setName(e.target.value)
            }}
          />
          <div className="mb-hint tiny muted">Building a meal · tap the name to rename</div>
        </div>
      </header>

      <div className="mb-body">
        <MealBuilderPlate
          dishes={dishes}
          persons={persons}
          addingRole={addingRole}
          onOpenDish={onOpenDish}
          onRemoveDish={removeDish}
          onAssignCook={assignCook}
          onPickRole={(role) => setAddingRole(role)}
          onDropOnRole={dropOnRole}
          onDragItem={(payload) => {
            dragRef.current = payload
          }}
        />
        <MealBuilderLibrary
          onPlate={onPlate}
          hasMain={dishes.some((d) => d.role === 'main')}
          addingRole={addingRole}
          onCancelAdding={() => setAddingRole(null)}
          onAddRecipe={addRecipe}
          onAddMeal={addMeal}
          onDragItem={(payload) => {
            dragRef.current = payload
          }}
        />
      </div>

      <MealBuilderBar
        name={name.trim() || NEW_NAME}
        servings={servings}
        totalMinutes={meal?.totalMinutes ?? null}
        toBuy={meal?.toBuy ?? 0}
        isSaved={isSaved}
        empty={dishes.length === 0}
        busy={busy}
        onServings={changeServings}
        onToggleSaved={toggleSaved}
        // Inside a picker the destination is already decided.
        onAddToList={onUse ? undefined : addToList}
        onSchedule={onUse ? undefined : () => setScheduling(true)}
        // A plate only has a cook route once it exists server-side.
        onCook={onCook && meal ? () => onCook(meal.id) : undefined}
        onUse={onUse ? () => meal && onUse(meal) : undefined}
        useLabel={useLabel}
      />

      {scheduling && meal ? (
        <MealBuilderScheduleModal
          meal={meal}
          onClose={() => setScheduling(false)}
          onScheduled={({ meal: after, dayLabel }) => {
            set(after)
            setToast({
              text: `Added “${after.name}” to ${dayLabel} · built ${after.toBuy}-item list`,
              link: { to: '/lists', label: 'View grocery' },
            })
          }}
        />
      ) : null}

      {toast ? (
        <div className="mb-toast" role="status">
          <span>{toast.text}</span>
          {toast.link ? (
            <Link className="mb-toast-link" to={toast.link.to}>
              {toast.link.label}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
