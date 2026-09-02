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

One question decides everything else about a rhythm: **what closes out a period?** You
answer it inside the sentence you write when you make one — the *counted when* clause —
and it can't be changed later (see [Notes](#notes)), so it's worth thirty seconds.

### "It's on the calendar"

A period is closed by **a calendar event existing for it**. Whether it happened is
deliberately not tracked.

Pick this for the things whose whole difficulty is finding a slot: a temple visit each
quarter, a self-care day every other month, the third-weekend family outing, trash night.

You then choose whether Waffled can pick the time itself:

- **Put it on the calendar automatically** *(on)* — the cadence fully determines when, so
  the recurring event is created **the moment you save the rhythm** and it just stays
  satisfied from there. Trash every Tuesday; a family outing on the third Saturday of the
  month. How *often* it repeats isn't asked twice — it comes from the cadence you already
  set, because a repeat rule that disagreed with the cadence would drop the event outside
  the period it's meant to satisfy.

  **You pick which day it lands on**, on every surface: weekday chips like the
  [calendar](/features/calendar/) uses; monthly rhythms get a "which day of the month"
  choice instead (the same date · the same weekday · the last of that weekday); and
  **Advanced** is there for imported rules and anything the pickers can't say. Leave the
  chips alone and it follows the start date you set, which is the sane default.

  One day at a time, deliberately — a rule that fired twice inside one period would claim
  something the cadence never said, and one booking settles the period either way.

  For **the same weekday** and **the last of that weekday**, Waffled quietly lines the
  periods up with calendar months, so each month holds exactly one of them. It has to:
  third Saturdays wander between the 15th and the 21st, so periods anchored on the 19th
  would put two in one month and none in the next — and a period with none can never be
  settled, so it would ask forever with the outing sitting right there on the calendar.
  The start date still picks *which* weekday you mean. If you write a rule by hand under
  **Advanced** that would skip a period like this, Waffled refuses it and says which
  period came up empty.

  The first event goes in at **6pm on the first day the rule allows, on or after the start
  date** — anchor a weekly rhythm on a Wednesday but choose Monday, and it starts the
  following Monday rather than landing on a day its own rule excludes. Move it like any
  other event; dragging it doesn't unlink it from the rhythm.
- **Off** — the cadence is known but *when* is an open decision every period. Waffled will
  ask you to pick a time as each period's deadline approaches. This is also the branch that
  can carry a **booking window** — see More options below — for the rhythms where *how
  often* and *when inside that* are two different answers.

### "I mark it done"

A period is closed by **you doing the thing**, and the clock restarts from when you
*actually* did it — so doing it two weeks late shifts everything two weeks instead of
stacking up missed ones.

Pick this for maintenance: the air filter, the car's oil, toothbrush heads,
smoke-detector batteries. These are exactly the items a calendar grid gets wrong.

## Setting one up

**Rhythms → New rhythm.** You say it as a sentence and everything else has a sane default:

> 🌬 **Air filter** every **3** **months**, counted when **I mark it done**, on **Kevin**

Each bolded part is editable in place. **What** and the optional **emoji** are the name and
the icon you'll see on the Today card and in countdowns; **every N days / weeks / months /
years** is the cadence, which both shapes use; **counted when** is the shape (above);
and **on** is a person, or **the whole household** (the default). "My self-care day" is not
"our self-care day", and a booked rhythm inherits this as the event's owner, so it can be
private to that person.

### What it will actually do

Underneath the sentence, Waffled states the consequence in plain language before you commit
to it — the two dates that are the whole promise:

> Next one lands around **November 19**. It'll be on your Today card from **November 5**. If
> you do it late the next one moves with it — misses never stack up.

A scheduled rhythm gets the other promise instead: that nobody will ever be asked whether it
happened, and the date its booking window closes if nothing is on the calendar by then.

Two things worth knowing about those dates:

- **A new rhythm is due one full cadence out, not today.** "Every 3 months, starting now"
  means the first one lands in three months. If you're adding something you're already
  behind on, set **First one due** under More options.
- **The date is the one you'll really get.** The runway is capped at half the cadence — or
  at the booking window, where you've set one (see below) — and the card quotes the capped
  number, so it never promises a nudge on a day nothing is going to happen.

### More options

Folded away, because each has a default worth having:

