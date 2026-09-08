# Tenant isolation — security audit

**Status:** complete, audited 2026-09-08 against `origin/main` (`261f4c68`). Read-only
analysis; no application code was changed. Scope is the API (`apps/api`) — every service
and route file under `apps/api/src/modules/*`, the shared guards in
`apps/api/src/platform/`, all 100 migrations in `apps/api/migrations/`, and the PowerSync
sync rules in `infra/compose/powersync/sync-config.yaml`.

The question this audit set out to answer: Waffled is multi-tenant, every row belongs to a
household, and the API must guarantee that a caller acting for household A can never read,
modify, or reference data belonging to household B. **Where does that guarantee break?**

## Verdict

**Tenant isolation is fundamentally sound in its architecture, with five isolated lapses of
one identical shape — but it is defended *entirely* in the application layer, and one of
those lapses lets a caller in household A change what household B sees.**

The load-bearing parts are right. The tenant is resolved server-side from the DB on every
request and cannot be steered by client input on any auth path. PowerSync buckets are
strictly parameterized by `household_id`. The offline-write sink — the one endpoint where
clients post arbitrary row operations — validates every foreign key and scopes every write.
A shared guard module, `apps/api/src/platform/household-refs.ts`, already exists with
eleven assertion helpers, and it is called at 40-odd write sites across goals, events,
meals, lists, chores, calendars and the PowerSync CRUD path. Someone has clearly been here
before: commit `5a634aee` ("fix(api): enforce household ownership for ids") created that
module and wired it in, with cross-household regression tests to match.

What is missing is any *structural* defense. The schema has **zero** composite
`(household_id, id)` foreign keys and **zero** `unique (household_id, id)` constraints —
all 93 cross-tenant-capable references are plain single-column FKs to `<table>(id)`. So
nothing in the database stops a row in household A from pointing at a row in household B.
Every one of those 93 references is safe only for as long as a human remembers to call an
assertion at the write site. It lapsed at five sites — and what each lapse *costs* is
decided not by the write but by the read path, because most reads join `persons` on a bare
`p.id = <table>.person_id` with no household predicate. A foreign person id written into
your household's row is then faithfully resolved into that stranger's name, avatar and
colour and handed back to you.

Of the five: three are read-side disclosures, one is inert, and one is a cross-household
write.

The three disclosures expose three profile fields — `name`, `avatar_emoji`, `color_hex` —
of a person whose UUID the attacker must already know, since v4 UUIDs are not enumerable.
Narrow, but real. The inert one (Family Night) is the useful control: identical unguarded
write, but its read path resolves names against the household's own member list, so nothing
leaks.

**The fifth is worse and should be fixed first.** `POST /api/persons/:id/award` writes a
ledger row stamped with the *attacker's* `household_id` but the *victim's* `person_id`, and
the chores Today/kiosk summary joins the balances view on `person_id` alone with no
household predicate. The result is that a caller in household A can change a number
displayed on household B's own kiosk. This was proved end to end: the victim's star balance
went from 0 to 999 without anyone in that household doing anything. No API in Waffled lets
you *read* another household's content, but this one lets you *affect* it — which breaks
the second half of the guarantee, not just the first.

## The seed finding: `updateGoalList` — not a vulnerability

This audit was commissioned off a specific report: that `updateGoalList`
(`apps/api/src/modules/goals/goals.service.ts:137`) inserts into `goal_list_members` using
client-supplied `input.memberIds` without validating those person ids belong to the
caller's household.

**That report is false on `origin/main`, and the "find every other place the guard is
missing" premise it implies is the wrong frame.**

The service function is indeed unvalidated — read in isolation, `goals.service.ts` looks
exactly as reported, and `createGoalList` at line 108 has the identical shape. But the
service is not reachable with unvalidated input. Both of its only two callers are routes
that assert first:

- `POST /api/goal-lists` — `goals.routes.ts:98` calls
  `assertPersonsInHousehold(tenant.householdId, body.memberIds)` before `createGoalList`.
- `PATCH /api/goal-lists/:id` — `goals.routes.ts:115` calls the same assertion before
  `updateGoalList`.

`grep` confirms those are the *only* call sites of either function. The guard landed in
`5a634aee` along with a regression test that asserts precisely the reported attack:

```
apps/api/test/goals.integration.test.ts
  it('rejects foreign list members, goal participants, list links, and log targets')
    POST /api/goal-lists  { memberIds: [foreignPersonId] }        → expect 404
    PATCH /api/goal-lists/:id { memberIds: [foreignPersonId] }    → expect 404
```

