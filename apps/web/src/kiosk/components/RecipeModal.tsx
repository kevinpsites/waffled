import { RecipeView } from './RecipeView'

// Modal preview of a recipe — just the chrome around the shared RecipeView, so a
// previewed recipe looks exactly like the full-screen route.
export function RecipeModal({
  recipeId,
  onClose,
  onSelect,
  selectLabel,
}: {
  recipeId: string
  onClose: () => void
  onSelect?: () => void
  selectLabel?: string
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card recipe-modal-card" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" aria-label="Close recipe" onClick={onClose}>×</button>
        <RecipeView id={recipeId} onSelect={onSelect} selectLabel={selectLabel} />
      </div>
    </div>
  )
}
