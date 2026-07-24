// "Add from library" — the right-hand column of the Meal Builder. Searches
// recipes AND saved meals (decision 11); a saved meal added here FLATTENS into
// individual dishes (decision 12), so it's badged distinctly.
import { useEffect, useMemo, useState } from 'react'
import { useRecipes, useSavedMeals, type Meal, type Recipe } from '../../lib/api'
import { roleLabel, type DragPayload, type PlateRole } from './MealBuilderPlate'

const SEGMENTS = [
  { key: 'side', label: 'Sides' },
  { key: 'main', label: 'Mains' },
  { key: 'dessert', label: 'Desserts' },
  { key: 'all', label: 'All' },
] as const
type Segment = (typeof SEGMENTS)[number]['key']

function isDessert(r: Recipe): boolean {
  return (r.category ?? '').toLowerCase() === 'dessert' || (r.mealType ?? '').toLowerCase() === 'dessert'
}

// Title + the metadata people actually search by (same spirit as RecipesLibrary).
function haystack(r: Recipe): string {
  return [r.title, r.category, r.cuisine, r.protein, r.base, r.collection, ...(r.tags ?? [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function minutesOf(r: Recipe): number {
  return (r.prepTimeMinutes ?? 0) + (r.cookTimeMinutes ?? 0)
}

function Row({
  name,
  emoji,
  meta,
  badge,
  onPlate,
  onAdd,
  onDragStart,
}: {
  name: string
  emoji: string
  meta: string
  badge?: string
  onPlate: boolean
  onAdd: () => void
  onDragStart: () => void
}) {
  return (
    <div
      className={`mb-lib-row${onPlate ? ' is-on' : ''}`}
      draggable={!onPlate}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copy'
        // A bespoke mime type, not text/plain — a text payload gets pasted into
        // whatever input the drag ends over.
        e.dataTransfer.setData('application/x-waffled-dish', name)
        onDragStart()
      }}
    >
      <span className="mb-thumb">{emoji}</span>
      <span className="mb-lib-b">
        <span className="mb-lib-t">{name}</span>
        <span className="mb-lib-m">{meta}</span>
      </span>
      {badge ? <span className="mb-lib-badge">{badge}</span> : null}
      <button type="button" className="mb-lib-add" aria-label={`Add ${name}`} disabled={onPlate} onClick={onAdd}>
        ＋
      </button>
    </div>
  )
}

export function MealBuilderLibrary({
  onPlate,
  addingRole,
  onCancelAdding,
  onAddRecipe,
  onAddMeal,
  onDragItem,
}: {
  onPlate: Set<string>
  addingRole: PlateRole | null
  onCancelAdding: () => void
  onAddRecipe: (recipeId: string, role: PlateRole) => void
  onAddMeal: (mealId: string) => void
  onDragItem: (payload: DragPayload | null) => void
}) {
  const [segment, setSegment] = useState<Segment>('all')
  const [q, setQ] = useState('')
  // Debounced so every keystroke doesn't hit /api/meals.
  const [dq, setDq] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])

  // Clicking a role's "+" switches the filter to that role (and banners it).
  useEffect(() => {
    if (addingRole) setSegment(addingRole)
  }, [addingRole])

  const { recipes } = useRecipes()
  const { meals: saved } = useSavedMeals(dq || undefined)

  const ql = dq.toLowerCase()
  const shownRecipes = useMemo(
    () =>
      recipes
        .filter((r) => (segment === 'dessert' ? isDessert(r) : segment === 'all' ? true : !isDessert(r)))
        .filter((r) => !ql || haystack(r).includes(ql))
        .sort((a, b) => a.title.localeCompare(b.title)),
    [recipes, segment, ql],
  )

  // Saved meals are role-agnostic (they flatten into their own per-dish roles),
  // so they show under every segment rather than being filtered out.
  const shownMeals: Meal[] = saved

  const empty = shownRecipes.length === 0 && shownMeals.length === 0

  // Tapping ＋ files the dish under the role you're looking at: the banner's role
  // if a plate slot asked for one, otherwise the segment. "All" has no role of its
  // own, so it falls back to the plate's catch-all group.
  const addRole: PlateRole = addingRole ?? (segment === 'all' ? 'side' : segment)

  return (
    <aside className="mb-lib">
      <div className="mb-lib-head">Add from library</div>

      {addingRole ? (
        <div className="mb-adding">
          <span>Adding to {roleLabel(addingRole)} — pick any recipe</span>
          <button type="button" className="mb-adding-x" aria-label="Stop adding" onClick={onCancelAdding}>
            ✕
          </button>
        </div>
      ) : null}

      <div className="seg mb-lib-seg">
        {SEGMENTS.map((s) => (
          <button key={s.key} type="button" className={segment === s.key ? 'on' : ''} onClick={() => setSegment(s.key)}>
            {s.label}
          </button>
        ))}
      </div>

      <input
        className="mb-search"
        aria-label="Search recipes and meals"
        placeholder="Search recipes & meals…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      <div className="mb-lib-rows">
        {shownMeals.map((m) => (
          <Row
            key={`meal-${m.id}`}
            name={m.name}
            emoji={m.emojis[0] ?? '🍽️'}
            meta={[
              m.totalMinutes ? `${m.totalMinutes} min` : null,
              `${m.toBuy} to buy`,
            ]
              .filter(Boolean)
              .join(' · ')}
            badge={`Meal · ${m.recipeCount}`}
            onPlate={false}
            onAdd={() => onAddMeal(m.id)}
            onDragStart={() => onDragItem({ kind: 'meal', id: m.id })}
          />
        ))}
        {shownRecipes.map((r) => {
          const mins = minutesOf(r)
          const kind = isDessert(r) ? 'Dessert' : r.category ? cap(r.category) : 'Recipe'
          return (
            <Row
              key={r.id}
              name={r.title}
              emoji={r.emoji ?? '🍽️'}
              meta={[kind, mins > 0 ? `${mins} min` : null].filter(Boolean).join(' · ')}
              onPlate={onPlate.has(r.id)}
              onAdd={() => onAddRecipe(r.id, addRole)}
              onDragStart={() => onDragItem({ kind: 'recipe', id: r.id })}
            />
          )
        })}
        {empty ? <div className="mb-lib-empty">Nothing matches — try another search.</div> : null}
      </div>

      <div className="mb-lib-foot tiny muted">
        Drag a row onto a slot, or tap ＋ to add it to {roleLabel(addRole)}.
      </div>
    </aside>
  )
}
