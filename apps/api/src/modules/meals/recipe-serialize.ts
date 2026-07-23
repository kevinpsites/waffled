// Recipe → Markdown serializer — the inverse of recipe-markdown.ts's parseRecipe.
// Turns a stored recipe (the { recipe, ingredients, steps } shape the
// GET /api/recipes/:id route returns) back into the blessed Markdown format so it can
// be shared as a portable .md file/text. Kept symmetric with the parser: the round-trip
// parseRecipe(serializeRecipe(x)) preserves title, servings, tags, metadata, ingredients,
// steps, and notes/source. See docs/RECIPE_FORMAT.md.

export interface SerializeIngredient {
  name: string
  amount?: number | null
  unit?: string | null
  prepNote?: string | null
  display?: string | null
  section?: string | null
}

export interface SerializeStep {
  instruction: string
  ingredients?: string[] | null
  timerSeconds?: number | null
}

export interface SerializeRecipe {
  title: string
  servings?: number | null
  prepTimeMinutes?: number | null
  cookTimeMinutes?: number | null
  tags?: string[] | null
  mealType?: string | null
  protein?: string | null
  base?: string | null
  cuisine?: string | null
  effort?: string | null
  cookMethod?: string | null
  flavorProfile?: string | null
  dietary?: string[] | null
  vegetables?: string[] | null
  notes?: string | null
  sourceName?: string | null
}

export interface SerializeDetail {
  recipe: SerializeRecipe
  ingredients: SerializeIngredient[]
  steps: SerializeStep[]
}

// Inverse of parseDuration: whole seconds → "1 hour 30 minutes". Returns null for a
// zero/absent duration (so callers can omit the **Timer:** line entirely). Uses the long
// unit words the parser understands, and singular/plural agreement.
export function formatDuration(seconds: number | null | undefined): string | null {
  const total = Math.round(seconds ?? 0)
  if (!total || total < 0) return null
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const parts: string[] = []
  const push = (n: number, unit: string) => { if (n) parts.push(`${n} ${unit}${n === 1 ? '' : 's'}`) }
  push(h, 'hour')
  push(m, 'minute')
  push(s, 'second')
  return parts.join(' ')
}

// A safe, portable download filename from the recipe title.
export function recipeFilename(title: string): string {
  const slug = (title ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'recipe'}.md`
}

function list(v: string[] | null | undefined): string | null {
  const items = (v ?? []).map((s) => s.trim()).filter(Boolean)
  return items.length ? `[${items.join(', ')}]` : null
}

// One ingredient bullet. Prefer the stored raw `display` line (round-trips exactly);
// otherwise compose "<amount> <unit> <name>, <prepNote>" from the parts.
function ingredientLine(i: SerializeIngredient): string {
  const display = (i.display ?? '').trim()
  if (display) return display
  const parts = [i.amount != null ? String(i.amount) : '', i.unit ?? '', i.name ?? ''].map((p) => p.trim()).filter(Boolean)
  let line = parts.join(' ')
  if (i.prepNote && i.prepNote.trim()) line += `, ${i.prepNote.trim()}`
  return line
}

export function serializeRecipe(detail: SerializeDetail): string {
  const { recipe, ingredients, steps } = detail
  const out: string[] = []

  // --- frontmatter (only non-empty fields) ---
  const fm: string[] = []
  const scalar = (key: string, v: string | null | undefined) => { if (v && v.trim()) fm.push(`${key}: ${v.trim()}`) }
  scalar('type', recipe.mealType)
  scalar('protein', recipe.protein)
  scalar('base', recipe.base)
  scalar('cuisine', recipe.cuisine)
  scalar('effort', recipe.effort)
  scalar('cook_method', recipe.cookMethod)
  scalar('flavor_profile', recipe.flavorProfile)
  const dietary = list(recipe.dietary)
  if (dietary) fm.push(`dietary: ${dietary}`)
  const vegetables = list(recipe.vegetables)
  if (vegetables) fm.push(`vegetables: ${vegetables}`)
  const tags = list(recipe.tags)
  if (tags) fm.push(`tags: ${tags}`)
  if (fm.length) {
    out.push('---')
    out.push(...fm)
    out.push('---')
    out.push('')
  }

  // --- title + servings ---
  out.push(`# ${recipe.title.trim()}`)
  out.push('')
  const servings = recipe.servings && recipe.servings > 0 ? recipe.servings : 4
  const totalMin = (recipe.prepTimeMinutes ?? 0) + (recipe.cookTimeMinutes ?? 0)
  // Always the plural "servings" token — the parser only matches `\d+ servings`, so a
  // singular "*1 serving*" would silently fall back to the default 4 on re-import.
  const servingsLine = `*${servings} servings${totalMin > 0 ? ` | ${totalMin} min` : ''}*`
  out.push(servingsLine)

  // --- ingredients, grouped by section (header emitted on section change) ---
  if (ingredients.length) {
    out.push('')
    out.push('## Ingredients')
    let currentSection: string | null = null
    for (const ing of ingredients) {
      const section = (ing.section ?? '').trim() || null
      if (section && section !== currentSection) {
        out.push('')
        out.push(`### ${section}`)
        currentSection = section
      }
      out.push(`- ${ingredientLine(ing)}`)
    }
  }

  // --- instructions (numbered), each with optional per-step ingredients + timer ---
  if (steps.length) {
    out.push('')
    out.push('## Instructions')
    out.push('')
    steps.forEach((step, idx) => {
      out.push(`${idx + 1}. ${step.instruction.trim()}`)
      const stepIngs = (step.ingredients ?? []).map((s) => s.trim()).filter(Boolean)
      if (stepIngs.length) {
        out.push('   **Ingredients:**')
        for (const si of stepIngs) out.push(`   - ${si}`)
      }
      const timer = formatDuration(step.timerSeconds)
      if (timer) out.push(`   **Timer:** ${timer}`)
    })
  }

  // --- notes + source ---
  const notes = (recipe.notes ?? '').trim()
  const source = (recipe.sourceName ?? '').trim()
  const notesHasSource = /^source:/im.test(notes)
  if (notes || (source && !notesHasSource)) {
    out.push('')
    out.push('## Notes')
    out.push('')
    if (notes) out.push(notes)
    if (source && !notesHasSource) out.push(`Source: ${source}`)
  }

  return out.join('\n') + '\n'
}
