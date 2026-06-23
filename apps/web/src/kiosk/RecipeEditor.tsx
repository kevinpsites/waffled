import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useTopbarFull } from './topbar-slot'
import { ChipEditor } from './components/ChipEditor'
import { ConfirmDialog } from './components/ConfirmDialog'
import { RECIPE_TEMPLATE, RECIPE_EXAMPLE } from './components/recipe-template'
import { mealsApi, useRecipe, type IngredientInput, type RecipeWriteInput, type StepInput } from '../lib/api'
import '../styles/recipe.css'

// The one unified recipe editor — authoring a brand-new recipe and fully editing an
// existing one (title, metadata, ingredients, steps). Replaces the old override-only
// CustomizeModal. A "paste markdown" mode reuses the server parser to prefill the form.
// Editing an imported recipe's structure detaches it from its markdown source (handled
// server-side), so the dev/seed importer won't overwrite it.

// Each ingredient row carries a stable client uid so a step can reference it (chips)
// even before the recipe is saved / has DB ids, and the link survives reordering.
type EditIng = { uid: string; name: string; amount: string; unit: string; prepNote: string; section: string }
// A step's ingredients are picks of the recipe's ingredients (by uid) with an optional
// per-step amount (the "split" case: 2 cups water → 1 cup here, 1 cup elsewhere).
// `extra` holds free-text lines that didn't map back to an ingredient (legacy data).
type StepPick = { uid: string; amount: string }
type EditStep = { instruction: string; picks: StepPick[]; extra: string[] }

const newUid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `i${Math.random().toString(36).slice(2)}`

// The full-amount label shown by default when an ingredient is added to a step
// (e.g. "2 cups"). The user can edit it down for a split.
const defaultStepAmount = (ing: EditIng): string => [ing.amount.trim(), ing.unit.trim()].filter(Boolean).join(' ')

const META_FIELDS: { key: keyof RecipeWriteInput; label: string; placeholder: string }[] = [
  { key: 'cuisine', label: 'Cuisine', placeholder: 'Italian, Thai…' },
  { key: 'protein', label: 'Protein', placeholder: 'chicken, beef, tofu…' },
  { key: 'mealType', label: 'Meal type', placeholder: 'dinner, breakfast…' },
  { key: 'base', label: 'Base', placeholder: 'rice, pasta, noodles…' },
  { key: 'effort', label: 'Effort', placeholder: 'weeknight, weekend…' },
  { key: 'cookMethod', label: 'Cook method', placeholder: 'sheet-pan, skillet…' },
  { key: 'flavorProfile', label: 'Flavor', placeholder: 'savory, spicy…' },
  { key: 'collection', label: 'Collection', placeholder: 'Weeknight favorites…' },
]

const blankIng = (): EditIng => ({ uid: newUid(), name: '', amount: '', unit: '', prepNote: '', section: '' })
const blankStep = (): EditStep => ({ instruction: '', picks: [], extra: [] })

function toIngInput(r: EditIng, i: number): IngredientInput {
  const amount = r.amount.trim() ? Number(r.amount) : null
  return {
    name: r.name.trim(),
    amount: amount != null && Number.isFinite(amount) ? amount : null,
    unit: r.unit.trim() || null,
    prepNote: r.prepNote.trim() || null,
    section: r.section.trim() || null,
    sortOrder: i,
  }
}
function toStepInput(s: EditStep, ings: EditIng[]): StepInput {
  const byUid = new Map(ings.map((i) => [i.uid, i]))
  const fromPicks = s.picks
    .map((p) => {
      const ing = byUid.get(p.uid)
      if (!ing || !ing.name.trim()) return ''
      return [p.amount.trim(), ing.name.trim()].filter(Boolean).join(' ')
    })
    .filter(Boolean)
  return { instruction: s.instruction.trim(), ingredients: [...fromPicks, ...s.extra] }
}

