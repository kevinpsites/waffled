// Import a folder of Markdown recipes into a household. DEV / SEED TOOL ONLY — not a
// user-facing feature. Self-hosters author recipes in-app (the unified recipe editor
// + "paste markdown"); this script is just a convenience for bulk-seeding a vault
// during development.
//
//   tsx scripts/import-recipes.ts <folder> [--sub dev|demo] [--household <uuid>]
//
// Parsing (frontmatter, sectioned ingredients with grocery aisle tagging, numbered
// steps) lives in the shared module so the CLI and the in-app paste path stay in sync.
// Re-running replaces a recipe of the same title (idempotent). Requires DATABASE_URL.
import { readdir, readFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { query, getPool, closePool } from '../src/platform/db'
import { parseRecipe, type ParsedRecipe } from '../src/modules/meals/recipe-markdown'

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
        `insert into recipe_steps (household_id, recipe_id, step_number, instruction, ingredients, timer_seconds) values ($1,$2,$3,$4,$5,$6)`,
        [householdId, recipeId, stepNo++, s.text, JSON.stringify(s.ingredients), s.timerSeconds ?? null]
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
