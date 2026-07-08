import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { groceryApi, mealsApi, pantryApi, useRecipe, type RecipeIngredient, type RecipeMatch, type RecipeOverrides, type RecipeStep } from '../../lib/api'
import { ScheduleModal } from './ScheduleModal'
import { CookConfirm } from './CookConfirm'
import { useTopbarFull } from '../topbar-slot'
import '../../styles/recipe.css'

// Favorite / edit / schedule as icon buttons. Rendered in the topbar (full-screen
// route, on the back-button row) and inline (modal preview, which has no topbar).
function RecipeActionIcons({ fav, onFav, onEdit, onSchedule }: { fav: boolean; onFav: () => void; onEdit: () => void; onSchedule: () => void }) {
  return (
    <>
      <button type="button" className={`icon-btn rd-fav ${fav ? 'on' : ''}`} aria-label="Favorite" aria-pressed={fav} onClick={onFav}>
        <svg viewBox="0 0 24 24"><path d="M12 20s-7-4.6-9.2-9C1.3 8 2.6 4.7 5.8 4.5 8 4.3 9.4 5.8 12 8.6c2.6-2.8 4-4.3 6.2-4.1 3.2.2 4.5 3.5 3 6.5C19 15.4 12 20 12 20z" /></svg>
      </button>
      <button type="button" className="icon-btn" aria-label="Edit recipe" onClick={onEdit}>
        <svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>
      </button>
      <button type="button" className="icon-btn" aria-label="Schedule" onClick={onSchedule}>
        <svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="16" rx="3" /><path d="M3 9.5h18M8 2.5v4M16 2.5v4" /></svg>
      </button>
    </>
  )
}

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
  const timer =
    s.timerSeconds != null && s.timerSeconds > 0
      ? `${Math.floor(s.timerSeconds / 60)}:${String(s.timerSeconds % 60).padStart(2, '0')}`
      : null
  return (
    <div className="rd-step">
      <div className="rd-step-n">{s.stepNumber}</div>
      <div className="rd-step-body">
        <div className="rd-step-t">{s.instruction}</div>
        {/* Ingredients referenced in one quiet line, not a wall of chips; timer as a small inline clock. */}
        {(s.ingredients.length > 0 || timer) && (
          <div className="rd-step-meta">
            {s.ingredients.length > 0 && (
              <span className="rd-uses"><b>Uses:</b> {s.ingredients.join(', ')}</span>
            )}
            {timer && (
              <span className="rd-timer" aria-label={`timer ${timer}`}>
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                {timer}
              </span>
            )}
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

export function RecipeView({ id, onSelect, selectLabel, fullScreen }: { id: string; onSelect?: () => void; selectLabel?: string; fullScreen?: boolean }) {
  const navigate = useNavigate()
  const { recipe, ingredients, steps, loading, error, refetch } = useRecipe(id)
  const [servings, setServings] = useState<number | null>(null)
  const [showAllTags, setShowAllTags] = useState(false)
  const [fav, setFav] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [addedNote, setAddedNote] = useState<string | null>(null)
  const [cooked, setCooked] = useState(0)
  const [notes, setNotes] = useState('')
  const [usedMatches, setUsedMatches] = useState<RecipeMatch[] | null>(null)

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
    // Offer to update the pantry with what this recipe likely used (skipped silently
    // when the pantry module is off or nothing on hand matched).
    pantryApi.forRecipe(recipe.id).then((m) => { if (m.length) setUsedMatches(m) }).catch(() => {})
  }
  const enc = encodeURIComponent
  const chip = (params: string) => navigate(`/meals/recipes?${params}`)

  // Full-screen route: the back button and the icon actions share one topbar row
  // (the modal renders them inline instead — it has no topbar). Re-runs on fav so
  // the heart fills/empties, and on load so the actions appear once the recipe is in.
  useTopbarFull(
    () =>
      fullScreen ? (
        <>
          <button type="button" className="pill" onClick={() => navigate(-1)}>‹ Recipes</button>
          {recipe && (
            <div className="rd-topbar-actions">
              <RecipeActionIcons
                fav={fav}
                onFav={toggleFav}
                onEdit={() => navigate(`/meals/recipe/${recipe.id}/edit`)}
                onSchedule={() => setScheduling(true)}
              />
            </div>
          )}
        </>
      ) : null,
    [fullScreen, fav, recipe?.id]
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

  // Categorical chips are what people scan — show the first few, tuck the rest behind
  // a "+N more" toggle. Free-form #hashtags drop to a quiet muted line (they're for
  // search, not scanning).
  const chipTags: Array<{ key: string; label: string; cls?: string; params: string }> = []
  if (fav) chipTags.push({ key: 'fav', label: '❤️ Favorites', cls: 'fav', params: 'fav=1' })
  if (cooked === 0) chipTags.push({ key: 'new', label: '🆕 New', cls: 'new', params: 'new=1' })
  if (recipe.collection) chipTags.push({ key: 'coll', label: `📁 ${recipe.collection}`, cls: 'coll', params: `collection=${enc(recipe.collection)}` })
  if (recipe.cuisine) chipTags.push({ key: 'cuisine', label: `🌍 ${recipe.cuisine}`, params: `cuisine=${enc(recipe.cuisine)}` })
  if (recipe.mealType) chipTags.push({ key: 'meal', label: recipe.mealType.replace('-', ' '), params: `q=${enc(recipe.mealType)}` })
  if (recipe.protein) chipTags.push({ key: 'protein', label: `🥩 ${recipe.protein}`, params: `protein=${enc(recipe.protein)}` })
  if (recipe.base) chipTags.push({ key: 'base', label: `🍚 ${recipe.base}`, params: `q=${enc(recipe.base)}` })
  if (recipe.cookMethod) chipTags.push({ key: 'method', label: `🍳 ${recipe.cookMethod}`, params: `q=${enc(recipe.cookMethod)}` })
  if (recipe.effort) chipTags.push({ key: 'effort', label: `⏱️ ${recipe.effort}`, params: `q=${enc(recipe.effort)}` })
  for (const d of recipe.dietary) chipTags.push({ key: `d-${d}`, label: d, cls: 'diet', params: `diet=${enc(d)}` })
  for (const v of recipe.vegetables) chipTags.push({ key: `v-${v}`, label: `🥬 ${v}`, cls: 'veg', params: `q=${enc(v)}` })
  const VISIBLE_TAGS = 3
  const shownTags = showAllTags ? chipTags : chipTags.slice(0, VISIBLE_TAGS)
  const hiddenCount = chipTags.length - shownTags.length
  const hashtags = [...recipe.addedTags, ...(recipe.tags ?? []).filter((t) => !recipe.addedTags.includes(t))]

  return (
    <div className="recipe-view">
      {/* Modal preview has no topbar, so the actions render inline here; the
          full-screen route puts them on the back-button row (see useTopbarFull). */}
      {!fullScreen && (
        <div className="rd-actions">
          {onSelect && (
            <button type="button" className="btn btn-primary rd-select" onClick={onSelect}>
              {selectLabel ?? 'Select'}
            </button>
          )}
          <RecipeActionIcons
            fav={fav}
            onFav={toggleFav}
            onEdit={() => navigate(`/meals/recipe/${recipe.id}/edit`)}
            onSchedule={() => setScheduling(true)}
          />
        </div>
      )}

      <div className="recipe-detail">
        {/* left: hero + meta + ingredients */}
        <div className="rd-left">
          <div className="rd-hero">
            {recipe.imageUrl ? (
              <img src={recipe.imageUrl} alt={recipe.title} />
            ) : (
              <span className="rd-hero-emoji">{recipe.emoji ?? '🍽️'}</span>
            )}
          </div>
          <div className="wf-serif rd-title">{recipe.title}</div>
          <div className="rd-meta">
            {recipe.cookTimeMinutes != null && <span>🕐 {recipe.cookTimeMinutes} min</span>}
            <span>🍽️ Serves {base}</span>
            {steps.length > 0 && <span>🪜 {steps.length} steps</span>}
            {recipe.sourceName && <span>📖 {recipe.sourceName}</span>}
          </div>

          <div className="rd-tagrow">
            {shownTags.map((t) => (
              <button key={t.key} className={`rd-tag ${t.cls ?? ''}`} onClick={() => chip(t.params)}>{t.label}</button>
            ))}
            {chipTags.length > VISIBLE_TAGS && (
              <button className="rd-tag rd-tag-more" onClick={() => setShowAllTags((v) => !v)}>
                {showAllTags ? 'Show less' : `+${hiddenCount} more`}
              </button>
            )}
          </div>
          {hashtags.length > 0 && (
            <div className="rd-hashtags">{hashtags.map((t) => `#${t}`).join(' · ')}</div>
          )}

          {steps.length > 0 && (
            <button type="button" className="rd-cookbar" onClick={() => navigate(`/meals/recipe/${recipe.id}/cook`)}>
              <span className="rd-cookbar-emoji" aria-hidden>👨‍🍳</span>
              Cook Mode
            </button>
          )}

          <div className="rd-status-row">
            <span className="st-lbl">{cooked > 0 ? `👨‍🍳 Cooked ${cooked}×` : 'Not cooked yet'}</span>
            <button type="button" className="rd-markbtn" onClick={markCooked}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg>
              Mark cooked
            </button>
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
          <div className="rd-ai">
            <div className="rd-ai-sp"><svg viewBox="0 0 24 24"><path d="M12 2.5l1.7 5.2 5.3 1.6-5.3 1.6L12 16l-1.7-5.1-5.3-1.6 5.3-1.6z" /></svg></div>
            <div className="rd-ai-tx">
              <b>{onHand} of {ingredients.length}</b> {onHand === ingredients.length ? 'ingredients on hand' : 'ingredients already on hand'}
              {missing.length > 0 && ` — need ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` +${missing.length - 3} more` : ''}`}
            </div>
            {missing.length > 0 && (
              <button type="button" className="rd-ai-go" onClick={addToGrocery}>Add to grocery</button>
            )}
          </div>
          {addedNote && <div className="rd-added tiny">{addedNote}</div>}

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
      {usedMatches && (
        <CookConfirm
          title={recipe.title}
          matches={usedMatches}
          onClose={() => setUsedMatches(null)}
          onApplied={(n) => n > 0 && setAddedNote(`Pantry updated — ${n} item${n === 1 ? '' : 's'}.`)}
        />
      )}
    </div>
  )
}
