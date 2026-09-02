---
title: Google Calendar
description: Connect two-way Google Calendar sync per person.
---

Waffled has its own calendar, and it **syncs two-way with Google Calendar** — it pulls your
Google events in and pushes the events it authors back out. This is optional and set up per
person, so each family member connects their own Google account.

Prefer Outlook? The same sync works with
[Outlook / Microsoft 365](/administration/outlook-calendar/), and a household can mix both.

## How it works

- **Inbound:** the api polls each connected calendar on an interval (`CALENDAR_SYNC_INTERVAL_MS`,
  default 5 min), using Google's incremental `sync_token` cursor so it only fetches changes.
- **Outbound:** events Waffled authors are pushed to that person's **write-target** calendar
  (their primary or an explicitly chosen writable calendar; read-only calendars are never
  targets). The push moves `pending_push → synced`, or `push_failed` and retries next cycle.
- **Server-side:** sync runs in the api, not on a device — so a phone with no signal still reads
  and queues via [PowerSync](/features/calendar/), and Google reconciliation happens on the
  server.

## One-time: create Google OAuth credentials

Google Calendar sync needs an OAuth client (this is the part that requires a Google Cloud
project):

1. In the [Google Cloud console](https://console.cloud.google.com/), create (or reuse) a project
   and enable the **Google Calendar API**.
2. Configure the **OAuth consent screen**. Add each family member who'll connect as a test user —
   **or publish the consent screen** (strongly recommended, see the warning below).
3. Create an **OAuth client ID** of type *Web application*.
4. Add the **authorized redirect URI**:
   `https://your.host/auth/google/calendar/callback` (or
   `http://localhost:8080/auth/google/calendar/callback` locally). Note this path has **no
   `/api`** prefix.
5. Copy the **Client ID** and **Client secret** into `infra/compose/.env`:

   ```bash
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_CALENDAR_REDIRECT_URI=https://your.host/auth/google/calendar/callback
   ```

   Make sure `TOKEN_ENCRYPTION_KEY` is set too — the stored Google **refresh token is encrypted
   at rest** with it. Then `./waffled up`.

> **⚠️ Publish your consent screen.** While the OAuth app is in **"Testing"**, Google **expires
> refresh tokens after 7 days**, so sync silently breaks about once a week. Moving the consent
> screen out of *Testing* to *Published* (In production) stops this recurring failure. This is
> the single most common Google-sync gotcha.

### After publishing: the "unverified app" screen

Calendar access is a **sensitive scope**, so a published-but-unverified consent screen shows
everyone who connects a *"Google hasn't verified this app"* warning. You can get past it with
**Advanced → Go to … (unsafe)**, and sync works normally afterwards — for a household of people
who know they set this up themselves, that is usually fine, and it's the path most self-hosters
take.

To remove the warning you have to pass Google's **branding verification**, which asks for two
things beyond the app name and logo:

- **A home page you've proven you own.** Add the domain in
  [Search Console](https://search.google.com/search-console) as a **Domain** property (it covers
  all subdomains) and verify it with the TXT record it gives you — signed in as **the same Google
  account that owns the Cloud project**, or the check fails with "not registered to you".
- **A privacy policy with real content**, on the same host as that home page, describing which
  Google data the app reads, what it's used for, how it's stored, and how to revoke access. A
  bare link to a docs site gets rejected as "insufficient content". Waffled's own
  [privacy policy](https://waffled.app/privacy) is a usable model if you need to write one.

Verification is only worth it if people outside your household will connect. Nothing about sync
itself depends on it.

## Connect a person

Once the credentials are set, each person connects in **Settings → Calendars** — on the web
app, or on iPhone/iPad, whichever is to hand:

1. Tap **Connect Google Calendar** and complete the Google consent flow.
2. Choose which of their Google calendars to sync, and which is the **write-target** for events
   Waffled pushes.
3. Use **Sync now** for an immediate pull (otherwise the poll picks it up within ~5 min).

## Disconnecting

**Settings → Calendars → Disconnect** destroys that account's stored access and refresh tokens
and drops its calendars, so nothing further is fetched from Google. Events already pulled in
**stay** on the family calendar as ordinary Waffled entries — disconnecting is not a way to
un-import them; delete them yourself if that's what you want. To withdraw the grant on Google's
side as well, remove Waffled at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Troubleshooting

- **`invalid_grant` / sync stopped** — the stored refresh token expired or was revoked. Reconnect
  the account in Settings → Calendars. If it keeps happening weekly, your consent screen is still
  in *Testing* (see the warning above).
- **Events not pushing** (`push_failed`) — the person may have no writable target calendar; pick
  one in Settings → Calendars.
- **Redirect errors** — `GOOGLE_CALENDAR_REDIRECT_URI` and the URI registered in Google Cloud
  must match exactly (including `http` vs `https` and the no-`/api` path).

More symptom→fix detail in
[Troubleshooting → Calendar sync](/operations/troubleshooting/#calendar-sync-failing-google-or-outlook).

## What's not backed up

Waffled stores the connection (encrypted tokens) in its database, which **is** in your
[backups](/operations/backup/). Wiping the database loses these tokens irrecoverably — you'd have
to re-consent every account. This is one of the reasons to **never wipe a volume**.
