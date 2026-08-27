import { useState } from 'react'
import { groceryApi, type RecipeIngredient } from '../../lib/api'
import { fmtAmt } from '../../lib/amount'

// "Add all, or pick specific ingredients" — the shopper may already have some on hand.
//
// Defaults to every ingredient checked EXCEPT the ones the pantry says you actually have
// (`inPantry`). That exception is the whole point: guessing was the old problem, and with
// the pantry module on this is no longer a guess but a real match against your inventory.
//
// Staples are a different thing and stay CHECKED. A staple is something the household is
// assumed to keep around — a standing assumption, not an observation — so it keeps only
// its "likely on hand" hint to steer the unchecking. Reversing that default would mean
// silently dropping items the shopper never told us they had, and an item missing at the
// shop costs more than an extra one to uncheck.
//
// Adds only the checked subset.
export function RecipeGroceryModal({
  recipeId,
  title,
  ingredients,
  ratio = 1,
  onClose,
  onAdded,
}: {
  recipeId: string
  title: string
  ingredients: RecipeIngredient[]
  /// The servings scaler from the page that opened this. The sheet sits directly on top
  /// of the scaled ingredient list, so showing unscaled amounts made the two disagree in
  /// plain sight ("2 cups flour" behind, "1 cup flour" in front).
  ratio?: number
  onClose: () => void
  onAdded: (added: number) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(ingredients.filter((i) => !i.inPantry).map((i) => i.id))
  )
  const [saving, setSaving] = useState(false)
  const pantryCount = ingredients.filter((i) => i.inPantry).length

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const allOn = selected.size === ingredients.length
  function toggleAll() {
    setSelected(allOn ? new Set() : new Set(ingredients.map((i) => i.id)))
  }

  async function add() {
    if (saving || selected.size === 0) return
    setSaving(true)
    try {
      const { added } = await groceryApi.groceryFromRecipe(recipeId, undefined, [...selected])
      onAdded(added)
      onClose()
    } catch {
      onAdded(-1) // signals failure to the caller
      onClose()
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>Add to grocery list</div>
        <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 12 }}>
          {pantryCount > 0
            ? `Choose what to add from “${title}” — we’ve already unchecked ${pantryCount} item${pantryCount === 1 ? '' : 's'} your pantry says you have.`
            : `Choose what to add from “${title}” — uncheck anything you already have.`}
        </div>

        <button type="button" className="pill" style={{ cursor: 'pointer', marginBottom: 10 }} onClick={toggleAll}>
          {allOn ? 'Select none' : 'Select all'}
        </button>

        <div style={{ maxHeight: '48vh', overflowY: 'auto', margin: '0 -4px' }}>
          {ingredients.map((ing) => {
            const on = selected.has(ing.id)
            const left = ing.amount != null ? `${fmtAmt(ing.amount * ratio)}${ing.unit ? ` ${ing.unit}` : ''}` : '—'
            const name = ing.prepNote ? `${ing.name}, ${ing.prepNote}` : ing.name
            return (
              <div
                key={ing.id}
                className={`ring-row picking ${on ? 'on' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => toggle(ing.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(ing.id) } }}
                style={{ cursor: 'pointer' }}
              >
                <span className="ring-ck" aria-hidden>{on ? '✓' : ''}</span>
                <span className="ring-amt">{left}</span>
                <span className="ring-name">
                  {name}
                  {/* The real match wins the hint slot: "in your pantry" is something we
                      observed, "likely on hand" only something we assumed. */}
                  {ing.inPantry ? (
                    <span className="ring-was ring-inpantry">🥫 in your pantry</span>
                  ) : (
                    ing.isStaple && <span className="ring-was">pantry staple — likely on hand</span>
                  )}
                </span>
              </div>
            )
          })}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" style={{ cursor: 'pointer' }} onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" style={{ cursor: 'pointer', marginLeft: 'auto' }} disabled={saving || selected.size === 0} onClick={add}>
            {/* Pre-unchecking can empty the selection outright when the pantry covers the
                whole recipe. "Add 0 items" on a dead button explains nothing; name the
                state instead, and leave "Select all" as the way out. */}
            {saving ? 'Adding…' : selected.size === 0 ? 'Nothing to add' : `Add ${selected.size} item${selected.size === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
