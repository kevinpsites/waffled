# Implementation plan — Inbound email (email → event / chore / list)

Status: **Planned**  ·  Scope: `apps/api`, `apps/web`, `apps/ios` (later), `infra`, docs
Owner branch: `claude/email-sending-inbound-qrk1mq`

## Goal

Let a user email a **secret per-household address** — from their phone, forwarding
a school flyer, a photo of a permission slip, a quick "add milk to groceries" —
and have Waffled parse it into the right thing: a **calendar event**, a **chore**,
or a **list item** (and later a meal / recipe). Essentially "self-posting" into the
household by email, including **attachments**.

This is the harder feature: the *parsing brain already exists*, but there is **no
mail transport, no server-side commit path, and no non-image attachment handling**
today. Plan below is phased so an MVP is shippable without the full pipeline.

## What already exists (reuse, don't rebuild)

- **`modules/capture/capture.ts`** — `parseWithProvider(householdId, text)` turns
  free text → a structured `CaptureIntent` of kind `event | task | grocery | meal |
  list` with dates/RRULEs/person-matching resolved against household context. **An
  email body drops straight in.**
- **`modules/meals/recipe-ingest.service.ts`** — attachment → structured data via
  `llm.completeJson({ images })` vision + `platform/storage.ts` blob store + TTL
  cleanup. Template for "email photo → structured event/chore".
- **`platform/storage.ts`** — `LocalBlobStore` (`/data/media/<household>/<hex>.<ext>`),
  images only (`jpeg/png/webp`); S3 driver is a stub that throws.
- **Create services** — `events.ts` `createEvent()`, `chores.service.ts`
  `createChore()`, `lists.service.ts` `addItem()` — the commit targets. `events`
  already has an `origin='ai_capture'` enum value.

## The three real gaps

1. **Inbound transport** — nothing receives mail.
2. **Server-side commit** — today the `CaptureIntent → DB row` mapping lives in the
   web/iOS **clients** (`apps/web/src/lib/capture/parse.ts`). Email has no client in
   the loop, so we need a **server-side committer**.
3. **Attachment breadth** — storage accepts images only; no PDF/OCR path.

## Ingress options (pick per deployment)

| Option | How | Effort | Self-hostable? |
|---|---|---|---|
| **Provider webhook** (recommended MVP) | Mailgun Routes / Postmark Inbound / SendGrid Parse / Cloudflare Email Workers POST parsed JSON (from, subject, text, attachments) to our endpoint | Low | No (external SaaS; free tiers cover a household) |
| **IMAP poll** (P2, self-host) | Dedicated mailbox; scheduled job polls via IMAP, parses MIME with `mailparser` | Medium | Yes |
| Full SMTP receiver (haraka/postfix) | Run MX + spam/DKIM | High | Yes, heavy |

Design the **transport as an adapter** so webhook and IMAP feed the same
`ingestInboundEmail({ to, from, subject, text, html, attachments, messageId })`
core. MVP ships the webhook adapter; IMAP is a drop-in P2.

## Addressing & trust (the actual hard part)

From headers are trivially forgeable, so we **cannot** authenticate on `From`
alone. Design:

- **Secret per-household inbound address.** `capture+<token>@inbound.<domain>`,
  where `<token>` is an unguessable, **revocable/rotatable** random id mapped to a
  household. This *is* the primary auth: knowing the address proves membership.
- **Provider signature/HMAC** on the webhook (Mailgun signing key / Postmark basic
  auth / a shared secret) verified before processing. The route is a **new
  `PUBLIC_PATHS` entry** (no JWT), authenticated by that signature — same shape as
  the Google-callback and kiosk-pair routes.
- **SPF/DKIM/DMARC pass** from the provider payload recorded; optionally require it
  for **auto-apply**, allow review-queue for soft-fail.
- **Sender allowlist (optional):** only accept from the account emails in that
  household unless the admin opts into "anyone with the address".
- **Review queue by default** (see below) so a spoofed/mis-parsed message can't
  silently create garbage — mirrors the capture bar's preview→commit model.
- Size/type caps (reuse the 10MB media cap), **dedupe by `Message-ID`**, rate
  limiting per household.

## Data model (migration `0082_inbound_email.sql`)

```sql
-- Up Migration
-- Secret addresses (rotatable). token is the routing key in the +address.
create table household_inbound_addresses (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  token         text not null unique,
  label         text,
  active        boolean not null default true,
  auto_apply    boolean not null default false,   -- commit without review?
  allow_any_sender boolean not null default false,
  created_by    uuid references persons(id),
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz
);

-- Received messages → parsed intent → review/apply lifecycle.
create table inbound_items (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  message_id    text,                              -- for dedupe
  from_address  text,
  subject       text,
  spf_dkim_pass boolean,
  intent        jsonb,                             -- the CaptureIntent
  attachments   jsonb,                             -- [{key, contentType, filename}]
  status        text not null default 'pending',   -- pending|applied|rejected|failed|unsupported
  applied_kind  text,                              -- event|chore|list_item|meal
  applied_ref_id uuid,
  error         text,
  created_at    timestamptz not null default now(),
  applied_at    timestamptz
);
create unique index inbound_items_dedupe
  on inbound_items(household_id, message_id) where message_id is not null;
```

## Server modules (`apps/api/src/modules/inbound/…`)

