// Markdown recipe parser — the single source of truth for turning a recipe in the
// blessed Markdown format into structured data. Used by both the `import-recipes`
// dev/seed CLI and the in-app "paste markdown" path (POST /api/recipes/parse-markdown),
// so a pasted recipe gets the same parsing + grocery aisle tagging as an imported one.
//
// Format: YAML-ish frontmatter, a `*N servings | … cal*` meta line, `## Ingredients`
// with `### sections` of `amount unit name, prep` bullets, and `## Instructions`
// numbered steps (each with an optional `**Ingredients:**` sub-block). See
// docs/RECIPE_FORMAT.md.
import { aisleFor, isStaple } from '../lists/aisles'

// ---- ingredient line parsing ---------------------------------------------

const FRACTIONS: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875, '⅕': 0.2, '⅖': 0.4 }
const UNITS = new Set(['oz', 'oz.', 'lb', 'lbs', 'g', 'kg', 'ml', 'l', 'tsp', 'tsp.', 'teaspoon', 'teaspoons', 'tbsp', 'tbsp.', 'tablespoon', 'tablespoons', 'cup', 'cups', 'clove', 'cloves', 'can', 'cans', 'jar', 'jars', 'bunch', 'bunches', 'sprig', 'sprigs', 'ct', 'count', 'package', 'packages', 'pkg', 'bottle', 'bottles', 'slice', 'slices', 'pinch', 'stick', 'sticks', 'head', 'heads'])

// Leading modifiers that describe an ingredient but never stand alone as one, e.g.
// "boneless, skinless chicken breast". A comma right after a run of these is part of
// the name, not the start of the prep note — otherwise the name collapses to
// "boneless". Everything else keeps the normal "name, prep note" split.
export const INGREDIENT_MODIFIERS = new Set([
  'boneless', 'skinless', 'bone-in', 'skin-on', 'fresh', 'frozen', 'organic',
  'ripe', 'lean', 'large', 'medium', 'small', 'jumbo', 'extra-large', 'x-large',
  'unsalted', 'salted', 'sweet', 'baby', 'whole', 'free-range', 'wild-caught',
])

// True when every word of `s` is a leading modifier (so "boneless" / "boneless
// skinless" → true, "scallions" / "chicken breast" → false).
export function isAllModifiers(s: string): boolean {
  const words = s.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return words.length > 0 && words.every((w) => INGREDIENT_MODIFIERS.has(w))
}

export function parseAmount(token: string): number | null {
  // mixed unicode like "4½", or "4 1/2", or plain "1.5", or fraction "1/2", or "½"
  const t = token.trim()
  const mixed = /^(\d+)([½¼¾⅓⅔⅛⅜⅝⅞⅕⅖])$/.exec(t)
  if (mixed) return parseInt(mixed[1], 10) + (FRACTIONS[mixed[2]] ?? 0)
  if (FRACTIONS[t] != null) return FRACTIONS[t]
  const frac = /^(\d+)\/(\d+)$/.exec(t)
  if (frac) return parseInt(frac[1], 10) / parseInt(frac[2], 10)
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t)
  // ranges "2-3" → take the first
  const range = /^(\d+(?:\.\d+)?)\s*[-–]\s*\d/.exec(t)
  if (range) return parseFloat(range[1])
  return null
}

export interface ParsedIng {
  name: string
  amount: number | null
  unit: string | null
  prepNote: string | null
  display: string
  section: string | null
  aisle: string
  isStaple: boolean
}

