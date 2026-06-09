// Import a folder of Markdown recipes into a household.
//
//   tsx scripts/import-recipes.ts <folder> [--sub dev|demo] [--household <uuid>]
//
// Parses the format used in the user's recipe vault: YAML frontmatter, a
// `*N servings | … cal*` meta line, `## Ingredients` with `### sections` of
// `amount unit name, prep` bullets, and `## Instructions` numbered steps. Each
// ingredient gets a grocery `aisle` (and an `is_staple` hint) so the grocery
// auto-build can group + dedupe later. Re-running replaces a recipe of the same
// title (idempotent). Requires DATABASE_URL.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { query, getPool, closePool } from '../src/db'

// ---- grocery aisle + staple categorization -------------------------------

// Leading \b (whole-word start) but NO trailing \b, so plurals/stems match
// ("tomatoes" → tomato, "peas" → pea). Order matters: canned tomatoes hit Pantry
// before fresh, so the canned phrases are listed in Pantry and checked first for
// those, but Produce is earlier — so we special-case canned tomato in Pantry via
// the "diced tomato"/"canned" tokens and keep fresh tomato in Produce.
const AISLES: Array<[RegExp, string]> = [
  [/\b(diced tomato|crushed tomato|canned tomato|tomato paste|can of|coconut milk)/i, 'Pantry'],
  [/\b(spinach|kale|lettuce|arugula|tomato|onion|shallot|scallion|garlic|basil|cilantro|parsley|herb|lemon|lime|zucchini|mushroom|bell pepper|broccoli|carrot|celery|pea|ginger|potato|cucumber|avocado|chili|jalapen|corn|squash|leek|cabbage)/i, 'Produce'],
  [/\b(cheese|parmesan|parmigiano|mozzarella|cotija|ricotta|feta|cream|crème|cr[eè]me fra[iî]che|milk|butter|yogurt|egg|ravioli|tortellini|half[- ]and[- ]half)/i, 'Dairy & Chilled'],
  [/\b(chicken|sausage|chorizo|salmon|shrimp|prawn|beef|steak|pork|bacon|turkey|fish|cod|tilapia|ground )/i, 'Meat & Seafood'],
  [/\b(bread|breadcrumb|panko|baguette|bun|roll)/i, 'Bakery'],
  [/\b(frozen)/i, 'Frozen'],
  [/\b(pasta|linguine|penne|spaghetti|noodle|lasagne|lasagna|rigatoni|fettuccine|macaroni|sauce|marinara|broth|stock|oil|vinegar|flour|sugar|rice|lentil|bean|chickpea|flake|oregano|spice|cumin|paprika|salt|pepper|honey|tortilla|pesto|wine|soy)/i, 'Pantry'],
]
function aisleFor(name: string): string {
  for (const [re, aisle] of AISLES) if (re.test(name)) return aisle
  return 'Other'
}

const STAPLES = /\b(olive oil|kosher salt|sea salt|salt|black pepper|garlic|butter|rice|pasta|flour|sugar|water|parmesan|parmigiano)\b/i
function isStaple(name: string): boolean {
  // "red pepper flakes" / "dried oregano" are seasonings, not pantry staples
  if (/flake|oregano|paprika|cumin|cayenne/i.test(name)) return false
  return STAPLES.test(name)
}

// ---- ingredient line parsing ---------------------------------------------

const FRACTIONS: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875, '⅕': 0.2, '⅖': 0.4 }
const UNITS = new Set(['oz', 'oz.', 'lb', 'lbs', 'g', 'kg', 'ml', 'l', 'tsp', 'tsp.', 'teaspoon', 'teaspoons', 'tbsp', 'tbsp.', 'tablespoon', 'tablespoons', 'cup', 'cups', 'clove', 'cloves', 'can', 'cans', 'jar', 'jars', 'bunch', 'bunches', 'sprig', 'sprigs', 'ct', 'count', 'package', 'packages', 'pkg', 'bottle', 'bottles', 'slice', 'slices', 'pinch', 'stick', 'sticks', 'head', 'heads'])

function parseAmount(token: string): number | null {
  // mixed unicode like "4½", or "4 1/2", or plain "1.5", or fraction "1/2", or "½"
  let t = token.trim()
  let whole = 0
  const mixed = /^(\d+)([½¼¾⅓⅔⅛⅜⅝⅞⅕⅖])$/.exec(t)
  if (mixed) return parseInt(mixed[1], 10) + (FRACTIONS[mixed[2]] ?? 0)
  if (FRACTIONS[t] != null) return FRACTIONS[t]
  const frac = /^(\d+)\/(\d+)$/.exec(t)
  if (frac) return parseInt(frac[1], 10) / parseInt(frac[2], 10)
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t)
  // ranges "2-3" → take the first
  const range = /^(\d+(?:\.\d+)?)\s*[-–]\s*\d/.exec(t)
  if (range) return parseFloat(range[1])
  void whole
  return null
}

interface ParsedIng {
  name: string
  amount: number | null
  unit: string | null
  prepNote: string | null
  display: string
  section: string | null
  aisle: string
  isStaple: boolean
}

function parseIngredient(raw: string, section: string | null): ParsedIng {
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
  // prep note after a comma
  let prepNote: string | null = null
  const commaIdx = rest.indexOf(',')
  if (commaIdx >= 0) {
    prepNote = rest.slice(commaIdx + 1).trim() || null
    rest = rest.slice(0, commaIdx).trim()
  }
  // strip a leading size word that isn't a unit ("large sweet onion" → "sweet onion")
  const name = rest.replace(/^(large|medium|small|jumbo|x-?large)\s+/i, '').replace(/\.$/, '').trim()
  return { name, amount, unit, prepNote, display, section, aisle: aisleFor(name || display), isStaple: isStaple(name || display) }
}

