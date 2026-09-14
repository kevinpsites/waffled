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
  tracks position. Swipe the strip to page weeks. **Tapping an event row opens its editor**;
  tapping the card does not open Day (a user call made during the build).
- **Day** is pushed on a navigation stack, so the system back button ("‹ September") and the
  edge swipe both return. Date header, a horizontal all-day strip (countdowns first), then a
  timed grid at 56pt/hour with overlap lanes and a now line on today. Tap an empty hour to add
  an event there; swipe sideways to step days.
- **Agenda** stays, reachable from the header menu but not the cycle: it is the only place the
  "Add an event…" AI capture bar lives, and it was a shipped, documented view.

## Navigation

- The header's **cycle pill** moves Month → Week → Day → Month from any of the three.
- **Pinch** zooms: spread Month → Week → Day, pinch back out. It stops at either end.
- The chosen view is remembered (`waffled.calendarMode`). A stored `agenda` still decodes.
- The handoff draws a **search** button; the app has no event search, so that slot is a menu
  holding the view list and the per-person filter.

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
- **Chip color:** the household's **Event style** (solid or tinted) and family color, like every
  other calendar surface. The handoff mock is drawn in the tinted style.

## Resolved open questions

| Handoff question | Decision |
| --- | --- |
| 4 chips vs 3 + a fatter "+N" | Height-driven, max 4 (above) |
| Week rail overscroll → next week, or stop at Sunday | Stops; page weeks by swiping the strip |
| Day hours fixed or auto-fit | 7–8 fixed, widened when an event falls outside |
| Event tap → detail sheet | Month/Day open the existing event detail; Week opens the editor |

## Not built

- The mock's **meal** and **thaw/prep** chips: those aren't calendar events on iOS, so there is
  nothing to color. A meal scheduled from the Meal Builder already appears as an ordinary event.
- The week card's **"Dinner · …" footer**, for the same reason.
