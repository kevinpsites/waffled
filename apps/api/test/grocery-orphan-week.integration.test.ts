// Grocery rows stranded on a week key nothing can reach.
//
// Before the snap landed (#162), "Plan the month" rebuilt with the 1st of the month —
// `2026-09-01`, a Tuesday — and stamped `list_items.week_start` with it. Now that every
// route snaps to the household's boundary, both the board query and the rebuild's delete
// only ever use ALIGNED keys. So those rows are invisible on every board AND unreachable
// by any rebuild: they can never be seen, ticked, or cleaned up. They just sit there.
//
// The two sources need OPPOSITE treatment, and that is the whole design:
//
//   source='auto'   — derived from the meal plan. `rebuildGroceryFromWeek` hard-deletes
//                     and regenerates these every time it runs, so an orphaned one is
//                     pure residue: dropping it loses nothing a rebuild won't rebuild.
//                     It can't even carry a meaningful `checked`, since no board could
//                     ever render it to be ticked.
//   source='recipe' — an explicit off-plan "add this recipe's shopping". Deliberately
//                     survives every rebuild, so it is NOT reproducible. It has to be
//                     moved onto the real week, not deleted.
//
// (source='manual' rows carry week_start = NULL — they're the global running list — so
// they cannot be orphaned and must not be touched.)
//
// Runs the REAL migration SQL, so any drift between it and the server's own week math
// fails here.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { Client } from 'pg'
import { runMigrations } from '../src/migrate'

const upSql = readFileSync(new URL('../migrations/0097_resnap_orphan_list_item_weeks.sql', import.meta.url), 'utf8')
  .split('-- Down Migration')[0]

let pg: StartedPostgreSqlContainer
let url = ''

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

type Row = {
  name: string
  source: string
  week_start: string | null
  deleted_at: Date | null
  source_recipe_ids: string[] | null
  quantity: string | null
}

/// A household + its grocery list, built straight in SQL — this is a data migration, so
/// the fixtures are rows, not HTTP calls.
async function makeHousehold(pref: 'sunday' | 'monday'): Promise<{ householdId: string; listId: string }> {
  return withClient(async (c) => {
    const h = await c.query<{ id: string }>(
      `insert into households (name, timezone, week_start) values ($1,'America/Chicago',$2) returning id`,
      [`H ${pref} ${Math.random()}`, pref]
    )
    const householdId = h.rows[0].id
    const l = await c.query<{ id: string }>(
      `insert into lists (household_id, name, list_type, is_auto_built) values ($1,'Groceries','grocery',true) returning id`,
      [householdId]
    )
    return { householdId, listId: l.rows[0].id }
  })
}

