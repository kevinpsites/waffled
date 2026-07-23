---
title: Waffled-Bites
description: Pair a kid's companion touchscreen device and control it from Family — quiet time, night light, wake-up light, sound machine, and more.
---

Waffled-Bites is a kid-facing companion device — a small touchscreen that sits in their room showing their routines, a quiet-time timer, a night light, and a gentle wake-up light — paired one-per-child and controlled by a parent from **Family → tap the kid → Waffled-Bite**. 🧇

**Where things stand today:** the pairing system, the parent control panel, and the on-device app are all built, and real-hardware bring-up on the target touchscreen is underway — including on-device WiFi setup and dozens of reboot tests confirming the WiFi connection holds up. Some rough edges remain (no over-the-air updates yet, a few missing icon assets), so this isn't yet something you can buy and plug in, but it's running on the real device, not just a desktop simulator. Everything below describes the intended experience.

## Highlights

- 🔗 **One device per kid, code-paired** — mint a short one-time code from the kid's profile page and enter it on the device; no shared picker, the device is fixed to that one child.
- 🟢 **Online status at a glance** — the control panel shows whether the device has checked in recently, or when it was last seen if it hasn't.
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
| iPhone | ✅ |
| iPad | ✅ |

The parent control panel is available on web, iPhone, and iPad — pair once from any of them, control from any of them.

## How pairing works

1. Turn the Waffled-Bite device on and connect it to Wi-Fi — the device scans for nearby networks and lets you pick one and enter the password right on its own screen. Picked the wrong network, or moving the device somewhere new? A "Change Wi-Fi network" option on the next screen takes you back to the picker — no reflash needed.
2. On web, iPhone, or iPad, open **Family → the kid → Waffled-Bite → Pair a Waffled-Bite**. This mints a short, one-time code (10-minute window).
3. Enter the code on the device. Once it claims the code, the control panel appears automatically — no refresh needed.

> This flow is proven end-to-end against the real backend, including on the physical touchscreen device. See the status note at the top of this page for what's still rough around the edges.

The device polls the server every few seconds for changes (settings, remote quiet-time/timer commands) rather than holding an always-open connection — simple, and plenty fast for a kid's room.

:::caution[If the device seems stuck, don't press the reset button — power-cycle it instead]
If the screen freezes, gets stuck on "Connecting to Wi-Fi," or otherwise stops responding, **don't use the device's reset button.** It doesn't fully restart the Wi-Fi hardware, so the device can come back up unable to find or connect to any network — stuck on a blank network list with no way to recover except powering it off.

Instead: turn the device off (or unplug it), wait about **10 seconds**, then turn it back on. A real power-off/power-on always recovers it.
:::

## Module

Waffled-Bites is an **optional module** (`waffledBites`, default **OFF**), toggled in **Settings → Modules**. Turn it on to see the Waffled-Bite section on a kid's profile page.

## Notes

- 👶 Devices pair to a specific child, not the household — there's no shared profile picker like [Kiosk](/features/kiosk/) uses for a communal tablet.
- ⭐ Task completion on the device is just a chore completion under the hood, so it shows up in the same stars ledger, streaks, and rewards as chores completed anywhere else — see [Chores & tasks](/features/chores/) and [Rewards & economy](/features/rewards/).
- 🔨 **Real-hardware bring-up is underway.** The on-device app (ESP32-P4 + LVGL) is code-complete and verified against the real backend, and has been bring-up tested on the actual board — display, touch, and on-board Wi-Fi all confirmed working on real silicon, including dozens of reboot tests. Remaining gaps: no over-the-air updates yet, and a few icon assets are still text-only. See the [product roadmap](https://github.com/kevinpsites/waffled/blob/main/docs/product/roadmap.md) for status.