**Verified by running it** against a throwaway Postgres in this worktree: passes. The seed's
author read the service file without following the call chain to the route — which is
exactly the error mode this audit had to avoid at every other candidate site, and did.

### Is goal-list membership a disclosure or an integrity flaw? Neither — it is closed.

The commissioning brief asked for a definitive answer on how goal-list membership is read,
on the theory that a foreign person added as a member might then see that list's contents
on their own client. The answer is definitive, and the question turns out to be moot in one
direction and inverted in the other.

**No foreign `person_id` can reach `goal_list_members` through the API at all**, per the
above. But had one been written, here is exactly what would and would not have happened:

- **Household B would see nothing.** `goal_lists` and `goal_list_members` are not in the
  PowerSync sync rules — the bucket syncs only `households`, `persons`, `events`,
  `event_participants` and `event_occurrences`, each `WHERE household_id = bucket.household_id`.
  And `listGoalLists(householdId)` is scoped to the *caller's* household, so a poisoned row
  stamped `household_id = A` never appears in any query B makes. The hypothesized leak
  direction — victim sees attacker's list — does not exist.
- **The attacker would have seen a little.** The members subquery at
  `goals.service.ts:85` joins `persons p on p.id = m.person_id` with no household
  predicate, so household A would have read back the foreign person's `name`,
  `avatarEmoji` and `colorHex`. The leak runs *inbound*, not outbound.

So the goal-list path is closed, and the residual note is defense-in-depth only: that
unfiltered `persons` join is the same latent amplifier that makes the three disclosure
findings below actually leak. It costs nothing to add `and p.household_id = gl.household_id`
and it would have contained the blast radius.

## Findings

Findings 1–5, 7 have a section of their own below. Finding 6 is discussed inside finding 2
(it is the same route), finding 8 is the subject of *Class 3 — the schema picture*, and
finding 9 needs no elaboration beyond its row.

| # | Location | Class | Severity | Preconditions | Verified how |
|---|---|---|---|---|---|
| 1 | `modules/rewards/rewards.ts:375` (`POST /api/persons/:id/award`) + unfiltered balances join in `modules/chores/chores.service.ts:231` | 2 — unvalidated client FK, **with cross-household write effect** | **High** | `reward.grant` capability (admin by default) + chores module on. Must know a foreign person UUID. | **Integration probe** — victim household's Today balance went 0 → 999 |
| 2 | `modules/rewards/rewards.ts:401` (`POST /api/rewards/:id/redeem`) + read-back join at `:394` | 2 — unvalidated client FK | **Medium** | Any signed-in member (`tenantRoute`, no capability). Chores module + rewards sub-flag on. Must know a foreign person UUID. | **Integration probe** — 201 created, `GET /api/redemptions` returned the foreign person's name, emoji and colour |
| 3 | `modules/photos/photos.ts:197` (`POST /api/photos`, `uploadedBy`) + `SELECT_PHOTO` join at `:63` | 2 — unvalidated client FK | **Medium** | Any signed-in member (`tenantRoute`). Must know a foreign person UUID. | **Integration probe** — 201 created, `GET /api/photos` returned the foreign person's name, emoji and colour |
| 4 | `modules/calendar/ics-feeds.ts:430` and `:472` (`POST`/`PATCH /api/calendar/feeds`, `personId`) + `FEED_SELECT` join at `:60` | 2 — unvalidated client FK | **Low–Medium** | Household **admin** (`adminRoute`). Must know a foreign person UUID. | **Integration probe** — 201 created; the foreign name and colour came back in the create response *and* in `GET /api/calendar/feeds` |
| 5 | `modules/familyNight/familyNight.ts:276` (`POST /api/family-night/occurrence`, `assignments[].personId`) | 2 — unvalidated client FK | **Low** | Any signed-in member. Family Night module on. | Static — no `assertPerson*` anywhere in `familyNight.routes.ts`; **integrity only, no disclosure** |
| 6 | `modules/rewards/rewards.ts:401` — no capability check when redeeming *on behalf of* another person | authorization (not tenant) | **Low** | Any signed-in member | Static — compared against `POST /api/conversions/:id/apply` and `POST /api/chore-instances/:id/claim`, which both gate this |
| 7 | `modules/health/health.ts:87–110`, route at `:220` | 4 — cross-tenant aggregate | **Low** | Admin of *any* household on the instance | Static — `adminRoute`, and the queries carry no `household_id` filter |
| 8 | Schema-wide: no composite `(household_id, id)` FKs, no `unique (household_id, id)` | 3 — schema gap | **Structural** | n/a | Migration sweep across all 100 files |
| 9 | `modules/rhythms/rhythms.ts:716` — local duplicate of `assertPersonInHousehold` | consistency | **Informational** | n/a | Static — it *does* enforce `household_id`; it omits `deleted_at is null` and the UUID pre-check |

