---
title: Countdowns
description: A "N days until X" anticipation layer on top of the calendar to build excitement.
---

Countdowns turn the calendar into an anticipation machine — a tidy **"N days until
X"** list that builds excitement for the trip, the birthday, the last day of school.
It's a core [Calendar](/features/calendar/) feature, **not** a gated module, so
everyone sees it.

## Highlights
- **Three sources, one sorted list:**
  - ⏳ **standalone countdown items** (their own table)
  - 📅 **calendar events** you've flagged `is_countdown`
  - 🎂 each member's **next birthday** (from their profile birthday)
- **Two read-only surfaces:**
  - a **[Today](/features/today/) card** — emoji · title · date · N-days (or
    "sleeps") · remove a standalone item · **+ Add**
  - **month-grid badges** on the calendar
- **In-editor toggle** — the event editor's **"⏳ Show a countdown"** switch rides
  the full offline `is_countdown` path (PowerSync schema + local/REST writes).
- 🎂 **Birthdays roll forward** — once a birthday passes it re-targets next year,
  and a **birthday horizon** (`settings.countdowns.birthdayHorizonDays`, default
  **183 days**) hides birthdays that are still too far out to be exciting.

## Where it works
| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ✅ |
| iPad | ✅ |

The Today card and month-grid badges render on every surface; there are no notable
per-surface differences.

## Settings
- **Settings → Calendars** — the household **"N sleeps"** toggle (renders "N sleeps"
  instead of "N days"), and the **birthday horizon** household setting.

## Module
None — Countdowns is part of **core** Calendar and is never gated.

## Notes
- The list is **read-only** apart from adding/removing standalone items and flipping
  the per-event "⏳ Show a countdown" toggle — you don't edit events or birthdays from
  here.
