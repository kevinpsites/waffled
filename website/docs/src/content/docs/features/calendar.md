---
title: Calendar & events
description: The family's shared schedule — native events plus optional two-way Google or Outlook sync and ICS calendar feeds.
---

![The month calendar — colour-coded family events with a Today rail and countdown badges](/screenshots/calendar.png)

The calendar is the family's shared schedule and the thing the whole hub is
anchored to — every person's events (and their colors) on one grid, so "whose
thing is when" stops being a group text. It's native events out of the box, with
optional **two-way [Google Calendar](/administration/google-calendar/) or
[Outlook / Microsoft 365](/administration/outlook-calendar/) sync** and
**[calendar feed (ICS) subscriptions](#calendar-feeds-ics)** layered on top.
Along with [Today](/features/today/), it is the one feature that is **never
gated off**.

## Highlights
- 📅 **Native events** — create / edit / delete, with **multiple participants per
  event** (stacked avatars, each in the person's color) and a **per-person filter**.
- 🎨 **Color you control** — solid or tinted event chips, any custom hex per person,
  and a **family color** for events that involve everyone. See
  [Colors on the calendar](#colors-on-the-calendar).
- **Four views** — Month / Week / Day / Agenda:
  - a live red **"now" line** on Week & Day
  - month cells show **event titles** (tap a day for times)
  - agenda **dims past events** so today reads first
- **Full-screen event detail** — location with **Directions**, repeats, notes, and
  an activity timeline.
- 🔁 **Recurring events** — full RRULE support:
  - in-editor creation (Daily / Weekdays / Weekly + days / Monthly / Custom)
  - per-occurrence **edit scope** (this / following / all)
  - end condition (never / until a date / after N)
  - monthly **nth-weekday ordinal** (first…fifth / last)
- 🔗 **Two-way Google & Outlook sync** — inbound incremental poll (a per-calendar sync
  cursor) plus outbound push to each person's **write-target** calendar (reader-only
  calendars are never a target). The push lifecycle runs `pending_push → synced` or
  `push_failed` (retried). Google and Microsoft accounts can be mixed in one household;
  each shows which provider it came from.
- 📡 **Calendar feeds (ICS)** — subscribe to any published `.ics` / `webcal://` link, no
  sign-in needed; refreshed every 15 minutes. See [below](#calendar-feeds-ics).
- 📶 **Fully offline via PowerSync** — the calendar is the *one* fully-offline domain:
  local reads and **queued writes** that drain on reconnect.
- ✨ **AI "Heads up this week"** digest plus a per-event insight.
- 🎯 **"Counts toward a goal"** tag on an event — feeds goal auto-counting (see
  [Goals](/features/goals/)).
- 🔁 **Rhythm marker** — an event booked to keep a [rhythm](/features/rhythms/) wears a
  small 🔁 before its title in every view, and its detail page says *"This slot keeps a
  rhythm"*. It's an ordinary event in every other respect.

## Where it works
| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ✅ |
| iPad | ✅ |

iPad uses distinct wide grids and lays the event detail out in **two columns**;
everything else is shared and adapts by size.

## Colors on the calendar

Color is how the calendar answers "whose thing is this?" from across the room, so
it's worth a minute in **Settings → Family & People** (admins). Both settings below
live with the household, so the browser, the wall tablet and everyone's phone all
follow them.

### Event style — solid or tinted

**Event style** decides how an event chip is painted in the month, week, day and
agenda views (and the Today dashboard's agenda card):

- **Solid colors** *(default)* — the chip fills with the event's color and the title
  flips to whichever of black or white reads better on it, so a pale yellow or a
  bright teal stays legible. This is the most glanceable option and what a
  wall-mounted kiosk wants.
- **Tinted** — a soft wash of the color with matching colored text: quieter, closer
  to a paper planner. It's theme-aware, so it stays readable in dark mode.

The choice belongs to the **household**, not the device, so every screen in the house
agrees. Flipping it restyles open screens immediately — no reload.

The style applies to chips that have a **background** — month-cell chips, the week
and day timeline blocks, all-day pills. The slim accent bars in the agenda and on the
Today dashboard, and the dots in a month cell, take the event's *color* but have no
fill to tint, so they look the same either way.

:::note
Upgrading an existing household? Solid is the default, so your calendar will look
bolder than it used to. Switch **Event style** to *Tinted* to get the old look back.
:::

### Person colors, and one for the whole family

Every member has a color (**Settings → Family & People →** tap a person **→ Color**).
Beyond the eight presets there's a ninth **custom** swatch that opens your device's
color picker, so you're not stuck with the palette. To change **your own** color
without being an admin, use **My Profile** on the web, or **Settings → Households**
on iPhone/iPad.

An event is colored by **who it belongs to**:

| The event involves | Its color |
| --- | --- |
| One person (or some of the family) | That person's color — the owner's, when several people are on it |
| **Everyone in the household** | The **family color** |
| Nobody yet | A neutral grey |

The **family color** is set once for the household (**Settings → Family & People →
Family color**) and starts as a warm orange, deliberately outside the member palette.
Before this existed, a whole-family dinner just borrowed whichever member owned it,
which made the calendar read as "Dad's dinner" instead of "our dinner". A household
with only one member never uses it — there's no whole-vs-part distinction to draw.

Member **avatars** always stay the person's own color, on every surface: the family
color describes the *event*, not the people on it.

## Calendar feeds (ICS)

The third calendar source next to [Google](/administration/google-calendar/) and
[Outlook](/administration/outlook-calendar/): **subscribe to any published calendar
link** — a school schedule, a sports team, a work calendar published from Outlook —
and its events appear on the family calendar. Feeds are read-only and need **no
sign-in or OAuth setup**; the URL is the whole credential, which makes them the
plan B when a workplace won't approve calendar OAuth access.

- **Add one in Settings → Calendars → Calendar feeds** (admins), on **web, iPhone or
  iPad**: paste an `.ics`
  or `webcal://` URL (webcal links are fetched over HTTPS) and optionally name it.
  The first refresh runs as soon as you add the feed; after that every feed is
  polled **every 15 minutes** (`ICS_SYNC_INTERVAL_MS`, `0` disables), and each
  feed row has an **↻ Sync** button when you don't want to wait for the cycle.
- **Person mapping & privacy** — map a feed to a person to color its events, and
  tick the row's **Private** checkbox to keep its events visible only to that
  person (the same family/personal visibility model as synced calendars). Private
  is offered only once the feed belongs to someone: "private to nobody" would hide
  the feed from everyone, including you, so unassigning a private feed shares it
  back with the family.
- **Feed events are read-only, everywhere.** A feed is a mirror of someone else's
  calendar and there's no way to write back to it, so Waffled won't let you edit or
  delete an imported event. Web and the iPhone/iPad apps hide the Edit and Delete
  actions and say where the event comes from; the API refuses the change whichever
  route it arrives by — the REST endpoints, an offline edit queued on a phone, or
  quick-add ("move the dentist appointment to Friday"). (Allowing it would be a lie:
  the next refresh restamps the event from the feed.) Change it at the source, or
  remove the feed. You *can* still set a local **reminder** on a feed event.
- **Recurring events** expand like any native series. One known limitation: a
  single moved/edited occurrence in the feed (an ICS `RECURRENCE-ID` exception)
  isn't applied — the base series renders as published.
- **Events that leave the feed leave the calendar** — they're soft-deleted on the
  next refresh, and come back if the feed publishes them again. Removing a feed
  removes its imported events too.
- Each feed shows its **last-synced time** and any fetch/parse **error** in the
  Calendars panel; one broken feed never blocks the others.

## Settings
- **Settings → Calendars** — connect Google or Outlook, add calendar feeds, set
  each person's **write-target** calendar, and **"sync now"**.
- **Household settings** — week start, timezone, and location (which also feeds
  weather). Provider sync and feed polling run **server-side**, on a schedule.

## Module
None — Calendar is **core** and never gated. See [Modules](/administration/modules/)
for what can be toggled.

## Notes
- Calendar sync executes **on the server**, not on the device — for Google, Outlook and
  feeds alike — so a device with no network still reads and queues writes through
  PowerSync, and the server reconciles when it next polls.
- The **events** domain is the only one with offline write queueing; every other
  domain (chores, lists, rewards, goals, meals, photos) is REST-backed and needs a
  connection.