- `inbound.routes.ts` — `POST /api/inbound/email/:provider` (public, signature-
  verified). Parse provider payload → normalized `InboundEmail` → `ingestInboundEmail`.
- `inbound.service.ts` — `ingestInboundEmail(email)`:
  1. Resolve household from the `+<token>` address (reject unknown/revoked).
  2. Verify sender policy + signature + dedupe on `Message-ID`.
  3. Store attachments via `getBlobStore()` (images now; see gap 3).
  4. Parse: `parseWithProvider(householdId, subject + "\n" + text)`; for image
     attachments, route through the recipe-ingest vision pattern
     (`llm.completeJson({ images })`) to enrich the intent.
  5. Insert an `inbound_items` row (`status='pending'`).
  6. If the address is `auto_apply` (and trust checks pass) → call the committer.
- `commit.service.ts` — **new server-side committer** (the missing piece). Ports the
  client mapping in `apps/web/src/lib/capture/parse.ts` to the server:
  `commitIntent(tenant, intent) → { kind, refId }` dispatching to `createEvent` /
  `createChore` / `addItem` / meal-plan. Set `events.origin='ai_capture'`. This is
  reusable beyond email (a server-side capture endpoint could adopt it too).

## API routes

- `POST /api/inbound/email/:provider` — ingress (public, signature-verified).
- `GET  /api/inbound/items` (tenant) — the review queue.
- `POST /api/inbound/items/:id/apply` (tenant/cap) — commit a pending item; may
  include user edits to the parsed intent.
- `POST /api/inbound/items/:id/reject` (tenant).
- Admin address management (`adminRoute`):
  `GET/POST /api/inbound/addresses`, `POST /api/inbound/addresses/:id/rotate`,
  `POST /api/inbound/addresses/:id/revoke`, toggle `auto_apply`/`allow_any_sender`.

## Web UI (`apps/web`) — match the design system

- **Inbound email card** under Settings: show the secret address with a **copy**
  button, a **rotate** and **revoke** action, `.toggle` pills for "Auto-apply
  without review" and "Allow any sender". Use `.set-card`, `.field`, `btn` classes.
- **Review inbox**: a modal/panel listing `inbound_items` (subject, from, parsed
  preview reusing the capture preview components), with **Apply / Edit / Reject**.
  Clone the existing capture preview UI rather than inventing one.

## iOS

Defer; the secret address + review inbox can mirror later via the same endpoints.
(iOS already has a capture flow to reuse for the preview.)

## Attachments / OCR (gap 3)

- **P1:** images only (jpeg/png/webp) — already supported end-to-end via storage +
  vision. A photo of a flyer works today through the recipe-ingest pattern.
- **P2:** PDFs — add a PDF→image rasterize step or an OCR pass before the LLM; widen
  the storage content-type allowlist. Non-trivial; keep out of MVP.

## Security & correctness checklist

- Unknown/revoked token → 202-and-drop (don't leak which addresses exist) or 404;
  never create anything.
- Provider signature verified before any work; reject on failure.
- `Message-ID` dedupe (providers retry).
- Review queue default; `auto_apply` requires SPF/DKIM pass (+ allowlist unless
  `allow_any_sender`).
- Attachment size/type caps; store under the household prefix only.
- Rate-limit per household; cap items/day.
- Never trust email content as instructions to the *system* — it's data to parse
  into a domain object, nothing more (prompt-injection: the LLM output is
  schema-constrained to a `CaptureIntent`, and commit only ever calls the fixed
  create services).

## Testing (TDD — failing test first, integration-first)

1. `test/inbound-address.integration.test.ts` — create/rotate/revoke addresses;
   admin-only.
2. `test/inbound-ingest.integration.test.ts` — POST a provider payload to a valid
   `+token` address → an `inbound_items` row with a parsed intent; unknown token →
   nothing created; bad signature → 401; duplicate `Message-ID` → deduped.
3. `test/inbound-commit.integration.test.ts` — apply a pending event/chore/grocery
   item → real row created in `events`/`chore_instances`/`list_items` with correct
   fields and `origin='ai_capture'`; reject → status flips, nothing created.
4. `test/inbound-attachment.integration.test.ts` — image attachment stored + fed to
   vision (fake LLM) → enriched intent.
5. `test/commit.unit.test.ts` — intent→create-input mapping parity with the client.

`npm test` green + `tsc`/build clean in every touched app before the PR.

## Docs & changelog

- `CHANGELOG.md` `[Unreleased] / Added` when it ships.
- How-to: "Add things by email" — get your secret address, forwarding tips, the
  review inbox, auto-apply + trust settings, supported attachments.
- Roadmap: add the inbound item (Planned → In progress → Done as it lands).

## Phasing

- **P1 (MVP):** provider-webhook adapter + secret address + signature verify +
  server-side committer + review queue (text + image attachments) + settings/inbox
  UI + tests + docs. Reuses `capture.ts` verbatim.
- **P2:** IMAP self-host adapter; PDF/OCR; auto-apply hardening (DMARC);
  per-sender allowlist UI.
- **P3:** iOS review inbox; meal/recipe intents from email; richer edit-before-apply.

## Dependency on the outbound plan

Inbound reuses nothing from outbound transport, but a good confirmation UX benefits
from outbound email ("we added 3 things from your email — view them"). Sequence
outbound first (it also proves the settings-card + encrypted-secret patterns this
plan leans on).
