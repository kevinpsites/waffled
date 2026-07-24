# Capture photo capture — implementation plan (TDD-first)

**Scope:** let the "Add anything" bar accept a **photo** and turn it into an action — a wedding
invitation → a calendar event, a sports schedule → a set of events, a receipt → pantry restock, a
recipe card → a recipe. **No new AI plumbing:** the vision layer already exists (built for recipe
ingest); this is **wiring a photo into the capture parse + a router on the way out**, done
test-first.
**Companion:** [`capture-expansion.md`](./capture-expansion.md) (the brief),
[`capture-tier1-plan.md`](./capture-tier1-plan.md) (the create-intent pattern this extends).
**Extends:** roadmap 6.6.

---

## 0. The two facts that shape the whole approach

**Fact 1 — the expensive part is already built.** The shared LLM layer
(`apps/api/src/platform/llm.ts`) is already multimodal:

- `LlmImage` (`{ contentType, dataBase64 }`) and an `images?: LlmImage[]` field on
  `LlmJsonRequest` — the Anthropic, OpenAI, and Ollama adapters each already wrap images in the
  shape their API expects.
- `visionAvailable(householdId)` / `modelSupportsVision(provider, model)` gate whether the
  household's *selected* model can read a photo at all (Claude & modern OpenAI = yes; Ollama =
  probed).

Recipe ingest (`POST /api/recipes/ingest/photo`) is the only caller today, but nothing about it
is recipe-specific. **Photo capture reuses `completeJson({ images })` verbatim.**

**Fact 2 — a photo maps to two different downstream shapes, so the design is a *router*, not a new
intent kind.**

| Photo produces… | Example | Downstream |
|---|---|---|
| **One structured entity** | wedding invite → 1 event | a normal `CaptureIntent` → existing `commit()` one-shot |
| **Many structured entities** | sports schedule → 6 events; receipt → 8 pantry items | a `CaptureIntent[]` → **batch** confirm-and-edit (new UX) |
| **A rich draft you review before saving** | recipe card → recipe | hand off to the **existing recipe importer** (`ingestRecipeFromPhotos` → draft → editor) |

The recipe case is the trap: a recipe is **not** a `CaptureIntent.kind` — it has its own
review-before-save draft flow (`RecipeImportModals.tsx` → `applyParsed()`). Don't rebuild it as an
intent; **route to it.** That keeps this plan additive.

---

## 1. Where we are today (source of truth)

- **Capture parse:** `POST /api/capture` (`capture.ts:691`) takes `{ text }` only → `parseWithProvider`
  → `completeJson(INTENT_SCHEMA)` → `finalizeIntent` → a single `CaptureIntent`. The **client**
  commits it: `CaptureBar.tsx` `commit()` (`:710`) switches on `intent.kind` and calls the module's
  REST endpoint. Parse and commit are deliberately **separate** (stateless parser, client owns the
  confirm-and-edit UI) — preserve that split.
- **Recipe ingest (the vision template):** `POST /api/recipes/ingest/photo` (`meals.routes.ts:239`)
  takes `{ images: [{ data: base64, contentType }] }`, validates (§4), gates on `visionAvailable`,
  stores source blobs, calls `completeJson({ images })`, returns a **draft** (not saved). Errors are
  already shaped: `IngestInputError` → 400, vision-unavailable → **501 `AIUnavailable`**, model
  failure → 502.
- **Client encoders (reuse verbatim):** `encodeImageForUpload` (`apps/web/src/lib/api/media.ts`) and
  `MediaImage.encodeJPEG` (iOS `Sync/MediaUpload.swift`) already downscale to 2048px, bake EXIF,
  enforce the 10 MB cap + MIME allow-list, and **re-encode HEIC → JPEG** (iPhone photos are HEIC by
  default — this is why we must go through the encoder, not roll our own).
- **Body-limit seam:** `bodyLimit()` in `apps/api/src/platform/http-server.ts:23` raises the JSON
  body cap per-route (base64 images are large). `/api/recipes/ingest/photo` is already listed; a new
  capture-photo route needs the same one-line entry.
