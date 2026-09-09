# API-key scopes: findings, corrections, and the plan

**Status:** investigation complete, two work items specified, neither built.
**Written:** 2026-09-08, from the Weekly Planning branch (`worktree-weekly-planning`).
**Why it exists:** PR #184 added 29 routes that tripped a guard test from #185, and pulling
that thread turned up a factual error that had been repeated across five files for months.
This doc is the handoff — it should be enough to start work without re-deriving anything.

---

## TL;DR

Three separate things, in the order they should be done:

1. **Correction of record — DONE** (commits `e0e8102c`, `701b2b2e` on `worktree-weekly-planning`).
   "lambda-api has no per-route middleware" was **false** and was load-bearing in five
   places. It supports both `api.use(path, mw)` and method-based
   `api.get(path, mw1, mw2, handler)`. Fixed everywhere, including the follow-on
   overstatement that middleware "cannot" pass a resolved tenant.
2. **Move the deny list into production code — SMALL, NOT BUILT.** The allow list
   (`API_SCOPES`) lives in `src`; the deny list (`NOT_KEY_REACHABLE`) lives in a **test
   file** and is never consulted at runtime. Absence already fails closed, so this is
   about making the deny decision a real declaration rather than a CI-enforced comment.
3. **Declare scopes per route instead of by path prefix — LARGE, NOT BUILT.** The prefix
   model puts the scope far from the route, which has already produced three near-misses
   and leaves cross-module surfaces (Weekly Planning) with *no* correct scope. The fix
   must be a **typed registrar**, not plain middleware — plain middleware is fail-open.
   See [the trap](#the-trap-naive-per-route-middleware-is-fail-open), which is the one
   part of this doc that must not be skimmed.

Nothing here changes any current behavior. Every route discussed is 403 to API keys today
and would remain so.

---

## 1. How it works today

Per-user API keys landed in **PR #185** (Immich-style). A key is a long random secret,
shown once, stored as a sha256 hash, presented in the `x-api-key` header. It resolves to
its **owner person**, so the owner's real role and capabilities still apply at the route
level; the key's **scopes** bound which resource families it may touch.

Two gates, deliberately separate (`apps/api/src/modules/api-keys/api-keys.ts` header):

| Gate | Question | Where |
|---|---|---|
| **Scope** | does the key hold `<resource>:<read\|write>` for this path? | central, in the auth gate |
| **Capability** | can the owner person actually do this? | per-route, unchanged |

The capability gate means a teen's key can never exceed the teen's rights, even with a
broad scope. That part is sound and is **not** what this doc is about.

### The scope catalog

`API_SCOPES` in `apps/api/src/modules/api-keys/api-keys.ts` maps each resource to one or
more **path prefixes**. `read` covers GET/HEAD; any other method needs `write`. `readOnly`
resources expose no write at all. It is the single source of truth — the create-key UI
reads it from `GET /api/api-keys/scopes`, so the web client never hard-codes the list.

Ten resources, eighteen grantable scope strings:

```
family (readOnly)  /api/household  /api/persons  /api/family
lists              /api/lists  /api/pantry-staples
pantry             /api/pantry
chores             /api/chores  /api/chore-instances  /api/chore-proofs
rewards            /api/rewards  /api/redemptions  /api/balances  /api/currencies  /api/conversions
meals              /api/recipes  /api/meals
calendar           /api/events
goals              /api/goals  /api/goal-lists
photos             /api/photos
weather (readOnly) /api/weather
```

### Enforcement

`enforceApiKeyScope(req)` (`api-keys.ts`), called from the single auth gate in
`apps/api/src/app.ts:112` when an `x-api-key` header is present:

```ts
export function enforceApiKeyScope(req: Request): void {
  const scopes = req.apiKey?.scopes ?? []
  const need = scopeForRequest(req.method, req.path)
  if (!need || need.denied) {
    throw new AuthError('This endpoint is not available to API keys', 403)
  }
  if (!keyHasScope(scopes, need.required)) {
    throw new AuthError(`API key is missing the required scope: ${need.required}`, 403)
  }
}
```

`scopeForRequest` picks the **longest matching prefix**, so a more specific resource beats
a broad one. Matching is on a `/` boundary, never a bare `startsWith` — see
[the near-misses](#3-why-the-prefix-model-is-the-real-problem).

**The key property: this is fail-CLOSED by construction.** A path in no resource returns
`null` from `scopeForRequest`, so `enforceApiKeyScope` throws 403. Forgetting to catalog a
new route family cannot make it key-reachable. Preserve this through any refactor.

### The three-way split (this is the confusing bit)

| | where it lives | consulted at runtime? |
|---|---|---|
| **Allow list** — `API_SCOPES` | `apps/api/src/modules/api-keys/api-keys.ts` | **yes** |
| **Deny list** — `NEVER_KEY_REACHABLE` / `UNSCOPED_YET` | `apps/api/test/api-keys.integration.test.ts` | **no** |
| **In neither** | nowhere | denied by default |

So "not in either → still denied" is *already* the behavior. But the deny list restricts
nothing — it is a CI-enforced comment. That is work item 2.

### The guard tests

In `apps/api/test/api-keys.integration.test.ts`, under
`describe('scope catalog covers the route table')`:

1. **`leaves no live route both unscoped and unlisted`** — walks lambda-api's own
   `app.routes()`, so it cannot drift from what is registered, and fails on any route that
   is neither scope-matched nor listed in the deny buckets. **This is the test PR #184
   tripped.**
2. **`has no stale allowlist entry — every listed prefix is still unscoped`** — the other
   direction. Give an allowlisted path a real scope and test 1 stops caring, while its
   deny entry sits there forever claiming a key is kept out of something it can now reach.
   Asserts on a joined string, not an array, because vitest collapses a long string inside
   an array to `expected [ Array(1) ]` and would hide the instruction the test exists to give.
3. **`every unscoped-yet entry names where its work is tracked`** — added in `e0e8102c`;
   see work item 2's rationale below.

### Current numbers (measured, 2026-09-08, on the #184 merge)

```
total registered routes  : 319
scoped by API_SCOPES     : 159
unscoped (403 to a key)  : 160, across 24 prefixes
weekly-planning routes   : 29
```

Reproduce with `app.routes()` filtered through `scopeForRequest`; there is a throwaway
script pattern in this doc's git history if needed, but it is four lines.

---

## 2. Correction of record: lambda-api middleware

### The false claim

Five places asserted that lambda-api has no per-route or path-scoped middleware, and used
that to justify (a) central scope enforcement and (b) wrapper guards instead of middleware:

- `apps/api/src/app.ts` (auth gate comment)
- `apps/api/src/modules/api-keys/api-keys.ts` (header)
- `apps/api/src/platform/route-guards.ts` (header)
- `website/docs/src/content/docs/developer/architecture.md`
- `docs/engineering-plan.md` ("Tech debt — route auth as middleware", 2026-06-25)

### The truth

`apps/api/node_modules/lambda-api/README.md` documents both, and the version in the repo
supports both:

- **Path-scoped:** `api.use('/users', mw)`, `api.use('/users/*', mw)`,
  `api.use(['/users', '/posts'], mw)`, `api.use('/users/:userId', mw)`, and multiple
  middleware in one call: `api.use('/users', mw1, mw2)`.
- **Method-based:** `api.get('/users', mw1, mw2, handler)` — lambda-api merges the
  execution stacks. This is the form that matters here.

The factory idiom works exactly as expected — a function taking config and returning the
`(req, res, next)` function:

```ts
api.post('/analyze-photo',
  verifyRouteBodyMiddleware({ s3Path: { type: 'string' } }, ['s3Path']),
  verifyBodyStoryIDMiddleware,
  handler)
```

**Note on matching:** the README says path matching for `use` checks the *defined route*,
so parameterized paths must be matched by the parameter (`/users/:param1`), not by a
concrete value. Relevant if anyone reaches for `api.use` instead of method-based
middleware.

### The follow-on overstatement (also corrected)

The first correction replaced the false claim with a weaker but still misleading one: that
a wrapper hands the handler a resolved `Tenant` "which middleware cannot do without an
untyped stash on `req`". Stashing on `req` needs no cast — the repo **already** augments
lambda-api's `Request` for exactly this (`api-keys.ts`):

```ts
declare module 'lambda-api' {
  interface Request {
    apiKey?: { id: string; scopes: string[] }
    apiKeyTenant?: Tenant
  }
}
```

So the entire residual difference between the two forms is:

- **wrapper** — `tenant` is `Tenant`, non-optional, guaranteed by the signature;
- **middleware** — `req.tenant` is `Tenant | undefined`, so handlers write `req.tenant!`.

That is a **preference, not a constraint.** Do not resurrect it as a blocker. Commit
`701b2b2e` records this in the source comments deliberately, so the next person does not
re-derive the same wrong conclusion.

### Wrapper vs middleware, side by side

Today (`apps/api/src/modules/chores/chores.routes.ts:138`):

```ts
api.patch('/api/chores/:id', capRoute('chore.manage', async (tenant, req, res) => {
  const id = req.params.id ?? ''
  ...
  await softDeleteChore(tenant.householdId, id, target.scope, target.instanceId)
}))
```

The middleware equivalent:

```ts
export const withTenant = async (req, res, next) => { req.tenant = await requireTenant(req); next() }
export const withCap = (cap: Capability) => async (req, res, next) => {
  await requireCapability(req.tenant!, cap); next()
}
export const withScope = (scope: string) => (req, res, next) => {
  if (req.apiKey && !keyHasScope(req.apiKey.scopes, scope)) {
    throw new AuthError(`API key is missing the required scope: ${scope}`, 403)
  }
  next()
}

api.patch('/api/chores/:id',
  withTenant, withCap('chore.manage'), withScope('chores:write'),
  async (req, res) => { const tenant = req.tenant! /* ... */ })
```

### What the existing guard design still gets right

`apps/api/src/platform/route-guards.ts` exports `tenantRoute(h)` / `adminRoute(h)` /
`capRoute(cap, h)` / `moduleRoutes(key)`, used by ~135 routes. **Permission checks are
already per-route** — they are handler wrappers rather than chained middleware, but the
granularity is per-route, and thrown `AuthError`s flow to the existing 4-arg error handler
with no try/catch in the wrappers. Guards also stash `req.tenantHouseholdId` for the
observability access log.

Only the **API-key scope check** is central. Its real justification is not the library: it
is fail-closed by construction, and the prefix catalog meant no scope argument had to be
threaded through ~135 existing registrations. That is a retrofit cost, which is a real but
*finite* argument — it is the thing work item 3 pays down.

---

## 3. Why the prefix model is the real problem

The scope lives far from the route, so correctness depends on someone noticing a **string
relationship**. Three cases already in the tree, all verified against the live route table:

### `/api/chore-instances` — a hyphenated sibling is not a child

```
/api/chore-instances/:id/approve   →  chores:read   (8 registered paths)
```

`/api/chores` does **not** match `/api/chore-instances` — the boundary rule requires
`/api/chores/…`. It works only because someone listed `/api/chore-instances` as a *third*
prefix on the `chores` resource. Miss that and eight chore routes belong to no resource.

### `/api/pantry-staples` — the path lies about which module owns it

```
/api/pantry-staples   →  lists:read
```

It reads like pantry, but it is registered in `lists.routes.ts` behind
`moduleRoutes('lists')`. It is correctly listed under **lists**, and the code carries a
comment saying why: a `pantry`-scoped key would clear the scope gate only to 403 at the
lists module gate. Nothing in the path tells you that; you must know where the route is
registered.

### `/api/households/invites` — the one the boundary rule prevents

This is why `pathMatches` uses a `/` boundary and not a bare `startsWith`. Under a bare
`startsWith`, `/api/household` (the **read-only `family`** resource) matches
`/api/households/invites`, and the household **invite list becomes readable with
`family:read`**. Measured, with the hypothetical bare-`startsWith` matcher:

```
/api/household/settings   →  family:read
/api/households/invites   →  NONE   ← correct today; family:read under startsWith
```

There is a comment above `pathMatches` warning against "fixing" the boundary rule. Keep it.

**All three are the same bug class, and per-route declaration makes them
unrepresentable** — there is no prefix to get wrong when the scope is an argument on the
registration.

---

## 4. The cross-module problem (Weekly Planning)

A planning session is a **write-through** surface. Over its ten steps it hands out chores,
features goals, adds calendar events and fills the meal plan — through its own 29 routes
under `/api/weekly-planning`.

Under **one scope per prefix**, a single `weeklyPlanning:write` scope would therefore be a
**skeleton key**: a key holding it could create chores without `chores:write`, events
without `calendar:write`, and so on — straight past the scopes that exist to bound exactly
that. So there is no correct scope to give this prefix today, and it stays denied.

**But that bypass is an artifact of the prefix model, not a property of planning.** Under
per-route declaration, each planning route asks for the downstream scope it actually needs
(`chores:write` on the route that creates chores, and so on) and the problem disappears.
This is why the entry is classified as **debt**, not as a permanent boundary — the earlier
wording justified a permanent exclusion with a contingent argument.

Whether a planning session *should* ever be key-drivable is a separate, unmade product
call. It is a facilitated interactive ritual; a reasonable answer is "no, and that's fine".
Either way, the decision should be recorded as a decision rather than inherited from a
limitation.

---

## 5. Work item: move the deny list into production code

**Size:** small (~40 lines + tests). **Risk:** touches the auth path — needs care.
**Blocked by:** nothing, but see [sequencing](#7-sequencing-and-conflicts).

### Current shape (after `e0e8102c`)

`apps/api/test/api-keys.integration.test.ts` holds two typed buckets, because the single
old list conflated two different claims under one mechanism — a permanent boundary and an
unpaid debt looked identical, and adding a prefix cost one line and read as a decision
either way:

```ts
type NeverReachable = { why: string; prefixes: string[] }
type UnscopedYet = NeverReachable & { tracked: string }   // `tracked` REQUIRED

const NEVER_KEY_REACHABLE: NeverReachable[] = [ /* 11 entries */ ]
const UNSCOPED_YET: UnscopedYet[] = [
  { why: 'a lists route that the /api/lists prefix cannot match',
    prefixes: ['/api/list-items'], tracked: 'PR #180' },
  { why: 'rhythms wants a whole new scope resource, not another prefix', ... },
  { why: 'no correct scope exists under one-scope-per-prefix — a session writes through …',
    prefixes: ['/api/weekly-planning'], ... },
]
const NOT_KEY_REACHABLE = [...NEVER_KEY_REACHABLE, ...UNSCOPED_YET]
```

`tracked` is a required field *and* a test asserts it names a followable `#123` or `docs/`
path — a debt entry that does not say where the work lives is indistinguishable from a
decision, which is the whole failure the split prevents.

### The change

Move both buckets into `apps/api/src/modules/api-keys/api-keys.ts`, export them, consult
the deny list in `enforceApiKeyScope`, and have the test **import** them rather than own a
copy. Absence stays fail-closed.

What it buys:

1. The deny decision is reviewable **in the PR that adds the routes**, next to the allow
   list — not buried in a test file nobody opens when adding a module.
2. **Forgotten** becomes distinguishable from **deliberately excluded**. Today both are the
   same state: absent.
3. Nothing can become key-reachable by accident, because absence still denies.

### Two things to hold to

- **Keep the 403 response body identical** for explicit-deny and for absence. Do not leak
  *why* a path is excluded to a key holder. The distinction belongs in logs, not the
  response. (There are existing tests asserting the current message — check them.)
- **Check the deny list first**, so deny is authoritative if a prefix somehow appears in
  both. Guard test 2 already fails on that contradiction.

### On logging the "forgotten" case

Tempting, and a real gain — an unlisted route family would surface in production rather
than only in CI. But `enforceApiKeyScope` runs on **every key-authenticated request**, so
an unguarded `log.warn` is an unbounded flood under load. `apps/api/src/platform/logger.ts`
exports only `createLogger` and `log`; there is **no de-dup facility**. So either use a
module-level `Set<string>` keyed on `method+path` (bounded by the route count, ~3 lines) or
drop the log entirely. Do not build rate-limiting machinery for this — the CI guard already
catches omissions, and the log is a nice-to-have.

### TDD shape

Failing integration test first, beside the existing cases in
`apps/api/test/api-keys.integration.test.ts`:

- a key hits 403 on an explicitly-denied prefix, **and** the deny list is what produced it
  rather than mere absence. The discriminator: removing the prefix from `API_SCOPES` must
  not change the outcome, and the two lists must never both match a path.
- Import the lists from `src`; do not duplicate them in the test.

---

## 6. Work item: declare scopes per route (a typed registrar)

**Size:** large — ~135 routes, mechanical but wide. **Risk:** high if done as plain
middleware; see the trap. **Prerequisite:** work item 2 is a natural first step but not
strictly required.

### The trap: naive per-route middleware is fail-OPEN

This is the single most important thing in this document.

- Today's model is fail-**closed** *by construction*: a route absent from the catalog is
  403. This is precisely why 29 uncatalogued planning routes were never an exposure.
- Naive per-route middleware **inverts** that: forget `withScope(...)` on a new route and
  it is wide open to any key that authenticates.
- You cannot fix this with a global default-deny that route middleware clears later.
  **Global middleware runs before route middleware**, so the global gate cannot know
  whether a route will subsequently clear it; and `finally()` runs after the response has
  been generated and **cannot alter it**.

### Therefore: a typed registrar

Wrap `api.get` / `api.post` / … in a registrar where a scope — or an explicit
`sessionOnly` / `deviceOnly` marker — is a **required argument**. Omission becomes a
**compile error**, so fail-closed survives the move to per-route declaration. Sketch:

```ts
// scope is not optional; there is no overload without it
route.post('/api/chores', { scope: 'chores:write' }, capRoute('chore.manage', handler))
route.post('/api/weekly-planning/session', { scope: sessionOnly('interactive ritual') }, handler)
```

### What it retires

- `API_SCOPES`' prefix lists (the resource/label/description catalog for the create-key UI
  stays — it is what `GET /api/api-keys/scopes` serves).
- `scopeForRequest`'s longest-prefix matching and `pathMatches`' boundary rule.
- **All three guard tests** and both deny buckets in `api-keys.integration.test.ts` — they
  exist *only* because the declaration is remote from the route. Deleting them is the
  signal the refactor actually landed.

### Design questions still open

- Can a single route require **more than one** scope (a planning route that writes chores
  *and* events)? If yes, `keyHasScope` needs an all-of/any-of decision.
- Does `readOnly` survive as a resource property, or become per-route (no `write`
  registration exists for that resource)?
- How does the create-key UI enumerate grantable scopes once prefixes are gone? Probably
  by collecting declarations at registration time — which also gives a free "what can this
  key reach?" introspection endpoint.

---

## 7. Sequencing and conflicts

- **PR #184 (Weekly Planning)** carries `e0e8102c` + `701b2b2e`: comments, docs, and one
  test file. **No production behavior.** It is green and independent of everything above.
- **Work item 2 rewrites the same region of `api-keys.integration.test.ts`** that #184's
  bucket split touches. Whichever lands second needs a rebase. Cleanest order: **merge
  #184 first, then start work item 2 on top of main.**
- **PR #180** gives `/api/list-items` to the `lists` resource. When it lands, guard test 2
  goes red and names the `UNSCOPED_YET` entry to delete. That is intended — the entry is
  `tracked: 'PR #180'` for exactly this reason.
- Do **not** put work item 2 in #184. It is a production auth change, and an auth bug there
  would block a planning merge for an unrelated reason.

---

## 8. What is already committed

On branch `worktree-weekly-planning` (PR #184):

- **`e0e8102c`** — corrected the false middleware claim in five places; split
  `NOT_KEY_REACHABLE` into `NEVER_KEY_REACHABLE` / `UNSCOPED_YET` with a required
  `tracked` field plus a test enforcing it; reclassified `/api/weekly-planning` as debt and
  rewrote its reason; added the roadmap entry. API suite 1690 pass (+1), `tsc` clean.
- **`701b2b2e`** — walked back the follow-on overstatement that middleware "cannot" pass a
  resolved tenant; recorded the wrapper choice as a preference in `route-guards.ts`, the
  engineering plan, and the developer architecture page.

Neither commit changes behavior. No `CHANGELOG.md` entry for either — comments, one test
file and docs are internal churn by the repo's own rule.

Also corrected outside the repo: the agent memory `observability-and-guards.md`, which
asserted "no path-scoped `api.use`" and would otherwise keep re-injecting the false fact.

---

## 9. File and symbol index

| What | Where |
|---|---|
| Scope catalog, `scopeForRequest`, `keyHasScope`, `enforceApiKeyScope`, `pathMatches` | `apps/api/src/modules/api-keys/api-keys.ts` |
| The single auth gate that calls it | `apps/api/src/app.ts:112` |
| Deny buckets + the three guard tests | `apps/api/test/api-keys.integration.test.ts` |
| Per-route permission guards (`tenantRoute`, `adminRoute`, `capRoute`, `moduleRoutes`) | `apps/api/src/platform/route-guards.ts` |
| Underlying helpers (`requireTenant`, `requireAdmin`, `requireCapability`) | `apps/api/src/modules/households/households.ts`, `apps/api/src/platform/permissions.ts` |
| `AuthError` (its `.name` becomes the response's `error` field) | `apps/api/src/platform/auth.ts` |
| Logger (no de-dup) | `apps/api/src/platform/logger.ts` |
| Worked example of a hyphenated-sibling prefix | `apps/api/src/modules/chores/chores.routes.ts:303` |
| Roadmap entry | `docs/product/roadmap.md`, "API-key scopes declared per route" |
| Public architecture description | `website/docs/src/content/docs/developer/architecture.md` |
| lambda-api middleware docs | `apps/api/node_modules/lambda-api/README.md`, "Middleware" |
