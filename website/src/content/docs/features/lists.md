---
title: Lists & groceries
description: Shared custom lists plus the auto-built grocery board that turns the week's dinners into an aisle-sorted shopping list.
---

Lists is where "things to buy or do" live — shared custom lists you build by hand, plus a grocery board that assembles itself from the week's dinners and sorts by aisle so a shopping run is one clean sweep. It consolidates the scattered notes-app lists and takes manual grocery entry off your plate. 🧺

## Highlights

- 📝 **Custom multi-lists** — sectioned items with quantities and assignees; create, rename, and delete (deletes cascade), each with its own emoji.
- 🗂️ **List templates** — save any list as a template (items stored unchecked, hidden from the rail); apply it to spin up a fresh custom list, long-press to delete. A template is just a lists row — there's no separate table.
- 🛒 **Auto-built grocery board** — the week's dinners become a shopping list with aisle grouping and quantity merge; flip between **By aisle** and **By meal**.
- 🏷️ **Shared aisle classification** — a regex table sorts items into Produce, Dairy & Chilled, Meat & Seafood, Bakery, Frozen, Pantry, or Other; canned and jarred forms file to [Pantry](/features/pantry/).
- 🧂 **Staples stay off the list** — staple detection keeps the salt-and-pepper basics out of your grocery run.
- 🎯 **Re-aisle an item** — section chips in its editor move it, and an **Auto** chip clears the override.
- ✅ **Check off / add / delete** — everything persists, with attribution ("added by {name}" or "🍽 from meal plan"), and the grocery build honors recipe substitutions.
- 🔄 **Live cross-surface refresh** — Today, Lists, and Rewards stay in sync through the in-app refresh bus.

## Where it works

| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ✅ |
| iPad | ✅ |

Every surface builds, checks, and edits lists; **iPad** uses a master/detail layout with the list rail beside the items.

## Settings

A dedicated Lists settings panel is 🚧 **planned** ("Soon") — it isn't built on any surface yet. For now, list behavior is configured inline (emoji, sections, assignees) on each list.

## Module

Lists is an **optional module** (`lists`, default **on**), toggled in **Settings → Modules**. It's also used by [Pantry](/features/pantry/) and [Meals & recipes](/features/meals/) — the grocery board is the meal planner's output — so turning it off affects those too.

## Notes

- 🧼 **Applying a template is a clean start** — it drops provenance and `source_recipe_ids`, so an applied template is a fresh starting point rather than a copy of the original's history.
- 📡 **REST-only, not offline** — Lists talks to the server directly; it doesn't sync through PowerSync, so it needs a connection.
- 🌉 **Meals feed the board** — planned dinners flow in as "🍽 from meal plan" items with substitutions applied. See [Meals & recipes](/features/meals/).
