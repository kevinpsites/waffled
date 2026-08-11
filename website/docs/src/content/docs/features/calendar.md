---
title: Calendar & events
description: The family's shared schedule — native events plus optional two-way Google or Outlook sync and ICS calendar feeds.
---

![The month calendar — colour-coded family events with a Today rail and countdown badges](/screenshots/calendar.png)

The calendar is the family's shared schedule and the thing the whole hub is
anchored to — every person's events (and their colors) on one grid, so "whose
thing is when" stops being a group text. It's native events out of the box, with
optional **two-way [Google Calendar](/administration/google-calendar/) or
[Outlook / Microsoft 365](/administration/outlook-calendar/) sync** and
**[calendar feed (ICS) subscriptions](#calendar-feeds-ics)** layered on top.
Along with [Today](/features/today/), it is the one feature that is **never
gated off**.

## Highlights
- 📅 **Native events** — create / edit / delete, with **multiple participants per
  event** (stacked avatars, each in the person's color) and a **per-person filter**.
- **Four views** — Month / Week / Day / Agenda:
  - a live red **"now" line** on Week & Day
  - month cells show **event titles** (tap a day for times)
  - agenda **dims past events** so today reads first
- **Full-screen event detail** — location with **Directions**, repeats, notes, and
  an activity timeline.
- 🔁 **Recurring events** — full RRULE support:
  - in-editor creation (Daily / Weekdays / Weekly + days / Monthly / Custom)
  - per-occurrence **edit scope** (this / following / all)
  - end condition (never / until a date / after N)
  - monthly **nth-weekday ordinal** (first…fifth / last)
- 🔗 **Two-way Google sync** — inbound incremental poll (a per-calendar `sync_token`
  cursor) plus outbound push to each person's **write-target** calendar (reader-only
  calendars are never a target). The push lifecycle runs `pending_push → synced` or
  `push_failed` (retried).
- 📶 **Fully offline via PowerSync** — the calendar is the *one* fully-offline domain:
  local reads and **queued writes** that drain on reconnect.
- ✨ **AI "Heads up this week"** digest plus a per-event insight.
- 🎯 **"Counts toward a goal"** tag on an event — feeds goal auto-counting (see
  [Goals](/features/goals/)).

## Where it works
| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ✅ |
| iPad | ✅ |

iPad uses distinct wide grids and lays the event detail out in **two columns**;
everything else is shared and adapts by size.

## Calendar feeds (ICS)

The third calendar source next to [Google](/administration/google-calendar/) and
[Outlook](/administration/outlook-calendar/): **subscribe to any published calendar
link** — a school schedule, a sports team, a work calendar published from Outlook —
and its events appear on the family calendar. Feeds are read-only and need **no
sign-in or OAuth setup**; the URL is the whole credential, which makes them the
plan B when a workplace won't approve calendar OAuth access.

- **Add one in Settings → Calendars → Calendar feeds** (admins): paste an `.ics`
  or `webcal://` URL (webcal links are fetched over HTTPS) and optionally name it.
  The first refresh runs as soon as you add the feed; after that every feed is
  polled **every 15 minutes** (`ICS_SYNC_INTERVAL_MS`, `0` disables), and each
  feed row has an **↻ Sync** button when you don't want to wait for the cycle.
- **Person mapping & privacy** — map a feed to a person to color its events, and
  tick the row's **Private** checkbox to keep its events visible only to that
  person (the same family/personal visibility model as synced calendars).
- **Feed events are read-only.** A feed is a mirror of someone else's calendar and
  there's no way to write back to it, so Waffled won't let you edit or delete an
  imported event — the Edit and Delete actions are hidden and the API refuses the
  change. (Allowing it would be a lie: the next refresh restamps the event from the
  feed.) Change it at the source, or remove the feed. You *can* still set a local
  **reminder** on a feed event.
- **Recurring events** expand like any native series. One known limitation: a
  single moved/edited occurrence in the feed (an ICS `RECURRENCE-ID` exception)
  isn't applied — the base series renders as published.
- **Events that leave the feed leave the calendar** — they're soft-deleted on the
  next refresh, and come back if the feed publishes them again. Removing a feed
  removes its imported events too.
- Each feed shows its **last-synced time** and any fetch/parse **error** in the
  Calendars panel; one broken feed never blocks the others.

## Settings
- **Settings → Calendars** — connect Google or Outlook, add calendar feeds, set
  each person's **write-target** calendar, and **"sync now"**.
- **Household settings** — week start, timezone, and location (which also feeds
  weather). Provider sync and feed polling run **server-side**, on a schedule.

## Module
None — Calendar is **core** and never gated. See [Modules](/administration/modules/)
for what can be toggled.

## Notes
- Google sync executes **on the server**, not on the device — so a device with no
  network still reads and queues writes through PowerSync, and the server reconciles
  when it next polls.
- The **events** domain is the only one with offline write queueing; every other
  domain (chores, lists, rewards, goals, meals, photos) is REST-backed and needs a
  connection.
