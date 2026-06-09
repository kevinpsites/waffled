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
import { join, basename } from 'node:path'
import { query, getPool, closePool } from '../src/db'

// ---- grocery aisle + staple categorization -------------------------------

// Leading \b (whole-word start) but NO trailing \b, so plurals/stems match
// ("tomatoes" → tomato, "peas" → pea). Order matters: canned tomatoes hit Pantry
// before fresh, so the canned phrases are listed in Pantry and checked first for
// those, but Produce is earlier — so we special-case canned tomato in Pantry via
// the "diced tomato"/"canned" tokens and keep fresh tomato in Produce.
const AISLES: Array<[RegExp, string]> = [
  // shelf-stable forms first, so "diced/canned/dried <produce>" → Pantry not Produce
  [/\b(diced tomato|crushed tomato|canned tomato|can tomato|tomato paste|tomato sauce|can of|coconut milk|marinara|pesto|broth|stock|sauce|dried|flake|ground |powder|paste|seasoning|oregano|cumin|paprika|cayenne|spice)/i, 'Pantry'],
  [/\b(spinach|kale|lettuce|arugula|tomato|onion|shallot|scallion|garlic|basil|cilantro|parsley|herb|lemon|lime|zucchini|mushroom|bell pepper|broccoli|carrot|celery|pea|ginger|potato|cucumber|avocado|chili|jalapen|corn|squash|leek|cabbage)/i, 'Produce'],
  [/\b(cheese|parmesan|parmigiano|mozzarella|cotija|ricotta|feta|cream|crème|cr[eè]me fra[iî]che|milk|butter|yogurt|egg|ravioli|tortellini|half[- ]and[- ]half)/i, 'Dairy & Chilled'],
  [/\b(chicken|sausage|chorizo|salmon|shrimp|prawn|beef|steak|pork|bacon|turkey|fish|cod|tilapia|ground )/i, 'Meat & Seafood'],
  [/\b(bread|breadcrumb|panko|baguette|bun|roll)/i, 'Bakery'],
  [/\b(frozen)/i, 'Frozen'],
  [/\b(pasta|linguine|penne|spaghetti|noodle|lasagne|lasagna|rigatoni|fettuccine|macaroni|oil|vinegar|flour|sugar|rice|lentil|bean|chickpea|salt|pepper|honey|tortilla|wine|soy)/i, 'Pantry'],
]
// canned/jarred forms are pantry regardless of the produce inside
const CANNED_UNITS = new Set(['can', 'cans', 'jar', 'jars'])
function aisleFor(name: string, unit?: string | null): string {
  if (unit && CANNED_UNITS.has(unit.toLowerCase())) return 'Pantry'
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
  return { name, amount, unit, prepNote, display, section, aisle: aisleFor(name || display, unit), isStaple: isStaple(name || display) }
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
  steps: Array<{ text: string; ingredients: string[] }>
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

function clean(v: string | undefined): string | null {
  const s = (v ?? '').trim().replace(/^["']|["']$/g, '')
  return s && s.toLowerCase() !== 'none' ? s : null
}

function parseRecipe(md: string, collection: string | null): ParsedRecipe {
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
  const steps: Array<{ text: string; ingredients: string[] }> = []
  const insSection = /##\s+Instructions\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i.exec(body)?.[1] ?? ''
  for (const block of insSection.split(/\n(?=\d+\.\s)/)) {
    const num = /^\s*\d+\.\s+([\s\S]*)$/.exec(block)
    if (!num) continue
    const [textPart, ingPart] = num[1].split(/\*\*\s*Ingredients?:?\s*\*\*/i)
    const text = textPart.replace(/\s+/g, ' ').trim()
    const ings: string[] = []
    if (ingPart) {
      for (const line of ingPart.split('\n')) {
        const bl = /^\s*[-*]\s+(.+)$/.exec(line)
        if (bl) ings.push(bl[1].trim())
      }
    }
    if (text) steps.push({ text, ingredients: ings })
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
    // update an existing recipe in place (its id may be referenced by a planned
    // meal, so we can't delete it) or insert a new one — idempotent re-run.
    const existing = (
      await client.query<{ id: string }>(
        `select id from recipes where household_id=$1 and lower(title)=lower($2) and deleted_at is null`,
        [householdId, r.title]
      )
    ).rows[0]
    const category = r.mealType === 'dessert' ? 'dessert' : r.mealType === 'side' ? 'side' : 'dinner'
    // shared column list (the metadata) for both branches
    const meta = [r.mealType, r.protein, r.base, r.cuisine, r.effort, r.cookMethod, r.flavorProfile, r.dietary, r.vegetables, r.collection]
    let recipeId: string
    if (existing) {
      recipeId = existing.id
      await client.query(
        `update recipes set title=$3, emoji=$4, description=$5, category=$6, tags=$7, servings=$8,
                notes=$9, source_type='markdown_import', source_name=$10, source_markdown=$11,
                meal_type=$12, protein=$13, base=$14, cuisine=$15, effort=$16, cook_method=$17,
                flavor_profile=$18, dietary=$19, vegetables=$20, collection=$21, updated_at=now()
           where id=$1 and household_id=$2`,
        [recipeId, householdId, r.title, r.emoji, r.description, category, r.tags, r.servings, r.notes, r.sourceName, r.markdown, ...meta]
      )
      await client.query(`delete from recipe_ingredients where recipe_id=$1`, [recipeId])
      await client.query(`delete from recipe_steps where recipe_id=$1`, [recipeId])
    } else {
      const ins = await client.query<{ id: string }>(
        `insert into recipes (household_id, title, emoji, description, category, tags, servings, notes, source_type, source_name, source_markdown,
                              meal_type, protein, base, cuisine, effort, cook_method, flavor_profile, dietary, vegetables, collection)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'markdown_import',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning id`,
        [householdId, r.title, r.emoji, r.description, category, r.tags, r.servings, r.notes, r.sourceName, r.markdown, ...meta]
      )
      recipeId = ins.rows[0].id
    }
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
        `insert into recipe_steps (household_id, recipe_id, step_number, instruction, ingredients) values ($1,$2,$3,$4,$5)`,
        [householdId, recipeId, stepNo++, s.text, JSON.stringify(s.ingredients)]
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

async function importFolder(householdId: string, folder: string): Promise<number> {
  const collection = basename(folder)
  let files: string[]
  try {
    files = (await readdir(folder)).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
  } catch (e) {
    console.error(`  (skipping ${folder}: ${(e as { code?: string }).code ?? (e as Error).message})`)
    return 0
  }
  if (files.length === 0) return 0
  console.log(`▸ ${collection} (${files.length})`)
  for (const f of files) {
    const md = await readFile(join(folder, f), 'utf8')
    await importRecipe(householdId, parseRecipe(md, collection))
  }
  return files.length
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const folder = args.find((a) => !a.startsWith('--'))
  const sub = args.includes('--sub') ? args[args.indexOf('--sub') + 1] : 'dev|demo'
  const household = args.includes('--household') ? args[args.indexOf('--household') + 1] : undefined
  const recursive = args.includes('--recursive') || args.includes('-r')
  if (!folder) {
    console.error('usage: tsx scripts/import-recipes.ts <folder> [--recursive] [--sub <sub>] [--household <uuid>]')
    process.exit(1)
  }
  const householdId = await resolveHousehold(sub, household)
  console.log(`Importing recipes from ${folder} → household ${householdId}`)
  let total = 0
  if (recursive) {
    // each immediate subfolder is a collection
    const subdirs = (await readdir(folder, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    for (const d of subdirs) total += await importFolder(householdId, join(folder, d))
    total += await importFolder(householdId, folder) // loose files at the root too
  } else {
    total += await importFolder(householdId, folder)
  }
  await closePool()
  console.log(`Done — ${total} recipes.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
