import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { groceryApi, mealsApi, useRecipe, type RecipeIngredient, type RecipeOverrides, type RecipeStep } from '../../lib/api'
import { ScheduleModal } from './ScheduleModal'
import '../../styles/recipe.css'

// The one canonical recipe view — hero, metadata chips, scalable ingredients with
// substitutions, the method (per-step ingredients + notes), on-hand banner, and
// "your notes". Self-contained by id so it renders identically whether it's the
// full-screen route (RecipeDetail) or a modal preview (RecipeModal).

const FRAC: Record<string, string> = { '0.5': '½', '0.25': '¼', '0.75': '¾', '0.33': '⅓', '0.67': '⅔' }
function fmtAmt(n: number): string {
  const whole = Math.floor(n)
  const frac = +(n - whole).toFixed(2)
  const fg = FRAC[String(frac)]
  if (fg) return whole > 0 ? `${whole}${fg}` : fg
  return `${+n.toFixed(2)}`
}

function IngredientRow({ ing, ratio, onSub }: { ing: RecipeIngredient; ratio: number; onSub: (val: string) => void }) {
  const [checked, setChecked] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const left = ing.amount != null ? `${fmtAmt(ing.amount * ratio)}${ing.unit ? ` ${ing.unit}` : ''}` : '—'
  const origName = ing.prepNote ? `${ing.name}, ${ing.prepNote}` : ing.name

  if (editing) {
    return (
      <div className="ring-row editing">
        <span className="ring-amt">{left}</span>
        <input
          className="ring-sub-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`use instead of ${ing.name}…`}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { onSub(draft); setEditing(false) }
            if (e.key === 'Escape') setEditing(false)
          }}
        />
        <button type="button" className="ring-sub-ok" onClick={() => { onSub(draft); setEditing(false) }}>Save</button>
        {ing.sub && <button type="button" className="ring-sub-clear" onClick={() => { onSub(''); setEditing(false) }}>Reset</button>}
      </div>
    )
  }
  return (
    <div className={`ring-row ${checked ? 'on' : ''} ${ing.sub ? 'subbed' : ''}`}>
      <span className="ring-ck" aria-hidden role="button" tabIndex={0} onClick={() => setChecked((v) => !v)}>{checked ? '✓' : ''}</span>
      <span className="ring-amt" onClick={() => setChecked((v) => !v)}>{left}</span>
      <span className="ring-name" onClick={() => setChecked((v) => !v)}>
        {ing.sub ? ing.sub : origName}
        {ing.sub && <span className="ring-was">↺ instead of {ing.name}</span>}
      </span>
      <button type="button" className="ring-sub-btn" aria-label="Substitute" onClick={() => { setDraft(ing.sub ?? ''); setEditing(true) }}>⇄</button>
    </div>
  )
}