### 1. Spot-award writes a ledger row for another household's person — and that household sees it

This is the only finding where a caller changes what a *different* household sees, and it
is the one to fix first.

`POST /api/persons/:id/award` takes the person id straight from the URL, checks only that it
is UUID-shaped, and calls `awardSpot`, which inserts:

```sql
insert into ledger_entries (household_id, person_id, currency, amount, reason, ...)
values ($1, $2, ...)   -- $1 = attacker's household, $2 = the victim's person
```

`ledger_entries.person_id` is a plain `references persons(id)`, so the row is accepted. On
its own that is only pollution of the attacker's own ledger. What turns it into a
cross-household effect is the read path in the chores summary
(`chores.service.ts:214`), which powers the Today board and the kiosk:

```sql
from persons p
left join v_person_balances b
  on b.person_id = p.id and b.currency = $3     -- ← no household predicate
where p.household_id = $1
```

`v_person_balances` is defined `group by household_id, person_id, currency` — it is
inherently household-scoped, and this join drops that column. So when household B renders
its own Today board, it picks up the balance row household A created for B's person.

That summary is not an internal helper: `todaySummary` is served by
`GET /api/chores/today` (`chores.routes.ts:180`), a plain `tenantRoute` — reachable by
*any* signed-in member of household B, and the endpoint that backs both the Today board and
the shared kiosk display.

**Proved end to end** with an integration probe against a real Postgres: household B's
member showed `stars: 0`, household A's admin called
`POST /api/persons/<B's person id>/award {amount: 999}` and got `201`, and B's summary then
showed `stars: 999`. Nobody in household B did anything.

The same join shape also means a victim whose person already has a legitimate balance can be
made to appear **twice** in their own summary, since the left join now matches two rows.

Two independent bugs line up here, and either one alone would have contained it: the write
has no `assertPersonInHousehold`, and the read has no `b.household_id = p.household_id`.
Both should be fixed — the write because it is the actual defect, the read because it is
what carried the effect across the boundary.

Note the same file's `left join chore_instances ci on ci.person_id = p.id` is likewise
missing a household predicate. It is not currently exploitable because every `person_id`
written to `chore_instances` *is* guarded (`chores.routes.ts:117,142,250,268`), but it is
the identical latent shape.

### 2. Reward redemption accepts a foreign `personId` — and discloses that person

`POST /api/rewards/:id/redeem` reads `personId` straight from the request body, checks only
that it is UUID-*shaped*, and passes it to `requestRedemption`, which inserts it into
`reward_redemptions.person_id`. That column is a plain `references persons(id)`, so a
foreign id satisfies the constraint and the row is written under *your* `household_id`.
`GET /api/redemptions` then does `left join persons p on p.id = r.person_id` with no
household predicate, and hands you the stranger's profile.

The comparison that makes this unambiguous is `POST /api/conversions/:id/apply`
(`modules/currencies/currencies.ts:346`), which is the *same three lines* — and is guarded:

```ts
// currencies.ts — guarded
const personId = body.personId?.trim() || tenant.personId
if (!UUID_RE.test(personId)) return res.status(400)...
await assertPersonInHousehold(tenant.householdId, personId)          // ← present
if (personId !== tenant.personId) await requireCapability(tenant, 'reward.manage')

// rewards.ts — not guarded
const personId = body.personId?.trim() || tenant.personId
if (!UUID_RE.test(personId)) return res.status(400)...
                                                                      // ← both missing
const red = await requestRedemption(tenant, id, personId)
```

Two routes in the same feature area, written to the same template, one hardened and one
not. That is finding 6 as well: rewards also dropped the capability check, so any member —
including a kid — can file a redemption in another *household member's* name.

The auto-approve path is largely self-limiting (the balance lookup for a foreign
`personId` finds zero and returns "not enough stars"), but the `requires_approval` path
inserts unconditionally, which is what the probe exercised.

### 3. Photo `uploadedBy` accepts a foreign person

