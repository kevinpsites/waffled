---
title: Comparison
description: How Waffled compares to Cozi, Skylight, Google, and rolling your own.
---

There are a lot of ways to run a family's logistics. Most are a **cloud service you rent** or
a **piece of hardware you buy**. Waffled is neither: it's software **you host**, on a machine
you already own, with the data staying in your house.

This page is an honest look at where Waffled fits — and where one of the alternatives might
suit you better.

## What makes Waffled different

- **Self-hosted, no subscription.** Runs as a small Docker stack on any always-on machine
  (an old laptop, a NUC, a Raspberry Pi). No monthly fee, no per-seat pricing, no account
  with a third party.
- **Your data stays yours.** One Postgres database you control. No ads, no analytics selling,
  no vendor that can change the terms or shut the product down.
- **One hub, many things.** Calendar *and* chores *and* meals *and* lists *and* goals *and*
  photos *and* a kitchen kiosk — not a single-purpose app you glue to five others. And each
  one goes deep: chores with **photo proof**, streaks and parent approvals; goals that track
  habits and auto-fill from **Apple Health**; recipes with a full **cook mode** (step-by-step,
  per-step timers); lists you can save as reusable **templates**; a pantry with a real
  **barcode scanner**.
- **Adds on, doesn't replace.** Waffled **syncs two-way with the Google Calendar you already
  use** — keep your existing calendar and let Waffled be the family layer on top, instead of
  migrating everyone to something new.
- **Turn a tablet you already own into the display.** Any spare iPad or Android tablet becomes
  the always-on kitchen kiosk — no dedicated hardware to buy, no screen locked to a
  subscription.
- **Three surfaces, one source of truth.** The same data drives that always-on kitchen
  **kiosk**, a full **web** dashboard, and a native **iOS** app that works offline.
- **AI that stays yours.** The capture bar, meal planning and recipe import all use AI — but it
  runs on a provider *you* choose (a local model, or your own API key). Your family's data is
  never sent to our servers, or to any vendor you didn't pick.
- **AGPL open source, and built to build on.** Read it, fork it, extend it. Features ship
  off-by-default as toggleable **modules**, and a scoped **public API** lets you wire Waffled
  into your own automations. You decide what your household runs.

## The trade-off, stated plainly

Self-hosting means **you run the server**. That's the whole point — and the whole cost. You
need a machine that stays on, a few minutes to `./waffled up`, and the willingness to own your
backups. If you'd rather someone else keep the lights on and you're comfortable renting that,
a hosted product is a reasonable choice. Waffled is for people who want the opposite.

## Where each alternative fits

| | **Waffled** | **Cozi** | **Skylight / Hearth** | **Google (Family/Calendar)** | **Notion / spreadsheet** |
|---|---|---|---|---|---|
| Model | Self-hosted software | Cloud service (free, ads; paid Gold) | Hardware + subscription | Cloud service (free) | Cloud service / DIY |
| Cost | Free (your hardware/power) | Free with ads / ~annual for Gold | Device + yearly plan | Free | Free–paid |
| Your data | On your machine | On their servers | On their servers | On their servers | On their servers |
| Kitchen display | ✅ **Any tablet you own**, no hardware to buy | 📱 App only | ✅ Their screen (buy it) | 📱 App only | ❌ |
| Calendar | ✅ Its own, **+ two-way Google sync** (adds on, doesn't replace) | ✅ | ✅ | ✅ (it *is* Google) | ⚠️ Manual |
| Chores + reward economy | ✅ Stars, approvals, shop, **photo proof**, streaks | ⚠️ Basic lists | ⚠️ Chore charts | ❌ | ⚠️ DIY |
| Goals + habit tracking | ✅ Count / total / habit / checklist, **Apple Health** auto-fill | ❌ | ❌ | ❌ | ⚠️ DIY |
| Meals → auto grocery list | ✅ | ⚠️ Recipe box + lists | ⚠️ Meal planner | ❌ | ⚠️ DIY |
| Recipes + **cook mode** | ✅ In-app recipes, AI import, step-by-step + per-step timers | ⚠️ Recipe box | ⚠️ Meal planner | ❌ | ⚠️ DIY |
| Lists | ✅ Custom multi-lists + reusable **templates** | ✅ Lists | ⚠️ Basic | ⚠️ Keep | ⚠️ DIY |
| Pantry / inventory | ✅ **Barcode scanner** + allergens | ❌ | ❌ | ❌ | ⚠️ DIY |
| Photos + screensaver | ✅ | ❌ | ✅ (photo frame) | 📱 Google Photos | ❌ |
| AI features | ✅ **Your model / key, or fully local** — never our cloud | ❌ | ❌ | ⚠️ Gemini (their cloud) | ⚠️ Their cloud |
| Build on it / open API | ✅ Public scoped API + toggleable modules | ❌ | ❌ | ❌ | ⚠️ API only |
| Native offline app | ✅ iOS (PowerSync) | ✅ | ⚠️ | ✅ | ⚠️ |
| Ads / tracking | None | Ads (free tier) | — | Ads elsewhere in ecosystem | — |
| Open source | ✅ AGPL-3.0 | ❌ | ❌ | ❌ | ❌ |

*⚠️ = partial or via a workaround; 📱 = phone/app only, no shared display.*

### Cozi
The closest "does a bit of everything" family app, and genuinely good for a shared calendar +
lists. But it's an ad-supported cloud product with a paid tier to remove ads, no kitchen-display
mode, and none of the depth Waffled goes for: no reward economy or **photo-proof chores**, no
**habit/goal tracking**, no **cook mode**, no pantry with a barcode scanner, no open API, and no
self-hosting. Waffled trades "install nothing" for "own everything."

### Skylight Calendar / Hearth Display
Beautiful dedicated wall screens — and that's the pitch: **buy the hardware, pay the yearly
plan**. Waffled turns *any* tablet you already have into that always-on display, for free, and
keeps the data local — and behind the display sits far more app (goals, cook mode, a barcode
pantry, an open API) than a fixed-function screen offers. If you specifically want a polished
physical device with support and don't mind the subscription, the hardware products are a fine
choice.

### Google Calendar / Family
Excellent calendar, ubiquitous, free — and Waffled **syncs with it two-way** rather than
replacing it. What Google doesn't give you is the family operating system around the calendar:
chores + stars, meal planning that builds a grocery list, a pantry, a shared kitchen kiosk. Use
both: keep Google as your calendar backbone and let Waffled be the hub on top.

### Notion / a spreadsheet
Infinitely flexible, and plenty of families run their life in one. The cost is that *you build
and maintain everything* — every chore chart, every rollover rule, every reward ledger — and it
still lives on someone else's cloud. Waffled is the opinionated, purpose-built version of that
spreadsheet, running on your own hardware.

## Still deciding?

- Want the shortest path to trying it? → [Quick start](/getting-started/quick-start/)
- Want to see everything it does first? → [Feature matrix](/reference/features/)
- Curious *why* self-hosted / how it's built? → [Architecture](/developer/architecture/)
