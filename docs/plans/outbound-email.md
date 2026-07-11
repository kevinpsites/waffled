# Implementation plan — Outbound email (SMTP) & weekly digests

Status: **Planned**  ·  Scope: `apps/api`, `apps/web`, `apps/ios` (later), `infra`, docs
Owner branch: `claude/email-sending-inbound-qrk1mq`

## Goal

Let a household admin configure an SMTP server (Gmail App Password being the
headline case, exactly like Immich) and have Waffled send transactional and
scheduled email — the first payload being a **weekly summary / plan digest**
(calendar heads-up + meal plan + grocery list + chores) with reusable HTML
templates.

We deliberately mirror **Immich's model**: SMTP transport config is stored in the
**database** and edited from an **admin Settings UI** (not just env vars), with a
**"Send test email and save"** affordance and an **enabled** toggle.

## Immich parity — field mapping

Immich's Notification Settings form → Waffled equivalents:

| Immich field | Waffled field | Notes |
|---|---|---|
| Enabled (toggle) | `enabled` | Master on/off for all outbound mail |
| Host | `host` | e.g. `smtp.gmail.com` |
| Port | `port` | `587` (STARTTLS) default; `465` = implicit TLS |
| Username | `username` | full Gmail address |
| Password | `password` (encrypted at rest) | Gmail **App Password** (needs 2-Step Verification) |
| Ignore certificate errors | `ignore_cert` | maps to nodemailer `tls.rejectUnauthorized=false` |
| From (`Name <addr>`) | `from_name` + `from_address` | |
| Send test email and save | `POST /api/email/settings/test` | validate + send one, then persist |

## Data model (migration `0081_email_settings.sql`)

A dedicated table keeps the SMTP **secret** out of the frequently-read
`households.settings` JSONB (same isolation rationale as the Google connection
credentials), and gives us a clean home for digest preferences.

```sql
-- Up Migration
create table household_email_settings (
  household_id     uuid primary key references households(id) on delete cascade,
  enabled          boolean     not null default false,
  host             text,
  port             integer     not null default 587,
  secure           boolean     not null default false,   -- implicit TLS (465)
  ignore_cert      boolean     not null default false,
  username         text,
  password_enc     text,                                  -- encryptSecret(app password)
  from_name        text,
  from_address     text,
  -- digest prefs (non-secret; could also live in households.settings.email)
  digest_enabled   boolean     not null default false,
  digest_dow       integer     not null default 1,        -- 1=Mon … 7=Sun (ISO)
  digest_hour      integer     not null default 7,         -- household-local hour
  digest_sections  jsonb       not null default '["calendar","meals","grocery","chores"]',
  updated_at       timestamptz not null default now()
);

-- Append-only send log: idempotency (don't double-send a weekly digest if the
-- container restarts mid-week), audit, and test assertions.
create table email_deliveries (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  kind          text not null,                 -- 'test' | 'weekly_digest'
  to_address    text not null,
  subject       text not null,
  dedupe_key    text,                          -- e.g. 'weekly_digest:2026-W28' (per household)
  status        text not null,                 -- 'sent' | 'failed'
  error         text,
  created_at    timestamptz not null default now()
);
create unique index email_deliveries_dedupe
  on email_deliveries(household_id, dedupe_key) where dedupe_key is not null;
```

> Renumber to the next free `NNNN_` if a parallel branch lands one first (current
> tip is `0080`; note the existing duplicate `0079_*` — do not add to it).

## Config (`platform/config.ts` + `.env.example`)

Transport creds live in the DB per household, so the only **env** additions are
operational defaults / overrides:

```
# Optional global fallback + branding for outbound mail
EMAIL_DEFAULT_FROM_ADDRESS=   # used if a household leaves From blank
EMAIL_PUBLIC_BASE_URL=        # absolute base for links/images in emails (e.g. https://home.example.com)
WEEKLY_DIGEST_INTERVAL_MS=900000   # scheduler tick (15 min); container-only
```