`POST /api/photos` spreads the request body into `createPhoto` and writes
`input.uploadedBy` verbatim. `storageKey` is carefully validated against
`mediaKeyBelongsToHousehold` a few lines above — `uploadedBy` is not validated at all.
`SELECT_PHOTO` joins `persons` unfiltered, so every read of that photo attributes it to,
and discloses, the foreign person. Reachable by any member.

### 4. ICS feed `personId` accepts a foreign person

Both `POST /api/calendar/feeds` and `PATCH /api/calendar/feeds/:id` accept `personId` with
only a UUID-shape check. The `UPDATE`'s own `WHERE` is correctly scoped by `household_id`
(the feed row itself cannot be hijacked) — it is the *value written into* `person_id` that
is unchecked. `FEED_SELECT` joins `persons` unfiltered. Admin-gated, so a higher bar than
findings 2 and 3. Note the sibling route `PATCH /api/calendar/google/calendars/:id`
(`calendars.ts:340`) *does* call `assertPersonInHousehold` — same inconsistency as rewards.

### 5. Family Night assignments accept a foreign person — the control case

`POST /api/family-night/occurrence` filters its `assignments` array on
`typeof a.partId === 'string'` and lets `a.personId` through entirely unchecked — not even a
UUID-shape test — into `family_night_assignments.person_id`.

This one is worth reading next to findings 1–4, because it is the same unguarded write with
a **different outcome**. `getOccurrence` resolves the display name through `nameOf`
(`familyNight.ts:205`), which looks the id up in the household's own member list:

```ts
const nameOf = (id: string | null) => (id ? members.find((m) => m.id === id)?.name ?? null : null)
```

A foreign id simply finds nothing and comes back as `personName: null`. **No disclosure** —
only a junk row and a nameless slot in the UI. (`PUT /api/family-night/config`'s
`rotationOrder` is unvalidated in the same way, and is likewise self-correcting: `suggest()`
filters it against real members before use.)

That contrast is the structural lesson of this audit. The write bug is identical in all
five places. What decides whether it becomes a leak, a cross-household write, or a harmless
bad row is entirely **how the read path resolves the id** — filtered against the household
(Family Night: safe), joined without a household predicate (rewards, photos, ICS feeds:
disclosure), or joined into a household-scoped aggregate without its household column
(the balances view: cross-household write). Fixing the writes is necessary; hardening the
reads is what makes the next missed write harmless.

### 7. `/api/health` reports instance-wide counts to any household's admin

`checkCalendar`, `checkDb`, `checkMigrations`, `checkSchedulers`, `checkStorage` and
`checkBackup` query without a `household_id` filter, so the report aggregates across every
household on the instance — e.g. `select sync_state, count(*) from events where sync_state
in ('pending_push','push_failed')`. The route is `adminRoute`, meaning *any* household
admin, whereas the comparable operator surface `/api/auth/config` gates on
`requireInstallationOwner`. This is plausibly deliberate for a single-household self-host,
and it leaks only aggregate counts — no ids, no PII. Worth a decision, not a fix drill:
if `/api/health` is an operator panel, it should use `requireInstallationOwner`.

## What is sound (verified, not assumed)

These were checked and found correct — recorded so the next audit does not redo them.

- **Tenant resolution (class 4).** `resolveTenant` reads the household from the signed
  JWT's household claim but *validates* it: `where p.account_id = $1 and p.household_id = $2`
  — the claim only resolves if the account genuinely has a person in that household.
  Otherwise it falls back to `findTenantBySub`. Both paths are DB-derived.
- **No route takes a household id from client input**, with exactly one deliberate
  exception: `POST /api/auth/switch` reads `body.householdId` and checks it against
  `listMemberships(accountId)` (itself `account_id`-scoped) before minting a token. Correct.
- **`findTenantBySub` misuse:** none. Its two call sites are inside `resolveTenant` (the
  documented legacy fallback) and in the OIDC callback for identity *linking*, not
  request-time tenant resolution. The documented gotcha does not apply to either.
- **API keys:** `authenticateApiKey` derives the household by joining `persons` off the
  key row's `person_id`, keyed only by the presented secret's hash. No client input.
- **Kiosk device tokens:** `requireDevice` re-queries `kiosk_devices` by the JWT `sub` on
  every request and reads `household_id` from the row — it does not trust the embedded
  claim at all. Stronger than required.
- **PowerSync.** Tokens are minted `mintPowerSyncToken(tenant.sub, tenant.householdId)`,
  RS256, 5-minute TTL. Sync rules parameterize the single bucket on
  `request.jwt() ->> 'household_id'` and every table is `WHERE household_id = bucket.household_id`.
