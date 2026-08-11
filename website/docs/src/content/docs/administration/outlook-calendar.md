---
title: Outlook / Microsoft 365
description: Connect two-way Outlook / Microsoft 365 calendar sync per person.
---

Waffled's calendar also **syncs two-way with Outlook / Microsoft 365** — the same sync engine
as [Google Calendar](/administration/google-calendar/), pointed at Microsoft Graph. It's
optional and set up per person, a household can mix Google and Microsoft accounts freely, and
connected accounts show a provider badge in Settings → Calendars.

## How it works

- **Inbound:** the api polls each connected calendar on the same interval as Google
  (`CALENDAR_SYNC_INTERVAL_MS`, default 5 min), using Graph's incremental **delta** cursor so
  it only fetches changes; deletions arrive as tombstones and a stale cursor triggers an
  automatic full resync.
- **Outbound:** events Waffled authors are pushed to that person's **write-target** calendar
  (their default calendar or an explicitly chosen editable one; read-only calendars are never
  targets). Same `pending_push → synced` / `push_failed` lifecycle as Google.
- **Refresh tokens rotate.** Unlike Google, Microsoft may issue a *new* refresh token on every
  refresh — Waffled persists the rotated token automatically; there's nothing to manage.
- **Server-side:** sync runs in the api, not on a device — same as
  [Google](/administration/google-calendar/#how-it-works).

## One-time: register an Azure app (free)

Outlook sync needs an app registration in Microsoft Entra ID. The registration itself is free —
no paid Azure services involved:

1. In the [Azure portal](https://portal.azure.com/), open **Microsoft Entra ID → App
   registrations → New registration**.
2. Under **Supported account types**, choose **"Accounts in any organizational directory …
   and personal Microsoft accounts"**. Waffled signs everyone in through Microsoft's *common*
   endpoint, so this is the option that lets **both** personal accounts (`@outlook.com`,
   `@hotmail.com`) and **work/school** accounts connect — a narrower choice rejects one kind
   or the other at sign-in.
3. Add a **Web** platform **redirect URI**:
   `https://your.host/auth/microsoft/calendar/callback` (or
   `http://localhost:8080/auth/microsoft/calendar/callback` locally). Note this path has **no
   `/api` prefix**, and Azure accepts `http://` only for `localhost` — any other host must be
   `https://`.
4. Under **Certificates & secrets**, create a **client secret** and copy its *Value*
   right away (it's shown only once). Client secrets **expire** on the lifetime you pick at
   creation — when one lapses, sync stops until you create a new secret and update the env.
5. Copy the **Application (client) ID** and the secret value into `infra/compose/.env`:

   ```bash
   MS_CLIENT_ID=...
   MS_CLIENT_SECRET=...
   MS_CALENDAR_REDIRECT_URI=https://your.host/auth/microsoft/calendar/callback
   ```

   Make sure `TOKEN_ENCRYPTION_KEY` is set too — the stored Microsoft **refresh token is
   encrypted at rest** with it. Then `./waffled up`.

The default scopes are `openid email offline_access User.Read Calendars.ReadWrite` (identity +
calendar read/write + a refresh token). Override with `MS_CALENDAR_SCOPES` only if you know you
need to — leave it unset otherwise.

## Work & school accounts: admin consent

Personal Microsoft accounts consent for themselves — connect and go. A **work or school
account** belongs to the employer's tenant, and many organizations restrict which apps their
users may consent to. In that case the consent screen shows **"Need admin approval"** instead
of an Accept button, and the employer's IT/OIT must approve the app before that person can
connect.

Pending approval can take time — it's a human process on the employer's side. **[Calendar
feeds (ICS)](/features/calendar/#calendar-feeds-ics) are the no-OAuth plan B**: if the work
calendar can be *published* as an ICS link, Waffled subscribes to it directly — read-only, no
approval needed.

## Connect a person

Once the credentials are set, each person connects in **Settings → Calendars**:

1. Click **Connect Outlook Calendar** and complete the Microsoft sign-in and consent flow.
2. Choose which calendars to sync, and which is the **write-target** for events Waffled pushes.
3. Use **Sync now** for an immediate pull (otherwise the poll picks it up within ~5 min).

## Troubleshooting

Microsoft's sign-in errors carry an `AADSTS` code on the error page:

- **`AADSTS50011` — redirect URI mismatch.** The redirect URI in the request doesn't match one
  registered on the app. `MS_CALENDAR_REDIRECT_URI` and the **Web** redirect URI in the Azure
  registration must match exactly (scheme, host, and the no-`/api` path).
- **`AADSTS65001` / "Need admin approval" — consent required.** The user (or their tenant)
  hasn't consented to the app. For work/school accounts this usually means the org restricts
  user consent — see [admin consent](#work--school-accounts-admin-consent) above, and consider
  an [ICS feed](/features/calendar/#calendar-feeds-ics) while approval is pending.
- **`AADSTS900144` — request missing the `scope` parameter.** On current builds, empty `MS_*`
  lines left in `.env` fall back to the defaults, so this shouldn't appear. If it does, you've
  set `MS_CALENDAR_SCOPES` to a blank or invalid value (or you're running an older build) —
  remove the override and restart.
- **Sync stopped after working** — the stored refresh token is no longer valid (account access
  revoked) or the **client secret expired**. Rotate the secret in Azure and update
  `MS_CLIENT_SECRET` if needed, then reconnect the account in Settings → Calendars.

## What's not backed up

Same story as Google: Waffled stores the connection (encrypted tokens) in its database, which
**is** in your [backups](/operations/backup/). Wiping the database loses these tokens
irrecoverably — you'd have to re-consent every account. This is one of the reasons to **never
wipe a volume**.
