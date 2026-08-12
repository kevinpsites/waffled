---
title: Meals & recipes
description: A recipe library plus weekly and monthly meal planning that auto-builds the grocery list and drives a guided, step-by-step cook.
---

![The weekly meal planner — breakfast, lunch and dinner slots across the week filled with recipes](/screenshots/meals.png)

Meals is your recipe library and your planner in one — pick what's for dinner on a weekly or monthly grid, and Waffled turns the plan into an aisle-sorted grocery list and a hands-free, step-by-step cook. It answers "what's for dinner" and then carries you all the way from the plan to the pan. 🍽️

## Highlights

- 🗓️ **Weekly and Month planners** — a grid with a recipe picker; drag-to-swap meals on either grid.
- 📖 **Full-screen recipe detail** — hero image, metadata chips, a servings scaler, and total time (prep + cook) computed for you.
- 🔎 **Recipes library** — search across everything, multi-select filters, and sort; a **🆕 New** tag + filter surfaces recipes you've never cooked (cooked count is zero).
- ✏️ **In-app recipe editor** — metadata, ingredients, and steps, with per-step ingredient amounts and ingredient **sections** you can drag items between. Set a photo by URL or upload, and **remove it** with the trash button next to the photo (delete-recipe is web-only).
- 🛒 **Add to grocery, your way** — "Add to grocery" opens a picker so you can add all of a recipe's ingredients or just the ones you're missing. Everything starts checked; pantry staples are marked "likely on hand" so you can uncheck what's already in the cupboard. See [Lists & groceries](/features/lists/).
- 📋 **Paste-markdown import** — drop in a markdown recipe, and Waffled parses it to fill the editor before you save.
- 🔀 **Per-recipe overrides** — ingredient substitutions that feed the grocery build, plus per-step and whole-recipe notes.
- 👨‍🍳 **Cook mode** — step-by-step with the screen kept awake, a recipe overview to jump between steps and ingredients, and **finish → mark cooked**.
- ⏲️ **Per-step timers** — set them in the editor; in cook mode they ride along in a floating dock with a looping alarm (and a local-notification fallback). Need one on a timer-less step? Spin up an on-the-spot timer with wheel pickers — it's ephemeral.
- 🧺 **Auto-built groceries** — the week's dinners become a shopping list that honors your substitutions (see [Lists & groceries](/features/lists/)).
- ✨ **AI "Plan my week/month"** — draws only from your library, works to a theme, and fills the gaps; **"Try New Recipe"** (a "Try something new" toggle plus "Dishes to try" chips) nudges the plan toward novelty, and AI metadata auto-fill guesses cuisine, protein, vegetables, and tags.
- 🍽️ **Meal Builder** — build one meal out of several recipes (a "plate"), then schedule it or shop for it. See [Building a meal](#building-a-meal).
- 🍳 **Meal types & placeholders** — breakfast / lunch / dinner / snack (default dinner), plus placeholder entries; the month planner drafts a rotation pool spread across nights, filling only the empty slots.

## Where it works

| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ✅ |
| iPad | ✅ |

Recipe delete and paste-markdown import are web-forward; mobile edits most fields and cooks fine. On **iPad**, tapping tonight's dinner from the Today view opens it full-screen — the recipe, or the whole meal when a plate is planned.

## Building a meal

Most dinners aren't one dish. **Meal Builder** puts a whole meal together — a main, a
couple of sides, maybe a dessert — and treats it as one thing you can plan, shop for and
cook.

Start one from **Recipes → ＋ New meal**, or from any recipe's **Build a meal around
this** (which seeds the plate with that recipe). Then:

- **Add dishes** — on web, drag a recipe from the library panel onto Main, Sides or
  Dessert; everywhere, tap **＋ Add a main / side / dessert** on a slot and pick one.
  Once a dish is on the plate you can **drag it between roles** — on iPhone and iPad,
  press and hold it and drop it under another heading (an empty role shows a
  "Drag a dish here" slot to aim at, once there's something to drag). The library's
  Sides / Mains / Desserts tabs sort recipes by their `mealType` and `category`
  (salads, sides, appetizers, breads and soups read as sides; anything untagged reads as
  a main), and tapping a slot's ＋ names a *destination*, not a filter — a main makes a
  perfectly good side.
- **Serves** — meal-level, so scaling the meal scales every dish with it.
- **Who cooks** — per dish, so a four-dish meal can have four cooks. Leave it as
  "whoever" and nobody is named.
- **Keep in library** — a toggle, applied the moment you flip it. On, the meal is
  reusable: it shows up in the recipe library and the planner's picker. Off, it stays
  exactly where it already is — nothing is deleted, and a scheduled meal stays scheduled.

### Scheduling it, or just shopping for it

Two different things, and you can do either or both:

- **Schedule meal** puts it on a day and slot. It fills that slot in the planner, goes on
  the calendar as one event, and its ingredients come into that week's grocery list with
  the weekly rebuild.
- **Add plate to list** only does the shopping. Nothing is scheduled and nothing appears
  on the calendar — the ingredients simply land on the list, marked as an off-plan add so
  the weekly rebuild never wipes them. Changed your mind? Take it back off with the ×
  next to the meal in the grocery week rail, or **Remove** in its By-meal section.
  Anything the week's actual plan still needs stays on the list.

In the grocery list's **By meal** view a meal's items group under its name, badged
**Unscheduled** when it isn't on a night, with a dot on each row in the meal's colour. An
ingredient two meals both want is still one row with one checkbox — it lists under
whichever meal claimed it first, and the other says where it went.

### Cooking it

**👨‍🍳 Cook meal** opens cook mode for the whole plate: tabs across every dish, with one
shared timer dock. A timer you start on the rice keeps running while you read the chicken
steps, and each dish remembers its own place, so moving between them never loses where
you were. Timers are named for their dish, so the dock — and the alarm on your lock
screen — tells you which pan is beeping.

Tapping a timer takes you to that dish and that step. On iPhone and iPad it also leaves a
**"Back to step 6 · Roast Chicken"** pill under the tabs, which puts you back exactly
where the timer pulled you from. It stays until you use it or dismiss it with its ×,
because a timer going off is precisely when you get distracted — and it covers the case
no tab can, where the timer belongs to the dish you were already reading.

Start it from the meal itself, or from tonight's card on the Today screen.

### What's left to buy

Every dish shows how many of its ingredients you still need, and tapping that count opens
the actual names — same on the recipe screen. With the [Pantry](/features/pantry/) module
on, those are specifically the ingredients your pantry doesn't already cover; with it off,
it's everything non-staple.

## Recipe markdown & timers

Paste-markdown import (**Use template** / **See example** in the editor) reads a plain-markdown recipe. Two step-level extras are worth knowing:

- **Per-step ingredients** — an `**Ingredients:**` sub-line under a step lists just what that step needs.
- **Per-step timers** — a `**Timer:**` sub-line (mirrors `**Ingredients:**`) declares the cook-mode timer for that step. The duration is written in plain language and parsed into seconds; the `**Timer:**` markup is stripped from the displayed step.

```markdown
1. Bread the chicken.
   **Ingredients:**
   - 2 eggs
   - 1 cup breadcrumbs

2. Pan-fry until golden, about 4 minutes a side.
   **Timer:** 4 minutes
```

Durations accept minutes / hours / seconds and compound or short forms — `20 minutes`, `1 hour 30 min`, `1.5 hrs`, `90s`. You can also drop a timer **inline** anywhere in the step text as `{timer: 20 minutes}` (equivalent, also stripped). Parsed timers become the per-step timer in [cook mode](#highlights), and the in-editor **Use template** / **See example** both include a `**Timer:**` line to copy. This works the same on web and iOS (iOS uses the same server-side parser).

## Settings

**Settings → Meals** holds the meal-calendar toggle (`addToCalendar`), push-to-Google (`pushToGoogle`), and your per-meal-type default times — breakfast 08:00, lunch 12:00, dinner 18:00, snack 15:00.

It also has an optional **thaw reminder** (`prepReminder`, off by default): a same-day calendar nudge — at a time you choose (default 08:00), for the meal slots you pick (dinner out of the box) — to pull the protein/ingredients out of the freezer for that day's planned meal. When meal-calendar push-to-Google is on, the reminder syncs to Google too.

## Module

Meals is an **optional module** (`meals`, default **on**), toggled in **Settings → Modules**. Turn it off and the planner, library, and cook mode disappear together.

## Notes

- 🌉 **Meals ↔ calendar bridge** — a planned entry can get a companion calendar event (`origin='meal_plan'`) so meals show up on the [Calendar](/features/calendar/) and can optionally push to Google.
- 🧺 **Groceries flow through [Lists & groceries](/features/lists/)** — the auto-build reads the week's dinners and applies your recipe substitutions.
- ✏️ **Some edits are web-forward** — recipe delete and paste-import parsing live on the web; mobile still edits most fields.
- 🚧 **Conversational recipe AI is planned** — "make it gluten-free" tweaks and photo → recipe capture aren't shipped yet.
