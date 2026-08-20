---
title: Rhythms
description: The things that should keep happening — the air filter, trash night, a quarterly self-care day — with one place to confirm each is actually handled.
---

A rhythm is a **standing intention with a cadence**: trash out weekly, the air filter every
three months, a temple visit each quarter, a self-care day every other month, a family outing
on the third weekend. Rhythms is the register you go to to confirm that the recurring things
are handled — not a task list, and not a habit tracker. 🔁

The unit of value is *"is this handled for this period?"*, asked of the whole household at
once.

## Rhythms vs chores vs goals

The three look similar from a distance and are deliberately different.

| | What it's for |
|---|---|
| **[Chores](/features/chores/)** | Kid-facing work with a reward, an assignee and an approval step. Nobody earns a star for changing the furnace filter. |
| **[Goals](/features/goals/)** | **Follow-through.** You set a goal because you want to actually do the thing, and the record of whether you did is the point. |
| **Rhythms** | **The opportunity existing.** A quarterly temple visit is a rhythm because getting a time set aside *is* the outcome. |

That last line is the one to hold on to: for a rhythm that gets scheduled, Waffled never asks
whether it happened. There are no streaks, no completion rate and no "on track" — a period
that got away is a week you rebook, not a miss on a scorecard. If you *do* want the
follow-through record for something, make it a [goal](/features/goals/) as well; one calendar
event can carry both.

## Turn the module on first

Rhythms is an **optional module and it's OFF by default**, so nothing appears until an
admin enables it in **Settings → [Modules](/administration/modules/)**. Once it's on you get:

- a **Rhythms** entry in the nav, with the full register behind it
- a **Rhythms** card on [Today](/features/today/) — which stays hidden on quiet days
- the 🔁 marker on rhythm-linked events across the [calendar](/features/calendar/)
- completion-shape rhythms in your [countdowns](/features/countdowns/)

Turn the module back off and all of that disappears; nothing is deleted.

## The two shapes — pick the right one