- **PowerSync CRUD upload sink** (`powersync-crud.ts`) — the highest-risk surface, since
  clients post arbitrary table/id/payload ops. `validateOps` asserts every reference
  (`assertEventReferences`, `assertEventInHousehold`, `assertPersonInHousehold`) before any
  write, every statement carries `household_id = $n`, and the `on conflict do update … where
  events.household_id = $2` makes a colliding id from another household a silent no-op.
- **Media/storage.** Keys are namespaced `<householdId>/<32-hex>.<ext>` and validated by
  regex via `mediaKeyBelongsToHousehold` on every write path that accepts a client key
  (chores proof, meals, photos, chores-capture). A good structural pattern — the one place
  the codebase *does* make cross-tenant reference impossible by construction.
- **Capture (Tier 2 mutate verbs).** Despite taking LLM-extracted `args`, every target
  resolves through household-scoped lookups (`findPersonByName(ctx.householdId, …)`,
  `instanceTitle(ctx.householdId, …)`, inline `where household_id=$1 and id=$2`). The
  rewards capture path resolves the person by *name within the household*, so it is not
  affected by finding 2.
- **Lists, meals, pantry, chores instance mutations, reward approval.** Swept exhaustively.
  Every bare `where id = $n` found is either preceded in the same transaction by a
  household-scoped `SELECT … FOR UPDATE` that proves ownership (the textbook pattern —
  `decideRedemption` is a clean example), or operates on an id read back from a
  household-scoped query. No exploitable IDOR found.
- **The `5a634aee` revert/reapply round trip.** The guard commit was reverted (`4a524564`,
  PR #30) and reapplied. Revert-and-reapply is where guard sites silently get dropped, so
  both diffs were compared file-by-file: identical file sets and hunk counts. **No call site
  was lost.**

## Class 3 — the schema picture

This is the structural core of the verdict. Across all 100 migrations:

- **Composite `(household_id, id)` foreign keys: 0.**
- **`unique (household_id, id)` constraints: 0.**
- **Single-column FKs to a domain table's `id`: 93** (excluding `households(id)` itself,
  which *is* the tenant column, and `accounts(id)`, which is deliberately cross-household).

Every one is a place where the database will happily accept a cross-tenant reference. The
concentration is stark:

| Referenced table | Referencing columns | Count |
|---|---|---|
| `persons` | `person_id`, `created_by`, `assigned_to`, `checked_by`, `completed_by`, `claimed_by`, `approved_by`, `decided_by`, `requested_by`, `done_by`, `cook_person_id`, `owner_person_id`, `uploaded_by`, `invited_by`, `skipped_by` | 55 |
| `goals` | `goal_id` | 9 |
| `events` | `event_id` | 6 |
| `recipes` | `recipe_id` | 5 |
| `meals`, `rhythms`, `goal_steps` | `meal_id`, `rhythm_id`, `goal_step_id` | 3 each |
| `rewards`, `lists`, `goal_logs`, `goal_lists` | — | 2 each |
| `chores`, `calendars`, `meal_plans`, `ledger_entries`, `event_overrides`, `calendar_accounts`, `family_night_occurrences` | — | 1 each |

`persons` is where the risk lives — 55 of 93 references, and every one of the five findings
is a person reference. **A composite FK on `persons` alone would have made findings 1 through 5
structurally impossible**, and would have caught them at insert time rather than at audit
time.

Two prerequisites the maintainer should know before costing this work:

1. A composite FK requires a matching `unique (household_id, id)` on the *referenced*
   table. None exists today, so every target table needs that index added first. It is
   cheap (`id` is already the PK, so the pair is trivially unique) but it is a real
   migration on every referenced table.
2. Some child tables have **no `household_id` column at all** to compose with —
   `meal_recipes` is keyed `(meal_id, recipe_id)` with cascade FKs only. Those would need a
   column added and backfilled, or must stay on application-layer guards.

The highest-value, lowest-cost subset is therefore: `persons`, then `goals`, `events`,
`recipes` — covering 75 of the 93 references.

## Recommended remediation order

Cheapest and highest-value first.

1. **Fix the spot-award path — both halves.** Add
   `assertPersonInHousehold(tenant.householdId, personId)` to `rewards.ts:375`, *and* add
   `and b.household_id = p.household_id` to the balances join at `chores.service.ts:231`.
   This is the only finding with a cross-household write effect; it is two lines and it
   should not wait for the rest.
