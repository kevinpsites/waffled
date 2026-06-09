import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useTopbarFull } from './topbar-slot'
import { groceryApi, mealsApi, useRecipe, type RecipeIngredient } from '../lib/api'
import { ScheduleModal } from './components/ScheduleModal'
import './../styles/recipe.css'

// Pretty-print a (possibly scaled) amount: integers stay integers, halves/quarters
// render as fractions, everything else to 2dp.
const FRAC: Record<string, string> = { '0.5': '½', '0.25': '¼', '0.75': '¾', '0.33': '⅓', '0.67': '⅔' }
function fmtAmt(n: number): string {
  const whole = Math.floor(n)
  const frac = +(n - whole).toFixed(2)
  const fg = FRAC[String(frac)]
  if (fg) return whole > 0 ? `${whole}${fg}` : fg
  return `${+n.toFixed(2)}`
}

function IngredientRow({ ing, ratio }: { ing: RecipeIngredient; ratio: number }) {
  const [checked, setChecked] = useState(false)
  const left = ing.amount != null ? `${fmtAmt(ing.amount * ratio)}${ing.unit ? ` ${ing.unit}` : ''}` : '—'
  const name = ing.prepNote ? `${ing.name}, ${ing.prepNote}` : ing.name
  return (
    <div className={`ring-row ${checked ? 'on' : ''}`} onClick={() => setChecked((v) => !v)} role="button" tabIndex={0}>
      <span className="ring-ck" aria-hidden>{checked ? '✓' : ''}</span>
      <span className="ring-amt">{left}</span>
      <span className="ring-name">{name}</span>
    </div>
  )
}

export function RecipeDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { recipe, ingredients, steps, loading, error } = useRecipe(id ?? null)
  const [servings, setServings] = useState<number | null>(null)
  const [fav, setFav] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [addedNote, setAddedNote] = useState<string | null>(null)
  const addRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (recipe) setFav(recipe.isFavorite)
  }, [recipe])

  function toggleFav() {
    const next = !fav
    setFav(next)
    if (recipe) mealsApi.updateRecipe(recipe.id, { isFavorite: next }).catch(() => setFav(!next))
  }

  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate(-1)}>‹ Recipes</button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="pill rd-fav" aria-label="Favorite" onClick={toggleFav} style={{ cursor: 'pointer' }}>
            {fav ? '❤️' : '🤍'}
          </button>
          <button className="pill" style={{ cursor: 'pointer' }} onClick={() => setScheduling(true)}>📅 Schedule</button>
          <button className="pill btn-primary" style={{ color: '#fff', border: 0, cursor: 'pointer' }} onClick={() => addRef.current()}>
            🛒 Add to grocery list
          </button>
        </div>
      </div>
    ),
    [navigate, fav, recipe?.id]
  )

  if (loading) return <div className="muted" style={{ padding: 30 }}>Loading…</div>
  if (error || !recipe) return <div className="muted" style={{ padding: 30 }}>This recipe isn’t available.</div>

  const base = recipe.servings || 4
  const current = servings ?? base
  const ratio = current / base
  const onHand = ingredients.filter((i) => i.isStaple).length
  const missing = ingredients.filter((i) => !i.isStaple).map((i) => i.name)

  async function addToGrocery() {
    await groceryApi.groceryFromRecipe(recipe!.id)
    setAddedNote(missing.length ? `Added ${missing.length} item${missing.length === 1 ? '' : 's'} to this week’s grocery list.` : 'Everything’s on hand — nothing to add.')
  }
  addRef.current = addToGrocery

  return (
    <div className="recipe-detail">
      {/* left: hero + meta + ingredients */}
      <div className="rd-left">
        <div className="rd-hero">
          <span className="rd-hero-emoji">{recipe.emoji ?? '🍽️'}</span>
        </div>
        <div className="nk-serif rd-title">{recipe.title}</div>
        <div className="rd-meta">
          {recipe.cookTimeMinutes != null && <span>🕐 {recipe.cookTimeMinutes} min</span>}
          <span>🍽️ Serves {base}</span>
          {steps.length > 0 && <span>🪜 {steps.length} steps</span>}
          {recipe.sourceName && <span>📖 {recipe.sourceName}</span>}
        </div>

        <div className="rd-tags">
          {recipe.collection && <span className="rd-tag coll">📁 {recipe.collection}</span>}
          {recipe.cuisine && <span className="rd-tag">🌍 {recipe.cuisine}</span>}
          {recipe.mealType && <span className="rd-tag">{recipe.mealType.replace('-', ' ')}</span>}
          {recipe.protein && <span className="rd-tag">🥩 {recipe.protein}</span>}
          {recipe.base && <span className="rd-tag">🍚 {recipe.base}</span>}
          {recipe.cookMethod && <span className="rd-tag">🍳 {recipe.cookMethod}</span>}
          {recipe.effort && <span className="rd-tag">⏱️ {recipe.effort}</span>}
          {recipe.dietary.map((d) => <span key={d} className="rd-tag diet">{d}</span>)}
          {recipe.vegetables.map((v) => <span key={v} className="rd-tag soft">{v}</span>)}
          {(recipe.tags ?? []).map((t) => <span key={t} className="rd-tag soft">#{t}</span>)}
        </div>

        <div className="card rd-ings">
          <div className="rd-ings-head">
            <div className="card-h">Ingredients</div>
            <div className="rd-servings">
              <span className="tiny muted" style={{ fontWeight: 700 }}>Servings</span>
              <button type="button" aria-label="Fewer" onClick={() => setServings(Math.max(1, current - 1))}>−</button>
              <span className="rd-sv-n">{current}</span>
              <button type="button" aria-label="More" onClick={() => setServings(current + 1)}>+</button>
            </div>
          </div>
          {ingredients.map((ing) => (
            <IngredientRow key={ing.id} ing={ing} ratio={ratio} />
          ))}
        </div>
      </div>

      {/* right: on-hand banner + method (with per-step ingredients) */}
      <div className="rd-right">
        <div className="rd-onhand">
          <div className="ai-spark"><span>✦</span></div>
          <div>
            <div className="rd-onhand-t">
              {onHand} of {ingredients.length} ingredient{ingredients.length === 1 ? '' : 's'} {onHand === ingredients.length ? 'are on hand' : 'already on hand'}
            </div>
            <div className="tiny muted">
              {addedNote
                ? addedNote
                : missing.length === 0
                  ? 'You’ve got everything — happy cooking.'
                  : `Need ${missing.length}: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}. Tap “Add to grocery list”.`}
            </div>
          </div>
        </div>

        <div className="card rd-method">
          <div className="card-h" style={{ marginBottom: 14 }}>Method</div>
          {steps.length === 0 && <div className="muted tiny" style={{ fontWeight: 600 }}>No steps recorded for this recipe.</div>}
          {steps.map((s) => (
            <div key={s.stepNumber} className="rd-step">
              <div className="rd-step-n">{s.stepNumber}</div>
              <div className="rd-step-body">
                <div className="rd-step-t">{s.instruction}</div>
                {s.ingredients.length > 0 && (
                  <div className="rd-step-ings">
                    {s.ingredients.map((ig, i) => (
                      <span key={i} className="rd-step-chip">{ig}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {scheduling && (
        <ScheduleModal
          recipe={recipe}
          onClose={() => setScheduling(false)}
          onScheduled={(label) => setAddedNote(`Scheduled for ${label}.`)}
        />
      )}
    </div>
  )
}