Making a rhythm asks one question before anything else: **what closes out a period?**
Everything below the shape picker follows from the answer, and it can't be changed later
(see [Notes](#notes)), so it's worth thirty seconds.

### "It gets scheduled"

A period is closed by **a calendar event existing for it**. Whether it happened is
deliberately not tracked.

Pick this for the things whose whole difficulty is finding a slot: a temple visit each
quarter, a self-care day every other month, the third-weekend family outing, trash night.

You then choose whether Waffled can pick the time itself:

- **Put it on the calendar automatically** *(on)* — the cadence fully determines when, so
  the recurring event is created **the moment you save the rhythm** and it just stays
  satisfied from there. Trash every Tuesday; a family outing on the third Saturday of the
  month. You pick the day it lands on with the same weekday chips the
  [calendar](/features/calendar/) uses; monthly rhythms get a "which day of the month"
  choice instead (the same date · the same weekday · the last of that weekday). How
  *often* it repeats isn't asked twice — it comes from the cadence you already set, because
  a repeat rule that disagreed with the cadence would drop the event outside the period
  it's meant to satisfy. **Advanced (raw RRULE)** is there for imported rules and anything
  the picker can't say.

  The first event goes in at **6pm on the first day the rule allows, on or after the start
  date** — anchor a weekly rhythm on a Wednesday but choose Monday, and it starts the
  following Monday rather than landing on a day its own rule excludes. Move it like any
  other event; dragging it doesn't unlink it from the rhythm.
- **Off** — the cadence is known but *when* is an open decision every period. Waffled will
  ask you to pick a time as each period's deadline approaches.

### "You do it"

A period is closed by **you doing the thing**, and the clock restarts from when you
*actually* did it — so doing it two weeks late shifts everything two weeks instead of
stacking up missed ones.

Pick this for maintenance: the air filter, the car's oil, toothbrush heads,
smoke-detector batteries. These are exactly the items a calendar grid gets wrong.

## Setting one up

**Rhythms → New rhythm.** After the shape picker:

- **What** and an optional **emoji** — the emoji is what shows on the Today card and in
  countdowns.
- **Every** *N* **days / weeks / months / years** — the cadence, for both shapes.
- **Who** — a person, or **Whole household** (the default). "My self-care day" is not "our
  self-care day", and a booked rhythm inherits this as the event's owner, so it can be
  private to that person.
- **First due** *(you-do-it)* or **Periods start** *(it-gets-scheduled)* — the anchor. For a
  scheduled rhythm this is what makes "which period are we in?" answerable: period *N* runs
  from the start date plus *N* cadences.
- **The nudge runway** — how many days of warning you want. For a you-do-it rhythm that's
  "warn me this many days before it's due"; for a scheduled one it's "how many days'
  warning before the **booking window** closes". The booking window is simply one cadence:
  a weekly rhythm opens a fresh one every week, and the runway is the tail of it.

  It defaults to **14 days** and is **capped at half the cadence** — a runway longer than
  the cycle never closes, so the item would nag forever and you'd learn to ignore it. Ask
  for 14 days on a weekly rhythm and you'll get three. The form spells out what you'll
  actually get, in days, so a number that got trimmed doesn't quietly become a mystery
  later. This is also why a weekly rhythm set to one day's warning shows nothing on Today
  for most of the week: that's the runway working, not a fault.
- **Notes** — the bit you'll want later: *"Furnace, 20x25x1"*.

## Living with them

### The Today card

The Rhythms card shows **only what needs attention today**, and **renders nothing at all**
otherwise — most days a quarterly register is quiet, and an empty card every morning is how
a board stops being read. Anything overdue sorts to the top.

Each row gets the verb its shape deserves: a you-do-it rhythm offers **Mark done**, a
scheduled one offers **Book a time** and **Skip**. There is no "done" on a scheduled rhythm,
because that isn't a question rhythms ask.

### Booking a period

**Book a time** opens the smallest thing that could work: a date, a time, and an **All day**
switch. The title and the assignee come from the rhythm itself — retyping "Temple visit" is
precisely the friction that keeps these things off the calendar.

The date picker is clamped to the current period, because a booking outside it satisfies the
wrong period. Confirm and you get an **ordinary calendar event**: real recurrence, colors,
participants, reminders, Google/Outlook sync, the usual editor. It just carries a link back
to the rhythm, which is what closes the period out.

Rhythm-linked events wear a small **🔁** before the title in Month, Week, Day, Agenda and
People views and on Today's agenda card, and the event's detail page says **"This slot keeps
a rhythm"** — so a booked rhythm doesn't look identical to every other event.

### Marking a completion done

A you-do-it rhythm can be completed from the Today card or the register, **whether or not
it's due yet** — "I did this today" resets the clock from today. Once it's done the button
says **Done today ✓** rather than offering itself again, so you can tell the tap landed;
pressing it twice in a day doesn't record two of anything.

Did it on Tuesday and only got round to logging it on Friday? **Log it for another day**
(on the row, or in the ⋯ menu on iPhone) records the date it actually happened, which is
the date the clock restarts from. It won't accept a date in the future.

The register shows **Last done** and **Next due** for every one of them, which is the whole
point of keeping the register: *"the filter last changed March 12"* stops being a guess.

### Skipping a period

Sometimes a period genuinely isn't happening — you're away, the quarter got eaten. **Skip**
sends that period quiet without inventing a calendar entry for something that isn't going to
take place. Only that one period is skipped; the next one comes round as normal.

### Pausing vs retiring

**Pause** a rhythm when it's genuinely on hold — a summer-only outing, a car you're not
driving. It stops appearing on the Today card and stops nudging, keeps everything else, and
comes back untouched when you un-pause it. **Retire** removes it for good; its completion
history survives, so *"when did we last change the filter?"* is still answerable. Pausing is
the reversible one — reach for it first.

### When the calendar and the intention disagree

An automatic rhythm normally never appears on the Today card — its recurring event *is* the
satisfied state. If it turns up anyway, someone deleted the event or the series ran out, and
the offer changes to **Put it back on the calendar**. This is checked rather than assumed:
noticing that the calendar and the intention have drifted apart is the whole reason the
register exists.

## Where it works

| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ✅ |
| iPad | ✅ |

Every part of Rhythms works on every surface, including the 🔁 marker on a booked event.

The events a scheduled rhythm books are ordinary calendar events, so they show up
**everywhere** — including on your phone, and including offline — the moment they're booked.

## Settings

There's no separate Rhythms settings screen — every choice that matters (cadence, runway,
assignee, notes) belongs to the individual rhythm and is made when you create it. The only
household-level switch is the module toggle in
**Settings → [Modules](/administration/modules/)**.

## Module

Rhythms is an **optional module** (`rhythms`, default **OFF** — opt-in), toggled in
**Settings → Modules** by an owner or admin. Any signed-in member can then use it.

## Notes

- 🔒 **The shape and the anchor are fixed once created.** You can't switch a rhythm between
  "you do it" and "it gets scheduled", or move when its periods start. Re-anchoring a live
  rhythm would silently re-interpret the periods you've already skipped and point its
  existing bookings at periods that no longer exist. Make a new rhythm instead.
- ⏳ **Completion rhythms become countdowns.** "18 days until the air filter" joins your
  [countdown](/features/countdowns/) list automatically. Scheduled rhythms don't need this —
  they're events, so the usual **"⏳ Show a countdown"** toggle already works on them.
- 📵 **The nudge to *book* something has no push notification.** Once a rhythm is on the
  calendar it gets the normal event reminders; the earlier nag — *"the temple visit still
  isn't booked and the quarter ends Sunday"* — lives on the Today card and in the register
  only, because it isn't an event yet.
- ✏️ **The shape and the anchor can't be changed after you create a rhythm.** Everything
  else is editable, but switching between the two shapes — or moving the date the periods
  are counted from — would re-interpret the periods you've already skipped and point
  bookings at periods that no longer exist. The editor says so and points you at retiring
  it and making a new one, which is the honest fix.
- 🌐 **Rhythms themselves need a connection.** The register and the Today card are
  online-only, like chores. The events a rhythm books are fully offline, like every other
  calendar event.

## See also

- [Calendar & events](/features/calendar/) — where a booked rhythm lands
- [Countdowns](/features/countdowns/) — the "N days until" layer
- [Goals](/features/goals/) — when you *do* want the follow-through record
- [Modules](/administration/modules/) — turning it on