- **Retention:** recipe source photos are throwaway — `recipe_ingest_photos` + the hourly TTL sweep
  (`cleanupExpiredIngestPhotos`, default 1 day). Reuse the pattern if capture stores source photos.
- **Default model:** Anthropic **Claude Haiku 4.5** (`config.ts`), which is multimodal, so the
  default household path already supports vision with no config change.

---

## 2. The design decisions (settle these before code)

1. **Photos parse through a dedicated `POST /api/capture/photo` route that shares the core parser.**
   Text stays on `/api/capture`; photo gets its own thin route wrapper over the same
   `parseWithProvider`/`finalizeIntent` (mirroring how recipe ingest splits `/voice` and `/photo`
   over one service). For single-entity photos the existing `INTENT_SCHEMA` needs **no change** — the
   model reads the photo and emits the same `CaptureIntent` it would from text. (See §6-Q2 for why a
   separate route, not folding `images` into `/api/capture`.)
2. **Photos always confirm-and-edit — no fast path, ever.** The brief's universal rule ("the user
   always confirms") is non-negotiable here: OCR/vision is fuzzier than typed text, so a photo intent
   is **never** eligible for any confident auto-commit. Always render the editable preview.
3. **The router lives at parse-time via a small discriminator.** The vision call returns either a
   `CaptureIntent` (or `CaptureIntent[]` in Tier B) **or** a `{ kind: 'recipe' }` handoff signal; the
   client routes a `recipe` signal to the existing importer instead of `commit()`.
