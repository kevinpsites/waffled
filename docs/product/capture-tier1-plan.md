# Capture Tier 1 — implementation plan (TDD-first)

**Scope:** the five remaining *create* intents — `goal`, `pantry`, `countdown`, `reward`, `person`.
No new backend: every create endpoint and web API-client method already exists. Tier 1 is
**parser + dispatch wiring**, done test-first.
**Companion:** [`capture-expansion.md`](./capture-expansion.md) (the brief). **Extends:** roadmap 6.6.

---

## 0. The one fact that shapes the whole approach

Capture is parsed in **three mirrored places that must stay in sync**, each with its own test file:

| Layer | Parser | Test |
|---|---|---|
| Server (LLM schema + normalize) | `apps/api/src/modules/capture/capture.ts` | `apps/api/test/capture.integration.test.ts` |
| Web on-device heuristic | `apps/web/src/lib/capture/parse.ts` | `apps/web/src/lib/capture/parse.test.ts` |
| iOS on-device heuristic | `apps/ios/Sources/Waffled/Sync/CaptureHeuristic.swift` | `apps/ios/Tests/CaptureHeuristicTests.swift` |

The server test **unit-tests the exported `finalizeIntent` with a raw object, never calling the LLM**
(`capture.integration.test.ts:87`; header note: *"LLM adapters … aren't exercised here;
finalizeIntent covers the mapping they feed into"*). That's our **red-first anchor** — a pure
function, deterministic, no provider. The LLM prompt is exercised only by hand/eval, not unit tests.

**Consequence:** for each new kind, "the failing test" = a `finalizeIntent` assertion. The prompt
change (schema + few-shot) is what makes the *real* LLM emit that kind, but it isn't what the test
locks down. We lock down the normalize + dispatch.

---

## 1. Sequencing (easiest → gnarliest gating)

Ship as **small PRs, one intent each**, in this order:

1. **`countdown`** — always-on, 2 required fields (`title`, `date`), reuses `resolveDayFromText`. The
   cleanest first cut to establish the pattern end-to-end.
2. **`person`** — always-on but **admin-only** create; introduces the "commit may be permission-
   refused" path.
3. **`goal`** — module-gated (`goals`, default **on**); the richest field mapping (`goalType` /
   `trackingMode` inference). Worked in full below.
4. **`pantry`** — module-gated, default **off** → introduces **suppress-unless-enabled**.
5. **`reward`** — the trickiest gate: `rewardsEnabled` (chores on **and** rewards sub-toggle) **plus**
   the `reward.manage` capability (kids can't create rewards).

---

## 2. The four touchpoints (every intent, every PR)

1. **Server schema + prompt** — add the `kind` to `INTENT_SCHEMA` (`capture.ts:64`) and its fields;
   add rules + one few-shot example to `systemPrompt` (`capture.ts:82`). For `goal`, **delete the
   goal→`unsupported` steering** at `capture.ts:102` and the example at `:119`.
2. **Server normalize** — a `finalizeIntent` branch (`capture.ts:124`) that validates and defaults.
3. **Client dispatch + preview** — a `commit()` case in `CaptureBar.tsx:309` calling the existing
   API method, behind the right module/permission gate, with an editable preview card.
4. **On-device parity** — mirror in `parse.ts` and `CaptureHeuristic.swift` (or route the kind to
   "needs connection" — see §5). Update all three test files.

---

## 3. Worked example — `goal`

### 3a. RED — write the failing `finalizeIntent` test first

`apps/api/test/capture.integration.test.ts`, alongside the existing `finalizeIntent` block (~:87):

```ts
const ctx = { now: '2026-06-11T09:00:00Z', timezone: 'America/Chicago', people: ['Wally', 'Lottie'] }

// count goal with an explicit numeric target + unit
expect(finalizeIntent(
  { kind: 'goal', title: 'Read 20 books', goalType: 'count', targetValue: 20, unit: 'books' }, ctx
)).toEqual({
  kind: 'goal', title: 'Read 20 books', goalType: 'count',
  trackingMode: 'shared_total', targetValue: 20, unit: 'books', deadline: null,
})

// bare "get in shape" → defaults to a habit, no target
expect(finalizeIntent({ kind: 'goal', title: 'Get in shape' }, ctx)).toMatchObject({
  kind: 'goal', title: 'Get in shape', goalType: 'habit', trackingMode: 'shared_total',
})

// a count kind with no number is NOT a valid count → coerced to habit
expect(finalizeIntent({ kind: 'goal', title: 'Drink water', goalType: 'count' }, ctx))
  .toMatchObject({ goalType: 'habit' })
```

Run `npm test` in `apps/api` → these fail (kind falls through to `task` today). That's the red.

### 3b. GREEN — server

- **Type** (`capture.ts:26`): add `'goal'` to the `kind` union; add `goalType?`, `trackingMode?`,
  `targetValue?`, `unit?`, `deadline?` to `CaptureIntent`.
- **Schema** (`capture.ts:64`): add `'goal'` to the enum and the new properties (with the
  `goalType` enum `['count','total','habit','checklist']` and `trackingMode`
  `['shared_total','each_tracks']`).
- **Prompt** (`capture.ts:82`): **remove** the `unsupported` goal rule (`:102`) and example (`:119`);
  add a `goal` rule + example:
  > `goal` = a personal/shared goal ("set a goal to…", "I want to read 20 books"). Extract `title`;
  > infer `goalType`: a countable target ("20 books") → `count` with `targetValue`+`unit`; a
  > recurring habit ("every day") → `habit`; saving/accumulating an amount → `total`; a list of
  > steps → `checklist`; when unsure → `habit`. Default `trackingMode` `shared_total`.

  `"set a goal to read 20 books this year" -> {"kind":"goal","title":"Read 20 books","goalType":"count","targetValue":20,"unit":"books","deadline":"2026-12-31"}`
- **Normalize** (`capture.ts:124`): add a `goal` branch — require `title`; coerce `goalType` to the
  valid set, **downgrading `count` without a whole-number `targetValue` to `habit`** (mirrors the
  server's own `goalShapeError`, goals.service.ts:50); default `trackingMode='shared_total'`;
  pass `deadline` through only if `YYYY-MM-DD`.

### 3c. GREEN — client dispatch + preview

`CaptureBar.tsx` `commit()` (`:309`), new case:

```ts
case 'goal':
  await api.createGoal({
    title: intent.title, goalType: intent.goalType, trackingMode: intent.trackingMode,
    targetValue: intent.targetValue ?? undefined, unit: intent.unit ?? undefined,
    deadline: intent.deadline ?? undefined,
  })  // apps/web/src/lib/api/goals.ts:152 → POST /api/goals
  break
```

**Preview card** must expose the *inferred* fields for edit — `goalType`, `targetValue`, `unit`,
`deadline` — because inference is fuzzy; this is exactly where confirm-and-edit earns its keep.
**Gate:** only offer the goal commit when `moduleEnabled(household, 'goals')`
(`apps/web/src/lib/modules.ts`); if off, fall through to an `unsupported`-style "Goals is turned
off" message rather than erroring on POST.

> **Out of scope for Tier 1:** goal *logging* (`POST /goals/:id/log`) — that's a Tier 2 **mutate**
> ("log 20 min on my reading goal"), needs candidate lookup. Tier 1 only *creates* goals.

### 3d. GREEN — integration round-trip (optional but recommended)

Add a `goals`-style round-trip in the capture test: POST `/api/capture` is heuristic-only in tests,
so instead assert the **commit path** by POSTing the finalized intent's fields to `/api/goals`
(as `goals.integration.test.ts` already does) — proving the field mapping the client will send is
accepted by the real route.

### 3e. Parity — heuristic + its tests

Add a `goal` case to `parse.ts` and `CaptureHeuristic.swift` triggered by "set a goal to…" /
"I want to…", producing a minimal `{kind:'goal', title, goalType:'habit', trackingMode:'shared_total'}`
(no target inference offline — the LLM upgrades it). Add matching assertions to `parse.test.ts` and
`CaptureHeuristicTests.swift`.

---

## 4. Per-intent specs (the other four)

All follow the §2/§3 flow. Endpoint + client method already exist — details below.

### `countdown` — always-on
- **Fields:** `title` (req), `date` (req, YYYY-MM-DD); optional `emoji`, `color`.
- **Parser:** "N days until X" / "X in N days" / "countdown to X on <date>". Resolve the date via
  `resolveDayFromText` (already imported) — very regex-friendly, so worth a full heuristic mirror.
- **Commit:** `api.countdowns.create({title, date, emoji?, color?})` → `POST /api/countdowns`
  (`countdowns.ts:33`). No gate.

### `person` — always-on, **admin-only**
- **Fields:** `name` (req), `memberType` ∈ `{adult, teen, kid}` (req); optional `avatarEmoji`,
  `birthday`, `isAdmin`.
- **Parser:** "add my son/daughter/husband/… <name>[, age N]" → infer `memberType` (son/daughter →
  `kid`, spouse/partner → `adult`); age → nothing today (no age field; birthday only).
- **Commit:** `api.createPerson(input)` → `POST /api/persons` (`persons.ts:317`, **`adminRoute`**).
- **Gate:** offer only when the current person is an admin; otherwise `unsupported` "Only an adult
  can add family members." (Don't POST and eat a 403.)

### `goal` — see §3 (module `goals`, default on).

### `pantry` — module `pantry`, **default OFF**
- **Fields:** `name` (req); optional `amount`, `unit`, `location` (default `'Pantry'`), `expiresOn`,
  `lowAt`.
- **Parser:** "add X to (the) pantry", "put X in the pantry" → `{name, amount?, unit?}`. Distinguish
  from `grocery` by the explicit "pantry" target (grocery = the shopping list).
- **Commit:** `api.pantry.create(input)` → `POST /api/pantry` (`pantry.ts:132`).
- **Gate — new pattern:** pantry defaults **off**, so **suppress the intent entirely unless
  `moduleEnabled(household,'pantry')`**. The LLM shouldn't even be told about pantry when it's off
  (or the client drops it to `unsupported`). This is the first "capture must respect a default-off
  module" case.

### `reward` — gated on rewards, **capability-limited**
- **Fields:** `title` (req); optional `emoji`, `cost` (int ≥0), `currency`, `category`,
  `requiresApproval`.
- **Parser:** "add a reward: <title> for N stars" → `{title, cost:N}`.
- **Commit:** `api.createReward({title, cost, ...})` → `POST /api/rewards` (`rewards.ts:59`).
- **Gate — two conditions:** only when `rewardsEnabled(household)` (chores on **and**
  `settings.chores.rewards !== false`, `modules.ts:98`) **and** the person has `reward.manage`
  (the create route is `capRoute('reward.manage')`). Kids → `unsupported` "Ask a parent to add a
  reward."

---

## 5. Cross-cutting Tier 1 decisions

- **Gating lives on the client commit, not just the prompt.** The LLM may still emit a `goal`/
  `reward` even when disabled; the `commit()` gate is the real guard, degrading to an
  `unsupported`-style message. (Mirrors how the server routes would 403 anyway — we just fail
  gracefully before the POST.)
- **Heuristic parity is per-intent, not all-or-nothing.** `countdown`/`pantry`/`reward` have crisp
  trigger phrases → full heuristic mirror. `goal`/`person` get a **minimal** heuristic (title +
  safe defaults) and rely on the LLM upgrade for the structured fields — the offline path still
  produces a valid, editable create rather than mis-routing to grocery.
- **The `unsupported` fallthrough gets friendlier.** Every gated-off or permission-blocked case
  returns a `reason` (and, per the brief, ideally a deep link to the right screen) instead of a
  silent drop or a POST error.
- **Sync burden is real.** Each intent = edits to 3 parsers + 3 test files. The PR checklist below
  makes it mechanical.

---

## 6. Per-intent PR checklist (copy-paste)

- [ ] **RED:** `finalizeIntent` assertion(s) for the new `kind` in `capture.integration.test.ts`
- [ ] Server: `kind` + fields in `CaptureIntent` type and `INTENT_SCHEMA`
- [ ] Server: rule + few-shot example in `systemPrompt` (for `goal`, also remove the `unsupported`
      steering)
- [ ] Server: `finalizeIntent` branch (validate + default) → test green
- [ ] Client: `commit()` case calling the existing API method
- [ ] Client: editable preview card exposing inferred fields
- [ ] Client: module/permission gate → graceful `unsupported` when off/blocked
- [ ] Web heuristic: `parse.ts` case + `parse.test.ts` assertions (full or minimal per §5)
- [ ] iOS heuristic: `CaptureHeuristic.swift` case + `CaptureHeuristicTests.swift` assertions
- [ ] `npm test` (api) green; `npm run build` (web) clean; `xcodegen && xcodebuild` (iOS) clean
- [ ] CHANGELOG `[Unreleased]` → Added; features.md updated
