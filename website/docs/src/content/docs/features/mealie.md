---
title: Mealie
description: Connect a Mealie server so meals, recipes and the grocery list come from Mealie instead of Waffled's built-ins.
---

If your family already plans meals and shops in [Mealie](https://mealie.io), Waffled can use it
as the source. Connected, Today, Meals, Lists, the Calendar and the capture bar all read and
write **Mealie's** meal plan, recipes and shopping list. Waffled's own recipes, meal plans and
grocery data are left untouched and come back when you disconnect. 🍳

Mealie **2.0 or newer** is required.

## Connect

Only admins can connect. In Mealie, open your profile → **API Tokens** and create a token. Then in
Waffled open **Settings → Mealie** and fill in:

- **Base URL** — where the Waffled server reaches Mealie.
- **Public URL** (optional) — the address you open Mealie at in a browser, if different. It is
  used for the **Open in Mealie** links.
- **API token** — pasted once, stored encrypted, and never shown again.

**Docker tip:** if Mealie runs on the same Docker network as Waffled, the base URL can be the
internal one (for example `http://mealie:9000`) while the public URL is the one you browse to.

## Choose the shopping list

After a successful connect, pick which Mealie shopping list Waffled should use. Non-admins see a
read-only **Connected to Mealie** line in Settings.

## What changes while connected

- **Today** — the Tonight, This week and Grocery cards read Mealie.
- **Meals** — **This week** shows the Mealie plan (previous/next week, remove an entry) and
  **Recipes** has search and Load more. A recipe opens in a cook view with **Plan this** and
  **Open in Mealie**. **Plan a meal** takes a recipe or a typed title, a day in the next 14, and
  breakfast, lunch, dinner or side, and saves it to Mealie.
- **Lists → Grocery** — shows the chosen Mealie shopping list, grouped by Mealie labels. Tap to
  check or uncheck, and add items. Your custom lists are unchanged.
- **Calendar** — Mealie meals appear as all-day chips (tap one to open the recipe), and Waffled's
  own older meal events are hidden.
- **Capture bar** — "add milk" goes to the Mealie list, and the Meal chip is hidden.
- **Weekly Planning** — skips its Meals step, and the recap leaves out meals and the grocery count.

Changes made in Mealie's own app show up in Waffled within about a minute (the shopping list
refreshes every 10 seconds, the meal plan every 30, and recipe details within 5 minutes).

## Pantry

[Pantry](/features/pantry/) is not connected to Mealie. Settings → Modules shows a note to that
effect.

## If Mealie is down

Waffled shows **Can't reach Mealie right now.** with a **Retry** button. If the token stops
working, reconnect in Settings → Mealie.

## Disconnect

**Settings → Mealie → Disconnect** removes the connection. The built-in recipes, meal plans and
grocery list are back as you left them.
