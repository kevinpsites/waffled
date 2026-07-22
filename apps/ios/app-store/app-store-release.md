# App Store release copy — Waffled

Copy-paste source for App Store Connect **Distribution → App Information** and each
version's metadata. Nothing here is a secret — it's just the marketing text. Keep it
updated when the store listing changes so we have a version-controlled record.

Character limits are noted per field (App Store Connect enforces them). Where a field
has a hard cap, a `[NN/limit]` count is shown so you can see headroom before pasting.

---

## App name  `[≤30]`

```
Waffled
```

## Subtitle  `[≤30]`

```
Your family, on the same page
```
<sub>Alt options: `Family planner & family board` · `Plan, share, and stay in sync` · `The family organizer`</sub>

## Promotional text  `[≤170]`  *(editable anytime without a new build)*

```
The calm command-center for family life — shared calendar, chores, meals, pantry, and goals, all in one place. Mount an iPad on the wall for the whole family to see.
```

## Keywords  `[≤100, comma-separated, no spaces after commas]`

```
family,planner,calendar,chores,meal,pantry,grocery,shopping,organizer,household,kids,routine,goals
```
<sub>Don't repeat the app name or subtitle words here — they're already indexed. No spaces after commas maximizes the character budget.</sub>

## Description  `[≤4000]`

```
Waffled is the calm command-center for family life. One shared home for your
calendar, chores, meals, pantry, shopping lists, and goals — so everyone in the
house is finally on the same page.

Mount an iPad on the wall or counter as a family display, and carry the same
plan in your pocket on your phone. Everything stays in sync.

• SHARED CALENDAR — Everyone's events in one view, with countdowns to the days
  that matter ("3 sleeps until the trip!") and birthdays that never sneak up on you.

• CHORES & REWARDS — Assign chores, snap photo-proof when they're done, and let
  kids earn rewards. Set up a rewards jar to save toward a shared goal.

• MEALS & SHOPPING — Plan the week's meals and build the grocery list from them.
  Scan barcodes to add pantry items in a tap.

• PANTRY — Track what's in the house and what's about to expire, with allergen
  warnings for the whole family or per person.

• GOALS — Keep the family's intentions front and center, from reading streaks to
  saving up for something big.

• FAMILY NIGHT — A customizable, auto-rotating agenda for your weekly family time.

• A HOME SCREEN THAT'S YOURS — Reorder and hide the cards on your Today view so it
  shows what your family actually cares about.

PRIVATE BY DESIGN
Waffled is self-hostable and open source. Run it on your own server and your
family's data stays yours — no ads, no tracking, no selling your life to anyone.

Get your family on the same page. Get Waffled.
```

## What's New (release notes)  `[≤4000]`

<sub>Current draft targets **0.9.0**, covering everything user-facing since the
0.8.0 build (commit `5b0acbe5`, the last one submitted for review). Update this
each time you submit a new version.</sub>

```
New in 0.9.0:

• See your goal progress your way — every goal now has a switcher of views: a
  week or month heatmap, a GitHub-style year grid, a pace chart showing where
  you need to be to hit your target on time, a "year in a ring," and stacked
  bars for family goals. Tap any day or month to see who logged what.

• Recipes can go straight to your grocery list, no meal plan needed. Add a
  one-off dinner or snack from any recipe page and it merges right in with
  what's already on the list.

• The "Add anything" bar can now act on things you already have, not just
  create new ones. Say "mark the trash chore done," "log 20 minutes on my
  reading goal," "cross off milk," or "move soccer to Thursday at 4," and
  confirm before anything changes.

• Quick-add can also start a countdown, add a family member, set a goal, stock
  the pantry, or add a reward — just by typing it in plain language.

• Track more from Apple Health: specific workout types (running, cycling,
  swimming, yoga, strength training), cycling/swimming/wheelchair distance,
  and a clearer picker for choosing what a goal follows.

• Swipe between weeks in the meal planner — the same gesture as Calendar and
  Chores.

Plus a batch of polish: a snappier iPad calendar, a Today screen that stays
fresh and grocery quick-add that no longer hides under the keyboard, more
reliable list creation and goal logging, a calmer Offline banner, and instant
meal drag-and-drop.

Thanks for using Waffled — we'd love your feedback!
```

---

## URLs

| Field | Value | Notes |
|-------|-------|-------|
| **Support URL** *(required)* | `https://waffled.app/support` | Must resolve. If no support page yet, point at `https://waffled.app` or a docs page. |
| **Marketing URL** *(optional)* | `https://waffled.app` | |
| **Privacy Policy URL** *(required)* | `https://waffled.app/privacy` | Required before you can submit for review. Must be a live page. |

---

## App information (set once, under Distribution → App Information)

| Field | Suggested value |
|-------|-----------------|
| **Primary category** | Lifestyle |
| **Secondary category** | Productivity |
| **Content rights** | Does not contain third-party content |
| **Age rating** | 4+ (no objectionable content) — confirm in the questionnaire |
| **Copyright** | `2026 Kevin Sites` *(or your legal name / entity)* |
| **Bundle ID** | `app.waffled` |
| **Encryption (Info.plist)** | `ITSAppUsesNonExemptEncryption = NO` — already declared, standard TLS only |

---

## Still needed before you can submit for review

These can't be text-pasted — they're uploads/answers in App Store Connect:

- [ ] **Screenshots** — at minimum 6.7" iPhone; add 12.9"/13" iPad since we support iPad.
- [ ] **App Privacy** questionnaire (Data collection) — declare what Waffled collects
      (self-hosted → likely "Data Not Collected" for the hosted app, but confirm).
- [ ] **Age rating** questionnaire.
- [ ] **Privacy Policy URL** live and reachable.
- [ ] **Select a build** for the 1.0 version (this also fixes the blank app-level icon).
```
