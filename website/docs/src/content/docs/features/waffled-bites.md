---
title: Waffled-Bites
description: Pair a kid's companion touchscreen device and control it from Family — quiet time, night light, wake-up light, sound machine, and more.
---

Waffled-Bites is a kid-facing companion device — a small touchscreen that sits in their room showing their routines, a quiet-time timer, a night light, and a gentle wake-up light — paired one-per-child and controlled by a parent from **Family → tap the kid → Waffled-Bite**. 🧇

**Where things stand today:** the pairing system, the parent control panel, and the on-device app are all built. The catch — the on-device app has only run in a desktop simulator so far, against the real backend, not on the actual physical touchscreen: the target hardware has never been in hand for a real bring-up. So this feature is **pending hardware validation**, not yet something you can buy and plug in. Everything below describes the intended experience once that's done.

## Highlights

- 🔗 **One device per kid, code-paired** — mint a short one-time code from the kid's profile page and enter it on the device; no shared picker, the device is fixed to that one child.
- 🌙 **Live quiet-time control** — start, pause, add 5 minutes, or end a stay-in-room countdown right from your phone or the web, and watch it count down.
- 💡 **Night light** — pick a color and brightness.
- 🌅 **Wake-up light schedule** — set per-day-of-week rules; the light glows yellow a few minutes before wake time, then green when it's okay to get up.
- ⏰ **Morning alarm** — a time and a gentle tone.
- 🔊 **Sound machine** — white noise / ocean / rain and friends, with a volume and an auto-off sleep timer.
- 🔆 **Screen & display** — daytime brightness and an auto-dark-at-night option.
- ⏱️ **Set a timer** — a countdown either a parent or the kid can start, pause, add time to, or end, right on the device.
- 🛌 **Bedtime preview** — a full-screen glow at the nightlight's real color and brightness, so a kid can see what "lights out" looks like before it locks in for the night.
- 🧩 **Reuses your existing chores** — the device's routine/task list is just your household's chores, grouped into morning / afternoon / evening windows by their due time (unscheduled chores show under a general bucket); completing one on the device awards stars through the same ledger as everywhere else.

## Where it works

| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | 🚧 Coming soon |
| iPad | 🚧 Coming soon |

The control panel is web-only for now; an iOS control panel is coming soon, planned as a fast-follow once the web version — and the physical device — have proven the shape out.

## How pairing works

1. Turn the Waffled-Bite device on and connect it to Wi-Fi (device-side; Wi-Fi provisioning is still hardcoded for development, a real setup UI comes with hardware bring-up).
2. On the web app, open **Family → the kid → Waffled-Bite → Pair a Waffled-Bite**. This mints a short, one-time code (10-minute window).
3. Enter the code on the device. Once it claims the code, the control panel appears automatically — no refresh needed.

> This flow is proven end-to-end against the real backend — but only with the on-device app running in a desktop simulator, not the physical touchscreen. See the status note at the top of this page.

The device polls the server every few seconds for changes (settings, remote quiet-time/timer commands) rather than holding an always-open connection — simple, and plenty fast for a kid's room.

## Module

Waffled-Bites is an **optional module** (`waffledBites`, default **OFF**), toggled in **Settings → Modules**. Turn it on to see the Waffled-Bite section on a kid's profile page.

## Notes

- 👶 Devices pair to a specific child, not the household — there's no shared profile picker like [Kiosk](/features/kiosk/) uses for a communal tablet.
- ⭐ Task completion on the device is just a chore completion under the hood, so it shows up in the same stars ledger, streaks, and rewards as chores completed anywhere else — see [Chores & tasks](/features/chores/) and [Rewards & economy](/features/rewards/).
- 🔨 **Pending real-hardware bring-up.** The on-device app (ESP32-P4 + LVGL) is code-complete and has been verified against the real backend, but only inside a desktop simulator — the target board has never been in hand for an actual bring-up, so things like the display driver and on-board Wi-Fi haven't been confirmed on real silicon yet. See the [product roadmap](https://github.com/kevinpsites/waffled/blob/main/docs/product/roadmap.md) for status.
- 📱 **iOS control panel — coming soon.** Web ships first; iOS is planned as a fast-follow.
