---
title: Family Night
description: A recurring family gathering with a small, customizable agenda whose roles auto-rotate fairly among members.
---

Family Night is a lightweight weekly ritual — a recurring gathering (Monday by default) with a short, customizable agenda of "parts" that auto-rotate among your family so nobody's stuck doing the same job every week. Pick who runs the activity, who brings the treat, and let the rotation keep it fair. 🎲

## Highlights

- 📋 **Customizable agenda parts** — start with **🎲 Activity · 🍪 Treat · 💬 Check-in**, add your own, and mark each part as **rotating** or fixed.
- 🔁 **Fair auto-rotation** — rotating parts cycle through members automatically, and you can **override any week** if plans change.
- 🏠 **Today card** — the next gathering's date plus a per-part person-picker to reassign this week's rotation on the spot.
- 🛠️ **Admin agenda editor** — set the weekday · time and do full CRUD on the agenda parts.
- 📅 **Optional calendar event** — flip "show on the calendar" to schedule (or unschedule) a weekly event; it auto-routes to the owner's ★ default write-target — landing in **Google** when connected. See [Calendar](/features/calendar/).

## Where it works

| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ✅ |
| iPad | ✅ |

Family Night is **entirely REST**, so every surface behaves the same — the Today card, the person-pickers, and the agenda editor all work identically on Web/Kiosk, iPhone, and iPad.

## Settings

**Settings → Family Night** (`households.settings.familyNight`):

- **`dayOfWeek`** — which day the gathering lands (default **1 = Monday**).
- **`time`** — default **19:00**, and **only meaningful when a calendar event is linked**.
- **`parts`** — your agenda, each with a rotating flag.
- **Linked calendar event** — `null` when it's not on the calendar; set when you schedule it.
- **`showOnToday`** — surface the Today card (default **true**).

## Module

Family Night is an **optional module** (`familyNight`, default **OFF** — opt-in), toggled in **Settings → Modules**. Enable it to see the Today card and the settings editor.

## Notes

- ⏰ **Time only matters on the calendar** — until you put the gathering on the calendar, the `time` field does nothing; the ritual is otherwise date-only.
- 🚧 **Phase 2 is not yet shipped** — history, recipe/goal links, and an idea bank are planned but not here yet.
