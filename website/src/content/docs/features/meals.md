---
title: Meals & recipes
description: A recipe library plus weekly and monthly meal planning that auto-builds the grocery list and drives a guided, step-by-step cook.
---

Meals is your recipe library and your planner in one — pick what's for dinner on a weekly or monthly grid, and Waffled turns the plan into an aisle-sorted grocery list and a hands-free, step-by-step cook. It answers "what's for dinner" and then carries you all the way from the plan to the pan. 🍽️

## Highlights

- 🗓️ **Weekly and Month planners** — a grid with a recipe picker; drag-to-swap meals on either grid.
- 📖 **Full-screen recipe detail** — hero image, metadata chips, a servings scaler, and total time (prep + cook) computed for you.
- 🔎 **Recipes library** — search across everything, multi-select filters, and sort; a **🆕 New** tag + filter surfaces recipes you've never cooked (cooked count is zero).
- ✏️ **In-app recipe editor** — metadata, ingredients, and steps, with per-step ingredient amounts and ingredient **sections** you can drag items between (delete is web-only).
- 📋 **Paste-markdown import** — drop in a markdown recipe, and Waffled parses it to fill the editor before you save.
- 🔀 **Per-recipe overrides** — ingredient substitutions that feed the grocery build, plus per-step and whole-recipe notes.
- 👨‍🍳 **Cook mode** — step-by-step with the screen kept awake, a recipe overview to jump between steps and ingredients, and **finish → mark cooked**.
- ⏲️ **Per-step timers** — set them in the editor; in cook mode they ride along in a floating dock with a looping alarm (and a local-notification fallback). Need one on a timer-less step? Spin up an on-the-spot timer with wheel pickers — it's ephemeral.
- 🧺 **Auto-built groceries** — the week's dinners become a shopping list that honors your substitutions (see [Lists & groceries](/features/lists/)).
- ✨ **AI "Plan my week/month"** — draws only from your library, works to a theme, and fills the gaps; **"Try New Recipe"** (a "Try something new" toggle plus "Dishes to try" chips) nudges the plan toward novelty, and AI metadata auto-fill guesses cuisine, protein, vegetables, and tags.
- 🍳 **Meal types & placeholders** — breakfast / lunch / dinner / snack (default dinner), plus placeholder entries; the month planner drafts a rotation pool spread across nights, filling only the empty slots.

## Where it works

| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ✅ |
| iPad | ✅ |

Recipe delete and paste-markdown import are web-forward; mobile edits most fields and cooks fine. On **iPad**, tapping a meal from the Today view opens the recipe full-screen.

## Settings

**Settings → Meals** holds the meal-calendar toggle (`addToCalendar`), push-to-Google (`pushToGoogle`), and your per-meal-type default times — breakfast 08:00, lunch 12:00, dinner 18:00, snack 15:00.

## Module

Meals is an **optional module** (`meals`, default **on**), toggled in **Settings → Modules**. Turn it off and the planner, library, and cook mode disappear together.

## Notes

- 🌉 **Meals ↔ calendar bridge** — a planned entry can get a companion calendar event (`origin='meal_plan'`) so meals show up on the [Calendar](/features/calendar/) and can optionally push to Google.
- 🧺 **Groceries flow through [Lists & groceries](/features/lists/)** — the auto-build reads the week's dinners and applies your recipe substitutions.
- ✏️ **Some edits are web-forward** — recipe delete and paste-import parsing live on the web; mobile still edits most fields.
- 🚧 **Conversational recipe AI is planned** — "make it gluten-free" tweaks and photo → recipe capture aren't shipped yet.
