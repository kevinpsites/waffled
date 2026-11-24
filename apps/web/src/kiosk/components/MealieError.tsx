import { mealieErrorCode } from '../../lib/api/mealie'
import { ApiSendError } from '../../lib/api/client'

export function mealieErrorMessage(e: unknown): string {
  switch (mealieErrorCode(e)) {
    case 'MealieAuthFailed': return "Mealie stopped accepting Waffled's token. An admin can reconnect it in Settings → Mealie."
    case 'MealieNoShoppingList': return 'Choose a shopping list in Settings → Mealie.'
    case 'MealieNotConnected': return "Mealie isn't connected. An admin can connect it in Settings → Mealie."
    default:
      if (e instanceof ApiSendError && e.status === 404) return "That recipe isn't in Mealie anymore."
      return "Can't reach Mealie right now."
  }
}

// `compact` is the single muted line for Today cards.
export function MealieError({ error, onRetry, compact }: { error: unknown; onRetry: () => void; compact?: boolean }) {
  const msg = mealieErrorMessage(error)
  if (compact) return <div className="muted" style={{ fontSize: 13 }}>{msg}</div>
  return (
    <div className="muted" role="alert" style={{ padding: 16, textAlign: 'center' }}>
      <div style={{ marginBottom: 10 }}>{msg}</div>
      <button type="button" className="btn btn-ghost" onClick={onRetry}>Retry</button>
    </div>
  )
}
