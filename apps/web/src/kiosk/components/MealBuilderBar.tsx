// The dark stat bar pinned under the Meal Builder: serves stepper · hands-on time · groceries ·
// "keep in library" · the two actions. `servings` is stored and displayed only — v1
// deliberately does not rescale ingredient quantities.

function hoursMinutes(total: number | null): string {
  if (!total || total <= 0) return '—'
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

export function MealBuilderBar({
  name,
  servings,
  totalMinutes,
  toBuy,
  isSaved,
  empty,
  busy,
  onServings,
  onToggleSaved,
  onAddToList,
  onSchedule,
  onCook,
  onUse,
  useLabel,
}: {
  name: string
  servings: number
  totalMinutes: number | null
  toBuy: number
  isSaved: boolean
  empty: boolean
  busy: boolean
  onServings: (n: number) => void
  onToggleSaved: () => void
  // The three actions are PRESENCE-GATED: each button exists only if it has somewhere to go.
  // The plate builder embedded in the recipe picker passes none of them and an `onUse` instead
  // — inside a picker the "now what?" is already answered by the slot that opened it.
  onAddToList?: () => void
  onSchedule?: () => void
  onCook?: () => void
  // "This plate is the answer" — hands the finished plate back to whatever opened the builder.
  // Its label names the destination, which the caller knows and this bar doesn't.
  onUse?: () => void
  useLabel?: string
}) {
  return (
    <footer className="mb-bar">
      <div className="mb-bar-stat">
        <span className="mb-bar-l">Serves</span>
        <div className="mb-step">
          <button type="button" aria-label="Fewer servings" onClick={() => onServings(Math.max(1, servings - 1))}>
            −
          </button>
          <span className="mb-step-v" data-testid="mb-serves">
            {servings}
          </span>
          <button type="button" aria-label="More servings" onClick={() => onServings(servings + 1)}>
            ＋
          </button>
        </div>
      </div>

      <div className="mb-bar-stat mb-bar-time">
        <span className="mb-bar-l">Hands-on time</span>
        <span className="mb-bar-v">{`≈ ${hoursMinutes(totalMinutes)}`}</span>
      </div>

      <div className="mb-bar-stat mb-bar-grocery">
        <span className="mb-bar-l">Groceries</span>
        <span className="mb-bar-v">{`${toBuy} to buy`}</span>
      </div>

      <div className="mb-bar-save">
        <button
          type="button"
          role="switch"
          aria-checked={isSaved}
          aria-label={`Keep “${name}” in your library`}
          className={`toggle ${isSaved ? 'on' : ''}`}
          onClick={onToggleSaved}
        />
        <span className="mb-bar-save-b">
          <span className="mb-bar-save-t">Keep in library</span>
          {/* The toggle applies immediately — a state, not a pending action. */}
          <span className="mb-bar-save-h">{isSaved ? 'Saved — it’s in your library' : 'One-off — not saved'}</span>
        </span>
      </div>

      <div className="mb-bar-actions">
        {onCook && !empty && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCook}>
            <span aria-hidden>👨‍🍳</span> Cook this meal
          </button>
        )}
        {onAddToList && (
          <button type="button" className="btn btn-ghost" disabled={empty || busy} onClick={onAddToList}>
            Add plate to list
          </button>
        )}
        {onSchedule && (
          <button type="button" className="btn btn-primary" disabled={empty || busy} onClick={onSchedule}>
            Schedule meal
          </button>
        )}
        {onUse && (
          <button type="button" className="btn btn-primary" disabled={empty || busy} onClick={onUse}>
            {useLabel ?? 'Use this plate'}
          </button>
        )}
      </div>
    </footer>
  )
}
