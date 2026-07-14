# Capture-bar expansion — "Add anything" → "Do anything"

**Status:** Design brief (pre-implementation). Extends roadmap item 6.6.
**Owner:** TBD
**Related code:** `apps/api/src/modules/capture/capture.ts`, `apps/web/src/lib/capture/parse.ts`, `apps/web/src/kiosk/components/CaptureBar.tsx`, `apps/ios/Sources/Waffled/Sync/CaptureHeuristic.swift`
**Related docs:** `website/docs/src/content/docs/features/capture.md`, `website/docs/src/content/docs/administration/ai-providers.md`

---

## 1. The principle

Every action in Waffled should have **two equally-good front doors**:

1. **Navigate the UI** — go to the screen, tap the button, fill the form.
2. **Tell the bar** — tap the "Add anything" bar and say what you want in plain language.

Whatever you can do by navigating, you should be able to do by talking. That includes things
that aren't "adding" at all: completing a chore, crossing off groceries, logging progress on a
goal, and even changing settings ("switch to dark mode", "start my week on Monday").

**One rule holds for every action: the user always confirms.** The bar never commits silently.
It parses your words into a *proposed* action, shows an **editable preview**, and only writes when
you tap confirm — exactly the way an event preview works today (title, time, Repeats/Ends are all
editable before it lands). This is a hard requirement across all verb classes below, not just
creates.

---

## 2. Where we are today (source of truth)

The bar today is **create-only**. The server parses free text into one of six intents; the
client commits the parsed intent to the matching module's API.

- **Intent enum:** `capture.ts:64` — `event · task · grocery · meal · list · unsupported`.
- **Prompt / rules / examples:** `capture.ts:82-121` (`systemPrompt`).
- **Normalizer:** `capture.ts:124-184` (`finalizeIntent`).
- **Client dispatch (`commit()`):** `apps/web/src/kiosk/components/CaptureBar.tsx:309` — event→`createEvent`,
  grocery→`addGroceryItem`, list→`createList`/`addListItem`, meal→`planSlot`, task→`createChore`,
  unsupported→flash reason (no write).
- **On-device heuristic mirrors** (offline fallback, kept byte-for-byte in sync):
  `apps/web/src/lib/capture/parse.ts` and `apps/ios/.../CaptureHeuristic.swift`.
- **Providers:** `apps/api/src/platform/llm.ts` — `anthropic · openai · ollama · heuristic`,
  selected per-household in `households.settings.ai`; keys are env-only (`config.ai`).

### Architectural note that shapes everything below

Parsing and committing are **separate**: the server returns a structured intent, the client
performs the mutation against the module API. This is good — it keeps the parser stateless and
lets the client own the confirm-and-edit UI. New verb classes should preserve this split.

---

## 3. The four verb classes

The bar today only *creates*. "Do anything" means three more verb families. Designing the intent
schema for **all four up front** avoids re-architecting the parser later.

| Verb class | Example phrases | New challenge introduced |
|---|---|---|
| **Create** (today) | "dentist Tuesday 3pm", "milk", "taco night Thursday" | — |
| **Mutate** | "mark the trash chore done", "cross milk off", "move soccer to Thursday", "log 20 min on my reading goal" | **Resolving *which* existing item** the user means |
| **Settings** | "switch to dark mode", "start my week on Monday", "turn on the pantry" | Writing to household/person **config** + permission sensitivity |
| **Query** | "what's for dinner tonight", "who has chores today", "how many stars does Emma have" | **Read** path (bar today only writes) + presenting an answer |

---

## 4. Universal confirm-and-edit contract

This is the load-bearing UX decision. For **every** intent, regardless of verb class:

1. Parse → produce a **proposed action** with a human-readable summary (`whenLabel`/`scheduleLabel`
   style) and the underlying fields.
