import { useState } from 'react'
import { groceryApi, type RecipeIngredient } from '../../lib/api'

const FRAC: Record<string, string> = { '0.5': '½', '0.25': '¼', '0.75': '¾', '0.33': '⅓', '0.67': '⅔' }
function fmtAmt(n: number): string {
  const whole = Math.floor(n)
  const frac = +(n - whole).toFixed(2)
  const fg = FRAC[String(frac)]
  if (fg) return whole > 0 ? `${whole}${fg}` : fg
  return `${+n.toFixed(2)}`
}

// "Add all, or pick specific ingredients" — the shopper may already have some on hand.
// Defaults to every NON-staple ingredient checked (staples are assumed in the pantry,
// matching the server's add-all behavior), and adds only the checked subset.
export function RecipeGroceryModal({
  recipeId,
  title,
  ingredients,
  onClose,
  onAdded,
}: {
  recipeId: string
  title: string
  ingredients: RecipeIngredient[]
  onClose: () => void
  onAdded: (added: number) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(ingredients.filter((i) => !i.isStaple).map((i) => i.id)))
  const [saving, setSaving] = useState(false)

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
          Choose what to add from “{title}” — uncheck anything you already have.
        </div>

        <button type="button" className="pill" style={{ cursor: 'pointer', marginBottom: 10 }} onClick={toggleAll}>
          {allOn ? 'Select none' : 'Select all'}
        </button>

        <div style={{ maxHeight: '48vh', overflowY: 'auto', margin: '0 -4px' }}>
          {ingredients.map((ing) => {
            const on = selected.has(ing.id)
            const left = ing.amount != null ? `${fmtAmt(ing.amount)}${ing.unit ? ` ${ing.unit}` : ''}` : '—'
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
                  {ing.isStaple && <span className="ring-was">pantry staple — likely on hand</span>}
                </span>
              </div>
            )
          })}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" style={{ cursor: 'pointer' }} onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" style={{ cursor: 'pointer', marginLeft: 'auto' }} disabled={saving || selected.size === 0} onClick={add}>
            {saving ? 'Adding…' : `Add ${selected.size} item${selected.size === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
