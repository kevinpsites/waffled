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

// What the segments filter on. Recipes carry no "role" of their own — a role
// belongs to a dish ON a plate, not to the recipe — so these read the metadata
// the recipe does have: `category` and `mealType`.
//
// Sides used to be "not a dessert", which is exactly what Mains was, so the two
// tabs listed the same thing however the library was tagged. Now each recipe
// falls in exactly one segment, and anything untagged is a main — most libraries
// are half-tagged, and a recipe with nothing to go on still has to be findable.
const SIDE_TYPES = new Set(['side', 'salad', 'appetizer', 'bread', 'soup'])

function isDessert(r: Recipe): boolean {
  return (r.category ?? '').toLowerCase() === 'dessert' || (r.mealType ?? '').toLowerCase() === 'dessert'
}

function isSide(r: Recipe): boolean {
  if (isDessert(r)) return false
  return SIDE_TYPES.has((r.category ?? '').toLowerCase()) || SIDE_TYPES.has((r.mealType ?? '').toLowerCase())
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
  hasMain,
}: {
  onPlate: Set<string>
  hasMain: boolean
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

  // Tapping a slot's "+" deliberately does NOT move the segment. It names a
  // DESTINATION, not a filter — roles are free text and a "main" recipe is a
  // perfectly good side. Narrowing here would hide the very recipe you meant to
  // put in that slot; the banner says where it's going instead.

  const { recipes } = useRecipes()
  const { meals: saved } = useSavedMeals(dq || undefined)

  const ql = dq.toLowerCase()
  const shownRecipes = useMemo(
    () =>
      recipes
        .filter((r) =>
          segment === 'all'
            ? true
            : segment === 'dessert'
              ? isDessert(r)
              : segment === 'side'
                ? isSide(r)
                : !isDessert(r) && !isSide(r),
        )
        .filter((r) => !ql || haystack(r).includes(ql))
        .sort((a, b) => a.title.localeCompare(b.title)),
    [recipes, segment, ql],
  )

  // Saved meals are role-agnostic (they flatten into their own per-dish roles),
  // so they show under every segment rather than being filtered out.
  const shownMeals: Meal[] = saved

  const empty = shownRecipes.length === 0 && shownMeals.length === 0

  // Where a ＋ tap files the dish. An explicit destination always wins: the slot
  // the user tapped on the plate, else the segment they're browsing. Only "All"
  // has no role of its own — and there, filing everything under Sides left plates
  // with an empty Main and a pile of sides, which is not what anyone meant. So
  // infer per recipe: a dessert is a dessert, the first savoury dish is the Main,
  // and everything after it is a side.
  function roleFor(r: Recipe): PlateRole {
    if (addingRole) return addingRole
    if (segment !== 'all') return segment
    if (isDessert(r)) return 'dessert'
    if (isSide(r)) return 'side'
    return hasMain ? 'side' : 'main'
  }
  // Only used for the footer hint, which can only name a role when there IS one
  // role for every row.
  const fixedRole: PlateRole | null = addingRole ?? (segment === 'all' ? null : segment)

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
          const kind = isDessert(r) ? 'Dessert' : isSide(r) ? 'Side' : r.category ? cap(r.category) : 'Recipe'
          return (
            <Row
              key={r.id}
              name={r.title}
              emoji={r.emoji ?? '🍽️'}
              meta={[kind, mins > 0 ? `${mins} min` : null].filter(Boolean).join(' · ')}
              onPlate={onPlate.has(r.id)}
              onAdd={() => onAddRecipe(r.id, roleFor(r))}
              onDragStart={() => onDragItem({ kind: 'recipe', id: r.id })}
            />
          )
        })}
        {empty ? <div className="mb-lib-empty">Nothing matches — try another search.</div> : null}
      </div>

      <div className="mb-lib-foot tiny muted">
        {fixedRole
          ? `Drag a row onto a slot, or tap ＋ to add it to ${roleLabel(fixedRole)}.`
          : 'Drag a row onto a slot, or tap ＋ and we’ll file it for you.'}
      </div>
    </aside>
  )
}