// Map stored display strings (e.g. "1 cup breadcrumbs") back onto ingredient picks
// when editing: match each to an ingredient by name (longest wins), the leading text
// becomes the per-step amount; anything unmatched is preserved as free text.
function stepFromStrings(instruction: string, strings: string[], ings: EditIng[]): EditStep {
  const named = ings.filter((i) => i.name.trim())
  const picks: StepPick[] = []
  const extra: string[] = []
  for (const raw of strings) {
    const s = raw.trim()
    if (!s) continue
    const lc = s.toLowerCase()
    const match = named
      .filter((i) => lc.includes(i.name.trim().toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length)[0]
    if (match) {
      const idx = lc.indexOf(match.name.trim().toLowerCase())
      picks.push({ uid: match.uid, amount: s.slice(0, idx).trim() })
    } else extra.push(s)
  }
  return { instruction, picks, extra }
}

export function RecipeEditor() {
  const { id } = useParams()
  const isEdit = !!id
  const navigate = useNavigate()
  const { recipe, ingredients, steps, loading } = useRecipe(isEdit ? id! : null)

  const [title, setTitle] = useState('')
  const [emoji, setEmoji] = useState('')
  const [servings, setServings] = useState('4')
  const [prep, setPrep] = useState('')
  const [cook, setCook] = useState('')
  const [meta, setMeta] = useState<Record<string, string>>({})
  const [dietary, setDietary] = useState<string[]>([])
  const [vegetables, setVegetables] = useState<string[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [imageUrl, setImageUrl] = useState('')
  const [notes, setNotes] = useState('')
  const [ings, setIngs] = useState<EditIng[]>([blankIng()])
  const [stps, setStps] = useState<EditStep[]>([blankStep()])

  const [pasteOpen, setPasteOpen] = useState(false)
  const [markdown, setMarkdown] = useState('')
  const [parsing, setParsing] = useState(false)
  const [parseErr, setParseErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [prefilled, setPrefilled] = useState(false)

  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate(-1)}>‹ Back</button>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600 }}>{isEdit ? 'Edit recipe' : 'New recipe'}</div>
      </div>
    ),
    [navigate, isEdit]
  )

  // Prefill from the loaded recipe when editing.
  useEffect(() => {
    if (!isEdit || prefilled || !recipe) return
    setTitle(recipe.title)
    setEmoji(recipe.emoji ?? '')
    setServings(String(recipe.servings ?? 4))
    setPrep(recipe.prepTimeMinutes != null ? String(recipe.prepTimeMinutes) : '')
    setCook(recipe.cookTimeMinutes != null ? String(recipe.cookTimeMinutes) : '')
    setMeta({
      cuisine: recipe.cuisine ?? '', protein: recipe.protein ?? '', mealType: recipe.mealType ?? '',
      base: recipe.base ?? '', effort: recipe.effort ?? '', cookMethod: recipe.cookMethod ?? '',
      flavorProfile: recipe.flavorProfile ?? '', collection: recipe.collection ?? '',
    })
    setDietary(recipe.dietary ?? [])
    setVegetables(recipe.vegetables ?? [])
    setTags(recipe.tags ?? [])
    setNotes(recipe.userNotes ?? recipe.notes ?? '')
    const ingRows: EditIng[] = ingredients.length
      ? ingredients.map((i) => ({
          uid: newUid(), name: i.name, amount: i.amount != null ? String(i.amount) : '', unit: i.unit ?? '',
          prepNote: i.prepNote ?? '', section: i.section ?? '',
        }))
      : [blankIng()]
    setIngs(ingRows)
    setStps(
      steps.length
        ? steps.map((s) => stepFromStrings(s.instruction, s.ingredients, ingRows))
        : [blankStep()]
    )
    setPrefilled(true)
  }, [isEdit, prefilled, recipe, ingredients, steps])

  function applyParsed(p: Awaited<ReturnType<typeof mealsApi.parseMarkdown>>) {
    setTitle(p.recipe.title)
    setEmoji(p.recipe.emoji ?? '')
    setServings(String(p.recipe.servings ?? 4))
    setMeta({
      cuisine: p.recipe.cuisine ?? '', protein: p.recipe.protein ?? '', mealType: p.recipe.mealType ?? '',
      base: p.recipe.base ?? '', effort: p.recipe.effort ?? '', cookMethod: p.recipe.cookMethod ?? '',
      flavorProfile: p.recipe.flavorProfile ?? '', collection: '',
    })
    setDietary(p.recipe.dietary ?? [])
    setVegetables(p.recipe.vegetables ?? [])
    setTags(p.recipe.tags ?? [])
    setNotes(p.recipe.notes ?? '')
    const ingRows: EditIng[] = p.ingredients.length
      ? p.ingredients.map((i) => ({
          uid: newUid(), name: i.name, amount: i.amount != null ? String(i.amount) : '', unit: i.unit ?? '',
          prepNote: i.prepNote ?? '', section: i.section ?? '',
        }))
      : [blankIng()]
    setIngs(ingRows)
    setStps(p.steps.length ? p.steps.map((s) => stepFromStrings(s.instruction, s.ingredients ?? [], ingRows)) : [blankStep()])
  }

  async function parse() {
    if (!markdown.trim()) return
    setParsing(true)
    setParseErr(null)
    try {
      applyParsed(await mealsApi.parseMarkdown(markdown))
      setPasteOpen(false)
    } catch {
      setParseErr('Could not parse that — check the format and try again.')
    } finally {
      setParsing(false)
    }
  }

  function buildPayload(): RecipeWriteInput & { title: string } {
    const num = (s: string) => (s.trim() && Number.isFinite(Number(s)) ? Number(s) : null)
    return {
      title: title.trim(),
      emoji: emoji.trim() || null,
      servings: num(servings) ?? 4,
      prepTimeMinutes: num(prep),
      cookTimeMinutes: num(cook),
      cuisine: meta.cuisine?.trim() || null,
      protein: meta.protein?.trim() || null,
      mealType: meta.mealType?.trim() || null,
      base: meta.base?.trim() || null,
      effort: meta.effort?.trim() || null,
      cookMethod: meta.cookMethod?.trim() || null,
      flavorProfile: meta.flavorProfile?.trim() || null,
      collection: meta.collection?.trim() || null,
      dietary,
      vegetables,
      tags,
      imageUrl: imageUrl.trim() || null,
      notes: notes.trim() || null,
      ingredients: ings.filter((r) => r.name.trim()).map(toIngInput),
      steps: stps.filter((s) => s.instruction.trim()).map((s) => toStepInput(s, ings)),
    }
  }

  async function save() {
    if (!title.trim() || saving) return
    setSaving(true)
    try {
      const payload = buildPayload()
      if (isEdit) {
        await mealsApi.updateRecipe(id!, payload)
        navigate(`/meals/recipe/${id}`)
      } else {
        const created = await mealsApi.createRecipe(payload)
        navigate(`/meals/recipe/${created.id}`)
      }
    } catch {
      setSaving(false)
    }
  }

  async function remove() {
    if (!isEdit) return
    await mealsApi.deleteRecipe(id!)
    navigate('/meals/recipes')
  }

  // ── ingredient/step row ops ──
  const moveIng = (i: number, d: -1 | 1) => setIngs((rs) => swap(rs, i, i + d))
  const moveStep = (i: number, d: -1 | 1) => setStps((rs) => swap(rs, i, i + d))
  const addPick = (i: number, ing: EditIng) =>
    setStps((rs) => patch(rs, i, { picks: [...rs[i].picks, { uid: ing.uid, amount: defaultStepAmount(ing) }] }))
  const removePick = (i: number, uid: string) =>
    setStps((rs) => patch(rs, i, { picks: rs[i].picks.filter((p) => p.uid !== uid) }))
  const setPickAmount = (i: number, uid: string, amount: string) =>
    setStps((rs) => patch(rs, i, { picks: rs[i].picks.map((p) => (p.uid === uid ? { ...p, amount } : p)) }))
  const removeExtra = (i: number, j: number) =>
    setStps((rs) => patch(rs, i, { extra: rs[i].extra.filter((_, k) => k !== j) }))

  const namedIngs = ings.filter((g) => g.name.trim())

  if (isEdit && loading && !prefilled) return <div className="muted" style={{ padding: 30 }}>Loading…</div>

  return (
    <div className="recipe-editor">
      {!isEdit && (
        <div className="re-paste-bar">
          <span className="tiny muted" style={{ fontWeight: 700 }}>Build it by hand below, or</span>
          <button type="button" className="pill" onClick={() => setPasteOpen((v) => !v)}>📋 Paste markdown</button>
        </div>
      )}

      {pasteOpen && (
        <div className="card re-paste">
          <div className="re-paste-head">
            <div className="card-h">Paste a recipe in Markdown</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="pill" onClick={() => setMarkdown(RECIPE_TEMPLATE)}>Use template</button>
              <button type="button" className="pill" onClick={() => setMarkdown(RECIPE_EXAMPLE)}>See example</button>
            </div>
          </div>
          <textarea className="re-paste-input" value={markdown} onChange={(e) => setMarkdown(e.target.value)} placeholder="Paste frontmatter + markdown here…" rows={12} />
          {parseErr && <div className="tiny" style={{ color: 'var(--danger,#c0392b)', fontWeight: 700, marginTop: 6 }}>{parseErr}</div>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 10 }}>
            <button type="button" className="pill" onClick={() => setPasteOpen(false)}>Cancel</button>
            <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} disabled={parsing || !markdown.trim()} onClick={parse}>
              {parsing ? 'Parsing…' : 'Parse → fill the form'}
            </button>
          </div>
        </div>
      )}

      {/* basics */}
      <div className="card re-card">
        <div className="re-row re-title-row">
          <label className="re-f re-emoji">
            <span>Emoji</span>
            <input value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="🍽️" maxLength={4} />
          </label>
          <label className="re-f re-grow">
            <span>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Recipe title" />
          </label>
        </div>
        <div className="re-row">
          <label className="re-f re-num"><span>Servings</span><input type="number" min={1} value={servings} onChange={(e) => setServings(e.target.value)} /></label>
          <label className="re-f re-num"><span>Prep (min)</span><input type="number" min={0} value={prep} onChange={(e) => setPrep(e.target.value)} /></label>
          <label className="re-f re-num"><span>Cook (min)</span><input type="number" min={0} value={cook} onChange={(e) => setCook(e.target.value)} /></label>
        </div>
      </div>

      {/* metadata */}
      <div className="card re-card">
        <div className="card-h re-section-h">Details</div>
        <div className="re-meta-grid">
          {META_FIELDS.map((f) => (
            <label key={f.key} className="re-f">
              <span>{f.label}</span>
              <input value={meta[f.key] ?? ''} onChange={(e) => setMeta((m) => ({ ...m, [f.key]: e.target.value }))} placeholder={f.placeholder} />
            </label>
          ))}
        </div>
        <div className="re-chips">
          <div className="re-chip-f"><div className="cz-label">Dietary</div><ChipEditor items={dietary} onChange={setDietary} placeholder="gluten-free, vegan…" color="#ede4ff" /></div>
          <div className="re-chip-f"><div className="cz-label">Vegetables</div><ChipEditor items={vegetables} onChange={setVegetables} placeholder="spinach, tomato…" color="#e4f5e9" /></div>
          <div className="re-chip-f"><div className="cz-label">Tags</div><ChipEditor items={tags} onChange={setTags} placeholder="family-favorite…" color="#e9eef6" /></div>
        </div>
        <label className="re-f" style={{ marginTop: 14 }}>
          <span>Image URL (optional)</span>
          <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…" />
        </label>
      </div>

      {/* ingredients */}
      <div className="card re-card">
        <div className="re-card-head">
          <div className="card-h re-section-h">Ingredients</div>
          <button type="button" className="pill" onClick={() => setIngs((rs) => [...rs, blankIng()])}>+ Add ingredient</button>
        </div>
        <div className="re-ings">
          {ings.map((row, i) => (
            <div key={i} className="re-ing-row">
              <input className="re-ing-amt" value={row.amount} onChange={(e) => setIngs((rs) => patch(rs, i, { amount: e.target.value }))} placeholder="2" />
              <input className="re-ing-unit" value={row.unit} onChange={(e) => setIngs((rs) => patch(rs, i, { unit: e.target.value }))} placeholder="cups" />
              <input className="re-ing-name" value={row.name} onChange={(e) => setIngs((rs) => patch(rs, i, { name: e.target.value }))} placeholder="ingredient" />
              <input className="re-ing-prep" value={row.prepNote} onChange={(e) => setIngs((rs) => patch(rs, i, { prepNote: e.target.value }))} placeholder="diced (optional)" />
              <input className="re-ing-sec" value={row.section} onChange={(e) => setIngs((rs) => patch(rs, i, { section: e.target.value }))} placeholder="section" />
              <div className="re-row-ctl">
                <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => moveIng(i, -1)}>↑</button>
                <button type="button" aria-label="Move down" disabled={i === ings.length - 1} onClick={() => moveIng(i, 1)}>↓</button>
                <button type="button" aria-label="Remove" className="re-del" onClick={() => setIngs((rs) => rs.filter((_, j) => j !== i))}>×</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* steps */}
      <div className="card re-card">
        <div className="re-card-head">
          <div className="card-h re-section-h">Method</div>
          <button type="button" className="pill" onClick={() => setStps((rs) => [...rs, blankStep()])}>+ Add step</button>
        </div>
        <div className="re-steps">
          {stps.map((s, i) => (
            <div key={i} className="re-step-row">
              <div className="re-step-n">{i + 1}</div>
              <div className="re-step-body">
                <textarea value={s.instruction} onChange={(e) => setStps((rs) => patch(rs, i, { instruction: e.target.value }))} placeholder="Describe this step…" rows={2} />
                <div className="re-stepings">
                  <span className="re-stepings-label">Ingredients used</span>
                  {namedIngs.length === 0 && <span className="tiny muted" style={{ fontWeight: 600 }}>Add ingredients above to pick them here.</span>}
                  {namedIngs.map((g) => {
                    const picked = s.picks.find((p) => p.uid === g.uid)
                    if (picked) {
                      return (
                        <span key={g.uid} className="re-stepchip on">
                          <input
                            className="re-stepchip-amt"
                            value={picked.amount}
                            onChange={(e) => setPickAmount(i, g.uid, e.target.value)}
                            placeholder="amt"
                            aria-label={`Amount of ${g.name} for this step`}
                          />
                          <span className="re-stepchip-name">{g.name}</span>
                          <button type="button" aria-label={`Remove ${g.name} from step`} onClick={() => removePick(i, g.uid)}>×</button>
                        </span>
                      )
                    }
                    return (
                      <button key={g.uid} type="button" className="re-stepchip add" onClick={() => addPick(i, g)}>+ {g.name}</button>
                    )
                  })}
                  {s.extra.map((x, j) => (
                    <span key={`x${j}`} className="re-stepchip on re-stepchip-extra">
                      <span className="re-stepchip-name">{x}</span>
                      <button type="button" aria-label={`Remove ${x} from step`} onClick={() => removeExtra(i, j)}>×</button>
                    </span>
                  ))}
                </div>
              </div>
              <div className="re-row-ctl">
                <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => moveStep(i, -1)}>↑</button>
                <button type="button" aria-label="Move down" disabled={i === stps.length - 1} onClick={() => moveStep(i, 1)}>↓</button>
                <button type="button" aria-label="Remove" className="re-del" onClick={() => setStps((rs) => rs.filter((_, j) => j !== i))}>×</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card re-card">
        <div className="card-h re-section-h">Notes</div>
        <textarea className="re-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything worth remembering…" rows={3} />
      </div>

      <div className="re-actions">
        {isEdit && <button type="button" className="pill re-delete-btn" onClick={() => setConfirmDelete(true)}>🗑 Delete recipe</button>}
        <div className="re-actions-right">
          <button type="button" className="pill" onClick={() => navigate(-1)}>Cancel</button>
          <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} disabled={!title.trim() || saving} onClick={save}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create recipe'}
          </button>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete this recipe?"
          message="It will be removed from your library. Any planned meals lose the link."
          confirmLabel="Delete"
          danger
          onConfirm={remove}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}

function patch<T>(rows: T[], i: number, fields: Partial<T>): T[] {
  return rows.map((r, j) => (j === i ? { ...r, ...fields } : r))
}
function swap<T>(rows: T[], a: number, b: number): T[] {
  if (b < 0 || b >= rows.length) return rows
  const next = rows.slice()
  ;[next[a], next[b]] = [next[b], next[a]]
  return next
}