// ---- markdown parsing -----------------------------------------------------

interface ParsedRecipe {
  title: string
  emoji: string
  tags: string[]
  servings: number
  description: string | null
  notes: string | null
  sourceName: string | null
  ingredients: ParsedIng[]
  steps: string[]
  markdown: string
}

function parseFrontmatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(md)
  const out: Record<string, string> = {}
  if (!m) return out
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z_]+):\s*(.*)$/i.exec(line.trim())
    if (kv) out[kv[1]] = kv[2]
  }
  return out
}

function parseList(v: string | undefined): string[] {
  if (!v) return []
  return v.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
}

function parseRecipe(md: string): ParsedRecipe {
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

  // ## Instructions → numbered steps (top-level "1." lines; ignore nested ingredient bullets)
  const steps: string[] = []
  const insSection = /##\s+Instructions\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i.exec(body)?.[1] ?? ''
  for (const block of insSection.split(/\n(?=\d+\.\s)/)) {
    const m = /^\s*\d+\.\s+([\s\S]*?)(?=\n\s*\*\*Ingredients|\s*$)/.exec(block)
    if (m) {
      const text = m[1].replace(/\s+/g, ' ').trim()
      if (text) steps.push(text)
    }
  }

  // ## Notes → notes + source
  const notesBlock = /##\s+Notes\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i.exec(body)?.[1] ?? ''
  const notes = notesBlock.trim() || null
  const sourceName = /Source:\s*(.+)/i.exec(notesBlock)?.[1]?.trim() ?? (fm.cuisine ? `${fm.cuisine}` : null)

  return { title, emoji, tags, servings, description: null, notes, sourceName, ingredients, steps, markdown: md }
}

// ---- import ----------------------------------------------------------------

async function resolveHousehold(sub: string, explicit?: string): Promise<string> {
  if (explicit) return explicit
  const byId = await query<{ household_id: string }>(
    `select p.household_id from identities i join persons p on p.id = i.person_id where i.auth0_user_id = $1 and i.deleted_at is null limit 1`,
    [sub]
  )
  if (byId.rows[0]) return byId.rows[0].household_id
  const first = await query<{ id: string }>(`select id from households where deleted_at is null order by created_at limit 1`)
  if (!first.rows[0]) throw new Error('No household found — seed one first')
  return first.rows[0].id
}

async function importRecipe(householdId: string, r: ParsedRecipe): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    // replace an existing recipe of the same title (idempotent re-run)
    const existing = await client.query<{ id: string }>(
      `select id from recipes where household_id=$1 and lower(title)=lower($2) and deleted_at is null`,
      [householdId, r.title]
    )
    for (const e of existing.rows) {
      await client.query(`delete from recipe_ingredients where recipe_id=$1`, [e.id])
      await client.query(`delete from recipe_steps where recipe_id=$1`, [e.id])
      await client.query(`delete from recipes where id=$1`, [e.id])
    }
    const ins = await client.query<{ id: string }>(
      `insert into recipes (household_id, title, emoji, description, category, tags, servings, notes, source_type, source_name, source_markdown)
       values ($1,$2,$3,$4,'dinner',$5,$6,$7,'markdown_import',$8,$9) returning id`,
      [householdId, r.title, r.emoji, r.description, r.tags, r.servings, r.notes, r.sourceName, r.markdown]
    )
    const recipeId = ins.rows[0].id
    let order = 0
    for (const ig of r.ingredients) {
      await client.query(
        `insert into recipe_ingredients (household_id, recipe_id, name, amount, unit, prep_note, display, section, aisle, is_staple, sort_order)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [householdId, recipeId, ig.name || ig.display, ig.amount, ig.unit, ig.prepNote, ig.display, ig.section, ig.aisle, ig.isStaple, order++]
      )
    }
    let stepNo = 1
    for (const s of r.steps) {
      await client.query(
        `insert into recipe_steps (household_id, recipe_id, step_number, instruction) values ($1,$2,$3,$4)`,
        [householdId, recipeId, stepNo++, s]
      )
    }
    await client.query('commit')
    console.log(`  ✓ ${r.title} — ${r.ingredients.length} ingredients, ${r.steps.length} steps`)
  } catch (err) {
    await client.query('rollback')
    console.error(`  ✗ ${r.title}: ${(err as Error).message}`)
  } finally {
    client.release()
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const folder = args.find((a) => !a.startsWith('--'))
  const sub = (args[args.indexOf('--sub') + 1] && args.includes('--sub')) ? args[args.indexOf('--sub') + 1] : 'dev|demo'
  const household = args.includes('--household') ? args[args.indexOf('--household') + 1] : undefined
  if (!folder) {
    console.error('usage: tsx scripts/import-recipes.ts <folder> [--sub <sub>] [--household <uuid>]')
    process.exit(1)
  }
  const householdId = await resolveHousehold(sub, household)
  const files = (await readdir(folder)).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
  console.log(`Importing ${files.length} recipes from ${folder} → household ${householdId}`)
  for (const f of files) {
    const md = await readFile(join(folder, f), 'utf8')
    await importRecipe(householdId, parseRecipe(md))
  }
  await closePool()
  console.log('Done.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