async function seed(
  householdId: string,
  listId: string,
  name: string,
  source: string,
  weekStart: string | null,
  recipeIds: string[] | null = null,
  quantity: string | null = null
): Promise<void> {
  await withClient((c) =>
    c.query(
      `insert into list_items (household_id, list_id, name, source, week_start, source_recipe_ids, quantity)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [householdId, listId, name, source, weekStart, recipeIds, quantity]
    )
  )
}

const live = (listId: string): Promise<Row[]> =>
  withClient((c) =>
    c
      .query<Row>(
        `select name, source, to_char(week_start,'YYYY-MM-DD') as week_start, deleted_at, source_recipe_ids, quantity
           from list_items where list_id=$1 and deleted_at is null order by name`,
        [listId]
      )
      .then((r) => r.rows)
  )

const runUp = () => withClient((c) => c.query(upSql))

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
}, 180_000)

afterAll(async () => {
  await pg?.stop()
})

// 2026-09-01 is a TUESDAY — the exact key "Plan the month" used to write. Under a sunday
// household it belongs to the week of Aug 30; under a monday one, Aug 31.
const ORPHAN_TUE = '2026-09-01'
const ORPHAN_WED = '2026-09-02'
const ALIGNED = { sunday: '2026-08-30', monday: '2026-08-31' } as const

describe.each(['sunday', 'monday'] as const)('orphaned grocery weeks (%s household)', (pref) => {
  let householdId = ''
  let listId = ''
  const aligned = ALIGNED[pref]

  beforeAll(async () => {
    ;({ householdId, listId } = await makeHousehold(pref))
    // Residue of the bug: meal-derived rows on a key no board asks for.
    await seed(householdId, listId, 'Orphan Onions', 'auto', ORPHAN_TUE)
    // An explicit off-plan add, stranded the same way — this one is NOT reproducible.
    await seed(householdId, listId, 'Stranded Saffron', 'recipe', ORPHAN_TUE, ['11111111-1111-1111-1111-111111111111'])
    // …and one whose name already exists on the real week, in different case. Snapping it
    // naively is exactly how this migration would CREATE the duplicate it exists to avoid.
    await seed(householdId, listId, 'LIMES', 'recipe', ORPHAN_TUE, ['22222222-2222-2222-2222-222222222222'])
    await seed(householdId, listId, 'limes', 'recipe', aligned, ['33333333-3333-3333-3333-333333333333'], '2')
    // Two orphans on DIFFERENT unaligned keys that snap to the same week, same name:
    // the merge has to handle orphan-vs-orphan, not just orphan-vs-existing.
    await seed(householdId, listId, 'Thyme', 'recipe', ORPHAN_TUE, ['44444444-4444-4444-4444-444444444444'])
    await seed(householdId, listId, 'thyme', 'recipe', ORPHAN_WED, ['55555555-5555-5555-5555-555555555555'])
    // Controls that must come through untouched.
    await seed(householdId, listId, 'Aligned Apples', 'auto', aligned)
    await seed(householdId, listId, 'Global Gum', 'manual', null)
  })

  it('leaves no row on a key the board can never ask for', async () => {
    await runUp()
    const rows = await live(listId)
    const unaligned = rows.filter((r) => r.week_start !== null && r.week_start !== aligned)
    expect(unaligned, `still stranded: ${JSON.stringify(unaligned)}`).toEqual([])
  })

  it('drops the meal-derived residue instead of moving it', async () => {
    await runUp()
    const rows = await live(listId)
    // A rebuild regenerates auto rows from the plan, so the orphan is noise. Moving it
    // would duplicate whatever the real week's rebuild already produced.
    expect(rows.find((r) => r.name === 'Orphan Onions')).toBeUndefined()
  })

  it('rescues an off-plan add onto the week it belongs to', async () => {
    await runUp()
    const saffron = (await live(listId)).find((r) => r.name === 'Stranded Saffron')
    expect(saffron, 'an explicit add is not reproducible — it must survive').toBeDefined()
    expect(saffron!.week_start).toBe(aligned)
  })

  it('merges onto an existing row of the same name rather than duplicating it', async () => {
    await runUp()
    const limes = (await live(listId)).filter((r) => r.name.toLowerCase() === 'limes')
    expect(limes).toHaveLength(1)
    // The survivor carries both adds' recipes, so nothing is silently dropped.
    expect([...(limes[0].source_recipe_ids ?? [])].sort()).toEqual([
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
    ])
    // Quantity is deliberately NOT summed: merging amounts needs unit logic that doesn't
    // exist in SQL, and a wrong quantity the user can't explain is worse than a low one.
    expect(limes[0].quantity).toBe('2')
  })

  it('merges two orphans that land on the same week', async () => {
    await runUp()
    const thyme = (await live(listId)).filter((r) => r.name.toLowerCase() === 'thyme')
    expect(thyme).toHaveLength(1)
    expect(thyme[0].week_start).toBe(aligned)
    expect([...(thyme[0].source_recipe_ids ?? [])].sort()).toEqual([
      '44444444-4444-4444-4444-444444444444',
      '55555555-5555-5555-5555-555555555555',
    ])
  })

  it('does not touch rows that were already fine', async () => {
    await runUp()
    const rows = await live(listId)
    expect(rows.find((r) => r.name === 'Aligned Apples')?.week_start).toBe(aligned)
    // The global running list is weekless by design and must stay that way.
    const gum = rows.find((r) => r.name === 'Global Gum')
    expect(gum?.week_start).toBeNull()
    expect(gum?.source).toBe('manual')
  })

  it('changes nothing when it runs a second time', async () => {
    // The property that makes a migration safe against a database in an unknown state —
    // and against the out-of-order re-application this repo deliberately tolerates.
    await runUp()
    const first = await live(listId)
    await runUp()
    expect(await live(listId)).toEqual(first)
  })
})
