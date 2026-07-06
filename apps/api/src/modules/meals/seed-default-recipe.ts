// Default "Waffles" recipe seeded into every freshly-created household — a fun
// nod to the app's name (Waffled 🧇) and a canonical example of the blessed recipe
// format, including a step timer (exercised by the markdown timer parser). It is
// inserted INSIDE the household-provisioning transaction so it's atomic with the
// household. Row shapes mirror the markdown importer (scripts/import-recipes.ts):
// recipes + recipe_ingredients + recipe_steps. We only read `parseRecipe` from the
// shared markdown module — no dependency on meals.service.
import type { PoolClient } from 'pg'
import { parseRecipe, type ParsedRecipe } from './recipe-markdown'

// The canonical Waffles recipe. Uses the blessed Markdown format so the parser
// produces structured ingredients + steps, and step 4 declares a **Timer:** so the
// iron-timing step lands with a parsed `timerSeconds`.
export const WAFFLES_MD = `# Waffles

*4 servings | 320 cal*

## Ingredients

- 2 cups all-purpose flour
- 2 tbsp sugar
- 1 tbsp baking powder
- 0.5 tsp salt
- 2 eggs
- 1.75 cups milk
- 0.5 cup butter, melted
- 1 tsp vanilla extract

## Instructions

1. Whisk the flour, sugar, baking powder, and salt together in a large bowl.
2. In a separate bowl, beat the eggs, then whisk in the milk, melted butter, and vanilla.
3. Pour the wet ingredients into the dry and stir just until combined — a few lumps are fine. Let the batter rest so the leavening wakes up. **Timer:** 5 minutes
4. Ladle the batter onto a hot, greased waffle iron and cook until golden and crisp. **Timer:** 4 minutes
5. Serve immediately with butter and maple syrup. 🧇

## Notes

The house special. Because we're Waffled, obviously.
Source: Waffled
`

// Insert the default recipe for a just-created household, using the caller's
// transaction `client` so it commits atomically with the household + owner.
export async function seedDefaultRecipe(
  client: PoolClient,
  householdId: string,
  // The owning person (kept in the signature for a stable seed API); `recipes`
  // has no author column, so — like the markdown importer — it isn't persisted.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  createdBy: string
): Promise<void> {
  const r: ParsedRecipe = parseRecipe(WAFFLES_MD, null)
  const category = 'breakfast'
  // The parser derives emoji heuristically from base/protein; force the waffle 🧇.
  const emoji = '🧇'
  const meta = [r.mealType, r.protein, r.base, r.cuisine, r.effort, r.cookMethod, r.flavorProfile, r.dietary, r.vegetables, r.collection]

  // Row shape mirrors scripts/import-recipes.ts exactly (no `created_by` column).
  const ins = await client.query<{ id: string }>(
    `insert into recipes (household_id, title, emoji, description, category, tags, servings, notes, source_type, source_name, source_markdown,
                          meal_type, protein, base, cuisine, effort, cook_method, flavor_profile, dietary, vegetables, collection)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'markdown_import',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning id`,
    [householdId, r.title, emoji, r.description, category, r.tags, r.servings, r.notes, r.sourceName, r.markdown, ...meta]
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
      `insert into recipe_steps (household_id, recipe_id, step_number, instruction, ingredients, timer_seconds) values ($1,$2,$3,$4,$5,$6)`,
      [householdId, recipeId, stepNo++, s.text, JSON.stringify(s.ingredients), s.timerSeconds ?? null]
    )
  }
}
