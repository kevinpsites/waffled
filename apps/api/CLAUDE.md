# Waffled API — conventions & gotchas (`apps/api`)

Folder-scoped notes; loads when working under `apps/api`. See the repo-root
`CLAUDE.md` for repo-wide workflow (worktree-first, TDD, PRs, releases).

## Database migrations (`apps/api/migrations`)

**Every migration gets a unique `NNNN_` number — never reuse a number.** Migrations are
`apps/api/migrations/NNNN_name.sql` applied in filename order by node-pg-migrate. Before
adding one, look at the highest existing number and use the next; if a parallel branch has
already claimed it by the time you rebase/merge, **renumber yours** to the next free slot.
Two files sharing a number (e.g. two `0079_*`) is a mistake — the CI **Migration hygiene**
job (`npm run check:migrations`) fails the PR on any new collision, so it can't merge. Each
`.sql` file starts with `-- Up Migration` and has a `-- Down Migration` section. The runner
uses `checkOrder: false` (parallel branches mean a DB can legitimately have a later migration
applied while an earlier one is still pending), so out-of-order application self-heals — but
that tolerance is a safety net, **not** a licence to reuse numbers. Never renumber or edit a
migration that's already been applied to a live DB (it breaks that DB's recorded history);
fix-forward with a new migration instead.
