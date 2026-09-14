# iPhone calendar — Month → Week → Day

The iPhone Calendar tab, rebuilt from the Claude Design handoff "iOS Calendar – Handoff Build".
The iPad keeps its own wide grids (`KioskCalendarView`); nothing here changes them except that
both now share one overlap-lane implementation (`TimeLanes`).

Code: `apps/ios/Sources/Waffled/Features/Calendar/CalendarView.swift` (navigation, header,
Agenda), `PhoneCalendarViews.swift` (the three screens), `PhoneCalendarLayout.swift` (the rules
below, unit-tested in `Tests/PhoneCalendarLayoutTests.swift`).

## Screens

- **Month** is home. A full-height grid with the ISO week number in a left gutter and event
  titles in every day cell. Tap a day → Day is pushed. Swipe sideways to change month.
- **Week** is a horizontal rail of day cards for one week, the next card peeking, snapping per
  card. A day strip above (with each day's person-color dots) jumps the rail; a dots row below
  tracks position. **Tapping an event row opens its editor**; tapping the card does not open Day.
- **Day** is pushed on a navigation stack, so the system back button ("‹ September") and the
  edge swipe both return. Date header, a horizontal all-day strip (countdowns first), then a
  timed grid at 56pt/hour with overlap lanes and a now line on today. Tap an empty hour to add
  an event there; swipe sideways on the grid to step days (not on the all-day strip, and not
  from the back-swipe edge).
- **Agenda** stays, in the view menu: it is the only place the "Add an event…" AI capture bar
  lives, and it was a shipped, documented view.

## Navigation

- The header's **view button** shows the current view's icon and opens a menu with Month, Week,
  Day and Agenda plus the per-person filter; a dot on the button marks an active filter. The
  handoff's M/W/D cycle pill was dropped after trying it in the simulator — the icon already
  says which view you're on. The same slot is where the handoff draws search; the app has no
  event search.
- **Pinch** zooms: spread Month → Week → Day, pinch back out. It stops at either end.
- Switching Month ↔ Week carries the date: Month opens on the selected day's month, Week on a
  day inside the month you were looking at.
- The remembered view (`waffled.calendarMode`) is the screen under a pushed Day, so tapping into
  a day doesn't make the tab reopen on Day.

## Week paging

- Pulling the rail past its **last card** (60pt beyond the end) moves to the **next week's first
  day**; pulling before the first card moves to the **previous week's last day**, so a swipe
  back keeps going backwards.
- Swiping the **day strip** pages a week either way and lands on that week's **first day**.

## Layout rules

- **Rows:** only as many as the month needs — 5 or 6 — cut on the household's week start
  (Sunday or Monday), never a hardcoded Monday. A Sunday-first row is numbered by the ISO week of
  the Monday inside it.
- **Titles per cell:** as many 16pt chips as the row height holds, capped at 4, with the
  countdown pill (label + "3d") taking one of those slots; the rest becomes "+N more". A 5-row
  month on an iPhone 17 fits four; a 6-row month fits three.
- **Order in a cell or card:** all-day first (birthdays, trips), then timed by start.
- **Day hours:** 7 AM–8 PM, widened to cover any timed event outside that range — the handoff
  left "fixed or auto-fit" open, and a fixed range would hide a 6 AM flight.
- **Chip color:** people follow the household's **Event style** (solid or tinted) and family
  color, like every other calendar surface. The handoff mock is drawn in the tinted style.

## Meals on the calendar

The Meals module writes each planned meal (`origin = 'meal_plan'`, "🍽️ Dinner · Salmon" at the
meal time) and, when **Thaw reminder** is on, a same-day reminder (`origin = 'meal_prep'`,
"🧊 Thaw for Dinner · Salmon") as ordinary events. The phone calendar recognises both by origin:

- A **meal** is always an amber wash, whatever the Event style, so it reads as a meal.
- A **thaw reminder** is the faintest grey wash — a daily constant that shouldn't compete.
- Neither adds a person dot to the week strip.
- With Meals on, each week card ends with **"Dinner · …"**, or **"Thaw · …"** when only the
  reminder exists, or "No dinner planned".

## Resolved open questions

| Handoff question | Decision |
| --- | --- |
| 4 chips vs 3 + a fatter "+N" | Height-driven, max 4 (above) |
| Week rail overscroll → next week, or stop at Sunday | Pages to the next week's first day |
| Day hours fixed or auto-fit | 7–8 fixed, widened when an event falls outside |
| Event tap → detail sheet | Month/Day open the existing event detail; Week opens the editor |
