// The plate — the left column of the Meal Builder. Dishes are grouped by `role`
// (Main → Sides → Dessert); each group ends in a drop zone that doubles as a
// tap target ("Add a side"). See docs/product/meal-builder-plan.md.
import { useState } from 'react'
import type { MealDish, Person } from '../../lib/api'

// Roles are free text server-side (soft scaffolding, not an enum) — these three
// are the ones the builder scaffolds today, in plate order.
export const PLATE_ROLES = [
  { key: 'main', label: 'Main', slot: 'Add a main' },
  { key: 'side', label: 'Sides', slot: 'Add a side' },
  { key: 'dessert', label: 'Dessert', slot: 'Add a dessert' },
] as const

export type PlateRole = (typeof PLATE_ROLES)[number]['key']

export function roleLabel(role: string): string {
  return PLATE_ROLES.find((r) => r.key === role)?.label ?? 'Sides'
}

// What a drag hands to a drop zone. A saved meal FLATTENS on drop — its dishes
// come in as individual rows and keep their own roles (decision 12). A `dish` is
// already ON the plate: dropping it re-roles it in place rather than adding it
// again, which matters because meal_recipes is keyed on (meal_id, recipe_id) and
// a recipe can therefore only appear once per plate.
export type DragPayload =
  | { kind: 'recipe'; id: string }
  | { kind: 'meal'; id: string }
  | { kind: 'dish'; id: string; from: PlateRole }

export function dishMinutes(d: { prepTimeMinutes: number | null; cookTimeMinutes: number | null }): number {
  return (d.prepTimeMinutes ?? 0) + (d.cookTimeMinutes ?? 0)
}

// The one rule that is easy to get wrong: `onHand` is null when the pantry module
// is off, and that means "we can't say" — render no on-hand claim at all. It is
// NOT `have: 0`, and we never render "0 of N" (see decisions 5 + 14).
function OnHand({ dish, open, onToggle }: { dish: MealDish; open: boolean; onToggle: () => void }) {
  if (dish.toBuy === 0) {
    // Only a pantry that actually reported can claim everything is on hand; with
    // the pantry off there is simply nothing to say.
    return dish.onHand ? <span className="mb-onhand-ok">✓ all on hand</span> : null
  }
  // A count on its own isn't actionable — make it open into the ingredients.
  return (
    <button
      type="button"
      className="mb-onhand-buy mb-onhand-btn"
      aria-expanded={open}
      onClick={(e) => {
        // The row around this opens the recipe; expanding the count must not.
        e.stopPropagation()
        onToggle()
      }}
    >
      {dish.toBuy} to buy
      <span className="mb-onhand-caret">{open ? '▾' : '▸'}</span>
    </button>
  )
}

