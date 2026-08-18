---
title: Pantry
description: On-hand inventory of what's in the fridge, freezer, and pantry — with barcode lookup, allergen warnings, and tight meal-planning integration.
---

![The pantry — items grouped by location with expiry and low-stock badges and an allergen legend](/screenshots/pantry.png)

Pantry tracks what's actually on your shelves — quantities and locations, barcode-scanned nutrition and allergen data, and a direct line into meal planning. It cuts waste and answers the two everyday questions: "can I cook this right now?" and "do I need to buy it?" 🥫

## Highlights

- 📦 **Items with quantities + locations** — default Freezer / Fridge / Pantry (a household-customizable list with per-location emoji icons); a quantity stepper plus tap-to-type, and stepping below one marks an item **used up**.
- 🗂️ **Redesigned list** — a location sidebar with counts, search, sort (Expiring / A–Z / Recent / Oldest), a card grid, and an item detail sheet; a Today card surfaces use-soon and running-low items.
- 🔦 **Open Food Facts integration** — barcode lookup (cached), nutrition and allergen snapshots, "may contain" traces, dietary flags (Vegan / Vegetarian / Palm-oil-free), and replace-photo.
- ⚠️ **Allergen warnings** — household avoid-list ∪ per-person allergens become colored letter badges with a persistent key, a red ring on avoided items, and a "⚠ Affects {people}" note.
- 📉 **Running-low threshold** — a household default with a per-item override drives a **Low** badge.
- ⏳ **Item age** — an added/bought date distinct from expiry powers a "Been a while" group, an "Oldest" sort, and an age chip.
- 📷 **Barcode camera scanner** — iOS uses native AVFoundation (EAN / UPC / Code128, with a "Type instead" fallback); the web uses zxing and needs a secure context (see [Reverse proxy & TLS](/install/reverse-proxy/)).
- 🍳 **Cook from your pantry** — recipes makeable now, on-hand proteins as "mains", leftovers, a Plan-my-week seeded with soon-to-expire items, and a per-item "Plan it in".
- 🔻 **Cook → decrement** — marking a recipe cooked opens a "Used from your pantry" confirm sheet (Used some / Used it up / Didn't use; staples skipped) that draws down your stock.
- 🛒 **"You already have this" on the grocery list** — pantry matches show up as a 🥫 badge on the grocery board, and the recipe "Add to grocery" picker starts them unchecked. Matched rows are flagged, never removed — see [Pantry-aware shopping](/features/lists/#pantry-aware-shopping).

## Where it works

| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ✅ |
| iPad | ✅ |

Some polish — the per-item running-low override and drag-between-locations — is web-only; on mobile you change an item's location through its editor.

## Settings

**Settings → Pantry** (`households.settings.pantry`) holds your **Locations** list (add / rename / remove / reorder) with per-location icons, `lowThreshold` (default 1), `staleMonths` — the "old" threshold (default 6, range 1–60) — `avoidAllergens`, and `showOnToday`.

## Module

Pantry is an **optional module** (`pantry`, default **off** — opt-in), toggled in **Settings → Modules**. The **Cook-from-pantry** surface additionally requires [Meals & recipes](/features/meals/) to be on.

## Notes

- 🔒 **Web barcode scanning needs HTTPS** — zxing requires a secure context, so set up [Reverse proxy & TLS](/install/reverse-proxy/) before scanning on the web. iOS has no such constraint.
- 🖥️ **Per-item running-low override is web-only** — mobile uses the household default and edits location through the item editor.
- 🧺 **Canned & jarred groceries file here** — items in those forms route to Pantry from the grocery board (see [Lists & groceries](/features/lists/)).
- 🔤 **Two different "pantries"** — your **items** (this screen: real quantities, locations, expiry) and **pantry staples** (a name list under the grocery board's "Pantry check" of things assumed always in the house). Staples are what keep salt and oil off the auto-built list; your items are what drive the badges and the on-hand counts. Adding rice to your items doesn't make it a staple, and vice versa.
- 📏 **Matching ignores quantities and plurals** — names are matched on significant words, so "ground beef" finds "beef, ground" and "chicken" finds "chicken breast", but "tomato" does **not** match "tomatoes". Amounts are never compared, which is why on-hand claims tell you what you have rather than whether it's enough.
- ⚠️ **Allergen notes are ignored when matching** — meal-kit recipes often name an ingredient "Cream cheese — contains milk". Those trailing words describe what's *in* the item, not what it *is*, so they're stripped before matching: a carton of milk no longer counts as cream cheese. This applies everywhere matching happens — the grocery badge, the recipe on-hand count, and Cook from your pantry.
- 🥜 **A general name can still find a specific item** — a row reading *butter* matches a jar of *peanut butter*, because "butter" really is one of its words. When several items match, the closest one wins (an item actually called "Butter" beats "Peanut butter"), and the badge always names what it found — so a mismatch is visible at a glance rather than silent.
- 🛒 **Grocery badges are web-only for now** — the on-hand counts on recipes work everywhere; the grocery-board badge and picker pre-uncheck are web/kiosk only.
