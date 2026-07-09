---
title: Calendar & events
description: The family's shared schedule — native events plus optional two-way Google Calendar sync.
---

![The month calendar — colour-coded family events with a Today rail and countdown badges](/screenshots/calendar.png)

The calendar is the family's shared schedule and the thing the whole hub is
anchored to — every person's events (and their colors) on one grid, so "whose
thing is when" stops being a group text. It's native events out of the box, with
optional **two-way [Google Calendar](/administration/google-calendar/) sync**
layered on top. Along with [Today](/features/today/), it is the one feature that
is **never gated off**.

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

## Settings
- **Settings → Calendars** — connect Google, set each person's **write-target**
  calendar, and **"sync now"**.
- **Household settings** — week start, timezone, and location (which also feeds
  weather). Google sync runs **server-side**, on a schedule.

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
