// Guard against two migrations sharing the same NNNN number prefix.
//
// Why: node-pg-migrate sorts migrations by filename, so two files numbered the same
// (e.g. `0079_a.sql` and `0079_b.sql`, born on parallel feature branches) apply in an
// undefined-but-stable order. That is *tolerated* at runtime (see checkOrder:false in
// src/migrate.ts), but it's a smell: reviewers can't tell the intended order, and a DB
// that applied one but not the other used to wedge. This check keeps NEW collisions out
// so numbering stays a reliable, gap-free sequence.
//
// Run: `npm run check:migrations` (also runs in CI on any apps/api change).
import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

// Grandfathered collisions that predate this guard. These are already applied in live
// DBs, so renumbering them would break those DBs' migration history — they stay as-is.
// DO NOT add to this list: a new duplicate is a mistake, not an exception. Renumber the
// new migration instead.
const GRANDFATHERED = new Set([
  '0079', // 0079_goal_target_basis + 0079_recipe_ingest_photos (parallel branches, July 2026)
])

const byNumber = new Map()
for (const name of readdirSync(migrationsDir)) {
  if (!name.endsWith('.sql')) continue
  const m = /^(\d{4})_/.exec(name)
  if (!m) {
    console.error(`✗ migration "${name}" does not start with a 4-digit number + underscore`)
    process.exit(1)
  }
  const num = m[1]
  if (!byNumber.has(num)) byNumber.set(num, [])
  byNumber.get(num).push(name)
}

const offenders = [...byNumber.entries()]
  .filter(([num, files]) => files.length > 1 && !GRANDFATHERED.has(num))
  .sort(([a], [b]) => a.localeCompare(b))

if (offenders.length > 0) {
  console.error('✗ Duplicate migration numbers found:')
  for (const [num, files] of offenders) {
    console.error(`    ${num}: ${files.sort().join(', ')}`)
  }
  console.error('\nRenumber the newer migration so every migration has a unique NNNN prefix.')
  console.error('(Grandfathered historical collisions are listed in this script and are exempt.)')
  process.exit(1)
}

console.log(`✓ ${byNumber.size} migration numbers, no new collisions`)
