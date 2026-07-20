---
title: Waffled-Bites
description: Pair a kid's companion touchscreen device and control it from Family — quiet time, night light, wake-up light, sound machine, and more.
---

Waffled-Bites is a kid-facing companion device — a small touchscreen that sits in their room showing their routines, a quiet-time timer, a night light, and a gentle wake-up light — paired one-per-child and controlled by a parent from **Family → tap the kid → Waffled-Bite**. 🧇

**Where things stand today:** the pairing system and the parent control panel described below are built and shipped. The physical Waffled-Bite device (a small touchscreen, running its own on-device app) is a separate, still-in-development project — so there's nothing to pair with yet. This page describes the parent-side half of the feature; the device firmware will follow.

## Highlights

- 🔗 **One device per kid, code-paired** — mint a short one-time code from the kid's profile page and enter it on the device; no shared picker, the device is fixed to that one child.
- 🌙 **Live quiet-time control** — start, pause, add 5 minutes, or end a stay-in-room countdown right from your phone or the web, and watch it count down.
- 💡 **Night light** — pick a color and brightness.
- 🌅 **Wake-up light schedule** — set per-day-of-week rules; the light glows yellow a few minutes before wake time, then green when it's okay to get up.
- ⏰ **Morning alarm** — a time and a gentle tone.
- 🔊 **Sound machine** — white noise / ocean / rain and friends, with a volume and an auto-off sleep timer.
- 🔆 **Screen & display** — daytime brightness and an auto-dark-at-night option.
- 📣 **Nudges** — send a quick message ("dinner is ready") that shows as a banner on the device.
- 🧩 **Reuses your existing chores** — the device's routine/task list is just your household's chores, grouped into morning / afternoon / evening windows by their due time (unscheduled chores show under a general bucket); completing one on the device awards stars through the same ledger as everywhere else.

## Where it works

| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ❌ N/A (not yet built) |
| iPad | ❌ N/A (not yet built) |

The control panel is web-only for now; a mobile control panel is planned as a fast-follow once the web version has proven the shape out.

## How pairing works

1. Turn the Waffled-Bite device on and connect it to Wi-Fi (device-side, once the device firmware ships).
2. On the web app, open **Family → the kid → Waffled-Bite → Pair a Waffled-Bite**. This mints a short, one-time code (10-minute window).
3. Enter the code on the device. Once it claims the code, the control panel appears automatically — no refresh needed.

The device polls the server every few seconds for changes (settings, nudges, remote quiet-time commands) rather than holding an always-open connection — simple, and plenty fast for a kid's room.

## Module

Waffled-Bites is an **optional module** (`waffledBites`, default **OFF**), toggled in **Settings → Modules**. Turn it on to see the Waffled-Bite section on a kid's profile page.

## Notes

- 👶 Devices pair to a specific child, not the household — there's no shared profile picker like [Kiosk](/features/kiosk/) uses for a communal tablet.
- ⭐ Task completion on the device is just a chore completion under the hood, so it shows up in the same stars ledger, streaks, and rewards as chores completed anywhere else — see [Chores & tasks](/features/chores/) and [Rewards & economy](/features/rewards/).
- 🔨 The physical device and its on-device app are tracked separately — see the [product roadmap](https://github.com/kevinpsites/waffled/blob/main/docs/product/roadmap.md) for status.
