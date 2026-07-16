---
title: Apple Health → goals
description: Link a goal to Apple Health on iPhone and let steps, distance (walking, cycling, swimming, wheelchair), workouts by type, activity rings, mindful minutes, or your mood fill your progress automatically.
---

Link a [goal](/features/goals/) to an Apple Health metric on your iPhone and it fills itself in — no more tapping "+1" after every walk. Steps, exercise, mindful minutes, your Apple Watch rings, even your mood flow from your iPhone and Apple Watch straight into the goal's progress, and opening the app catches up any days you missed. ❤️

## Highlights

- 🏃 **Lots of metrics** — **steps**, **flights climbed**, **exercise minutes**, **active energy** (calories), **distance** for **walking & running** (hikes included), **cycling**, **swimming**, and **wheelchair** (miles or kilometers), **workouts by type** (running / cycling / swimming / yoga / strength training — or any workout), **mindful minutes**, your **activity rings** (Move / Exercise / Stand, or all three), and **your mood** (iOS 17+). Apple Watch data counts automatically, because it already syncs into your iPhone's Health.
- 🏊 **Track one activity, three ways** — a workout metric can add up **minutes** ("300 minutes of yoga this year"), count **sessions** ("swim 12 times this month"), or keep a **habit** ("work out 5 days a week" — any session counts the day, or require at least N minutes). Prefer laps or miles? Swim and cycling **distance** are metrics of their own.
- 🔁 **Fills itself** — numeric goals accumulate each day's total; a **habit** counts a day whenever it clears a daily threshold you set ("2,000 steps a day, 5 days a week"); rings and mood count a day when the ring closes or you log a mood.
- 🔎 **Set a goal from your Health data** — not sure what to track? Tap **See your Health data** to see your live value for each metric and build a goal around it in one tap.
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

1. On your **iPhone**, create or edit a goal — e.g. a **total** goal "10,000 steps" or a **habit** "Daily steps."
2. Open the **Extras** section and turn on **Auto-fill from Apple Health**.
3. Tap the **Counting** card to open the **Track from Apple Health** picker (searchable, grouped to fit your goal). A total or count goal shows what **adds up** — **Everyday** (steps, flights, exercise, energy), **Distance** (walk + run, cycling, swimming, wheelchair), **Workouts** (by type — minutes on a total, sessions on a count), and **Mindfulness**; count goals also offer the rings and mood as *met days* toward a target ("close it 15×"). A **habit** shows what can **count a qualifying day** — your **Apple Watch rings**, **logged each day** (mood, a mindful session), **workout days**, and **daily targets** (steps a day, miles a day…). A short explanation of what each one tracks appears under the card, and a sensible target is pre-filled.
4. For a numeric **habit** (e.g. steps), set the daily threshold ("Reach **2,000** steps a day"); ring and mood habits skip this — they're simply met or not. A **workout habit** picks how a day qualifies: **any workout counts**, or **at least N minutes**. Then set the weekly cadence (the goal's "how many days a week" target).
5. Save. The first time, iOS shows Apple's **Health access** sheet — allow the metric you picked. (Apple only asks **once**, ever; see [Managing access](#managing-access) to change it later.)

Progress starts filling on the next app open, and again each time you open Goals or pull-to-refresh.

### Or start from your Health data

Not sure what to track? In the same **Extras** section, tap **See your Health data →**. It reads your **current value for every supported metric** — "Steps 7,340 today," "Exercise ring: done today," "Mood: not yet today" — and tapping one builds the goal around it (choosing the right goal type and target for you). It only ever shows the metrics Waffled supports, after a permission request — never everything in your Health app.

## How progress is counted

The counting follows the **goal type**, so the same Health data does the right thing whether you're piling up a total or keeping a streak:

- **Total / count** (e.g. "1,000,000 steps this year") — each day's total is added toward your target. Re-syncing a day **replaces** that day's number rather than double-counting it.
- **Habit — numeric** (e.g. "2,000 steps a day, 5 days a week") — a day counts as **one completion** when it clears your daily threshold. Days below don't count, and a day that later drops below (a correction in Health) is un-counted. A manual check-in and an auto one on the same day still count as a single day.
- **Habit — rings & mood** — a day counts when the ring **closes** (you met your own Apple Watch goal for it) or you **log a mood** that day. "All rings" needs Move, Exercise, and Stand all closed. There's no number to set — it's simply met or not.
- **Count — rings & mood** (e.g. "close my Exercise ring **15×** this month," "log my mood **20 days**") — instead of a streak, each met day adds **one** toward a running count. Open days add nothing, and a day later corrected (a ring that turns out not to have closed) drops back out on its own. Pick a **count** goal, turn on a ring or mood metric, and set the target to how many days you're aiming for.
- **Workouts by type** — reads your actual **workout sessions** (from your Apple Watch or iPhone), filtered to the activity you picked: running, cycling, swimming, yoga, or strength training (traditional *and* functional), or **any workout**. On a **total** it adds up the **minutes**; on a **count** it counts the **sessions**; on a **habit** a day qualifies with any session — or only past a minutes threshold, your choice. Unlike exercise minutes or the combined distance totals, this distinguishes *what* you did — a bike ride, a treadmill run, and an elliptical session are no longer one big number.

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
- 🔁 **Switching metrics starts the auto-fill fresh** — re-linking a goal to a *different* metric clears the previous metric's auto-filled progress (the same yoga session must never count twice when "at least 30 min" becomes "any workout counts"). Manual entries always stay, **unlinking** keeps everything already earned, and re-linking the *same* metric just picks up where it left off.
- 🔐 **Your data stays yours** — only the aggregated number (e.g. "7,340 steps") is synced to your self-hosted server; raw Health records never leave your phone.
- ⏳ **Mood needs iOS 17+** — mood uses Apple's *State of Mind*, which only exists on iOS 17 and later.
- 📏 **Distance uses your region's units** — every distance metric (walk + run, cycling, swimming, wheelchair) reads in **miles** or **kilometers** to match your iPhone's region setting, and is tracked to a decimal (e.g. "3.2 mi today") rather than rounded. Walk + run covers all your walking and running, hikes included.
- 🏊 **Swim laps** — Apple Health stores swims as distance and strokes, not laps, so track swim **distance** (a lap is one pool length) or swim **sessions** instead.
- 🧭 **What's still coming** — graduated ring goals (e.g. "hit 75% of my Move ring," using the ring's underlying percentage rather than a plain closed/not-closed), background sync (to keep the family iPad fresh on days you never open your phone), and a rewards tie-in are on the [roadmap](https://github.com/kevinpsites/waffled/blob/main/docs/product/roadmap.md); everything above works today.
