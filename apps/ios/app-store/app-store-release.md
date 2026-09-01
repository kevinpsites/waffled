# App Store release copy — Waffled

Copy-paste source for App Store Connect **Distribution → App Information** and each
version's metadata. Nothing here is a secret — it's just the marketing text. Keep it
updated when the store listing changes so we have a version-controlled record.

Character limits are noted per field (App Store Connect enforces them). Where a field
has a hard cap, a `[NN/limit]` count is shown so you can see headroom before pasting.

---

## App name  `[7/30]`

```
Waffled
```

## Subtitle  `[29/30]`

```
Your family, on the same page
```
<sub>Alt options: `Family planner & family board` · `Plan, share, and stay in sync` · `The family organizer`</sub>

## Promotional text  `[165/170]`  *(editable anytime without a new build)*

```
The calm command-center for family life — shared calendar, chores, meals, pantry, and goals, all in one place. Mount an iPad on the wall for the whole family to see.
```

## Keywords  `[98/100, comma-separated, no spaces after commas]`

```
family,planner,calendar,chores,meal,pantry,grocery,shopping,organizer,household,kids,routine,goals
```
<sub>Don't repeat the app name or subtitle words here — they're already indexed. No spaces after commas maximizes the character budget.</sub>

## Description  `[1695/4000]`

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

• RHYTHMS — The things that should keep happening but aren't chores and aren't
  goals: trash out weekly, the air filter every three months, a family outing on
  the third weekend. Waffled counts down to each one and gets out of the way.

• FAMILY NIGHT — A customizable, auto-rotating agenda for your weekly family time.

• A HOME SCREEN THAT'S YOURS — Reorder and hide the cards on your Today view so it
  shows what your family actually cares about.

PRIVATE BY DESIGN
Waffled is self-hostable and open source. Run it on your own server and your
family's data stays yours — no ads, no tracking, no selling your life to anyone.

Get your family on the same page. Get Waffled.
```

## What's New (release notes)  `[2754/4000]`

<sub>Current draft targets **0.14.0**, built from that version's changelog section
filtered to what iPhone/iPad users can actually see. Web-only work is deliberately
left out — the smaller first-load bundle, the month-view add-event fix, and the two
browser-kiosk offline fixes. Update this each time you submit a new version.</sub>

```
RHYTHMS — THE THINGS THAT SHOULD KEEP HAPPENING (NEW MODULE)
Some things around the house aren't chores and aren't goals. They just need to
keep coming around: trash out weekly, the air filter every three months, a
family outing on the third weekend. Rhythms is a new optional module for exactly
those.

Write one as a sentence you edit in place — "Air filter, every 3 months, counted
when I mark it done" — and Waffled names the two dates that are the whole promise
before you commit to it: the day the first one lands, and the day it starts
asking.

Some rhythms are things you do, and the clock restarts from when you actually did
it, so being late moves the next one instead of stacking up missed ones. Others
just need to get scheduled — booking one puts a real event on your calendar, so
it gets recurrence, colors, reminders and Google/Outlook sync like anything else.

The register is sorted by when, not by kind — Needs you now, Coming up, Steady —
and every row is anchored by a countdown. The Today card stays invisible on the
many quiet days and, when it isn't quiet, says both things at once: what's asking
now, and how much isn't. Can't get to something this time? Push it out a week
without claiming you did it, or skip the period entirely rather than inventing an
entry for something that isn't happening.

Rhythms is off by default — turn it on in Settings → Modules.

COOK WITH YOUR HANDS FULL
Every ingredient in Cook Mode is now a checkbox. Tap it as it goes in and it's
struck through, with a running "3 of 11" count of what you've gathered. A step's
ingredient and its row in the full list are the same thing, so ticking either
ticks both, your ticks stay put as you move between steps, and a meal with
several dishes keeps a separate list for each.

A NEW RECIPE WITHOUT LOSING YOUR PLACE
Filling a night on the plan and the thing you want to cook isn't in your recipes
yet? The picker has a New recipe button of its own now. Write it there and it
goes straight into the slot you opened, with the plan behind it untouched.

YOUR WEEK REALLY DOES START ON MONDAY
"Week starts on Monday" used to quietly change nothing you could see. It now
moves every grid in the app — the meal planner's weekly and monthly views and
"Plan my week", the calendar's month and week views, the This week / Next week
pickers you get when scheduling from a recipe, and the goal heatmaps.

Plus a lot of polish and fixes: a goal's deadline is the day you picked, adding a
note to a goal entry no longer quietly moves it to another day, and birthdays and
planned meals no longer read a day early. Pull-to-refresh reloads the whole Today
screen on iPhone, and the wall iPad can refresh its cards at all.

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
