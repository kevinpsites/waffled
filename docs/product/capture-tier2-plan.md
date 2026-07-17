# Capture Tier 2 — the "mutate verb" class (implementation plan)

Authoritative build plan for Tier 2 of the "Add anything" capture bar. Companion to
`capture-expansion.md` (§Tier 2) and `capture-tier1-plan.md`. Tier 1 (create verbs) shipped in
PR #70; this plan covers **mutate verbs**, whose one genuinely new capability is **candidate
lookup** — turning a vague spoken description ("the trash chore", "my reading goal") into one
specific existing row's id, then applying an `UPDATE`/`DELETE` to it.

Everything below is grounded in the current code (post-#70 merge). File:line anchors are current as
of `1e0ae91f`.

---

## 1. Scope — verbs × targets

| Verb | Example phrase | Target(s) | Apply endpoint (reused) |
|---|---|---|---|
| **complete** | "mark the trash chore done", "cross milk off the list" | chore instance, list item | `POST /api/chore-instances/:id/complete` · `PATCH /api/list-items/:id {checked:true}` |
| **log** | "log 20 min on my reading goal", "read 2 chapters" | goal | `POST /api/goals/:id/log` |
| **reschedule** | "move soccer to Thursday" | event | `PATCH /api/events/:id {startsAt,…}` |
| **reassign** | "give the dishes to Wally" | chore instance, event | `POST /api/chore-instances/:id/assign` · `PATCH /api/events/:id {participantIds}` |
| **redeem** | "Emma spent 3 stars on ice cream" | reward | `POST /api/rewards/:id/redeem` |
| **delete** | "delete the dentist appointment" | event, list item, chore template | `DELETE /api/events/:id` · `DELETE /api/list-items/:id` · `DELETE /api/chores/:id` — **always a destructive confirm** |

**Explicitly deferred / constrained** (discovered during mapping — do not silently assume these):
- **Per-occurrence participant reassign is unsupported** server-side (`event_overrides` fields are
  master-only; `events.ts:374`). "Give *this Thursday's* dishes to Wally" on a recurring event can
  only reassign the whole series. The resolver must surface this (reassign a recurring event →
  series-scope only, stated in the confirm card).
- **There is no `reward.redeem` capability** — redeem is plain `tenantRoute` (any member, incl. a
  kid); the parent gate is the reward's `requires_approval` data flag, not a cap. Don't invent one.
- **Chores mutate the per-date `chore_instances` row, never the template.** See §4.1.

---

## 2. Architecture — the load-bearing decisions

### 2.1 Two-step: parse (unresolved) → resolve (candidates) → commit
`POST /api/capture` parses to an **unresolved mutate intent** — `{ kind, verb, target:{description},
…verbArgs }`, **no id**. A separate `POST /api/capture/resolve` finds candidate rows; the client
shows a pick-one preview; `POST /api/capture/commit` applies the chosen mutation. This keeps the
parser stateless (the property that makes today's parse/commit split clean) and makes the
0/1/many-candidate fork natural. (Confirmed in `capture-expansion.md` as Option B.)

### 2.2 The model proposes, deterministic code resolves — never let the LLM pick the id
The LLM only extracts the **verb** and the **`target.description`** (the free-text noun phrase). It
never sees real ids or the current inventory (it would hallucinate). Deterministic DB code does the
actual lookup — exactly how `resolveDayFromText` (`capture.ts:464`) overrides the model on date math.
This generalizes the two existing "baby" resolvers: `matchListStrict` (list names, token overlap ≥0.6,
`capture.ts:343`) and the inline exact-name person match (`capture.ts:198`). Both return *names*, not
*ids*; Tier 2's ranking util (§3.4) returns *ids with confidences*.

### 2.3 Module-owned resolvers behind a capture registry (dependency inversion)
Capture must **never** query or mutate another module's tables. Instead each module registers its own
resolver + applier into a capture-owned registry, mirroring how `moduleRoutes()` inverts the module
dependency:

- New file `apps/api/src/modules/capture/capture-resolvers.ts` — a `Map`-backed registry:
  ```ts
  export interface CaptureTarget { resolveCandidates(ctx, req): Promise<Candidate[]>;
                                   applyMutation(ctx, cmd): Promise<{ message: string }> }
  const REGISTRY = new Map<TargetKind, CaptureTarget>()
  export function registerCaptureTarget(kind: TargetKind, t: CaptureTarget): void
  export function getCaptureTarget(kind: TargetKind): CaptureTarget | undefined
  ```
  It imports **nothing** from other modules (no cycle). Each module calls
  `registerCaptureTarget('chore', { resolveCandidates, applyMutation })` from inside its existing
  `registerXxxRoutes(api)` (already called imperatively in `app.ts` — the natural startup seam; no new
  plugin loader needed). `/api/capture/resolve` and `/api/capture/commit` are **thin dispatchers**:
  look up the target by `kind`, call it, return a uniform shape.
- **`ModuleGate` falls out for free**: a disabled module simply never registered — resolve returns 0
  candidates → a graceful "that's turned off." (We still assert `moduleEnabled` in the dispatcher for a
  clearer message; see §6.)

> **Deviation from the brief, flagged:** the brief named only `resolveCandidates`. We add a symmetric
> **`applyMutation`** and a **`POST /api/capture/commit`** dispatcher so the mutation logic (verb →
> endpoint, occurrence handling, hours/minutes folding, capability checks) lives **once on the server**
> instead of being duplicated across the web + iOS clients. `applyMutation` reuses the module's own
> service functions (`completeInstance`, `logProgress`, `patchItem`, `updateEvent`,
> `requestRedemption`) **and must enforce the same authorization the corresponding route enforces**
> (see the per-target caps in §4). This is the one open decision worth a sign-off (§9).

### 2.4 Mutations are server-only; the on-device heuristic must never guess a destructive action
The offline heuristic (`parse.ts` / `CaptureHeuristic.swift`) detects a mutation verb and returns a
**non-committable `mutate` marker** that forces the server path (`looksConfident` returns `false` for
it, so the bar shows "thinking" and never auto-commits offline). Offline, a mutate degrades to "I need
a connection for that." A destructive `delete` is **always** a confirm, even with one confident match.

---

## 3. The wire contract (FREEZE THIS before parallel work)

Everything in §3 is the interface the module agents and the client agents build against
independently. It must be settled first (Phase A) and not changed under them.

### 3.1 Unresolved mutate intent (from `POST /api/capture`)
```ts
type TargetKind = 'chore' | 'goal' | 'listItem' | 'event' | 'reward'
type MutateVerb = 'complete' | 'log' | 'reschedule' | 'reassign' | 'redeem' | 'delete'

interface MutateIntent {
  kind: 'mutate'
  verb: MutateVerb
  targetKind: TargetKind          // which registry entry to search
  target: { description: string } // the spoken noun phrase, e.g. "trash chore"
  args: MutateArgs                // verb params the LLM could extract (below), all optional
}
// MutateArgs (only the fields a verb uses are read):
//   log:        { amount?: number; hours?: int; minutes?: 0-59; unitHint?: string }
//   reschedule: { date?: 'YYYY-MM-DD'; time?: 'HH:mm' }   // resolved via resolveDayFromText
//   reassign:   { personName?: string }                    // resolved to id server-side
//   redeem:     { personName?: string }
//   complete/delete: {}                                    // no args
```
Extend `INTENT_SCHEMA` (`capture.ts:89`) with `kind:'mutate'` + `verb`/`targetKind`/`target`/`args`,
and `systemPrompt` (`capture.ts:132`) with the verb vocabulary + few-shots. `finalizeIntent`
(`capture.ts:192`) gains a `mutate` branch that validates/normalizes (never resolves an id).

### 3.2 `POST /api/capture/resolve`  (tenantRoute → has `tenant.personId` speaker + `householdId`)
Request: `{ verb, targetKind, target:{description}, args }` (the MutateIntent, echoed).
Response: `{ candidates: Candidate[] }`. Two flagged empty cases so the client never says
"couldn't find it" about something quick-add can't touch: an unregistered `targetKind` or a
verb outside the target's `supportedVerbs` → `{ candidates: [], unsupported: true,
disabledReason }` (friendly per-kind copy, e.g. "Quick-add can't change calendar events yet —
edit them on the Calendar page."); a disabled module → `{ candidates: [], disabledReason }`.
Resolver/DB failures are a logged 500, never a silent no-match.
```ts
interface Candidate {
  id: string           // the row id to act on (chore_instances.id, goal id, list_items.id, event master id, reward id)
  title: string        // display title ("Take out the trash")
  subtitle?: string    // disambiguating context ("Wally · due today", "Fri 4pm", "50 ⭐")
  confidence: number   // 0..1 from the ranking util
  meta?: Record<string,unknown> // verb/kind extras commit needs (e.g. { occurrenceStart } for a recurring event, { seriesScopeOnly:true })
}
```
The dispatcher: `moduleEnabled` check → `getCaptureTarget(targetKind).resolveCandidates(ctx, req)`.
`ctx = { householdId, personId, now, timezone }` (extend `CaptureContext`, `capture.ts:78`, to carry
ids — today it is names-only).

### 3.3 `POST /api/capture/commit`  (tenantRoute)
Request: `{ verb, targetKind, targetId, args, meta? }` (targetId = the chosen `Candidate.id`, meta
echoed from the candidate).
Response: `{ ok: true, message: string }` (or a 4xx with `{ error, message }` the preview surfaces).
Dispatcher: `getCaptureTarget(targetKind).applyMutation(ctx, { verb, targetId, args, meta })`, which
enforces caps and delegates to the module service. Before dispatching it 400s an unregistered kind,
a verb outside the target's `supportedVerbs` (same friendly copy /resolve uses), and a non-UUID
`targetId`. A thrown 4xx domain error is relayed as `{ error, message }`; anything else (raw
Postgres errors, outages) is logged and returned as a generic 500.

### 3.4 Shared ranking util (build once, every resolver uses it)
`apps/api/src/modules/capture/candidate-match.ts`:
```ts
rankCandidates(description: string, rows: { id; title; subtitle?; keywords?: string[] }[]):
  Candidate[]  // sorted desc by confidence
```
Generalizes `matchListStrict`'s tokenization/overlap into a **ranked** list with a confidence per row
(reuse `normList`, `capture.ts:338`; borrow the stemmer/concept ideas from `goals/goal-match.ts:66`).
The 0/1/many fork (§5) is decided by the caller from the returned confidences + a threshold.

---

## 4. Per-target specs (each is one parallel work-unit in Phase B)

Common shape for every target: **Search** (load rows via the module's *existing* list query, then
`rankCandidates`) · **Disambiguate** (scope to speaker/date) · **Apply** (delegate to the existing
service fn, enforcing the route's caps).

### 4.1 Chores — the worked example (`modules/chores/`)
- **Search:** reuse `listTodayInstances(householdId, dueOn, tz)` (`chores.service.ts:289`) — returns
  `ci.id`, `chore_title`, `person_name/person_id`, `status`. **Call `ensureTodayInstances` first**
  (`chores.service.ts:141`) so recurring chores have a `chore_instances` row to act on. Rank
  `chore_title` against the description; **candidate id = `chore_instances.id`** (never the template).
- **Disambiguate:** subtitle = `${assignee ?? 'Up for grabs'} · ${status}`. Skip `status='done'`
  candidates for `complete` (or mark them). "my chore" → prefer `person_id = tenant.personId`.
- **Apply:**
  - `complete` → `completeInstance(tenant, id, proof)` (`chores.service.ts:514`). Photo-proof chores
    return `422 ProofRequired` (surface: "That chore needs a photo — open Chores to finish it").
  - `reassign` → resolve `args.personName` → personId via `persons.name`; `setInstanceAssignee(tenant,
    id, personId)` (`chores.service.ts:173`). **Cap:** assigning to *another* person (≠
    `tenant.personId`) requires `chore.manage` (`chores.routes.ts:219`) — replicate that check.
  - `delete` → template delete `DELETE /api/chores/:id` needs `chore.manage`; destructive-confirm.
- **Gate:** `moduleEnabled('chores')` (defaultOn).

### 4.2 Goals — log progress (`modules/goals/`)
- **Search:** `listGoals(householdId)` (`goals.service.ts:433`) → id/title/goal_type/unit/
  target_value/participants. **Scope "my … goal" to goals whose `participants` include
  `tenant.personId`.** Rank `title`; there's a stronger matcher `keywordMatch` (`goal-match.ts:95`)
  that abstains on ties — reuse its tokens in `rankCandidates`.
- **Apply — `log` → `logProgress(tenant, id, amount, personIds, note, {at})`** (`goals.service.ts:754`;
  `/log` already exists). Map `args` by `goal_type` (validated at `goals.routes.ts:219`):
  - `habit` → amount forced to 1 (once/day). `count` → whole-number amount ("read 2 chapters" → 2).
  - `total` + **time unit** (`isTimeUnit(unit)`) → send `{hours,minutes}`; server folds to decimal
    hours ("log 20 min" → `{minutes:20}` → 0.333h). Sending hours/minutes on a non-time goal is a 400.
  - `checklist` → `/log` is a 400; out of Tier 2 scope for `log` (tick steps via the UI). Resolver
    should not offer checklist goals for `log`.
  - **Cap:** attributing to *another* personId needs `goal.manage` (`goals.routes.ts:268`) — self-log
    is open. Default to the speaker.
- **Gate:** `moduleEnabled('goals')` (defaultOn).

### 4.3 List items — check off / delete (`modules/lists/`) — SHIPPED (`lists-capture.ts`)
- **Search:** live items across the household's active (non-template) lists in one query joining
  `lists` for the name, then `rankCandidates` on `name`. **Subtitle = the list's name** so two "Milk"s
  disambiguate ("Milk (Groceries)" vs "Milk (Costco)"). Checked items are dropped for `complete`
  (still offered for `delete`).
- **Apply:** `complete` → `setItemChecked(tenant, id, true)` (`lists.service.ts:280`). `delete` →
  `softDeleteItem(householdId, id)` — soft, but still a destructive-confirm in the UI. Household-scoped
  404 guard; no per-capability gate (mirrors the plain-tenantRoute item routes).
- **Gate:** `moduleEnabled('lists')` → disabledReason "Lists is turned off."

### 4.4 Events — reschedule / delete (`modules/events/events.ts`) — SHIPPED (`events-capture.ts`)
- **Search:** an upcoming window via `rangeEvents` from "now", ranked on `title`; past events are
  excluded. Subtitle = a human date/time ("Fri Jul 18 · 7:00 PM"). Candidate meta =
  `{ seriesId, occurrenceStart | null }` (echoed for the client contract only — `applyMutation`
  re-derives the occurrence/series handle from the DB by targetId, with an `rrule is null` guard so
  a master id can never be mutated as a "single").
- **Semantics — the occurrence, never the series:** recurring rows go through `overrideOccurrence`
  (scope `'this'`; delete = cancel + rematerialize), singles through `updateEvent` /
  `softDeleteEvent` + `materializeMaster` — mirroring the PATCH/DELETE routes.
- **Apply:**
  - `reschedule` → `args.date` / `args.time` (LLM contract; the web heuristic extracts them
    on-device too). Date-only keeps the original clock time, time-only keeps the day; neither →
    friendly 400. Duration preserved by sliding `endsAt` by the start delta.
  - `delete` → destructive-confirm in the UI; "Canceled *X* (just this one)" for an occurrence.
  - **`reassign` is NOT wired to capture** (deferred) — the bar answers with the honest
    unsupported-verb copy. Recurring reassign being master-only is the open design question.
- **Gate:** none (calendar always on).

### 4.5 Rewards — redeem (`modules/rewards/rewards.ts`) — SHIPPED (`rewards-capture.ts`)
- **Search:** the reward catalog, ranked on `title`. Candidate id = reward id; subtitle =
  `${cost} ${currency}`.
- **Apply** — via `requestRedemption` (`rewards.ts:170`), exactly as `POST /api/rewards/:id/redeem`:
  resolve `args.personName`→id via the shared `findPersonByName` (default speaker; unknown name →
  friendly 400). `requires_approval` → pending redemption + "waiting for approval" message; else
  balance-guarded debit ("Redeemed … (−N stars)"; `{error}` → 409 with the route's own "not enough
  stars" message). **No redeem capability** — any member. `reward.grant`/spot-award stays out of scope.
- **Gate:** `rewardsEnabled` (chores module on AND `settings.chores.rewards`) → disabledReason
  "Rewards is turned off." (the sub-toggle nuance is not distinguished, same as the routes' gate).

---

## 5. Worked example end-to-end — "mark the trash chore done" (TDD-first)
1. `POST /api/capture` → `{ kind:'mutate', verb:'complete', targetKind:'chore',
   target:{description:'trash chore'}, args:{} }`.
2. `POST /api/capture/resolve` → chores target: `ensureTodayInstances` → `listTodayInstances` →
   `rankCandidates('trash chore', rows)` → `[{ id: <instance>, title:'Take out the trash',
   subtitle:'Wally · pending', confidence:0.9 }]`.
3. Fork: **1 confident** → confirm card (no picker). **0** → "couldn't find a chore like that" (+ offer
   to create). **2+** → picker chips in the preview.
4. `POST /api/capture/commit` → `applyMutation('chore', {verb:'complete', targetId})` →
   `completeInstance` → `{ ok, message:'Marked "Take out the trash" done' }`.

**Tests (write first, watch fail):** a `describe('POST /api/capture/resolve — chores')` +
`describe('POST /api/capture/commit — chores')` block in `chores.integration.test.ts` (Testcontainers
PG + `app.run`, per §Test-harness): seed a household + a chore, drive the two endpoints, assert the
candidate shape and that the instance flips to `done`. Unit-test `rankCandidates` directly (pure fn) —
exact match, token-overlap, tie → both returned, below-threshold → empty.

---

## 6. Cross-cutting

- **Gating message:** dispatcher checks `moduleEnabled` (or `rewardsEnabled`) and returns a 200 with
  `candidates:[]` **plus** a `disabledReason` the preview shows ("Chores is turned off"), so the client
  distinguishes "off" from "no match."
- **Permissions:** `applyMutation` enforces the same cap the route does — `chore.manage` (reassign
  other / delete template), `goal.manage` (attribute-other). Self-actions and redeem are open.
- **0/1/many fork thresholds:** ≥1 candidate over `HIGH` (~0.75) and clearly ahead of #2 → auto-single;
  any candidates over `LOW` (~0.4) → picker; none → not-found. Tune in the ranking util; unit-tested.
- **Keyword matches count at half weight** (`KEYWORD_WEIGHT` in `candidate-match.ts`): a description
  token found only in a row's `keywords` (concept vocabulary) scores 0.5 vs 1.0 for a title token —
  otherwise a one-word description like "outside" tied every outdoors-concept goal at 1.00 (PR #73
  review fast-follow).
- **Destructive confirm:** every `delete` (and the "already done?" undo edge) forces an explicit
  confirm button in the preview even at confidence 1.0.
- **Offline / heuristic:** `parse.ts` + `CaptureHeuristic.swift` detect mutation verbs at the top of
  `parseCapture` and return `{kind:'mutate', …}` (non-committable); `looksConfident` → false. Offline →
  "I need a connection for that." KEEP-IN-SYNC across both parsers + both test suites.

## 7. Client integration (seams from the mapping)
- **Web** (`CaptureBar.tsx`): add `mutate` to the `rawIntent → intent` gating chain (~:552), a
  `CandidatePicker` branch in the preview/`DraftFields` (reuse `.cap-people`/`.cap-person` chips), and a
  `commit` branch (~:584) that calls `captureApi.commitMutate`. New `captureApi.resolveCandidates` +
  `commitMutate` in `apps/web/src/lib/api/capture.ts`. `parse.ts`: `mutate` union member + top-of-parse
  detector + `looksConfident`/`intentSummary` cases.
- **iOS** (`Capture.swift` enum + decoder + summary; `CaptureSheet.swift` phases/state/commit switch;
  `SyncManager` `resolveCandidates`/`commitMutate`; `WaffledAPI` endpoints; `CaptureHeuristic.swift`
  mirror). Web is the priority surface for the richer picker; iOS reaches parity.

---

## 8. Build phases & parallelization

**Phase A — the spine (serial, one focused pass; freezes §3).** Blocks everything.
- `capture-resolvers.ts` registry + `candidate-match.ts` `rankCandidates` (+ unit tests).
- `capture.ts`: `mutate` intent type, `INTENT_SCHEMA` + `systemPrompt` verb vocab, `finalizeIntent`
  mutate branch, extended id-carrying `CaptureContext`, and the two thin dispatcher routes
  (`/resolve`, `/commit`) with a stub registry (0 targets) + their integration-test skeleton.
- Freeze the wire contract (§3).

**Phase B — parallel work-units (all against the frozen §3 contract, file-disjoint):**
- 5 module agents: **chores** (do first / reference), **goals**, **listItem**, **events**, **rewards**
  — each: resolver + applyMutation + `registerCaptureTarget` + integration tests, in its module dir only.
- **web agent** and **iOS agent** — client flow + heuristic + tests.

**Phase C — integration + ship.** Full suites (api/web/iOS), Playwright drive of the kiosk for the
mutate flow, CHANGELOG (`[Unreleased] → Added`) + features.md + roadmap, then PR (ready-for-review).

**Proposed first-PR scope (recommend):** Phase A + **chores + goals** targets + **web** client — the
two exemplar targets (occurrence handling + unit folding are the interesting cases) end-to-end on the
priority surface. Lists/events/rewards + iOS parity follow as fast-follow PRs on the same frozen
contract. (Alternative: everything in one large PR — more review surface, more parallel agents.)

## 9. Decisions (signed off)
1. **DECIDED: unified `/api/capture/commit` dispatcher** — verb/occurrence/unit/cap logic lives once on
   the server; `applyMutation` re-asserts the routes' caps; clients stay thin. (§2.3)
2. **DECIDED: first PR = Phase A spine + chores + goals + web.** Lists/events/rewards + iOS parity are
   fast-follow PRs on the same frozen contract. (§8)
3. **Ranking thresholds** (HIGH/LOW) — start ~0.75/0.4, tune against seeded fixtures. (§6, implementer's
   call.)
4. **DECIDED: capture event mutates act on the occurrence, never the series** (§4.4) — and event
   `reassign` is deferred (unsupported-verb copy answers it). Shipped in the fast-follow PR along with
   the listItem + reward targets and the keyword half-weight ranking fix; iOS parity remains open.

## 10. TDD checklist (per work-unit)
- [ ] `rankCandidates` unit tests (exact / overlap / tie / below-threshold).
- [ ] Per-target `resolve` integration test (seed rows → candidate shape + confidence order).
- [ ] Per-target `commit` integration test (applies the mutation; caps enforced; destructive path).
- [ ] Offline heuristic: mutation verbs → `mutate` marker, `looksConfident` false (web + iOS).
- [ ] Full suites green (api/web/iOS) + Playwright mutate-flow before PR.