2. **Add the four remaining missing assertions.** One line each, mirroring the existing
   calls: `rewards.ts:401` (redeem), `photos.ts:197` (`uploadedBy`), `ics-feeds.ts:430`
   and `:472`, and `familyNight.ts` via its route. Add the capability check to the rewards
   redeem route at the same time, matching `conversions/:id/apply` and
   `chore-instances/:id/claim`.
3. **Add the cross-household regression tests** alongside them, in the shape
   `goals.integration.test.ts` already uses — a foreign household seeded in `beforeAll`, and
   `expect(...).toBe(404)`. That file is the template; it is why the goal-list path stayed
   fixed through a revert.
4. **Harden the read joins** (defense in depth). Add the household predicate to the
   `persons` joins in `rewards.ts:394`, `photos.ts:63`, `ics-feeds.ts:60` and
   `goals.service.ts:85`, and to the `chore_instances` join at `chores.service.ts:222`.
   Even with steps 1–2 done, this turns any *future* missed assertion from a disclosure
   into a silent null.
5. **Decide `/api/health`'s audience** — `requireInstallationOwner` if it is an operator
   panel, or scope its queries by household if it is a per-household panel.
6. **Delete the duplicate helper** in `rhythms.ts:716`; import the platform one.
7. **Then the systemic fix — and yes, it beats patching sites individually.**

### Systemic fix: worth it, and here is the order

Patching the five sites is necessary but does not change the risk profile: the codebase
would still have 93 references defended only by human diligence, and this audit found five
lapses in a codebase that had *already* been through a dedicated hardening pass. That is the
argument. The failure rate of "remember to call the helper" is not zero even under
deliberate attention.

Ranked by value per unit of effort:

- **Composite FKs on `persons` first** (55 of 93 references, and **5 of 5** findings — every
  single lapse in this audit was a person reference). Add `unique (household_id, id)` to
  `persons`, add `household_id` to any child table lacking it, then convert the FKs. This
  makes the whole class impossible at the database level and is the single highest-value
  change available.
- **A lint or a test that enumerates routes** reading a `*Id` from `req.body` or `req.params`
  and asserts each has a corresponding guard. Cheaper than the migration, catches the class
  at review time, and would have caught all five findings. A grep-based test in
  `apps/api/test/` is enough — it does not need real static analysis.
- **A companion check on the read side:** any join to `persons` (or to a household-scoped
  view like `v_person_balances`) that lacks a household predicate. That single rule would
  have caught the amplifier in all four of the leaking/writing findings.
- **The shared helper already exists and is the right design** — the problem is not the
  helper, it is that nothing forces its use. `household-refs.ts` needs no redesign. Two
  gaps worth closing: there are no helpers for `chore_id`, `currency_id`, `reward_id` or
  `countdown_id`, so those areas improvise inline (correctly, today); and the assertions sit
  in routes rather than services, which is what let the seed report look true. Moving the
  assertion *into* the service functions — so `createGoalList` defends itself regardless of
  caller — would make the service files honest when read in isolation and remove a whole
  category of false report.

## Method and confidence

Every finding in the table above was traced by hand from the route registration through to
the SQL before being reported; nothing entered the table on a search result alone. Module
coverage was fanned out across the service and route files of all 28 modules, and every
candidate returned was independently re-read against its route.

Findings 1, 2, 3 and 4 were **proved empirically**, not reasoned. A temporary integration
test in the repo's existing testcontainers harness (real Postgres, real migrations, real
HTTP routes via `app.run`) seeded a second household containing a person named
`SECRET-VICTIM-NAME`, then from the first household's session:

- posted that person's id to `POST /api/rewards/:id/redeem`, `POST /api/photos` and
  `POST /api/calendar/feeds` — all three returned `201`, and all three subsequently
  returned the victim's `name`, `avatar_emoji` and `color_hex` on their read endpoints;
- called `POST /api/persons/<victim>/award {amount: 999}` — returned `201`, and the victim
  household's own `todaySummary` went from `stars: 0` to `stars: 999`.

The probe was deleted after the run and is **not** part of the committed tree; no
application code was modified at any point. The seed finding's *closure* was likewise
proved by running the repo's own existing regression test
(`goals.integration.test.ts`, "rejects foreign list members…"), not by reading it.

Findings 5, 6, 7, 8 and 9 were reasoned statically from the source and the migrations, as
were all of the "what is sound" entries. The one place this audit stopped short of proof is
finding 7 (`/api/health`): the behaviour is unambiguous from the code, but whether it is a
defect depends on whether that endpoint is meant as a per-household or an installation-wide
panel — a product decision, not a code question.