export function parseIngredient(raw: string, section: string | null): ParsedIng {
  const display = raw.trim()
  let rest = display
  let amount: number | null = null
  let unit: string | null = null

  // leading amount (supports "1", "½", "4½", "1/2", "2-3")
  const amtMatch = /^([\d.]+[½¼¾⅓⅔⅛⅜⅝⅞⅕⅖]?|[½¼¾⅓⅔⅛⅜⅝⅞⅕⅖]|\d+\/\d+|\d+\s*[-–]\s*\d+)\s+(.*)$/.exec(rest)
  if (amtMatch) {
    amount = parseAmount(amtMatch[1])
    rest = amtMatch[2]
  }
  // optional unit token (handles a trailing dot like "oz." / "tsp.")
  const unitMatch = /^([A-Za-z]+)\.?\s+(.*)$/.exec(rest)
  if (unitMatch && (UNITS.has(unitMatch[1].toLowerCase()) || UNITS.has(unitMatch[1].toLowerCase() + '.'))) {
    unit = unitMatch[1]
    rest = unitMatch[2]
  }
  // a parenthetical size like "(15 oz.)" — drop from the name (kept in display)
  rest = rest.replace(/\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim()
  // Prep note after a comma. Normally the first comma is the name↔prep boundary
  // ("mozzarella, shredded"), but a comma that merely follows a run of leading
  // modifiers ("boneless," / "boneless, skinless,") is part of the name — skip it,
  // or the name collapses to "boneless". Split at the first NON-modifier comma.
  let prepNote: string | null = null
  let segStart = 0
  for (let ci = rest.indexOf(','); ci >= 0; ci = rest.indexOf(',', ci + 1)) {
    if (isAllModifiers(rest.slice(segStart, ci))) {
      segStart = ci + 1
      continue
    }
    prepNote = rest.slice(ci + 1).trim() || null
    rest = rest.slice(0, ci).trim()
    break
  }
  // strip a leading size word that isn't a unit ("large sweet onion" → "sweet onion")
  const name = rest.replace(/^(large|medium|small|jumbo|x-?large)\s+/i, '').replace(/\.$/, '').trim()
  return { name, amount, unit, prepNote, display, section, aisle: aisleFor(name || display, unit), isStaple: isStaple(name || display) }
}

// ---- duration parsing -----------------------------------------------------

// Parse a human-written duration ("20 minutes", "1 hour 30 min", "90s", "1.5 hrs")
// into total seconds. Sums every unit-tagged number it finds. Returns null when the
// string carries no recognizable duration.
const DURATION_UNIT_SECONDS: Array<{ re: RegExp; mult: number }> = [
  { re: /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/gi, mult: 3600 },
  { re: /(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/gi, mult: 60 },
  { re: /(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/gi, mult: 1 },
]

export function parseDuration(raw: string | null | undefined): number | null {
  const t = (raw ?? '').trim()
  if (!t) return null
  let total = 0
  let matched = false
  for (const { re, mult } of DURATION_UNIT_SECONDS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(t)) !== null) {
      total += parseFloat(m[1]) * mult
      matched = true
    }
  }
  if (!matched) return null
  return Math.round(total)
}

// ---- markdown parsing -----------------------------------------------------

export interface ParsedRecipe {
  title: string
  emoji: string
  tags: string[]
  servings: number
  description: string | null
  notes: string | null
  sourceName: string | null
  // rich frontmatter metadata
  mealType: string | null
  protein: string | null
  base: string | null
  cuisine: string | null
  effort: string | null
  cookMethod: string | null
  flavorProfile: string | null
  dietary: string[]
  vegetables: string[]
  collection: string | null
  ingredients: ParsedIng[]
  steps: Array<{ text: string; ingredients: string[]; timerSeconds?: number }>
  markdown: string
}

export function parseFrontmatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(md)
  const out: Record<string, string> = {}
  if (!m) return out
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z_]+):\s*(.*)$/i.exec(line.trim())
    if (kv) out[kv[1]] = kv[2]
  }
  return out
}

export function parseList(v: string | undefined): string[] {
  if (!v) return []
  return v.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
}