- **First one due** *(I-mark-it-done)* or **First period starts** *(it's-on-the-calendar)* —
  the anchor. For a scheduled rhythm this is what makes "which period are we in?"
  answerable: period *N* runs from the start date plus *N* cadences.
- **Only the first … days of each period count** *(it's-on-the-calendar, booked by hand)* —
  the booking window, when it isn't the whole period. Leave it blank and a booking anywhere
  in the period counts, which is how every rhythm behaved before this existed.

  Use it when *how often* and *when inside that* are two different answers. "Date night
  once a month" is a monthly cadence; "and it needs to be in the first week" is a 7-day
  window inside it. Set both and Waffled asks you on the 1st, the date picker offers only
  the 1st to the 7th, and a dinner booked on the 20th leaves the period still asking —
  it's a real event on your calendar, it just isn't the thing this rhythm wanted.

  The window is measured from the **start** of each period, so put it at the other end by
  moving the anchor instead: **First period starts** on the 25th with a 7-day window is
  "the last week of the month". And it is the one part of *when* you can change your mind
  about later — the cadence and the anchor are fixed once a rhythm exists, but the window
  can be edited in place at any time.

  Not offered on a rhythm that puts itself on the calendar: its repeat rule already picks
  the day, so there's nothing left for you to choose.
- **Start nudging me** — how many days of warning you want. For an I-mark-it-done rhythm
  that's "this many days early"; for a scheduled one it's "this many days before the
  **booking window** closes". Without a window that's the whole period: a weekly rhythm
  opens a fresh one every week, and the runway is the tail of it. With one, it's the tail
  of the window, and the default is the whole window — "book it this week" means being
  asked all week.

  It **follows the cadence** unless you set it — up to 14 days, and never more than half the
  cycle (or, where there's a booking window, never more than the window). That cap is the real rule: a runway longer than the cycle never closes, so the item
  would nag forever and you'd learn to ignore it. Ask for 14 days on a weekly rhythm and
  you'll get three, and the form says so rather than letting a trimmed number become a
  mystery later. This is also why a weekly rhythm set to one day's warning shows nothing on
  Today for most of the week: that's the runway working, not a fault.
- **Put it on the calendar automatically** *(it's-on-the-calendar only)* — see above.
- **Notes** — the bit you'll want later: *"Furnace, 20x25x1"*.

## Living with them

### The register

The Rhythms page is **sorted by when, not by kind**. Three groups, top to bottom:

- **Needs you now** — late, or the booking window is closing. This is exactly what the
  Today card is nudging you about, so the two can never disagree about the same rhythm.
- **Coming up** — due in the next fortnight, but not shouting yet.
- **Steady** — nothing to do. On a healthy register this is most of them.

Paused rhythms sit in a single line at the bottom that **names** them, rather than a count
you'd have to open to make sense of.

Every row is anchored by a **countdown** on the right — *6 days late*, *5 days*, *3 months*,
or **Booked · Aug 19, 6:00 PM** in green once a scheduled period has an event, so you can see
*when* without opening the calendar. (An all-day booking gives its date and no time, because
it hasn't got one.) A period you skipped reads **Skipped** instead — skipping exists to send
one period quiet without inventing a calendar entry, so it never claims one. Under the name,
a hairline shows how much of the current cycle is already spent. Rows are ordered soonest-first inside
each group, so the top of the page is always the thing most worth your attention.

You won't see the two shapes named anywhere on this page, and that's deliberate — the
difference shows up where it changes what you'd do. An I-mark-it-done rhythm reads *"last done
Aug 19"* and offers **I did it**; a scheduled one reads *"not on the calendar yet"* and
offers **Book a time**. Steady rows offer no button at all; everything else — backdating,
skipping, pushing it out a week, editing and pausing — lives in the row's **⋯** menu.
**Push it out a week** only appears while a rhythm is actually asking — on a Steady row
there is nothing to push away from, and a control that does nothing you can feel just teaches
you the menu is noise.

**Retire** is in that menu on iPhone and iPad; on the web it sits inside the edit dialog,
one step further from the tap that would end a rhythm for good. (On iPhone and iPad,
editing, pausing and pushing out are on a swipe as well.)

A rhythm set to **put itself on the calendar automatically** should never have an empty
period, and there are two different ways one ends up empty. If the series is still there
and a single occurrence is missing — you cancelled that week, say — the row reads *"nothing
on the calendar this time"* and offers the ordinary **Book a time**, because what is missing
is one event in one period, exactly as it would be for a hand-booked rhythm. If nothing
recurring is left at all — the series was deleted, or the recurrence ran out — the row reads
*"the series needs putting back"* and the button becomes **Put it back**, which restores the
whole series rather than picking a single slot.

The distinction is not cosmetic. Booking a period on a rhythm whose series was still alive
used to create a *second* series beside the first, silently doubling every future occurrence
from then on.

### The Today card

The Rhythms card shows **only what needs attention today**, and **renders nothing at all**
otherwise — most days a quarterly register is quiet, and an empty card every morning is how
a board stops being read. Anything overdue sorts to the top.

Its header says both halves of where you stand: **3 want attention** on the left, and
**All 10 →** on the right. The second number is the reassuring one — seven other things are
handled — and it's the way into the full register.

Each row **leads with the countdown**, then the cadence: *7 days late · every 3 months*,
*in 5 days · every 3 months*, *1 day left to book it*. On a board read from the other side
of a kitchen the cadence is the half you already know.

The loud button is **earned, not given**. Everything on this card wants attention, so a
primary button on every row would make none of them mean anything; the filled button is
kept for what is actually late, or a booking window with a day left in it.

Each row gets the verb its shape deserves: an I-mark-it-done rhythm offers **I did it**, a
scheduled one offers **Book** — with **Skip** beside it on the web and in the row's **⋯**
menu on iPhone and iPad, where there isn't width for two. There is no "done" on a scheduled
rhythm, because that isn't a question rhythms ask.

### Booking a period

**Book a time** opens the smallest thing that could work: a date, a time, and an **All day**
switch. The title and the assignee come from the rhythm itself — retyping "Temple visit" is
precisely the friction that keeps these things off the calendar.

The date picker is clamped to the period's **booking window**, because a booking outside it
settles the wrong period — or, where the window is narrower than the period, settles nothing
at all. Most rhythms have no window and the two are the same span. Confirm and you get an **ordinary calendar event**: real recurrence, colors,
participants, reminders, Google/Outlook sync, the usual editor. It just carries a link back
to the rhythm, which is what closes the period out.

Rhythm-linked events wear a small **🔁** before the title in Month, Week, Day, Agenda and
People views and on Today's agenda card, and the event's detail page says **"This slot keeps
a rhythm"** — so a booked rhythm doesn't look identical to every other event.

### Counting an event you already put on the calendar

Booking from the register isn't the only way a period gets settled. Plenty of family outings
get planned in the Calendar screen, from a message someone sent, or as part of a longer day —
and a rhythm has no way of knowing that's what it was.

So the event editor carries a **Keeps a rhythm** picker, on both the phone and the web. Pick
one and that event settles the period it falls in, exactly as a booking made from the register
would; pick **No rhythm** to unlink it again. Only *it's-on-the-calendar* rhythms are offered —
an I-mark-it-done rhythm closes its period when you say you did the thing, so an event
pointing at one would settle nothing.

Worth knowing: the event has to fall inside the period's booking window to count. If a rhythm
only accepts the first week of the month and the outing is on the 20th, linking it won't
silence the card — which is the window doing its job rather than the link failing.

### Marking a completion done

An I-mark-it-done rhythm can be completed from the Today card or the register, and it doesn't
have to be due — "I did this today" resets the clock from today whenever you press it. The
**I did it** button is on the row while the rhythm is *Needs you now* or *Coming up*; a
**Steady** row has no buttons at all by design, so reach for **Mark done on another day** in
its ⋯ menu and pick today. Once it's done the button says **Done today ✓** rather than
offering itself again, so you can tell the tap landed; pressing it twice in a day doesn't
record two of anything.

Did it on Tuesday and only got round to logging it on Friday? **Mark done on another day**
(in the row's ⋯ menu) records the date it actually happened, which is the date the clock
restarts from. It won't accept a date in the future.

The register shows **last done** on every one of them alongside its countdown, which is the
whole point of keeping the register: *"the filter last changed March 12"* stops being a
guess.

Open one to edit it and you get the rest of the record: **Done 6 times · about every 123
days, against every 3 months**, over its recent dates. The comparison is the useful half — a
rhythm you set to every 3 months that really runs at five is the cadence telling you it's
wrong, and worth changing to what actually happens. The average needs at least two
completions, because one date isn't an interval.

### Skipping a period

Sometimes a period genuinely isn't happening — you're away, the quarter got eaten. **Skip**
sends that period quiet without inventing a calendar entry for something that isn't going to
take place. Only that one period is skipped; the next one comes round as normal.

### Pushing one out a week

It's asking, and today isn't the day. **Push it out a week** (in the row's **⋯** menu on
every surface, and on a swipe on iPhone and iPad) moves the clock without recording a
completion — claiming you did it would restart the cadence from today and quietly erase the
fact that it's still outstanding.

The new date is **today or the due date, whichever is later, plus seven days**, and both
halves of that matter. Counted from a date it already sailed past, "a week" on something six
days overdue would bring it back tomorrow — a control that reads as a week and delivers a
day is worse than none. Counted from the due date when it hasn't arrived, something due in
three days moves to ten rather than resetting to seven, so the rhythm keeps the shape of its
own schedule instead of being re-anchored to whenever a button got pressed.

It's one period's reprieve, not a permanent shift: doing it for real still restarts the
count from the day you actually did it, so the push is forgotten rather than compounding.

It's offered only while the rhythm is actually asking — *Needs you now* or *Coming up* —
because there's nothing to defer on a Steady row. It's for the I-mark-it-done shape only: a
scheduled rhythm's periods *are* its anchor, so **Skip** is that shape's version of this.

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

Rhythms works on every surface, including the 🔁 marker on a booked event.

The **regrouped register** described above — Needs you now / Coming up / Steady — the
**Today card**, and the **creation form as an editable sentence** are all on every surface.
What differs is mostly room rather than features. On the web a row's verb lives in a column
at the right; on iPhone and iPad it sits on its own line beneath the row, because a title, a
countdown and a verb don't fit across one phone line. For the same reason the Today card's
**Skip** is a button beside **Book** on the web and an item in the row's **⋯** menu on the
phone, and that card shows its first four rows there with a **+N more** line rather than the
full list.

The editor is the same on every surface, including the day pickers for an auto-scheduled
series — see [Put it on the calendar automatically](#its-on-the-calendar) above.

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
