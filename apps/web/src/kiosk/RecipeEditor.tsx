import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useTopbarFull } from './topbar-slot'
import { ChipEditor } from './components/ChipEditor'
import { ConfirmDialog } from './components/ConfirmDialog'
import { RECIPE_TEMPLATE, RECIPE_EXAMPLE } from './components/recipe-template'
import { mealsApi, uploadImage, useRecipe, type IngredientInput, type RecipeMetadataSuggestion, type RecipeWriteInput, type StepInput } from '../lib/api'
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
type EditStep = { uid: string; instruction: string; picks: StepPick[]; extra: string[]; timerSeconds: number | null }

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
const blankStep = (): EditStep => ({ uid: newUid(), instruction: '', picks: [], extra: [], timerSeconds: null })

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
  return { instruction: s.instruction.trim(), ingredients: [...fromPicks, ...s.extra], timerSeconds: s.timerSeconds ?? null }
}

// Map stored display strings (e.g. "1 cup breadcrumbs") back onto ingredient picks
// when editing: match each to an ingredient by name (longest wins), the leading text
// becomes the per-step amount; anything unmatched is preserved as free text.
function stepFromStrings(instruction: string, strings: string[], ings: EditIng[], timerSeconds: number | null = null): EditStep {
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
  return { uid: newUid(), instruction, picks, extra, timerSeconds }
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
  // When the user uploads a photo we carry the returned storageKey (the server resolves
  // it to the served imageUrl on save). `imagePreview` shows the uploaded image inline.
  const [storageKey, setStorageKey] = useState<string | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState<string | null>(null)
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

  // Quiet AI auto-fill: compute a metadata suggestion in the background as the recipe
  // takes shape; show each one inline (per field) to keep or dismiss; never overwrite
  // what the user typed.
  const [suggestion, setSuggestion] = useState<RecipeMetadataSuggestion | null>(null)
  const [suggesting, setSuggesting] = useState(false) // an AI request is in flight
  const [dismissed, setDismissed] = useState<Set<string>>(new Set()) // individually-dismissed suggestion keys
  const aiOffRef = useRef(false) // stop probing once the server says no provider
  const lastSigRef = useRef('')

  // Keyboard flow: focus the newly-added ingredient/step row so the cursor stays put.
  const ingListRef = useRef<HTMLDivElement>(null)
  const stepListRef = useRef<HTMLDivElement>(null)
  const focusIngRef = useRef(false)
  const focusStepRef = useRef(false)

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
    // Restore the existing image so an edit that doesn't touch it re-sends the same
    // key (a blob) or URL instead of clearing it. A stored blob has a storageKey;
    // otherwise imageUrl is an external link to keep in the URL field.
    if (recipe.storageKey) {
      setStorageKey(recipe.storageKey)
      setImageUrl('')
    } else {
      setImageUrl(recipe.imageUrl ?? '')
    }
    setImagePreview(recipe.imageUrl ?? null)
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
        ? steps.map((s) => stepFromStrings(s.instruction, s.ingredients, ingRows, s.timerSeconds ?? null))
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

  async function onPickImage(file: File | undefined) {
    if (!file) return
    setUploadErr(null)
    setUploading(true)
    try {
      const { key, url } = await uploadImage(file)
      setStorageKey(key)
      setImageUrl('') // a fresh upload supersedes any typed URL
      setImagePreview(url)
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : 'Upload failed — please try again.')
    } finally {
      setUploading(false)
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
      storageKey: storageKey || null,
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
      // replace: true so the editor page doesn't linger in history — otherwise
      // "‹ Recipes" from the saved recipe would walk back INTO the editor.
      if (isEdit) {
        await mealsApi.updateRecipe(id!, payload)
        navigate(`/meals/recipe/${id}`, { replace: true })
      } else {
        const created = await mealsApi.createRecipe(payload)
        navigate(`/meals/recipe/${created.id}`, { replace: true })
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
  const setStepTimer = (i: number, secs: number | null) =>
    setStps((rs) => patch(rs, i, { timerSeconds: secs }))

  const namedIngs = ings.filter((g) => g.name.trim())

  // ── quiet AI auto-fill ──
  const META_AI_KEYS = ['cuisine', 'protein', 'mealType', 'base', 'effort', 'cookMethod', 'flavorProfile'] as const
  const ingNames = ings.map((g) => g.name.trim()).filter(Boolean)
  const stepTexts = stps.map((s) => s.instruction.trim()).filter(Boolean)
  const aiSig = JSON.stringify([title.trim(), ingNames, stepTexts])

  useEffect(() => {
    if (aiOffRef.current || title.trim().length < 3 || ingNames.length < 1 || aiSig === lastSigRef.current) return
    const handle = setTimeout(async () => {
      lastSigRef.current = aiSig
      setSuggesting(true)
      try {
        const r = await mealsApi.suggestMetadata({ title: title.trim(), ingredients: ingNames, steps: stepTexts })
        if (r.suggestion) { setSuggestion(r.suggestion); setDismissed(new Set()) }
      } catch {
        aiOffRef.current = true // no provider / error → stop probing this session
        setSuggestion(null)
      } finally {
        setSuggesting(false)
      }
    }, 1200)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiSig])

  // A scalar suggestion shows only when the field is empty and not dismissed.
  const sugScalar = (key: string): string | null => {
    if (!suggestion || dismissed.has(key) || meta[key]?.trim()) return null
    const v = (suggestion as unknown as Record<string, unknown>)[key]
    return typeof v === 'string' && v.trim() ? v : null
  }
  // Array suggestions: items not already present and not dismissed.
  const sugItems = (prefix: string, cur: string[], sug: string[]): string[] =>
    sug.filter((x) => !cur.some((c) => c.toLowerCase() === x.toLowerCase()) && !dismissed.has(`${prefix}:${x.toLowerCase()}`))

  const sugDietary = suggestion ? sugItems('dietary', dietary, suggestion.dietary) : []
  const sugVeg = suggestion ? sugItems('veg', vegetables, suggestion.vegetables) : []
  const sugTags = suggestion ? sugItems('tag', tags, suggestion.tags) : []
  const aiPending =
    (suggestion ? META_AI_KEYS.filter((k) => sugScalar(k)).length : 0) + sugDietary.length + sugVeg.length + sugTags.length

  const dismiss = (key: string) => setDismissed((d) => new Set(d).add(key))
  const acceptScalar = (key: string, val: string) => setMeta((m) => ({ ...m, [key]: val }))
  const acceptItem = (set: typeof setDietary, cur: string[], val: string) => set([...cur, val])

  function keepAll() {
    if (!suggestion) return
    setMeta((m) => {
      const next = { ...m }
      for (const k of META_AI_KEYS) { const v = sugScalar(k); if (v) next[k] = v }
      return next
    })
    if (sugDietary.length) setDietary((d) => [...d, ...sugDietary])
    if (sugVeg.length) setVegetables((v) => [...v, ...sugVeg])
    if (sugTags.length) setTags((t) => [...t, ...sugTags])
    setSuggestion(null)
  }
  const dismissAll = () => { setSuggestion(null); setDismissed(new Set()) }

  function addIngredient() { setIngs((rs) => [...rs, blankIng()]); focusIngRef.current = true }
  function addStep() { setStps((rs) => [...rs, blankStep()]); focusStepRef.current = true }

  // After adding a row, drop the cursor into it so entry stays on the keyboard.
  useEffect(() => {
    if (!focusIngRef.current) return
    focusIngRef.current = false
    const rows = ingListRef.current?.querySelectorAll('.re-ing-row')
    ;(rows?.[rows.length - 1]?.querySelector('input') as HTMLInputElement | undefined)?.focus()
  }, [ings.length])
  useEffect(() => {
    if (!focusStepRef.current) return
    focusStepRef.current = false
    const rows = stepListRef.current?.querySelectorAll('.re-step-row')
    ;(rows?.[rows.length - 1]?.querySelector('textarea') as HTMLTextAreaElement | undefined)?.focus()
  }, [stps.length])

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
        <div className="card re-card re-paste">
          <div className="re-paste-head">
            <div className="card-h re-section-h">Paste a recipe in Markdown</div>
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
        <div className="re-card-head">
          <div className="card-h re-section-h">Details</div>
          {suggesting ? (
            <span className="re-ai-thinking"><span className="re-ai-spark">✨</span> Thinking…</span>
          ) : aiPending > 0 ? (
            <div className="re-ai-actions">
              <span className="re-ai-tag">✨ {aiPending} suggestion{aiPending === 1 ? '' : 's'}</span>
              <button type="button" className="re-ai-chip" onClick={keepAll}>Keep all</button>
              <button type="button" className="re-ai-dismiss" onClick={dismissAll}>Dismiss</button>
            </div>
          ) : null}
        </div>
        <div className="re-meta-grid">
          {META_FIELDS.map((f) => {
            const sv = sugScalar(f.key)
            return (
              <label key={f.key} className={`re-f${sv ? ' re-f-sug' : ''}`}>
                <span>{f.label}</span>
                {sv ? (
                  <div className="re-sug-field">
                    <input value={meta[f.key] ?? ''} onChange={(e) => setMeta((m) => ({ ...m, [f.key]: e.target.value }))} placeholder={`✨ ${sv}`} />
                    <button type="button" className="re-sug-ok" title={`Use “${sv}”`} aria-label={`Use ${sv}`} onClick={() => acceptScalar(f.key, sv)}>✓</button>
                    <button type="button" className="re-sug-no" title="Dismiss" aria-label="Dismiss suggestion" onClick={() => dismiss(f.key)}>×</button>
                  </div>
                ) : (
                  <input value={meta[f.key] ?? ''} onChange={(e) => setMeta((m) => ({ ...m, [f.key]: e.target.value }))} placeholder={f.placeholder} />
                )}
              </label>
            )
          })}
        </div>
        <div className="re-chips">
          <div className="re-chip-f">
            <div className="cz-label">Dietary</div>
            <ChipEditor items={dietary} onChange={setDietary} placeholder="gluten-free, vegan…" color="#ede4ff" />
            <SugChips items={sugDietary} onAccept={(v) => acceptItem(setDietary, dietary, v)} onDismiss={(v) => dismiss(`dietary:${v.toLowerCase()}`)} />
          </div>
          <div className="re-chip-f">
            <div className="cz-label">Vegetables</div>
            <ChipEditor items={vegetables} onChange={setVegetables} placeholder="spinach, tomato…" color="#e4f5e9" />
            <SugChips items={sugVeg} onAccept={(v) => acceptItem(setVegetables, vegetables, v)} onDismiss={(v) => dismiss(`veg:${v.toLowerCase()}`)} />
          </div>
          <div className="re-chip-f">
            <div className="cz-label">Tags</div>
            <ChipEditor items={tags} onChange={setTags} placeholder="family-favorite…" color="#e9eef6" />
            <SugChips items={sugTags} onAccept={(v) => acceptItem(setTags, tags, v)} onDismiss={(v) => dismiss(`tag:${v.toLowerCase()}`)} />
          </div>
        </div>
        <label className="re-f" style={{ marginTop: 14 }}>
          <span>Photo (optional)</span>
          <div className="re-image">
            <div className="re-image-row">
              <input
                value={imageUrl}
                onChange={(e) => { setImageUrl(e.target.value); if (e.target.value.trim()) { setStorageKey(null); setImagePreview(e.target.value.trim()) } }}
                placeholder="Paste an image URL…"
              />
              <label className="pill re-upload-btn" style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {uploading ? 'Uploading…' : '📷 Upload'}
                <input
                  type="file"
                  // Supported, canvas-decodable formats only — greys out HEIC in the
                  // picker; onPickImage/uploadImage still guard at runtime.
                  accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                  style={{ display: 'none' }}
                  disabled={uploading}
                  onChange={(e) => { onPickImage(e.target.files?.[0]); e.target.value = '' }}
                />
              </label>
            </div>
            {uploadErr && <div className="tiny" style={{ color: 'var(--danger,#c0392b)', fontWeight: 700, marginTop: 6 }}>{uploadErr}</div>}
            {imagePreview && (
              <div className="re-image-preview">
                <img src={imagePreview} alt="Recipe preview" />
                <button
                  type="button"
                  className="pill"
                  onClick={() => { setStorageKey(null); setImageUrl(''); setImagePreview(null) }}
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        </label>
      </div>

      {/* ingredients */}
      <div className="card re-card">
        <div className="card-h re-section-h" style={{ marginBottom: 14 }}>Ingredients</div>
        <div className="re-ings" ref={ingListRef}>
          {ings.map((row, i) => (
            <div key={i} className="re-ing-row">
              <input className="re-ing-amt" value={row.amount} onChange={(e) => setIngs((rs) => patch(rs, i, { amount: e.target.value }))} placeholder="2" />
              <input className="re-ing-unit" value={row.unit} onChange={(e) => setIngs((rs) => patch(rs, i, { unit: e.target.value }))} placeholder="cups" />
              <input className="re-ing-name" value={row.name} onChange={(e) => setIngs((rs) => patch(rs, i, { name: e.target.value }))} placeholder="ingredient" />
              <input className="re-ing-prep" value={row.prepNote} onChange={(e) => setIngs((rs) => patch(rs, i, { prepNote: e.target.value }))} placeholder="diced (optional)" />
              <input className="re-ing-sec" value={row.section} onChange={(e) => setIngs((rs) => patch(rs, i, { section: e.target.value }))} placeholder="section" />
              <div className="re-row-ctl">
                <button type="button" tabIndex={-1} aria-label="Move up" disabled={i === 0} onClick={() => moveIng(i, -1)}>↑</button>
                <button type="button" tabIndex={-1} aria-label="Move down" disabled={i === ings.length - 1} onClick={() => moveIng(i, 1)}>↓</button>
                <button type="button" tabIndex={-1} aria-label="Remove" className="re-del" onClick={() => setIngs((rs) => rs.filter((_, j) => j !== i))}>×</button>
              </div>
            </div>
          ))}
        </div>
        <button type="button" className="pill re-add-row" onClick={addIngredient}>+ Add ingredient</button>
      </div>

      {/* steps */}
      <div className="card re-card">
        <div className="card-h re-section-h" style={{ marginBottom: 14 }}>Method</div>
        <div className="re-steps" ref={stepListRef}>
          {stps.map((s, i) => (
            <div key={s.uid} className="re-step-row">
              <div className="re-step-n">{i + 1}</div>
              <div className="re-step-body">
                <textarea value={s.instruction} onChange={(e) => setStps((rs) => patch(rs, i, { instruction: e.target.value }))} placeholder="Describe this step…" rows={2} />
                <div className="re-step-tags">
                  <StepIngredients
                    picks={s.picks}
                    extra={s.extra}
                    namedIngs={namedIngs}
                    onAddPick={(ing) => addPick(i, ing)}
                    onRemovePick={(uid) => removePick(i, uid)}
                    onSetAmount={(uid, amt) => setPickAmount(i, uid, amt)}
                    onRemoveExtra={(j) => removeExtra(i, j)}
                  />
                  <StepTimerControl seconds={s.timerSeconds} onChange={(secs) => setStepTimer(i, secs)} />
                </div>
              </div>
              <div className="re-row-ctl">
                <button type="button" tabIndex={-1} aria-label="Move up" disabled={i === 0} onClick={() => moveStep(i, -1)}>↑</button>
                <button type="button" tabIndex={-1} aria-label="Move down" disabled={i === stps.length - 1} onClick={() => moveStep(i, 1)}>↓</button>
                <button type="button" tabIndex={-1} aria-label="Remove" className="re-del" onClick={() => setStps((rs) => rs.filter((_, j) => j !== i))}>×</button>
              </div>
            </div>
          ))}
        </div>
        <button type="button" className="pill re-add-row" onClick={addStep}>+ Add step</button>
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

// Visible AI suggestions for an array field — ghost chips you tap to keep (✨) or
// dismiss (×). Nothing is added until you tap.
function SugChips({ items, onAccept, onDismiss }: { items: string[]; onAccept: (v: string) => void; onDismiss: (v: string) => void }) {
  if (!items.length) return null
  return (
    <div className="re-sug-chips">
      {items.map((v) => (
        <span key={v} className="re-sug-chip">
          <button type="button" className="re-sug-chip-add" onClick={() => onAccept(v)} title={`Add ${v}`}>✨ {v}</button>
          <button type="button" className="re-sug-chip-x" aria-label={`Dismiss ${v}`} onClick={() => onDismiss(v)}>×</button>
        </span>
      ))}
    </div>
  )
}

// Per-step ingredient tagging: shows only the tagged ingredients as compact
// "• name · amount" tags; a "+ Tag ingredient" button opens a popover to check
// ingredients on/off and set per-step amounts (keeps the step row uncluttered).
function StepIngredients({
  picks,
  extra,
  namedIngs,
  onAddPick,
  onRemovePick,
  onSetAmount,
  onRemoveExtra,
}: {
  picks: StepPick[]
  extra: string[]
  namedIngs: EditIng[]
  onAddPick: (ing: EditIng) => void
  onRemovePick: (uid: string) => void
  onSetAmount: (uid: string, amount: string) => void
  onRemoveExtra: (j: number) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <>
      {/* The tag button (popover anchor) stays FIRST so it never shifts as tags are
          added or amounts change — otherwise the open popover jumps around. */}
      <div className="re-tagpop-wrap" ref={wrapRef}>
        <button type="button" className="re-tag-add" onClick={() => setOpen((o) => !o)}>+ Tag ingredient</button>
        {open && (
          <div className="re-tagpop">
            <div className="re-tagpop-h">Tag an ingredient for this step</div>
            {namedIngs.length === 0 ? (
              <div className="re-tagpop-empty">Add ingredients above first.</div>
            ) : (
              namedIngs.map((g) => {
                const picked = picks.find((p) => p.uid === g.uid)
                return (
                  <div className="re-tagpop-row" key={g.uid}>
                    <button
                      type="button"
                      className={`re-tagpop-check${picked ? ' on' : ''}`}
                      onClick={() => (picked ? onRemovePick(g.uid) : onAddPick(g))}
                      aria-label={picked ? `Untag ${g.name}` : `Tag ${g.name}`}
                    >
                      {picked ? '✓' : ''}
                    </button>
                    <span className={`re-tagpop-name${picked ? ' on' : ''}`}>{g.name}</span>
                    {picked && (
                      <input
                        className="re-tagpop-amt"
                        value={picked.amount}
                        placeholder="amt"
                        aria-label={`Amount of ${g.name}`}
                        onChange={(e) => onSetAmount(g.uid, e.target.value)}
                      />
                    )}
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>
      {picks.map((p) => {
        const g = namedIngs.find((x) => x.uid === p.uid)
        if (!g) return null
        return (
          <button type="button" key={p.uid} className="re-tag" onClick={() => setOpen(true)} aria-label={`Edit ${g.name} for this step`}>
            <span className="re-tag-dot" />
            <span className="re-tag-name">{g.name}</span>
            {p.amount.trim() && <span className="re-tag-amt">· {p.amount.trim()}</span>}
          </button>
        )
      })}
      {extra.map((x, j) => (
        <span key={`x${j}`} className="re-tag re-tag-extra">
          <span className="re-tag-dot" />
          <span className="re-tag-name">{x}</span>
          <button type="button" tabIndex={-1} aria-label={`Remove ${x}`} className="re-tag-x" onClick={() => onRemoveExtra(j)}>×</button>
        </span>
      ))}
    </>
  )
}

function fmtTimer(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Per-step timer: a filled "⏱ m:ss" pill when set (tap to edit, × to clear), or a
// dashed "⏱ Add timer" button when unset. Editing exposes minute + second inputs.
// The value lives on the step (prop-driven) so it never desyncs from saved state.
function StepTimerControl({ seconds, onChange }: { seconds: number | null; onChange: (secs: number | null) => void }) {
  const [editing, setEditing] = useState(false)
  const mins = seconds != null ? Math.floor(seconds / 60) : 0
  const secs = seconds != null ? seconds % 60 : 0

  // Commit minute/second edits back to a single total (null when both are empty/0).
  const commit = (m: number, s: number) => {
    const total = Math.max(0, Math.floor(m)) * 60 + Math.max(0, Math.min(59, Math.floor(s)))
    onChange(total > 0 ? total : null)
  }

  if (editing) {
    return (
      <span className="re-timer-edit">
        <span className="re-timer-ic" aria-hidden>⏱</span>
        <input type="number" min={0} className="re-timer-num" value={mins || ''} placeholder="0" aria-label="Timer minutes" autoFocus onChange={(e) => commit(Number(e.target.value || 0), secs)} />
        <span className="re-timer-unit">min</span>
        <input type="number" min={0} max={59} className="re-timer-num" value={secs || ''} placeholder="0" aria-label="Timer seconds" onChange={(e) => commit(mins, Number(e.target.value || 0))} />
        <span className="re-timer-unit">sec</span>
        <button type="button" className="re-timer-done" aria-label="Done" onClick={() => setEditing(false)}>✓</button>
        <button type="button" className="re-timer-cancel" aria-label="Remove timer" onClick={() => { onChange(null); setEditing(false) }}>×</button>
      </span>
    )
  }
  if (seconds != null) {
    return (
      <span className="re-timer-pill">
        <span aria-hidden>⏱</span>
        <button type="button" className="re-timer-time" onClick={() => setEditing(true)} aria-label="Edit timer">{fmtTimer(seconds)}</button>
        <button type="button" className="re-timer-x" aria-label="Remove timer" onClick={() => onChange(null)}>×</button>
      </span>
    )
  }
  return (
    <button type="button" className="re-timer-add" onClick={() => setEditing(true)}>⏱ Add timer</button>
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
