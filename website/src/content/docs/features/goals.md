---
title: Goals
description: Personal and family goal tracking with progress, streaks, milestones, and calendar auto-counting.
---

Goals turn intentions into visible progress. Track **count**, **total**, **habit**, or **checklist** goals — for one person or the whole family — with milestones, streaks, and an activity feed. Some goals even count themselves: tag a [Calendar](/features/calendar/) event and its occurrences roll into the total automatically. 🎯

## Highlights

- 📊 **Four goal types** — count, total, habit, checklist — each with type-aware logging (amount, stepper, once-a-day, tick steps).
- 👪 **Lists + membership** — shared or individual, with two tracking modes: **shared_total** (one pooled number) or **each_tracks** (everyone counts their own).
- 🕰️ **Backdated logs** — a **"When?"** picker so yesterday's run still counts.
- 🏁 **Milestones** — per-type thresholds with an emoji, label, and reward text; checklists get **named steps**.
- 🔍 **Goal detail** — a milestone track, hours-by-person, streaks, and recent activity.
- 👤 **Person profile + Family overview** — see one person's goals or the whole household at a glance.
- 📅 **Calendar auto-count** — a single-event recap, smart **"might count toward a goal"** suggestions that learn over time, and recurring-event counting (via Calendar's **"counts toward a goal"** tag).
- ❤️ **Apple Health auto-fill (iPhone)** — link a goal to steps, flights, exercise minutes, or active energy and progress fills itself, including days you didn't open the app. See [Apple Health → goals](/features/apple-health/).

## Where it works

| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ✅ |
| iPad | ✅ |

Full parity across surfaces — the same goal types, logging, and milestone views everywhere.

## Settings

No dedicated settings panel — everything is configured **per goal** (type, milestones, list membership, tracking mode) when you create or edit it.

## Module

Optional module `goals`, default **on** — toggle it in **Settings → Modules**.

## Notes

- 🎚️ **The milestone axis differs by type** — habit tracks **streak days**, checklist tracks **step %**, and count/total track raw **progress**. Same milestone concept, different yardstick.
- 🔒 **Capability-gated where it touches someone else** — `goal.manage` covers logging for others and editing/deleting shared or others' goals; your **own** progress and personal goals stay open. See [Permissions](/concepts/permissions/).
- 📶 **REST-only, not offline** — goals don't ride PowerSync, so logging needs a live connection.
- ❤️ **Apple Health is iPhone-only** — HealthKit doesn't exist on iPad or the web, so linking and syncing happen on iPhone; every surface just *displays* the synced number. Full walkthrough: [Apple Health → goals](/features/apple-health/).
