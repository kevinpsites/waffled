import type { Meal } from '../../lib/api'

// A saved meal ("plate") rendered as a card, so it can sit in the recipe library and
// in the slot picker next to real recipes without ever being mistaken for one
// (decision 11 — a saved meal is a first-class citizen of the recipe library).
//
// Two cues do that work: a "Meal · N" type badge, and the dish emoji strip in place
// of a single recipe's hero emoji. Both reuse the shared card vocabulary (`rc` /
// `rc-img` / `rc-b` / `tag` / `mp-actions`) rather than hand-rolling a new card.

const MAX_EMOJIS = 4

export function MealCardBadge({ meal }: { meal: Meal }) {
  return (
    <span className="tag" style={{ background: 'var(--primary-t)', color: 'var(--primary-d)' }}>
      Meal · {meal.recipeCount}
    </span>
  )
}

export function MealCardEmojis({ meal }: { meal: Meal }) {
  const all = meal.emojis?.length ? meal.emojis : ['🍽️']
  const shown = all.slice(0, MAX_EMOJIS)
  return (
    <span
      className="mc-emojis"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexWrap: 'wrap', fontSize: 32, lineHeight: 1 }}
    >
      {shown.map((e, i) => (
        <span key={`${e}-${i}`}>{e}</span>
      ))}
      {all.length > MAX_EMOJIS && (
        <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--ink-2)' }}>+{all.length - MAX_EMOJIS}</span>
      )}
    </span>
  )
}

export function MealCard({
  meal,
  onOpen,
  onSelect,
  selectLabel,
  className,
}: {
  meal: Meal
  onOpen?: () => void
  onSelect?: () => void
  selectLabel?: string
  className?: string
}) {
  return (
    <div
      className={`rc ${className ?? ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (onOpen && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <div className="rc-img g-pasta">
        <MealCardEmojis meal={meal} />
      </div>
      <div className="rc-b" style={{ padding: '12px 14px 14px' }}>
        <div className="rc-t" style={{ fontSize: 16 }}>{meal.name}</div>
        <div className="rc-m" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <MealCardBadge meal={meal} />
          <span>🍽️ Serves {meal.servings}</span>
          {meal.totalMinutes != null && meal.totalMinutes > 0 && <span>🕐 {meal.totalMinutes}m</span>}
        </div>
        {onSelect && (
          <div className="mp-actions">
            <button
              type="button"
              className="pill btn-primary mp-select"
              onClick={(e) => {
                e.stopPropagation()
                onSelect()
              }}
            >
              {selectLabel ?? 'Select'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
