# Waffled API — conventions & gotchas (`apps/api`)

Folder-scoped notes; loads when working under `apps/api`. See the repo-root
`CLAUDE.md` for repo-wide workflow (worktree-first, TDD, PRs, releases).

## Database migrations (`apps/api/migrations`)

**Every migration gets a unique `NNNN_` number — never reuse a number.** Migrations are
`apps/api/migrations/NNNN_name.sql` applied in filename order by node-pg-migrate. Before
adding one, look at the highest existing number and use the next; if a parallel branch has
already claimed it by the time you rebase/merge, **renumber yours** to the next free slot.
Two files sharing a number is a mistake — the CI **Migration hygiene**
job (`npm run check:migrations`) fails the PR on any new collision, so it can't merge.

**`0079` is already duplicated on `main`, on purpose — leave it alone.**
`0079_goal_target_basis.sql` and `0079_recipe_ingest_photos.sql` were born on parallel
branches in July 2026 and are both applied in live DBs, so they're listed in the
`GRANDFATHERED` set in `scripts/check-migration-numbers.mjs` and the hygiene job passes
them deliberately. Do **not** "fix" it by renumbering: node-pg-migrate records applied
migrations by **filename**, not by number, so renaming one makes it look unapplied and it
re-runs — that is exactly how the demo stack once hit `CREATE TABLE … already exists`.
The pair is independent anyway (one alters `goals`, the other creates a new
`recipe_ingest_photos` table), so their relative order can't matter. A *new* duplicate is
still a mistake: renumber yours, and never add to the grandfathered set.

**Gaps in the sequence are fine too — don't backfill them.** `0012`–`0014`, `0044`,
`0046`–`0047`, `0081` and `0082` are unused or reverted numbers (`0082_powersync_personal_privacy`
was reverted four days after landing and never shipped in a release — verified absent from
both `v0.7.0` and `v0.8.0`, and confirmed unapplied on the local and demo stacks). The
runner sorts filenames and never requires contiguity, so a gap costs nothing and reusing
one to "tidy up" risks colliding with a number some DB has already recorded. Each
`.sql` file starts with `-- Up Migration` and has a `-- Down Migration` section. The runner
uses `checkOrder: false` (parallel branches mean a DB can legitimately have a later migration
applied while an earlier one is still pending), so out-of-order application self-heals — but
that tolerance is a safety net, **not** a licence to reuse numbers. Never renumber or edit a
migration that's already been applied to a live DB (it breaks that DB's recorded history);
fix-forward with a new migration instead.
