---
title: Today dashboard
description: The at-a-glance home screen — agenda, tonight's meal, this week, chores, and grocery.
---

![The Waffled Today dashboard — the day’s events, family chores, tonight’s dinner, pantry and countdowns at a glance](/screenshots/today.png)

Today is the home screen — the at-a-glance view your family lands on: what's on the
[calendar](/features/calendar/), what's for dinner, how the week looks, whose chores
are left, and what's on the grocery list. Like Calendar, it is **never gated** — it's
always there, whatever modules you've turned on.

## Highlights
- **The cards** — agenda · tonight's meal · this week · chores rings · grocery, plus
  **module cards** ([Pantry](/administration/modules/), Family Night,
  [Countdowns](/features/countdowns/)) that appear only when their module is on.
- 🎛️ **Customize mode** (web / iPhone):
  - **drag** to reorder or hide cards
  - save the layout **"for me"** (per-user) or **"for everyone"** (family default)
  - iPhone keeps a separate mobile `{order, hidden}` config
- 📐 **iPad layout presets** — Balanced / Agenda / Meals / **Goal-focused**; the iPad
  layout is **device-local**.
- ✅ **"Did these happen?"** — the goal recap queue surfaces here.
- 👀 **"Needs your OK"** — the approvals banner surfaces here too.

## Where it works
| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ✅ |
| iPad | ✅ |

iPad shows a distinct **3-column dashboard**, and its customization is
**preset-based** rather than drag-to-reorder — the fixed shape suits the wall display.

## Settings
- Layout is configured **in place** — customize mode on the card grid, saved per-user
  or as the family default. There's no separate settings screen for it.
- **Module cards** only appear once their module is enabled in
  [Settings → Modules](/administration/modules/).

## Module
Today itself is **never gated**. Individual **cards** are gated only by their own
module — enable the module and its card shows up; disable it and the card quietly
drops off the dashboard.

## Notes
- The agenda, chores, and grocery cards reflect live data, but only the
  [calendar](/features/calendar/) domain is offline-capable — the other cards need a
  connection to refresh.
