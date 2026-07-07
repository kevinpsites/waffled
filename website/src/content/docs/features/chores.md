---
title: Chores & tasks
description: The assignable Tasks board — recurring or one-off chores that pay out stars on completion.
---

Chores are the assignable Tasks board: recurring or one-off jobs that award stars (or any currency you invent) when someone finishes them, with optional parent approval and photo proof. It's the *earn* half of the family economy — every completed chore feeds the ledger behind [Rewards](/features/rewards/). Kids can see what's theirs, grab what's up for grabs, and watch a streak climb 🔥.

## Highlights

- ✅ **Recurring or one-off** — weekly/custom schedules pick specific weekdays (RRULE under the hood), or mark a task **"Just once"** with a due date.
- 🔁 **Carry-over** — an unfinished one-off rolls forward with an **overdue·since** badge; per-chore rollover toggle, default **on**.
- 🙋 **Up-for-grabs** — leave a chore unassigned and anyone can **claim** it; drag between columns to reassign.
- 🧒 **Family rings on Today** plus a full Tasks board (on iPad it's a wrapping Kanban).
- ✅ **Complete → award** — daily instances flip done and pay out the chore's currency/amount.
- 🔥 **Streaks** — N consecutive days, shown right on the chore.
- ✔️ **Parent approval** — flag a chore `requires_approval` and completion goes *awaiting* → approve/reject (gated by `chore.approve`).
- 📸 **Photo proof** — per-chore **"Requires a photo"**; snap or pick on complete, review thumbnail → large → **Approve / Not yet**; proof auto-deletes after N days.

## Where it works

| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ✅ |
| iPad | ✅ |

Same board everywhere — on iPad the Tasks board becomes a wrapping **Kanban** with drag-to-reassign between columns.

## Settings

**Settings → Chores & rewards** holds the household-wide knobs: currencies, conversion rates, and the **proof retention window** (`settings.chores.proofTtlDays`, default **3**, clamped 0–365; set **0** to keep proof forever). A stored-proof gallery lets admins view, delete, or clear all saved photos.

Each chore carries its own: reward currency + amount, due time, **requires-approval**, **requires-photo**, and **rollover** (default on).

## Module

Optional module `chores`, default **on** — toggle it in **Settings → Modules**. Turning it off hides the Tasks board, the chores Today card, and the nav entry — and disables [Rewards](/features/rewards/), which is a sub-toggle of chores.

## Notes

- 🔒 **Capability-gated where it has stakes** — `chore.manage` (create for others, edit/delete) and `chore.approve` (approve/reject). Anyone may add a chore **for themselves** or **up-for-grabs**, and anyone may complete or claim. See [Permissions](/concepts/permissions/) for the full capability model.
- 📶 **REST-only, not offline** — chores don't ride PowerSync; they're kept fresh by the in-app refresh bus, so they need a live connection.
- 🗑️ **Proof photos are throwaway** — they're verification, not memories, and are meant to be deleted after review.
