// Meal Builder — compose a named, multi-recipe plate, then schedule it or send it
// straight to the grocery list. See docs/product/meal-builder-plan.md.
//
// Two columns: the plate (role-grouped dishes) on the left, "Add from library" on
// the right, with a dark stat bar pinned below. Every mutation returns the whole
// updated plate, so the screen repaints from the response instead of refetching.
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

export function MealBuilder() {
  const { id: routeId } = useParams()
  const navigate = useNavigate()

  // `/meals/build` starts with no id: the plate is created lazily on the first
  // dish add or the first rename, then the URL is swapped for /meals/build/:id so
  // a refresh doesn't lose the work.
  const [id, setId] = useState<string | null>(routeId ?? null)
  // Mirrors `id` so an async write can decide whether the URL still needs
  // swapping without reading stale closure state.
  const idStateRef = useRef<string | null>(routeId ?? null)
  useEffect(() => {
    idStateRef.current = id
  }, [id])
  useEffect(() => {
    if (routeId && routeId !== idStateRef.current) setId(routeId)
  }, [routeId])

  const { meal, loading, error, set } = useMeal(id)
  const { persons } = usePersons()

  // Locally-owned bits of the plate so typing/stepping paints instantly. Synced
  // from the server plate whenever a DIFFERENT plate loads (not on every write,
  // which would fight the optimistic value).
  // Starts blank so the placeholder invites a name rather than making the user
  // clear “New meal” first; the lazy create falls back to NEW_NAME.
  const [name, setName] = useState('')
  const [servings, setServings] = useState(4)
  const [isSaved, setIsSaved] = useState(false)
  const syncedRef = useRef<string | null>(null)
  useEffect(() => {
    if (meal && syncedRef.current !== meal.id) {
      syncedRef.current = meal.id
      setName(meal.name)
      setServings(meal.servings)
      setIsSaved(meal.isSaved)
    }
  }, [meal])

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
  // One create, ever: a fast rename-then-add must not fire two POSTs, so the
  // in-flight promise is shared.
  const idRef = useRef<string | null>(routeId ?? null)
  const createRef = useRef<Promise<string> | null>(null)
  const nameRef = useRef(name)
  nameRef.current = name
  const servingsRef = useRef(servings)
  servingsRef.current = servings

  const ensureId = useCallback(async (): Promise<string> => {
    if (idRef.current) return idRef.current
    if (!createRef.current) {
      createRef.current = mealBuilderApi
        .create({ name: nameRef.current.trim() || NEW_NAME, servings: servingsRef.current })
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

  // Run a write against the plate (creating it first if this is a fresh one),
  // repaint from the response, and only then adopt the new URL — so the refetch
  // the id change triggers can't hand back a pre-write plate.
  const run = useCallback(
    async (fn: (mealId: string) => Promise<Meal>) => {
      setBusy(true)
      try {
        const mealId = await ensureId()
        const updated = await fn(mealId)
        set(updated)
        if (idStateRef.current !== mealId) {
          idStateRef.current = mealId
          setId(mealId)
          navigate(`/meals/build/${mealId}`, { replace: true })
        }
      } catch {
        /* leave the UI as it was — the plate is still whatever the server last said */
      } finally {
        setBusy(false)
      }
    },
    [ensureId, navigate, set],
  )

  // ── name ──────────────────────────────────────────────────────────────────
  const renamedRef = useRef(false)
  useEffect(() => {
    if (!renamedRef.current) return
    const t = setTimeout(() => {
      const next = name.trim()
      if (!next || (meal && meal.name === next)) return
      void run((mealId) => mealBuilderApi.update(mealId, { name: next }))
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
  // A saved meal added here flattens — its dishes come in individually and keep
  // their own roles. Meals never nest (decision 12).
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
    setServings(n)
    // On a plate that doesn't exist yet this just rides along on the lazy create
    // — no point creating a meal because someone tapped the stepper.
    if (!idRef.current) return
    void run((mealId) => mealBuilderApi.update(mealId, { servings: n }))
  }
  function toggleSaved() {
    const next = !isSaved
    setIsSaved(next)
    void run((mealId) => mealBuilderApi.update(mealId, { isSaved: next }))
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
    else addRecipe(item.id, role)
  }

  if (error) return <div className="mb-shell mb-empty">Couldn’t load that meal.</div>
  if (loading && !meal) return <div className="mb-shell" />

  return (
    <div className="mb-shell">
      <header className="mb-head">
        <button type="button" className="pill mb-back" onClick={() => navigate('/meals')}>
          ‹ Meals
        </button>
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
          onOpenDish={(recipeId) => navigate(`/meals/recipe/${recipeId}`)}
          onRemoveDish={removeDish}
          onAssignCook={assignCook}
          onPickRole={(role) => setAddingRole(role)}
          onDropOnRole={dropOnRole}
        />
        <MealBuilderLibrary
          onPlate={onPlate}
          addingRole={addingRole}
          onCancelAdding={() => setAddingRole(null)}
          onAddRecipe={(recipeId) => addRecipe(recipeId, addingRole ?? 'side')}
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
        onAddToList={addToList}
        onSchedule={() => setScheduling(true)}
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