Add an `email` block to `AppConfig` following the `ai`/`google` shape. **No SMTP
secret ever goes in env** — that's the per-household DB row.

Encryption for `password_enc` reuses `platform/crypto.ts`
(`encryptSecret`/`decryptSecret`, `encryptionAvailable()`), i.e. this feature
requires `TOKEN_ENCRYPTION_KEY` to be set — gate saving a password on
`encryptionAvailable()` exactly like the Google grant does.

## Server modules (`apps/api/src/modules/email/…`)

- `platform/email.ts` — thin nodemailer wrapper. `buildTransport(settings)` →
  `nodemailer.createTransport({ host, port, secure, auth, tls:{rejectUnauthorized:!ignore_cert} })`;
  `sendMail(settings, { to, subject, html, text })`. **nodemailer is a new
  dependency** (`apps/api/package.json`). Pure/injectable so unit tests can pass a
  fake transport.
- `modules/email/email-settings.service.ts` — `getEmailSettings(householdId)`
  (decrypts nothing it doesn't need; never returns the plaintext password to
  clients — return `hasPassword: boolean`), `upsertEmailSettings(...)` (encrypts
  password on write; leaves it untouched when the field is omitted so the UI can
  save without re-entering it).
- `modules/email/digest.service.ts` — `buildWeeklyDigest(householdId, weekStart)`:
  compose from existing sources —
  - calendar: `weekHeadsUp(householdId, from, to, viewerPersonId)`
    (`modules/calendar/calendar-ai.ts`)
  - meals: this week's `meal_plan_entries`
  - grocery: `groceryBoard()` / `rebuildGroceryFromWeek()` (`modules/lists`)
  - chores: `todaySummary()` / week rollup (`modules/chores`)
  Returns `{ subject, html, text }`. Honors `digest_sections`.
- `modules/email/templates/` — HTML templates. Start with hand-written,
  inline-styled HTML (email clients need inline CSS); a `layout.ts` shell +
  per-section partials + a plaintext fallback. (MJML/react-email optional later;
  avoid a heavy dep for v1.)
- `modules/email/weekly-digest.service.ts` — the scheduler, modeled **exactly** on
  `chore-proof-cleanup.service.ts`:
  `startWeeklyDigestScheduler()` registers a `weekly-digest` job and `setInterval`s
  a tick. Each tick: for every household with `digest_enabled`, compute
  household-local now via `luxon`; if it's the configured `digest_dow`/`digest_hour`
  and there's no `email_deliveries` row for this ISO week (`weekly_digest:YYYY-Www`),
  build + send to each account email, then record the delivery. `setInterval` is not
  cron, so we gate on local time + the dedupe key rather than trusting tick timing.
  Started in `server.ts` alongside the other schedulers. **Container-only — Lambda
  never runs `server.ts`; on Lambda this would need EventBridge → a route (out of
  scope for v1).**

## API routes (`modules/email/email.routes.ts`, registered in `app.ts`)

All admin-gated via `adminRoute`:

- `GET  /api/email/settings` → current settings **without** the password
  (`{ …, hasPassword, canEncrypt: encryptionAvailable() }`).
- `PUT  /api/email/settings` → upsert transport + digest prefs. Validates port
  range, non-empty host/username when `enabled`, from address shape. Omitting
  `password` preserves the stored one.
- `POST /api/email/settings/test` → build transport from the **submitted** body
  (so admins can test before persisting), send one email to the caller's account
  email, and on success persist. Surface the SMTP error **verbatim** on failure
  (top support issue). Logs an `email_deliveries` row (`kind='test'`).
- `POST /api/email/digest/preview` (optional) → returns the rendered digest HTML
  for the current week without sending (drives a UI preview).

No new public paths — everything is authenticated.

## Web UI (`apps/web`) — match the design system + Immich layout

