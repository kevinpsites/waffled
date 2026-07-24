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

// What a library row hands to a drop zone. A saved meal FLATTENS on drop — its
// dishes come in as individual rows and keep their own roles (decision 12).
export type DragPayload = { kind: 'recipe'; id: string } | { kind: 'meal'; id: string }

export function dishMinutes(d: { prepTimeMinutes: number | null; cookTimeMinutes: number | null }): number {
  return (d.prepTimeMinutes ?? 0) + (d.cookTimeMinutes ?? 0)
}

// The one rule that is easy to get wrong: `onHand` is null when the pantry module
// is off, and that means "we can't say" — render no on-hand claim at all. It is
// NOT `have: 0`, and we never render "0 of N" (see decisions 5 + 14).
function OnHand({ dish }: { dish: MealDish }) {
  if (!dish.onHand) return null
  if (dish.toBuy === 0) return <span className="mb-onhand-ok">✓ all on hand</span>
  return <span className="mb-onhand-buy">{dish.toBuy} to buy</span>
}

function DishRow({
  dish,
  persons,
  onOpen,
  onRemove,
  onAssignCook,
}: {
  dish: MealDish
  persons: Person[]
  onOpen: () => void
  onRemove: () => void
  onAssignCook: (personId: string | null) => void
}) {
  const mins = dishMinutes(dish)
  const title = dish.title ?? 'Untitled recipe'
  return (
    <div className="mb-dish">
      <button type="button" className="mb-dish-open" onClick={onOpen}>
        <span className="mb-thumb">{dish.emoji ?? '🍽️'}</span>
        <span className="mb-dish-b">
          <span className="mb-dish-t">{title}</span>
          <span className="mb-dish-m">
            {mins > 0 ? <span>{`🕐 ${mins} min`}</span> : null}
            <OnHand dish={dish} />
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
      </button>

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
}: {
  dishes: MealDish[]
  persons: Person[]
  addingRole: PlateRole | null
  onOpenDish: (recipeId: string) => void
  onRemoveDish: (recipeId: string) => void
  onAssignCook: (recipeId: string, personId: string | null) => void
  onPickRole: (role: PlateRole) => void
  onDropOnRole: (role: PlateRole) => void
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
          <section className="mb-group" key={role.key} data-role={role.key}>
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
              />
            ))}

            {/* Drop zone + tap target. Deliberately WITHOUT the AI "pairs well
                here" nudge — that suggestion is deferred (decision 6). */}
            <button
              type="button"
              aria-label={role.slot}
              className={`mb-slot${hover === role.key ? ' is-over' : ''}${addingRole === role.key ? ' is-adding' : ''}`}
              onClick={() => onPickRole(role.key)}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
                setHover(role.key)
              }}
              onDragEnter={(e) => {
                e.preventDefault()
                setHover(role.key)
              }}
              onDragLeave={() => setHover((h) => (h === role.key ? null : h))}
              onDrop={(e) => {
                e.preventDefault()
                setHover(null)
                onDropOnRole(role.key)
              }}
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
