// One-off repair: re-normalize existing `recipe_ingredients` names after the
// ingredient-parser fix (a comma is only a prep-note boundary when what follows is
// a prep instruction). Older rows were split at the FIRST comma, so a line like
// "3 boneless, skinless chicken breast halves, cut into 1" pieces" was stored with
// name="boneless" — which then produced a grocery item literally named "boneless".
//
// This re-parses each row's original `display` string with the current parser and,
// where the derived name differs, updates name/prep_note/aisle/is_staple.
//
// Usage (dry run prints what would change; add --commit to write):
//   DATABASE_URL=postgres://user:pass@localhost:5432/db \
//     npx tsx scripts/reparse-ingredients.ts [--commit]
//
// Safe to re-run (idempotent): a row already matching the parser is skipped.
import { Client } from 'pg'
import { parseIngredient, isAllModifiers } from '../src/modules/meals/recipe-markdown'

const COMMIT = process.argv.includes('--commit')

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('Set DATABASE_URL (postgres://user:pass@localhost:5432/db)')
    process.exit(1)
  }

  const client = new Client({ connectionString: url })
  await client.connect()

  const { rows } = await client.query<{
    id: string
    name: string
    prep_note: string | null
    display: string | null
    section: string | null
  }>(`select id, name, prep_note, display, section from recipe_ingredients where deleted_at is null`)

  let changed = 0
  for (const r of rows) {
    const display = (r.display ?? '').trim()
    if (!display) continue
    // Only repair rows the bug actually broke: a name truncated to a bare leading
    // modifier ("boneless"). Rows whose name is a real noun ("scallions", "lime")
    // were split correctly and are left untouched.
    if (!isAllModifiers(r.name)) continue
    const p = parseIngredient(display, r.section ?? null)
    const newName = p.name || display
    if (newName === r.name) continue
    changed++
    console.log(`  ${JSON.stringify(r.name)} -> ${JSON.stringify(newName)}   [prep ${JSON.stringify(r.prep_note)} -> ${JSON.stringify(p.prepNote)}]   <<${display}>>`)
    if (COMMIT) {
      await client.query(
        `update recipe_ingredients set name=$1, prep_note=$2, aisle=$3, is_staple=$4 where id=$5`,
        [newName, p.prepNote, p.aisle, p.isStaple, r.id]
      )
    }
  }

  console.log(`\n${COMMIT ? 'COMMITTED' : 'DRY RUN'}: ${changed} of ${rows.length} ingredient rows ${COMMIT ? 'updated' : 'would change'}.`)
  await client.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