Add an **Email / Notifications** card under Settings, mirroring Immich's form and
built from the shared vocabulary (see `CLAUDE.md` web section — no raw HTML
controls):

- `.set-card` container; `.toggle` pill for **Enabled** and **Send weekly digest**.
- `.field` / `.field-row` labeled inputs for Host, Port, Username, Password
  (password shows `••••• (saved)` when `hasPassword`, only sent on change),
  From name / From address; `.toggle` for Ignore cert.
- `.sel` pill selects for digest day-of-week and hour, checkboxes/toggles for
  sections.
- Buttons: `btn btn-primary` "Save", `btn btn-ghost` "Send test email" — wire the
  test button to `POST /api/email/settings/test` and surface success/error inline.
- New API client methods in `apps/web/src/lib/api/…` mirroring the settings
  endpoints.

Reference the Google-calendar connection card as the closest existing analog
(stored credential + connect/test + status).

## iOS

Defer. The digest is server-driven; iOS only needs a read-only mirror of the
settings screen later (same endpoints). Note it in the roadmap as follow-up.

## Security & correctness

- Password encrypted at rest (`crypto.ts`); never returned to clients; save-without-
  re-entering supported.
- Gate password save on `encryptionAvailable()`.
- Recipients come from **`accounts.email`** (join `persons → accounts`); persons
  without an account are not emailable.
- Idempotent weekly sends via `email_deliveries` dedupe key.
- Respect `enabled` and `digest_enabled` independently.
- Gmail sending limits (~500/day consumer, 2000 Workspace) — fine for a household;
  note in docs.

## Testing (TDD — failing test first, integration-first)

1. `test/email-settings.integration.test.ts` — `PUT`/`GET` round-trip; password
   never echoed; omitting password preserves it; admin-only (403 for non-admin);
   port validation.
2. `test/email-send.integration.test.ts` — inject a **fake transport** (env-gated
   or DI seam in `platform/email.ts`); assert `sendMail` called with expected
   `to/subject`; `/test` records an `email_deliveries` row; SMTP error surfaces
   verbatim.
3. `test/weekly-digest.integration.test.ts` — seed a household + week of
   events/meals/chores; call the digest builder directly (unit-ish) asserting the
   HTML/text contains the seeded items and honors `digest_sections`; drive one
   scheduler tick at the configured local time and assert exactly one delivery +
   idempotency on a second tick.
4. `test/email.unit.test.ts` — transport option mapping (secure/port/ignore_cert),
   template rendering snapshots, luxon "is it send time?" logic.

Follow repo rules: `npm test` green **and** `tsc`/build clean in `apps/api` (and
`apps/web` build if UI lands in the same PR) before opening the PR.

## Docs & changelog

- `CHANGELOG.md` → `[Unreleased] / Added`: "**Email digests** — configure an SMTP
  server (e.g. Gmail) and get a weekly summary of your calendar, meals, groceries,
  and chores by email."
- Features reference (`website/docs/src/content/docs/reference/features.md`).
- New how-to page: "Sending email with Gmail (SMTP)" — App Password steps,
  the settings form, the test button, sending limits (Starlight frontmatter + voice).
- Roadmap: move the item to Done (or trim to remaining inbound work).

## Phasing

- **P1 (this PR):** migration, config, `platform/email.ts` (nodemailer), settings
  service + routes + encryption, test endpoint, web settings card, tests, docs.
- **P2:** weekly-digest builder + scheduler + templates + preview endpoint, tests.
- **P3:** iOS settings mirror; optional richer templates (MJML/react-email);
  per-person opt-in.

## Open questions

- Digest recipients: every adult account, or admin-selectable? (Default: all adult
  accounts in the household; refine later.)
- One combined digest per household vs. per-recipient personalization (assignee
  filtering)? v1 = one combined digest.
- Do we also send transactional email now (invites, chore reminders), or only the
  digest? v1 wires the transport so invites *can* adopt it, but only ships the digest.
