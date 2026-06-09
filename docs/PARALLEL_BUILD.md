# Parallel screen build — coordination contract

Four kiosk screens are being built **in parallel**, one agent per domain, each on
its own git worktree/branch. This doc is the contract that keeps them from
colliding. The shared wiring is **already stubbed on `main`** so each agent only
edits files it exclusively owns.

## Reference pattern
The **Goals** vertical slice is the worked example — copy its shape:
- migration: `apps/api/migrations/0010_goals.sql`
- api domain: `apps/api/src/goals.ts` (+ `test/goals.integration.test.ts`)
- web client slice: `apps/web/src/lib/api/goals.ts`
- screen: `apps/web/src/kiosk/Goals.tsx` (+ `Goals.test.tsx`)
- design source: `docs/handoff/screens-goals.js` (`KIOSK_goals`)

Design system classes live in `apps/web/src/styles/nook.css` (ported verbatim —
reuse `.card`, `.goal-card`, `.gc-bar`, `.cat-pill`, `.seg`, `.av`, `.btn`,
`.pill`, etc). Match the handoff mock; wire real data; make it interactive
(add/edit/delete), not a static render.

## The four slices

| Agent | Route | Migration | Backend | Web client slice | Screen | Mock |
|------|-------|-----------|---------|------------------|--------|------|
| **Lists** | `/lists` | `0011_*` (if needed) | `src/lists.ts` (extend — grocery already here) | `lib/api/grocery.ts` (extend) or new `lib/api/lists.ts` | `kiosk/Lists.tsx` | `docs/handoff/screens-lists.js` → `KIOSK_lists` |
| **Meals** | `/meals` | `0012_*` (if needed) | `src/meals.ts` (extend — recipes+plans already here) | `lib/api/meals.ts` (extend) | `kiosk/Meals.tsx` | `docs/handoff/screens-meals.js` → `KIOSK_meals` |
| **Settings/Family** | `/settings` | `0013_*` (if needed) | `src/persons.ts` + `src/households.ts` (CRUD already here) | `lib/api/persons.ts` (extend) | `kiosk/Settings.tsx` | `docs/handoff/screens-settings.js` + `screens-settings2.js` |
| **Photos** | `/photos` | `0014_photos.sql` (new `photos` table) | `src/photos.ts` (stub — fill `registerPhotoRoutes`) | `lib/api/photos.ts` (stub — fill `photosApi`) | `kiosk/Photos.tsx` | `docs/handoff/screens-lists.js` → `KIOSK_photos` + `screens-extra.js` (screensaver/addPhotos) + `screens-detail.js` (photoView) |

**Migration numbers are pre-assigned** — use only yours. Skip the migration if
your slice reuses existing tables (`lists`/`list_items`, `recipes`/`meal_plans`,
`persons`/`households` all already exist).

## Files you OWN (edit freely)
- your `apps/api/src/<domain>.ts` and `apps/api/test/<domain>.integration.test.ts`
- your migration `apps/api/migrations/00NN_*.sql`
- your `apps/web/src/lib/api/<domain>.ts`
- your `apps/web/src/kiosk/<Screen>.tsx` and `<Screen>.test.tsx`
- your components under `apps/web/src/kiosk/components/` (prefix names with your
  domain to avoid collisions, e.g. `ListModal.tsx`, `PhotoModal.tsx`)
- your CSS: create `apps/web/src/styles/<screen>.css` and `import` it from your
  screen component — **do not** edit `styles/kiosk.css` (shared).

## Files that are SHARED — DO NOT edit
Already stubbed/wired on `main`, so you never need to touch them:
- `apps/web/src/kiosk/routes.tsx` (all four routes already point at the screens)
- `apps/web/src/lib/api/index.ts` (barrel already re-exports + spreads all slices)
- `apps/api/src/app.ts` (all `registerXRoutes` already called)
- `apps/web/src/kiosk/nav.ts`, `apps/web/src/kiosk/routes.test.tsx`,
  `apps/web/src/test/setup.ts`
If you think you genuinely need a shared file, leave it for the merge step and
note it in your summary instead.

## Validation (all isolated — no shared running stack needed)
Run from your worktree before reporting done:
- API: `cd apps/api && npx tsc --noEmit && npx vitest run test/<domain>.integration.test.ts`
  (integration tests spin their own ephemeral Postgres via Testcontainers — fully
  parallel-safe, no port coordination)
- Web: `cd apps/web && npx tsc --noEmit && npx vitest run && npx vite build`

Live Playwright verification against the running stack is done by the
orchestrator after merge (serialized), so you don't need to run a live stack.

## Auth in tests
Mint a local HS256 dev token (see `goals.integration.test.ts`): `requireTenant`/
`requireAdmin` from `households.ts`; all queries household-scoped + soft-deleted
(`deleted_at`). Reads open to members; mutations admin-only where it matters.

## Deliverable
Commit to a branch `screen/<domain>` with conventional messages and the standard
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
Report: what you built, files touched, test/build results, any shared-file change
you couldn't avoid.