function StepRow({ s, onNote }: { s: RecipeStep; onNote: (val: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  return (
    <div className="rd-step">
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
        {s.note && !editing && <div className="rd-step-note">📝 {s.note}</div>}
        {editing ? (
          <div className="rd-step-noteedit">
            <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="add a note for this step…" />
            <div className="rd-step-noteactions">
              <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} onClick={() => { onNote(draft); setEditing(false) }}>Save</button>
              {s.note && <button type="button" className="pill" onClick={() => { onNote(''); setEditing(false) }}>Remove</button>}
              <button type="button" className="pill" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button type="button" className="rd-step-addnote" onClick={() => { setDraft(s.note ?? ''); setEditing(true) }}>
            {s.note ? 'Edit note' : '+ Add note'}
          </button>
        )}
      </div>
    </div>
  )
}

export function RecipeView({ id, onSelect, selectLabel }: { id: string; onSelect?: () => void; selectLabel?: string }) {
  const navigate = useNavigate()
  const { recipe, ingredients, steps, loading, error, refetch } = useRecipe(id)
  const [servings, setServings] = useState<number | null>(null)
  const [fav, setFav] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [addedNote, setAddedNote] = useState<string | null>(null)
  const [cooked, setCooked] = useState(0)
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (recipe) {
      setFav(recipe.isFavorite)
      setCooked(recipe.cookedCount)
      setNotes(recipe.userNotes ?? '')
    }
  }, [recipe])

  function toggleFav() {
    const next = !fav
    setFav(next)
    if (recipe) mealsApi.updateRecipe(recipe.id, { isFavorite: next }).catch(() => setFav(!next))
  }

  async function patchOverrides(mutate: (ov: RecipeOverrides) => RecipeOverrides) {
    if (!recipe) return
    try {
      await mealsApi.updateRecipe(recipe.id, { overrides: mutate(recipe.overrides ?? {}) })
      refetch()
    } catch {
      /* ignore */
    }
  }
  function setSub(name: string, value: string) {
    patchOverrides((ov) => {
      const subs = { ...(ov.subs ?? {}) }
      const k = name.trim().toLowerCase()
      if (value.trim()) subs[k] = value.trim()
      else delete subs[k]
      const next = { ...ov }
      if (Object.keys(subs).length) next.subs = subs
      else delete next.subs
      return next
    })
  }
  function setStepNote(n: number, value: string) {
    patchOverrides((ov) => {
      const sn = { ...(ov.stepNotes ?? {}) }
      if (value.trim()) sn[String(n)] = value.trim()
      else delete sn[String(n)]
      const next = { ...ov }
      if (Object.keys(sn).length) next.stepNotes = sn
      else delete next.stepNotes
      return next
    })
  }
  function saveNotes() {
    if (recipe && notes.trim() !== (recipe.userNotes ?? '')) mealsApi.updateRecipe(recipe.id, { userNotes: notes }).catch(() => {})
  }
  function markCooked() {
    if (!recipe) return
    setCooked((c) => c + 1)
    setAddedNote('Marked as cooked — nice work.')
    mealsApi.markCooked(recipe.id).catch(() => setCooked((c) => Math.max(0, c - 1)))
  }
  const enc = encodeURIComponent
  const chip = (params: string) => navigate(`/meals/recipes?${params}`)

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

  return (
    <div className="recipe-view">
      <div className="rd-actions">
        {onSelect && (
          <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} onClick={onSelect}>
            {selectLabel ?? 'Select'}
          </button>
        )}
        <button type="button" className="pill" onClick={() => navigate(`/meals/recipe/${recipe.id}/edit`)}>✏️ Edit</button>
        <button type="button" className="pill rd-fav" aria-label="Favorite" onClick={toggleFav}>{fav ? '❤️' : '🤍'}</button>
        {steps.length > 0 && (
          <button type="button" className="pill" onClick={() => navigate(`/meals/recipe/${recipe.id}/cook`)}>👨‍🍳 Cook</button>
        )}
        <button type="button" className="pill" onClick={() => setScheduling(true)}>📅 Schedule</button>
        <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} onClick={addToGrocery}>🛒 Add to grocery</button>
      </div>

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
            {recipe.collection && <button className="rd-tag coll" onClick={() => chip(`collection=${enc(recipe.collection!)}`)}>📁 {recipe.collection}</button>}
            {recipe.cuisine && <button className="rd-tag" onClick={() => chip(`cuisine=${enc(recipe.cuisine!)}`)}>🌍 {recipe.cuisine}</button>}
            {recipe.mealType && <button className="rd-tag" onClick={() => chip(`q=${enc(recipe.mealType!)}`)}>{recipe.mealType.replace('-', ' ')}</button>}
            {recipe.protein && <button className="rd-tag" onClick={() => chip(`protein=${enc(recipe.protein!)}`)}>🥩 {recipe.protein}</button>}
            {recipe.base && <button className="rd-tag" onClick={() => chip(`q=${enc(recipe.base!)}`)}>🍚 {recipe.base}</button>}
            {recipe.cookMethod && <button className="rd-tag" onClick={() => chip(`q=${enc(recipe.cookMethod!)}`)}>🍳 {recipe.cookMethod}</button>}
            {recipe.effort && <button className="rd-tag" onClick={() => chip(`q=${enc(recipe.effort!)}`)}>⏱️ {recipe.effort}</button>}
            {recipe.dietary.map((d) => <button key={d} className="rd-tag diet" onClick={() => chip(`diet=${enc(d)}`)}>{d}</button>)}
            {recipe.vegetables.map((v) => <button key={v} className="rd-tag veg" onClick={() => chip(`q=${enc(v)}`)}>🥬 {v}</button>)}
            {recipe.addedTags.map((t) => <button key={t} className="rd-tag soft" onClick={() => chip(`q=${enc(t)}`)}>#{t}</button>)}
          </div>
          {(recipe.tags ?? []).filter((t) => !recipe.addedTags.includes(t)).length > 0 && (
            <div className="rd-tags">
              {(recipe.tags ?? []).filter((t) => !recipe.addedTags.includes(t)).map((t) => <button key={t} className="rd-tag soft" onClick={() => chip(`q=${enc(t)}`)}>#{t}</button>)}
            </div>
          )}

          <div className="rd-cooked">
            <span className="tiny muted" style={{ fontWeight: 700 }}>{cooked > 0 ? `👨‍🍳 Cooked ${cooked}×` : 'Not cooked yet'}</span>
            <button type="button" className="pill" onClick={markCooked}>✓ Mark cooked</button>
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
              <IngredientRow key={ing.id} ing={ing} ratio={ratio} onSub={(val) => setSub(ing.name, val)} />
            ))}
            <div className="tiny muted rd-sub-hint">Tap ⇄ to swap an ingredient — your swaps stick across re-imports.</div>
          </div>
        </div>

        {/* right: on-hand banner + method */}
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
                    : `Need ${missing.length}: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}. Tap “Add to grocery”.`}
              </div>
            </div>
          </div>

          <div className="card rd-method">
            <div className="card-h" style={{ marginBottom: 14 }}>Method</div>
            {steps.length === 0 && <div className="muted tiny" style={{ fontWeight: 600 }}>No steps recorded for this recipe.</div>}
            {steps.map((s) => (
              <StepRow key={s.stepNumber} s={s} onNote={(val) => setStepNote(s.stepNumber, val)} />
            ))}

            <div className="rd-notes">
              <div className="card-h" style={{ fontSize: 16, margin: '6px 0 8px' }}>📝 Your notes</div>
              <textarea
                className="rd-notes-input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={saveNotes}
                placeholder="e.g. doubles well · use less salt · the kids love this one. (Kept across re-imports.)"
              />
              {recipe.notes && (
                <details className="rd-srcnotes">
                  <summary>Recipe notes (from the source)</summary>
                  <div className="tiny muted" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{recipe.notes}</div>
                </details>
              )}
            </div>
          </div>
        </div>
      </div>

      {scheduling && (
        <ScheduleModal recipe={recipe} onClose={() => setScheduling(false)} onScheduled={(label) => setAddedNote(`Scheduled for ${label}.`)} />
      )}
    </div>
  )
}
