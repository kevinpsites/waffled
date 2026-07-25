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

<sub>Current draft targets **0.12.0**, covering iOS-facing changes since the
**0.9.0** public launch (the version currently live on the App Store) — i.e. the
0.10.0, 0.11.0, and 0.12.0 changelogs, filtered to what iPhone/iPad users can
actually see. Update this each time you submit a new version.</sub>

```
Since launch, Waffled has gotten a lot more capable on iPhone and iPad:

GOALS YOU CAN SEE
The Today goal card is now a full hero — a progress ring, each person's
contribution, and Log progress right there — with a switcher to jump between
goals. Swipe through the week and month heatmaps, and the charts now show the
true calendar week and the whole year.

SMARTER LISTS
Give items a 1–5 priority (urgent ones get a flag) and drag them between
sections. Bulk-edit a whole selection at once — set the section, assignee, or
priority, even into a brand-new section you name on the spot. Rename a list from
its menu, watch the count tick down to what's left, and let checked-off items
tuck into a Completed section that clears itself.

MEALS & SHOPPING
Jump straight into Cook Mode from the Today card and swipe between steps. Shop
ahead by planning next week's groceries without disturbing this week's, add or
remove any recipe's ingredients from the list, and share a recipe as a file
anyone can import.

CALENDAR & COUNTDOWNS
Countdowns now show up right on the calendar and are tappable to edit. Type an
event into "Add anything" and it's assigned to you by default.

WAFFLED-BITES (NEW MODULE)
A new optional module adds parent controls for a kid's Waffled-Bite companion
device — quiet time, a wake-up light schedule, a night light, a sound machine,
a morning alarm, and screen brightness — all managed right from Family on your
phone or tablet. (The companion device itself is still on the way.)

Plus a lot of polish and fixes: adding a grocery item from Today no longer hangs
the iPad, a half-typed list item is saved when you leave, add bars are easier to
tap, the goal week/year charts are accurate, and adding a meal from the capture
bar works reliably again.

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
