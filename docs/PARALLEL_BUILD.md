# Parallel screen build — coordination contract

Four kiosk screens are being built **in parallel**, one agent per domain, each on
its own git worktree/branch. This doc is the contract that keeps them from
colliding. The shared wiring is **already stubbed on `main`** so each agent only
edits files it exclusively owns.

## The quality bar: match the mocks ~100%
These screens' data models were built off the handoff mocks. **Match the mock
almost exactly.** Where you deviate, you must (1) call it out explicitly in your
summary and (2) defend why (e.g. needs an integration we haven't built). Do not
silently simplify or substitute a different layout. The Goals domain was rebuilt
to this bar — study it as the worked example of "match the mock, defend the gaps."

## Reference material (per domain)
- **Rendered mock screenshots:** `docs/handoff/screenshots/<domain>*.png` — these
  are the source of truth for layout/spacing/copy. Open yours and match it.
- **Mock source (exact markup):** `docs/handoff/screens-*.js` — the template
  literals that generate those screenshots (`KIOSK_<key>`). Read the structure +
  inline styles; the design-system classes are in `apps/web/src/styles/nook.css`
  (reuse `.card`, `.seg`, `.av`, `.btn`, `.pill`, `.glist`, `.cat-pill`, etc).
- Re-render any screen yourself: `docs/handoff/render-harness.html` +
  `window.show('<KIOSK key>')` under Playwright (see how the screenshots were made).

## Reference implementation (the pattern to copy)
The **Goals** vertical slice (commits `GO-R1..GO-R4`):
- migration `apps/api/migrations/0011_goal_lists_membership.sql`
- api domain `apps/api/src/goals.ts` (+ `test/goals.integration.test.ts`)
- web client slice `apps/web/src/lib/api/goals.ts`
- screens `apps/web/src/kiosk/Goals.tsx` / `GoalCreate.tsx` / `GoalDetail.tsx`
- co-located CSS `apps/web/src/styles/goals.css` (imported by the screen)
- per-screen topbar via `kiosk/topbar-slot.tsx` (`useTopbarRight` / `useTopbarFull`)

## The four slices

| Agent | Route(s) | Migration | Backend | Web client slice | Screen(s) | Mock screenshots |
|------|-------|-----------|---------|------------------|--------|------|
| **Lists** | `/lists` | `0012_*` (if needed) | `src/lists.ts` (extend — grocery already here) | `lib/api/grocery.ts` (extend) or new `lib/api/lists.ts` | `kiosk/Lists.tsx` | `lists.png` (mock src `screens-lists.js` → `KIOSK_lists`) |
| **Meals** | `/meals` | `0013_*` (if needed) | `src/meals.ts` (extend — recipes+plans already here) | `lib/api/meals.ts` (extend) | `kiosk/Meals.tsx` (+ recipe/plan views) | `meals.png`, `meals-recipes.png`, `meals-recipe-detail.png`, `meals-plan.png`, `meals-picker.png` (`screens-meals.js`) |
| **Settings/Family** | `/settings` | `0014_*` (if needed) | `src/persons.ts` + `src/households.ts` (CRUD already here; may need household-settings/PATCH) | `lib/api/persons.ts` (extend) + new `lib/api/settings.ts` | `kiosk/Settings.tsx` | `settings.png`, `settings-add-person.png`, `settings-person-edit.png`, `settings-accounts.png`, `settings-display.png`, `settings-notif.png` (`screens-settings.js` + `screens-settings2.js`) |
| **Photos** | `/photos` | `0015_photos.sql` (new `photos` table) | `src/photos.ts` (stub — fill `registerPhotoRoutes`) | `lib/api/photos.ts` (stub — fill `photosApi`) | `kiosk/Photos.tsx` | `photos.png`, `photos-screensaver.png`, `photos-add.png`, `photos-detail.png` (`screens-lists.js`→`KIOSK_photos`, `screens-extra.js`) |

**Migration numbers are pre-assigned** (goals took 0011) — use only yours. Skip the
migration if your slice reuses existing tables (`lists`/`list_items`,
`recipes`/`meal_plans`, `persons`/`households` all already exist).

## Files you OWN (edit freely)
- your `apps/api/src/<domain>.ts` and `apps/api/test/<domain>.integration.test.ts`
- your migration `apps/api/migrations/00NN_*.sql`
- your `apps/web/src/lib/api/<domain>.ts`
- your `apps/web/src/kiosk/<Screen>.tsx` (+ sub-screens) and `<Screen>.test.tsx`
- your components under `apps/web/src/kiosk/components/` (prefix names with your
  domain to avoid collisions, e.g. `ListModal.tsx`, `PhotoModal.tsx`)
- your CSS: create `apps/web/src/styles/<screen>.css` and `import` it from your
  screen — **do not** edit `styles/kiosk.css` (shared).

## Files that are SHARED — DO NOT edit
Already stubbed/wired on `main`, so you never need to touch them:
- `apps/web/src/kiosk/routes.tsx` (all routes already point at the screens — if you
  add a sub-route like `/meals/:id`, that's the one allowed router edit; do it as a
  single line and note it)
- `apps/web/src/lib/api/index.ts` (barrel already re-exports + spreads all slices)
- `apps/api/src/app.ts` (all `registerXRoutes` already called)
- `apps/web/src/kiosk/nav.ts`, `apps/web/src/kiosk/routes.test.tsx`,
  `apps/web/src/test/setup.ts`, `apps/web/src/kiosk/topbar-slot.tsx`
If you genuinely need a shared file, note it in your summary for the merge step.

## Validation (all isolated — no shared running stack needed)
Run from your worktree before reporting done:
- API: `cd apps/api && npx tsc --noEmit && npx vitest run test/<domain>.integration.test.ts`
  (integration tests spin their own ephemeral Postgres via Testcontainers — fully
  parallel-safe, no port coordination)
- Web: `cd apps/web && npx tsc --noEmit && npx vitest run && npx vite build`

Live Playwright verification against the running stack is done by the
orchestrator after merge (serialized).

## Auth in tests
Mint a local HS256 dev token (see `goals.integration.test.ts`): `requireTenant`/
`requireAdmin` from `households.ts`; all queries household-scoped + soft-deleted
(`deleted_at`). Reads open to members; mutations admin-only where it matters.

## Deliverable
Commit to a branch `screen/<domain>` with conventional messages and the standard
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
Report: what you built, files touched, **every deviation from the mock + why**,
test/build results, any shared-file change you couldn't avoid.
