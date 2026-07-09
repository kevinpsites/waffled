---
title: Apple Health → goals
description: Link a goal to Apple Health on iPhone and let steps, flights, exercise minutes, or active energy fill your progress automatically.
---

Link a [goal](/features/goals/) to an Apple Health metric on your iPhone and it fills itself in — no more tapping "+1" after every walk. Steps, flights, exercise minutes, and active energy flow from your iPhone and Apple Watch straight into the goal's progress, and opening the app catches up any days you missed. ❤️

## Highlights

- 🏃 **Four metrics** — **steps**, **flights climbed**, **exercise minutes**, and **active energy** (calories). Apple Watch data counts automatically, because it already syncs into your iPhone's Health.
- 🔁 **Fills itself** — count/total goals accumulate each day's total; a **habit** counts a day whenever it clears a daily threshold you set ("2,000 steps a day, 5 days a week").
- 📆 **Catches up missed days** — open the app after a two-week trip and it back-fills all fourteen days at once. It never pulls data from before the goal existed.
- 🎚️ **Opt-in per goal** — a single toggle in the goal editor's **Extras**, right next to calendar auto-count. Off until you turn it on.
- 🔐 **Permission-aware** — a **Settings → Permissions** screen and an in-goal link help you grant or change Health access.

## Where it works

| Surface | Support |
|---|---|
| iPhone | ✅ |
| iPad | ❌ N/A — displays the synced number only |
| Web / Kiosk | ❌ N/A — displays the synced number only |

Apple's **HealthKit framework exists only on iPhone** — there's no Health data on iPad or the web. So linking and syncing happen on your iPhone; the family iPad and the web/kiosk simply *show* the number your phone synced up ("Jerry: 7,340 / 10,000 steps"). They never read your health data themselves.

## Set it up

1. On your **iPhone**, create or edit a goal whose unit fits a Health metric — e.g. a **total** goal "10,000 steps" or a **habit** "Daily steps."
2. Open the **Extras** section and turn on **Auto-fill from Apple Health**.
3. Pick the metric — **Steps**, **Flights**, **Exercise**, or **Energy**. A short explanation of what each one tracks appears under the picker, and a sensible target is pre-filled.
4. For a **habit** goal, set the daily threshold ("Reach **2,000** steps a day") and the weekly cadence (the goal's "how many days a week" target).
5. Save. The first time, iOS shows Apple's **Health access** sheet — allow the metric you picked. (Apple only asks **once**, ever; see [Managing access](#managing-access) to change it later.)

Progress starts filling on the next app open, and again each time you open Goals or pull-to-refresh.

## How progress is counted

The counting follows the **goal type** — so the same Health data does the right thing whether you're piling up a total or keeping a streak:

- **Total / count** (e.g. "1,000,000 steps this year") — each day's total is added toward your target. Re-syncing a day **replaces** that day's number rather than double-counting it.
- **Habit** (e.g. "2,000 steps a day, 5 days a week") — a day counts as **one completion** when it clears your daily threshold. Days below the threshold don't count, and a day that later drops below what it was (a correction in Health) is un-counted. A manual check-in and an auto one on the same day still count as a single day.

## Catching up missed days

You don't have to open the app every day. Waffled keeps a private, per-goal **"synced-through" marker** on your phone, and on each open it fills in **every day since that marker** — bounded to the last 90 days and never earlier than the day you created the goal. So:

- Away for two weeks → the next open fills all fourteen missed days.
- A late Apple Watch write for a recent day → the last couple of days are re-checked so it still lands.
- Reinstalled the app → it re-catches-up from the 90-day window once (syncing is idempotent, so nothing double-counts).

Because this reconciles on the next open, **background sync isn't required** for your numbers to be correct — it would only keep the *family iPad* fresher on days you never pick up your phone.

## Managing access

Apple prompts for Health access only the **first** time, and never re-reveals or re-asks. To change what Waffled can read afterward:

- **Settings → Permissions** (in the app) lists Apple Health with an **Open** button, or
- iOS **Settings → Privacy & Security → Health → Waffled**.

If you deny access, the goal simply stops receiving Health data — you can still log it by hand. Access granted later resumes from around that moment forward (it doesn't retroactively pull the period while it was denied).

## Notes

- ⌚ **Apple Watch is automatic** — Watch steps, stairs, and workouts sync into iPhone Health on their own, so there's nothing separate to connect.
- 🔒 **Personal by nature** — a health link belongs to the one person whose iPhone it is; it attaches to that person's tracking, not a shared household goal.
- 🛜 **Needs a connection** — goals are online-only (not offline PowerSync), so syncing a day's total requires a live link to your server.
- 🔐 **Your data stays yours** — only the aggregated number (e.g. "7,340 steps") is synced to your self-hosted server; raw Health records never leave your phone.
- 🧭 **More metrics are planned** — activity rings, mindful minutes, and mood, plus a "set a goal from your Health data" picker, are on the [roadmap](https://github.com/kevinpsites/waffled/blob/main/docs/product/roadmap.md) as the next tier.