export function clean(v: string | undefined): string | null {
  const s = (v ?? '').trim().replace(/^["']|["']$/g, '')
  return s && s.toLowerCase() !== 'none' ? s : null
}

export function parseRecipe(md: string, collection: string | null = null): ParsedRecipe {
  const fm = parseFrontmatter(md)
  const body = md.replace(/^---\n[\s\S]*?\n---\n?/, '')

  const title = (/^#\s+(.+)$/m.exec(body)?.[1] ?? 'Untitled').trim()
  const servings = parseInt(/\*\s*(\d+)\s+servings/i.exec(body)?.[1] ?? '4', 10) || 4
  const tags = parseList(fm.tags)
  const base = fm.base ?? ''
  const emoji = /noodle|pasta/i.test(base + ' ' + tags.join(' ')) ? '🍝' : /chicken/i.test(fm.protein ?? '') ? '🍗' : '🍽️'

  // ## Ingredients → ### sections → bullets
  const ingredients: ParsedIng[] = []
  const ingSection = /##\s+Ingredients\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i.exec(body)?.[1] ?? ''
  let section: string | null = null
  for (const line of ingSection.split('\n')) {
    const sec = /^###\s+(.+)$/.exec(line.trim())
    if (sec) {
      section = sec[1].trim()
      continue
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line.trim())
    if (bullet) ingredients.push(parseIngredient(bullet[1], section))
  }

  // ## Instructions → numbered steps, each with its own per-step ingredient list
  // (the "**Ingredients:**" sub-block). REQUIRED to keep.
  const steps: Array<{ text: string; ingredients: string[]; timerSeconds?: number }> = []
  const insSection = /##\s+Instructions\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i.exec(body)?.[1] ?? ''
  for (const block of insSection.split(/\n(?=\d+\.\s)/)) {
    const num = /^\s*\d+\.\s+([\s\S]*)$/.exec(block)
    if (!num) continue
    // A step timer can be declared two ways (either strips out of the display text):
    //   - a **Timer:** sub-line (mirrors **Ingredients:**), e.g. "**Timer:** 20 minutes"
    //   - an inline {timer: …} token, e.g. "Rest the dough. {timer: 1 hour 30 min}"
    // Extract it from the WHOLE step body first — it may sit before OR after the
    // **Ingredients:** sub-list — then split off the per-step ingredients.
    let timerSeconds: number | undefined
    let stepBody = num[1]
    const subLine = /\*\*\s*Timer:?\s*\*\*\s*([^\n]+)/i.exec(stepBody)
    if (subLine) {
      timerSeconds = parseDuration(subLine[1]) ?? undefined
      stepBody = stepBody.replace(subLine[0], ' ')
    }
    const inline = /\{\s*timer:?\s*([^}]+)\}/i.exec(stepBody)
    if (inline) {
      timerSeconds = timerSeconds ?? (parseDuration(inline[1]) ?? undefined)
      stepBody = stepBody.replace(inline[0], ' ')
    }
    const [textPart, ingPart] = stepBody.split(/\*\*\s*Ingredients?:?\s*\*\*/i)
    const text = textPart.replace(/\s+/g, ' ').trim()
    const ings: string[] = []
    if (ingPart) {
      for (const line of ingPart.split('\n')) {
        const bl = /^\s*[-*]\s+(.+)$/.exec(line)
        if (bl) ings.push(bl[1].trim())
      }
    }
    if (text) steps.push(timerSeconds != null ? { text, ingredients: ings, timerSeconds } : { text, ingredients: ings })
  }

  // ## Notes → notes + source
  const notesBlock = /##\s+Notes\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i.exec(body)?.[1] ?? ''
  const notes = notesBlock.trim() || null
  const sourceName = /Source:\s*(.+)/i.exec(notesBlock)?.[1]?.trim() ?? (fm.cuisine ? `${fm.cuisine}` : null)

  return {
    title,
    emoji,
    tags,
    servings,
    description: null,
    notes,
    sourceName,
    mealType: clean(fm.type),
    protein: clean(fm.protein),
    base: clean(fm.base),
    cuisine: clean(fm.cuisine),
    effort: clean(fm.effort),
    cookMethod: clean(fm.cook_method),
    flavorProfile: clean(fm.flavor_profile),
    dietary: parseList(fm.dietary),
    vegetables: parseList(fm.vegetables),
    collection,
    ingredients,
    steps,
    markdown: md,
  }
}
