import { useState } from 'react'
import { mealsApi, type RecipeDetail, type RecipeOverrides } from '../../lib/api'

type MetaField = 'mealType' | 'protein' | 'base' | 'cuisine' | 'effort' | 'cookMethod' | 'flavorProfile'
const META_FIELDS: { key: MetaField; label: string; placeholder: string }[] = [
  { key: 'protein', label: 'Protein', placeholder: 'chicken, beef, tofu…' },
  { key: 'cuisine', label: 'Cuisine', placeholder: 'Italian, Thai…' },
  { key: 'mealType', label: 'Meal type', placeholder: 'dinner, breakfast…' },
  { key: 'base', label: 'Base', placeholder: 'rice, pasta, noodles…' },
  { key: 'effort', label: 'Effort', placeholder: 'easy, weeknight…' },
  { key: 'cookMethod', label: 'Cook method', placeholder: 'sheet-pan, skillet…' },
  { key: 'flavorProfile', label: 'Flavor', placeholder: 'savory, spicy…' },
]

// Small comma/enter chip editor for an array field. `sourceSet` (lowercased names)
// marks chips that came from the recipe file so they read differently from the
// user's own additions.
function ChipEditor({ items, onChange, placeholder, color, sourceSet }: { items: string[]; onChange: (next: string[]) => void; placeholder: string; color: string; sourceSet?: Set<string> }) {
  const [draft, setDraft] = useState('')
  function commit() {
    const v = draft.trim()
    if (v && !items.some((i) => i.toLowerCase() === v.toLowerCase())) onChange([...items, v])
    setDraft('')
  }
  return (
    <div className="cz-chips">
      {items.map((it) => {
        const fromSource = sourceSet?.has(it.toLowerCase())
        return (
          <span key={it} className={`cz-chip ${fromSource ? 'src' : ''}`} style={fromSource ? undefined : { background: color }}>
            {fromSource && <span className="cz-chip-src" aria-hidden>📄</span>}
            {it}
            <button type="button" aria-label={`Remove ${it}`} onClick={() => onChange(items.filter((x) => x !== it))}>×</button>
          </span>
        )
      })}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit() }
        }}
        placeholder={placeholder}
      />
    </div>
  )
}

// Edit a recipe's in-app overrides: metadata, dietary, and custom tags. Overrides
// win over the markdown source and survive re-imports, so we only persist values
// that actually differ from the source (or that were already overridden).
export function CustomizeModal({ recipe, onClose, onSaved }: { recipe: RecipeDetail; onClose: () => void; onSaved: () => void }) {
  const ov = recipe.overrides ?? {}
  const [form, setForm] = useState<Record<MetaField, string>>(() => {
    const f = {} as Record<MetaField, string>
    for (const { key } of META_FIELDS) f[key] = (recipe[key] as string | null) ?? ''
    return f
  })
  const [dietary, setDietary] = useState<string[]>(recipe.dietary ?? [])
  // The tag editor manages the full effective set (recipe-file tags + your own).
  const addedSet = new Set((recipe.addedTags ?? []).map((t) => t.toLowerCase()))
  const sourceTags = (recipe.tags ?? []).filter((t) => !addedSet.has(t.toLowerCase()))
  const sourceSet = new Set(sourceTags.map((t) => t.toLowerCase()))
  const [tags, setTags] = useState<string[]>(recipe.tags ?? [])
  const [saving, setSaving] = useState(false)

  const dietaryChanged = JSON.stringify(dietary) !== JSON.stringify(recipe.dietary ?? [])
  const lc = (s: string) => s.trim().toLowerCase()

  function buildOverrides(): RecipeOverrides {
    const meta: Record<string, string> = { ...(ov.meta ?? {}) }
    for (const { key } of META_FIELDS) {
      const v = form[key].trim()
      const hadOverride = (ov.meta ?? {})[key] != null
      if (!v) { delete meta[key]; continue } // cleared → revert to source
      // When no override exists yet, recipe[key] is the source value — skip if unchanged.
      if (!hadOverride && v === ((recipe[key] as string | null) ?? '')) continue
      meta[key] = v
    }
    const next: RecipeOverrides = { ...ov }
    if (Object.keys(meta).length) next.meta = meta
    else delete next.meta
    if (dietaryChanged) next.dietary = dietary

    // Tags: anything not from the recipe file is an addition; any source tag the
    // user dropped becomes a removal (kept across re-imports). A re-added tag wins.
    const workingLc = new Set(tags.map(lc))
    const added = tags.filter((t) => !sourceSet.has(lc(t)))
    const newlyRemoved = sourceTags.filter((t) => !workingLc.has(lc(t)))
    const removedAll = [...(ov.removedTags ?? []), ...newlyRemoved].filter((t) => !workingLc.has(lc(t)))
    const removed = [...new Map(removedAll.map((t) => [lc(t), t])).values()]
    if (added.length) next.addedTags = added
    else delete next.addedTags
    if (removed.length) next.removedTags = removed
    else delete next.removedTags
    return next
  }

  async function save() {
    setSaving(true)
    try {
      await mealsApi.updateRecipe(recipe.id, { overrides: buildOverrides() })
      onSaved()
      onClose()
    } catch {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card cz-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 2 }}>Customize “{recipe.title}”</div>
        <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 14 }}>Your edits win over the recipe file and stick across re-imports.</div>

        <div className="cz-grid">
          {META_FIELDS.map(({ key, label, placeholder }) => (
            <label key={key} className="cz-f">
              <span>{label}</span>
              <input value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} placeholder={placeholder} />
            </label>
          ))}
        </div>

        <div className="cz-section">
          <div className="cz-label">Dietary</div>
          <ChipEditor items={dietary} onChange={setDietary} placeholder="add dietary tag…" color="#ede4ff" />
        </div>

        <div className="cz-section">
          <div className="cz-label">Tags <span className="cz-hint">📄 from the recipe file · others are yours · remove any you don’t want</span></div>
          <ChipEditor items={tags} onChange={setTags} placeholder="add a tag…" color="#e9eef6" sourceSet={sourceSet} />
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
          <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={onClose}>Cancel</button>
          <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0, cursor: 'pointer' }} disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
