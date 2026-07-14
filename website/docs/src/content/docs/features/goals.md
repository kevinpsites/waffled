---
title: Goals
description: Personal and family goal tracking with spotlight tiers, measure-aware group counting, milestones, streaks, and calendar auto-counting.
---

![Goals in Waffled — personal and family goals with progress](/screenshots/goals.png)

Goals turn intentions into visible progress. Track **count**, **total**, **habit**, or **checklist** goals — for one person or the whole family — with milestones, streaks, and an activity feed. Each list has one **Spotlight** hero and any number of **Pinned** favourites so the goals that matter stay up top. Some goals even count themselves: tag a [Calendar](/features/calendar/) event and its occurrences roll into the total automatically. 🎯

## Highlights

- 📊 **Four goal types** — count, total, habit, checklist — each with a **type-aware Log sheet** (amount, a count stepper, once-a-day habit, or ticking named steps, with the right unit).
- 🌟 **Spotlight · Pinned · More** — every goal list has **one Spotlight** (the big hero card), any number of **Pinned** goals in a band at the top, then everything else as compact **A–Z rows**. Set the tier from a **Spotlight / Pinned / Normal** picker when you create or edit a goal (choosing Spotlight tells you which goal it replaces), or **pin/unpin in one tap right on a card**.
- 👪 **Lists + membership** — shared or individual, with two tracking modes: **one shared total** (everyone feeds one pooled number) or **each tracks their own** (a per-person target, e.g. "read 12 books *each*").
- 🧮 **Measure-aware group counting** — for a shared goal, a short follow-up under *"How do you measure it?"* asks how a group activity should count, with a worked example using your family's names. A **total** can have *everyone's counts fully* (2 people × 1 hr → +2 hrs) or *split across who took part* (1 hr together → +1 hr); a **count** can *count for each person* (3 at the park → +3) or *count the activity once* (→ +1, the people are just who came).
- ✏️ **Fix a mistaken entry** — every line in a goal's Recent activity can be **edited** (amount, **who took part**, note, date) or **deleted**; a shared/split entry is removed as a whole and re-splits correctly when you change who was there.
- 🏠 **Today goal card** — the home dashboard shows a chosen goal's progress. Pick **My spotlight**, **Family spotlight**, or a **specific goal** from a grouped picker (goals grouped by list, "My goals" first) — on web and iPhone.
- 🕰️ **Backdated logs** — a **"When?"** picker so yesterday's run still counts.
- 🏁 **Milestones** — per-type thresholds with an emoji, label, and reward text; checklists get **named steps**.
- 🔍 **Goal detail** — a milestone track, hours-by-person, streaks, and recent activity.
- 👤 **Person profile + Family overview** — see one person's goals or the whole household at a glance.
- 📅 **Calendar auto-count** — a single-event recap, smart **"might count toward a goal"** suggestions that learn over time, and recurring-event counting (via Calendar's **"counts toward a goal"** tag).
- ❤️ **Apple Health auto-fill (iPhone)** — link a goal to steps, exercise, mindful minutes, your Apple Watch rings, or your mood and progress fills itself, including days you didn't open the app. See [Apple Health → goals](/features/apple-health/).

## Where it works

| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ✅ |
| iPad | ✅ |

Full parity across surfaces — the same goal types, logging, and milestone views everywhere.

## Settings

No dedicated settings panel — everything is configured **per goal** (type, tier, milestones, list membership, tracking mode, and how a group activity counts) when you create or edit it.

## Module

Optional module `goals`, default **on** — toggle it in **Settings → Modules**.

## Notes

- 🔤 **The goals list reads top-down: Spotlight → Pinned → More (A–Z).** Within the Pinned band and the More rows, goals are alphabetical by title — so the order is predictable, not "random by creation date." (Manual drag-to-reorder of the Pinned band is still on the roadmap.)
- 🎚️ **The milestone axis differs by type** — habit tracks **streak days**, checklist tracks **step %**, and count/total track raw **progress**. Same milestone concept, different yardstick.
- 🧮 **Group counting only appears when it can matter** — the *"how does a group activity count?"* follow-up shows only for a shared goal with more than one person and a measure that has a per-person dimension (a total or a count); a checklist's steps are always shared, so it never asks.
- 🔒 **Capability-gated where it touches someone else** — `goal.manage` covers logging for others and editing/deleting shared or others' goals; your **own** progress and personal goals stay open. See [Permissions](/concepts/permissions/).
- 📶 **REST-only, not offline** — goals don't ride PowerSync, so logging needs a live connection.
- ❤️ **Apple Health is iPhone-only** — HealthKit doesn't exist on iPad or the web, so linking and syncing happen on iPhone; every surface just *displays* the synced number. Full walkthrough: [Apple Health → goals](/features/apple-health/).
