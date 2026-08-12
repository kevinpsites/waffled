---
title: Lists & groceries
description: Shared custom lists plus the auto-built grocery board that turns the week's dinners into an aisle-sorted shopping list.
---

![A shared list in Waffled, synced across the kiosk and every phone](/screenshots/lists.png)

Lists is where "things to buy or do" live — shared custom lists you build by hand, plus a grocery board that assembles itself from the week's dinners and sorts by aisle so a shopping run is one clean sweep. It consolidates the scattered notes-app lists and takes manual grocery entry off your plate. 🧺

## Highlights

- 📝 **Custom multi-lists** — sectioned items with quantities and assignees; create, rename, and delete (deletes cascade), each with its own emoji.
- 🗂️ **List templates** — save any list as a template (items stored unchecked, hidden from the rail); apply it to spin up a fresh custom list, long-press to delete. A template is just a lists row — there's no separate table.
- 🛒 **Auto-built grocery board** — the week's dinners become a shopping list with aisle grouping and quantity merge; flip between **By aisle**, **By store**, and **By meal**.
- 🏷️ **Shared aisle classification** — a regex table sorts items into Produce, Dairy & Chilled, Meat & Seafood, Bakery, Frozen, Pantry, or Other; canned and jarred forms file to [Pantry](/features/pantry/).
- 🏬 **Assign a store** — tag an item with where you'll buy it (Costco, Walmart, …) from its editor and group the board **By store**. The store box is a quick-select over the stores you've used before, so the same shop doesn't split into "Costco" and "costco".
- 🧂 **Staples stay off the auto-built list** — when your grocery list is built from the week's meal plan, staple detection keeps the salt-and-pepper basics out of your run. Adding a recipe from its own page is different: that picker starts with everything ticked (staples flagged "likely on hand") so you decide what to drop.
- 🎯 **Re-aisle an item** — section chips in its editor move it, and an **Auto** chip clears the override.
- ✅ **Check off / add / delete** — everything persists, with attribution ("added by {name}" or "🍽 from meal plan"), and the grocery build honors recipe substitutions.
- 🔄 **Stays fresh across devices** — a list you're looking at refreshes on its own (when you return to the app, and every ~20 s while it's open) so a family member's check on another phone shows up without a manual reload.
- 📤 **Share list** — hand any list to any phone: an aisle-grouped text list (quantities included) via share sheet, clipboard, or a QR code a phone camera grabs — no app, no account. See [Taking a list with you](#taking-a-list-with-you).
- 🔄 **Live cross-surface refresh** — Today, Lists, and Rewards stay in sync through the in-app refresh bus.

## Taking a list with you

Every list can be handed to the phone of whoever is actually going: the grocery board has a
**📤 Share list** button in its top bar, and a custom list offers **Share list** in its **⋯**
menu, beside Rename and Delete. It turns the unchecked
items into a clean plain-text list with quantities, grouped by aisle on the grocery board and by
section on a custom list:

```
PRODUCE
- Asparagus (2 bunch)

DAIRY & CHILLED
- Milk (1 gal) [Costco]
- Yoghurt (4) [Costco · Kelly]
```

Items carry the two things the plain name doesn't: the **store**, if you've assigned one, and
**who it's for**, if it's assigned to someone. Both only appear when they're set, so an ordinary
list stays clean.

Send it through your phone's share sheet, copy it to the clipboard, or point a phone camera at
the **QR code** — the QR encodes the text itself, so the list lands on any phone with no app,
no account, and nothing to configure. Checked-off items are left out, and items with no aisle
are filed under **OTHER**. A list with no sections at all comes out as a plain list with no
headers, and the button only appears while something on the list is still unchecked.

**Very long lists show no QR.** A QR code holds a fixed amount of data, so the more items on the
list, the smaller each square in the code becomes — past roughly 30–35 items they get too small
for a phone camera to read. Rather than show a code that can't be scanned, Waffled says the list
is too long and points you at **Copy** or **Share**, which work at any length.

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