2. Render an **editable preview card** — the user can adjust fields before committing.
3. Commit **only on explicit confirm**.
4. For **destructive** mutations (delete, mark-done-that-can't-be-undone) and **settings** changes,
   the preview states the exact effect ("This turns on dark mode for everyone on this hub").

Implications for new verb classes:

- **Mutate** previews must show *which* item resolved ("Chore: **Take out the trash** — Tuesday,
  Lottie") so the user catches a wrong match before it commits.
- **Settings** previews must show scope (this person vs. whole household) and the before→after value.
- **Query** results are read-only, so "confirm" degenerates to "dismiss" — but a query that the
  model *reinterprets as an action* ("actually, add that") still routes back through a normal
  confirm.

Preview + edit lives in the client (`CaptureBar.tsx` and the iOS equivalent), consistent with
today's event preview.

---

## 5. Tiered roadmap

Each tier is a real jump in engineering effort. Ship in order; don't blend.

### Tier 1 — Finish "add anything" (create-only, same architecture)

Low risk: adds intent kinds that follow the existing create-and-confirm pattern. No item
resolution, no reads, no settings writes.

| New intent | Phrase | Commits to | Notes |
|---|---|---|---|
| `goal` | "set a goal to read 20 books this year" | Goals module | Currently forced to `unsupported` at `capture.ts:102,119` — flip it to a real intent. |
| `pantry` | "add 2 cans of black beans to the pantry" | Pantry module | Quantity + location; no barcode needed for text add. |
| `countdown` | "42 days until Disney" | Countdowns module | Target date + label; reuses date resolution (`resolveDayFromText`). |
| `reward` | "add a reward: movie night for 50 stars" | Rewards module | Create a redeemable reward (distinct from stars-on-a-task). |
| `person` | "add my son Max, he's 8" | Persons module | Name + optional age/role; **permission-gated** (not every user can add family). |

### Tier 2 — "Do anything" (the mutate verb class)

Introduces **item resolution**: the parser must identify *which* existing chore/event/grocery
item/goal the user means, from partial descriptions, and the preview must let the user correct a
wrong match. This is the same fuzzy-resolution problem already flagged for person names
(`capture.md:37`), generalized to arbitrary items.

| Mutation | Phrase | Target |
|---|---|---|
| Complete / check off | "mark the trash chore done", "cross milk off the list" | Chores, grocery/list items |
| Log progress | "log 20 min on my reading goal", "read 2 chapters" | Goals (`POST /goals/:id/log`, roadmapped) |
| Reschedule / reassign | "move soccer to Thursday", "give the dishes to Wally instead" | Events, chores |
| Redeem | "Emma spent 3 stars on ice cream" | Rewards ledger |
| Delete | "delete the dentist appointment" | Any — **always** a destructive confirm |

Design work Tier 2 needs before coding:
- A **resolution step**: given a verb + a fuzzy noun, return candidate items (with enough context
  to disambiguate) so the preview can show the match and offer alternatives.
- Ambiguity handling: 0 matches → "couldn't find that"; >1 → let the user pick in the preview.
- Offline: mutations should **require** the LLM/server path (see §6) rather than heuristic-guess.

### Tier 3 — "Run anything" (settings + queries)

The true "talk to the app" experience. Two sub-parts:

**Settings writes** — a small, closed vocabulary maps cleanly to `households.settings` / person prefs:

| Setting | Phrase | Scope |
|---|---|---|
| Theme | "switch to dark mode" | Person (or household default) |
| Start of week | "start my week on Monday" | Household |
| Module toggle | "turn on the pantry" | Household — **admin-gated** |
| AI provider/model | "use Claude for capture" | Household — **admin-gated** |
| Allergens | "add peanuts to Emma's allergies" | Person |
| Today-card layout, kiosk pairing | "hide the weather card" | Person / device |

**Queries (read path)** — the first genuinely non-write class:

| Query | Phrase |
|---|---|
| Meal lookup | "what's for dinner tonight" |
| Chore lookup | "who has chores today", "what's left on my list" |
| Rewards balance | "how many stars does Emma have" |
| Schedule lookup | "when's the dentist" |

Queries return an **answer card**, not a mutation. Confirm-and-edit degenerates to dismiss, but a
follow-up action ("add that to the list") re-enters the normal confirm flow.

---

## 6. Cross-cutting design decisions

These apply across tiers and should be settled before Tier 2.

### Intent schema shape (design once)

Extend the current flat `CaptureIntent` to carry a **verb** alongside **kind**, so a single schema
covers all four classes without a rewrite later. Sketch:

```
{
  verb: "create" | "complete" | "update" | "delete" | "log" | "set" | "query",
  kind: "event" | "task" | "grocery" | "list" | "meal" | "goal" | "pantry" |
        "countdown" | "reward" | "person" | "setting",
  ...existing create fields...,
  target?: { ref?: string; description?: string },  // for mutate/query: which item
  setting?: { key: string; value: string; scope: "person" | "household" },
  unsupported?: { reason: string }
}
```

The `unsupported` escape hatch stays: anything the bar can't do yet returns a friendly reason and,
ideally, a **deep link to the right screen** ("I can't do that yet — here's Settings →
Notifications"). That turns every gap into a helpful redirect instead of a dead end.

### Permissions

Today's create-only bar mostly sidesteps authorization. Mutations, settings, and person-creation
**must** run through the same permission gates as the corresponding UI screens (a kid at the kiosk
can't disable a module, hand out 50 stars, or delete someone's events). Enforce at **commit** time
on the server route, not just by hiding UI. The parser may propose; the commit authorizes.

### Offline behavior

The on-device heuristics never emit `unsupported` — they fall back to **grocery** for bare nouns.
That's fine for creates but dangerous for the new classes (a "delete X" or "dark mode" typed
offline must not become a grocery item). New verb classes should **require the server/LLM path**
and degrade to "I need a connection for that" rather than a heuristic guess. Keep the two on-device
heuristics (`parse.ts`, `CaptureHeuristic.swift`) in sync per their header contracts.

### Confirm UI reuse

The event preview (editable title/time/Repeats/Ends) is the template. Generalize it to render any
intent's fields + a plain-language effect line, so mutate/settings/query previews are the same
component with different field sets.

---

## 7. Implementation contract per new intent (the four touchpoints)

Adding any capability touches the same four places — miss one and web/iOS/offline drift:

1. **Server schema + prompt** — new `verb`/`kind` in `INTENT_SCHEMA` (`capture.ts:64`), rules +
   few-shot examples in `systemPrompt` (`capture.ts:91-119`).
2. **Server normalizer** — a `finalizeIntent` branch (`capture.ts:124`) that validates and shapes
   the fields, plus any deterministic resolution (dates via `resolveDayFromText`, lists via
   `matchListStrict`, and — new — item/target resolution for mutations).
3. **Client dispatch + preview** — a `commit()` case in `CaptureBar.tsx:309` (and the iOS
   equivalent) that renders the editable preview and calls the module API on confirm.
4. **On-device heuristic** — mirror in `parse.ts` **and** `CaptureHeuristic.swift` (or explicitly
   route the class to "needs connection" — see §6).

TDD per repo convention: integration test (testcontainer PG + real `/api/capture` route) asserting
the parsed intent first, then implement.

---

## 8. Open questions

- **Resolution service (Tier 2):** new endpoint, or fold candidate-lookup into the parse response?
- **Query answers (Tier 3):** does the bar render structured answer cards, or hand off to the
  relevant screen? How much read surface do we expose?
- **Settings vocabulary (Tier 3):** enumerate the exact settable keys — start with the highest-value
  (theme, start-of-week, module toggles, allergens) rather than "any setting".
- **Multi-action phrases:** "add milk and mark the trash done" — one intent per utterance today.
  Do we split, or keep one-action-per-capture?
- **Voice quick-add (roadmap ~219):** the iOS freeform voice intent parses via `/api/capture` then
  speaks a summary — the universal confirm-and-edit contract needs a spoken-confirm story.
