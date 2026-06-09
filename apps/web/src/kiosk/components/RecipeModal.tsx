import { useRecipe, type RecipeIngredient } from '../../lib/api'

function ingredientLine(i: RecipeIngredient): string {
  if (i.display) return i.display
  const qty = [i.amount, i.unit].filter((x) => x != null && x !== '').join(' ')
  const base = [qty, i.name].filter(Boolean).join(' ')
  return i.prepNote ? `${base}, ${i.prepNote}` : base
}

function groupBySection(ings: RecipeIngredient[]): Array<[string, RecipeIngredient[]]> {
  const map = new Map<string, RecipeIngredient[]>()
  for (const i of ings) {
    const key = i.section ?? 'Ingredients'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(i)
  }
  return [...map.entries()]
}

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
  const { recipe, ingredients, loading, error } = useRecipe(recipeId)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" aria-label="Close recipe" onClick={onClose}>
          ×
        </button>

        {loading && <div className="muted">Loading…</div>}
        {error && <div className="muted">Couldn’t load the recipe.</div>}

        {recipe && (
          <>
            <div style={{ fontSize: 40 }}>{recipe.emoji ?? '🍽️'}</div>
            <div className="nk-serif" style={{ fontSize: 26, fontWeight: 600, margin: '4px 0 4px' }}>
              {recipe.title}
            </div>
            <div className="tiny muted" style={{ display: 'flex', gap: 14, marginBottom: 10, flexWrap: 'wrap' }}>
              {recipe.cookTimeMinutes != null && <span>🕐 {recipe.cookTimeMinutes} min</span>}
              <span>🍽️ Serves {recipe.servings}</span>
              {recipe.sourceName && <span>📖 {recipe.sourceName}</span>}
            </div>
            {recipe.description && (
              <div className="muted" style={{ fontSize: 14, marginBottom: 14 }}>{recipe.description}</div>
            )}

            {ingredients.length === 0 && <div className="muted tiny">No ingredients added yet.</div>}
            {groupBySection(ingredients).map(([section, items]) => (
              <div key={section} style={{ marginBottom: 12 }}>
                <div
                  className="card-h"
                  style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--ink-2)', marginBottom: 4 }}
                >
                  {section}
                </div>
                {items.map((i) => (
                  <div key={i.id} style={{ fontSize: 15, padding: '4px 0', borderBottom: '1px solid var(--hair-2)' }}>
                    {ingredientLine(i)}
                  </div>
                ))}
              </div>
            ))}

            {onSelect && (
              <button
                type="button"
                className="btn btn-primary"
                style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                onClick={onSelect}
              >
                {selectLabel ?? 'Select meal'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