function DishRow({
  dish,
  persons,
  onOpen,
  onRemove,
  onAssignCook,
  onDragDish,
}: {
  dish: MealDish
  persons: Person[]
  onOpen: () => void
  onRemove: () => void
  onAssignCook: (personId: string | null) => void
  onDragDish: (e: React.DragEvent) => void
}) {
  const mins = dishMinutes(dish)
  const title = dish.title ?? 'Untitled recipe'
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-dish" draggable onDragStart={onDragDish}>
      {/* A div, not a <button>: the to-buy count inside it is itself a button, and
          interactive content may not nest inside a button. The class already
          resets border/background/padding, so this renders identically. */}
      <div
        role="button"
        tabIndex={0}
        // Named explicitly, else the accessible name is the row's whole text —
        // which swallows the nested to-buy control and makes both unaddressable.
        aria-label={`Open ${title}`}
        className="mb-dish-open"
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpen()
          }
        }}
      >
        <span className="mb-thumb">{dish.emoji ?? '🍽️'}</span>
        <span className="mb-dish-b">
          <span className="mb-dish-t">{title}</span>
          <span className="mb-dish-m">
            {mins > 0 ? <span>{`🕐 ${mins} min`}</span> : null}
            <OnHand
              dish={dish}
              open={open}
              onToggle={() => setOpen((v) => !v)}
            />
            {/* A four-dish plate has up to four cooks — the badge says whose job
                this dish is (decision 10). */}
            {dish.cook ? (
              <span
                className="mb-cook-badge"
                style={{ background: dish.cook.colorHex ? `${dish.cook.colorHex}22` : undefined }}
              >
                👩‍🍳 {dish.cook.avatarEmoji ?? '🧑‍🍳'} {dish.cook.name ?? 'Cook'}
              </span>
            ) : null}
          </span>
        </span>
      </div>

      {/* Per-dish cook assignment. Empty = "whoever" (the default). */}
      <select
        className="sel mb-cook-sel"
        aria-label={`Who cooks ${title}?`}
        value={dish.cook?.personId ?? ''}
        onChange={(e) => onAssignCook(e.target.value || null)}
      >
        <option value="">— whoever —</option>
        {persons.map((p) => (
          <option key={p.id} value={p.id}>
            {p.avatarEmoji ? `${p.avatarEmoji} ` : ''}
            {p.name}
          </option>
        ))}
      </select>

      <button type="button" className="mb-x" aria-label={`Remove ${title}`} onClick={onRemove}>
        ×
      </button>

      {/* Wraps onto its own full-width line inside the dish card. */}
      {open && dish.toBuyNames.length > 0 ? (
        <ul className="mb-tobuy">
          {dish.toBuyNames.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function MealBuilderPlate({
  dishes,
  persons,
  addingRole,
  onOpenDish,
  onRemoveDish,
  onAssignCook,
  onPickRole,
  onDropOnRole,
  onDragItem,
}: {
  dishes: MealDish[]
  persons: Person[]
  addingRole: PlateRole | null
  onOpenDish: (recipeId: string) => void
  onRemoveDish: (recipeId: string) => void
  onAssignCook: (recipeId: string, personId: string | null) => void
  onPickRole: (role: PlateRole) => void
  onDropOnRole: (role: PlateRole) => void
  onDragItem: (payload: DragPayload | null) => void
}) {
  // Which drop zone the pointer is currently over — HTML5 drag has no :hover.
  const [hover, setHover] = useState<PlateRole | null>(null)

  return (
    <div className="mb-plate">
      {PLATE_ROLES.map((role) => {
        const rows = dishes
          .filter((d) => (role.key === 'side' ? d.role !== 'main' && d.role !== 'dessert' : d.role === role.key))
          .sort((a, b) => a.sortOrder - b.sortOrder)
        return (
          // The whole group is the drop target, not just its trailing slot — a
          // populated group's slot sits below its rows, so requiring a hit on it
          // would make Sides → Main a game of pixel-hunting.
          <section
            className="mb-group"
            key={role.key}
            data-role={role.key}
            onDragOver={(e) => {
              e.preventDefault()
              // Answer the drag in its own terms. A browser refuses a drop whose
              // dropEffect contradicts the source's effectAllowed — and refuses it
              // silently, by never firing `drop` at all. Library rows drag as
              // 'copy' (adding a dish), plate rows as 'move' (re-roleing one), so
              // hardcoding either one kills the other.
              e.dataTransfer.dropEffect = e.dataTransfer.effectAllowed === 'move' ? 'move' : 'copy'
              setHover(role.key)
            }}
            onDragEnter={(e) => {
              e.preventDefault()
              setHover(role.key)
            }}
            onDragLeave={(e) => {
              // Moving between children fires dragleave on the parent; ignore it
              // unless the pointer actually left the group.
              if (e.currentTarget.contains(e.relatedTarget as Node)) return
              setHover((h) => (h === role.key ? null : h))
            }}
            onDrop={(e) => {
              e.preventDefault()
              setHover(null)
              onDropOnRole(role.key)
            }}
          >
            <div className="mb-group-head">
              <span className={`mb-dot mb-dot-${role.key}`} />
              <span className="mb-group-label">{role.label}</span>
              {rows.length > 0 ? <span className="mb-group-count">{rows.length}</span> : null}
            </div>

            {rows.map((d) => (
              <DishRow
                key={d.recipeId}
                dish={d}
                persons={persons}
                onOpen={() => onOpenDish(d.recipeId)}
                onRemove={() => onRemoveDish(d.recipeId)}
                onAssignCook={(personId) => onAssignCook(d.recipeId, personId)}
                onDragDish={(e) => {
                  // A bespoke mime type, never text/plain — a text payload gets
                  // pasted into whatever input the drag happens to end over.
                  e.dataTransfer.setData('application/x-waffled-dish', d.recipeId)
                  e.dataTransfer.effectAllowed = 'move'
                  onDragItem({ kind: 'dish', id: d.recipeId, from: role.key })
                }}
              />
            ))}

            {/* Drop zone + tap target. Deliberately WITHOUT the AI "pairs well
                here" nudge — that suggestion is deferred (decision 6). */}
            <button
              type="button"
              aria-label={role.slot}
              className={`mb-slot${hover === role.key ? ' is-over' : ''}${addingRole === role.key ? ' is-adding' : ''}`}
              onClick={() => onPickRole(role.key)}
            >
              <span className="mb-slot-plus">＋</span>
              <span className="mb-slot-label">{role.slot}</span>
            </button>
          </section>
        )
      })}
    </div>
  )
}