4. **Vision-unavailable is a first-class, friendly state.** If `visionAvailable` is false
   (heuristic/text-only household, or an Ollama model without vision), the photo affordance is
   **disabled with a message + deep link to Settings → AI & capture** — mirror the 501 `AIUnavailable`
   copy, never a silent failure. (There is **no on-device heuristic fallback for photos** — unlike
   text, a photo with no vision model simply can't be parsed offline.)
5. **Reuse every client/transport primitive:** `encodeImageForUpload` / `MediaImage.encodeJPEG` for
   encoding, a `bodyLimit()` entry for the new photo route, and the `IngestInputError` validation
   shape. **Source photos are not persisted** (see §6-Q1) — no `recipe_ingest_photos` twin, no TTL
   sweep; the client holds the bytes for the session (retry + recipe handoff).

---

## 3. Sequencing (ship in tiers; each tier is shippable)

**Tier A — single photo → single intent (web).** The v1. Covers invitations, appointment cards, a
single grocery/pantry item, a save-the-date (event + countdown). Recipe handoff included because the
destination already exists. **This is the ~2–3 day slice.**

**Tier B — multi-entity photos.** The high-value, higher-effort slice: a schedule → many events, a
receipt → many pantry/grocery items, a handwritten list → many groceries. Needs a **batch**
confirm-and-edit surface (a list of editable preview cards, each independently
keep/edit/discard/commit). Ship after Tier A.

**Tier C — iOS parity.** Mirror the bar affordance in `CaptureSheet.swift` with `PhotosPicker` /
camera, plus the **camera-permission capability gate** (`Info.plist` usage string + the capability
pattern in `apps/ios/CLAUDE.md`) and an XcodeGen regen. iOS is the heavier client; the recipe
importer (`RecipeImportSheets.swift`) is the exact precedent to copy.

---

## 4. Tier A — the touchpoints (TDD-first)

### 4a. The red-first anchor

Following `capture-tier1-plan.md`'s discipline: **the LLM extraction itself is exercised by
hand/eval, not unit tests** (the vision call is the extraction and can't be asserted
deterministically). What we lock down with failing tests first is everything *around* the model:

- **Input validation** (server, unit/integration): reuse the recipe rules — MIME ∈
  `{jpeg, png, webp}`, ≤ 10 MB/image, ≤ 6 images, non-empty `data`+`contentType` → `IngestInputError`
  → 400. **Write these assertions before the handler.**
- **Vision gate** (integration): a household on `heuristic` posting a photo gets **501
  `AIUnavailable`** (capture persists nothing regardless, so there's no orphaned-blob concern the
  recipe path has to guard against).
- **`images` threading** (unit): `parseWithProvider` passes `images` through to `completeJson` and
  short-circuits to the vision gate when absent-capability — assert with a stubbed `completeJson`.
- **Router discriminator** (unit): a raw `{ kind: 'recipe' }` from the model normalizes to the
  handoff signal, not a `task` fallthrough; a normal `{ kind: 'event', … }` still finalizes as today.

### 4b. Green — server

- **Route:** a new `POST /api/capture/photo` taking `{ images: IngestPhotoInput[] }`; validate with
  the same helper recipe ingest uses (extract it so both share one validator). Add
  `/api/capture/photo` to `bodyLimit()` (the 84 MB ingest tier) — `/api/capture` stays on the 1 MB
  default. Error semantics mirror `/api/recipes/ingest/photo`: `IngestInputError` → 400, vision-
  unavailable → **501 `AIUnavailable`**, model failure → 502 (no `fallback` field — photos have no
  heuristic path).
- **`parseWithProvider(householdId, text, images?)`:** the shared core both routes call; when
  `images` present, gate on `visionAvailable`, thread `images` into `completeJson`, and bump
  `maxTokens`/`timeoutMs` for the vision path (recipe uses `2000` / `90s`).
- **Prompt:** a short addition to `systemPrompt` — "You may be given a photo. Extract the single most
  actionable item into one intent. If the photo is a **recipe**, return `{ kind: 'recipe' }` and
  nothing else." (Tier A: single item + recipe handoff. Multi-item is Tier B's schema change.)
- **`finalizeIntent`:** add the `recipe` handoff branch (a thin marker intent — non-committable via
  the normal path, like Tier 2's resolve marker); everything else reuses the existing normalize.

### 4c. Green — client (web)

- **Affordance:** a camera/upload button in `CaptureBar.tsx`. Reuse `encodeImageForUpload` for the
  file → `{ data, contentType }` step (handles HEIC, downscale, size); accept
  `image/jpeg,image/png,image/webp` with `capture="environment"` (copy from `RecipeImportModals.tsx`).
- **Parse:** POST the image(s) to `/api/capture/photo`; render a **loading** state (vision is ~1–3s,
  slower than text).
- **Route the result:** a normal intent → the existing editable preview → `commit()`; a `recipe`
  signal → open the existing **PhotoImportModal** pre-seeded with the same photo (hand the bytes over;
  don't re-pick).
- **Gate:** when `GET /api/capture/config` (or a `visionAvailable`-style flag) says no vision, disable
  the photo button with a tooltip + link to Settings → AI & capture.

### 4d. Parity note

**No heuristic mirror for photos** (see §2.4) — so unlike Tier 1, there is no `parse.ts` /
`CaptureHeuristic.swift` change for the photo path itself. The text intents remain untouched.

---

## 5. Use-case priority (what the extraction should nail first)

Grounded in the modules that already exist, so each maps to a real `commit()` target:

| Priority | Photo | → intent(s) | Notes |
|---|---|---|---|
| **P0** | Kids' activity / sports / school schedule | many `event` (often recurring) | The killer use case; **needs Tier B** (multi-entity) to shine. |
| **P0** | Invitation / save-the-date | `event` (+ `countdown`) | Fits Tier A; a save-the-date is a natural two-fer. |
| **P0** | Recipe card / cookbook page | `recipe` handoff | Reuses the shipped importer; Tier A. |
| **P1** | Grocery receipt | many `pantry` (restock) or `grocery` | Pantry is a distinct module — receipts fit it well (incl. expiry). Tier B. |
| **P1** | Handwritten grocery/shopping list | many `grocery` | Tier B batch. |
| **P1** | Appointment card / after-visit summary | `event` | Tier A. |
| **P2** | Menu / takeout flyer | `meal` ("Eating out") | Tier A. |
| **P2** | Fridge chore chart / whiteboard | many `task` | Tier B. |
| **P2** | Near-empty container / product label | `grocery` or `pantry` | Tier A single-item. |

Module/permission gating is inherited from Tier 1's `commit()` gates — a `person`/`reward`/`pantry`
extracted from a photo degrades to the same friendly `unsupported` message when the module is off or
the viewer lacks the capability.

---

## 6. Decisions & open questions

**Q1 — Persist source photos? → DECIDED: no.** Capture stays **ephemeral** — no server-side blob,
no `capture_ingest_photos` twin, no TTL sweep. The client holds the bytes for the session (covers
retry + the recipe handoff). Rationale: privacy (receipts, invitations, medical cards are the
photos here), less to build, and recipe-quality eval is already covered because the recipe **handoff
persists downstream** in the importer. *Revisit only if* the design introduces a photo history or an
undo that must survive navigating away.

**Q2 — One route or two? → DECIDED: two.** A dedicated **`POST /api/capture/photo`** sharing
`parseWithProvider`/`finalizeIntent` internally. Text stays on `/api/capture`. Why not fold in:
(1) `bodyLimit()` is path-keyed, so folding images in would raise the hot text path to the 84 MB
tier and lose its 1 MB protection; (2) `/api/capture` is contractually "never fails → heuristic
fallback", while photo has no heuristic and *must* surface 501/400/502; (3) vision needs a
90 s / 2000-token profile vs. text's fast 512. Separate routes keep all three clean with one shared
core.

**Q3 — Tier B batch schema (still open; design-driven).** Current lean, to be locked once the
batch-review mocks exist: return **`{ items: CaptureIntent[] }`** (object wrapper, not a bare array —
extensible + friendlier to the strict structured-output transforms); **no model-emitted per-item
confidence in v1** — derive "needs review" client-side from missing/ambiguous fields; **allow mixed
kinds** (a newsletter → 2 events + 1 task falls out naturally); **cap the item count (~15–20) and
surface truncation** rather than silently dropping. The batch-review UI decides what metadata is
actually worth asking the model for, so hold the final schema until then.

---

## 7. What the designs need to cover (for the design pass)

1. **The photo affordance** in the bar — camera vs. upload, where it sits relative to text/voice.
2. **Parse-loading state** — vision is slower than text; needs a visible "reading your photo…" beat.
3. **Single-intent preview** — same editable card as text today, but always shown (no auto-commit),
   with the source-photo thumbnail visible for cross-checking.
4. **Recipe handoff transition** — the moment "this is a recipe" is detected and the importer opens;
   should feel continuous, not like a restart.
5. **Batch review (Tier B)** — a scannable list of editable cards, each keep/edit/discard, with a
   single "add all N" and per-card commit. This is the biggest new surface.
6. **Vision-unavailable state** — the disabled affordance + the path to enabling a vision provider.
7. **Error states** — unreadable photo, wrong type/too big (HEIC is auto-converted, so this is rare),
   model timeout.

---

## 8. Tier A PR checklist (copy-paste)

- [ ] **RED:** input-validation + vision-gate + `images`-threading + `recipe`-discriminator tests
- [ ] Server: new `POST /api/capture/photo` route (`{ images }`); shared validator (extract from recipe ingest)
- [ ] Server: `bodyLimit()` entry for `/api/capture/photo` (84 MB tier); `/api/capture` stays 1 MB
- [ ] Server: `parseWithProvider` threads `images` → `completeJson`; gates `visionAvailable`
- [ ] Server: prompt addition (single item + `recipe` handoff); `finalizeIntent` `recipe` branch
- [ ] Client: photo button in `CaptureBar.tsx` reusing `encodeImageForUpload`
- [ ] Client: parse-loading state + always-shown editable preview
- [ ] Client: `recipe` signal → open existing PhotoImportModal with the same bytes
- [ ] Client: disabled-with-link state when vision unavailable
- [ ] `npm test` (api) green; `npm run build` (web) clean
- [ ] CHANGELOG `[Unreleased]` → Added; `features/capture.md` updated (photo input + the vision-provider requirement)
