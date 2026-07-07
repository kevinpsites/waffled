---
title: Rewards & economy
description: The spend half of the chores economy — a stars ledger, per-kid shop, and approved redemptions.
---

Rewards is the *spend* half of the family economy: an append-only stars ledger, a per-kid reward shop, and parent-approved redemptions. It gives [Chores](/features/chores/) a payoff and teaches kids to save toward something they want. Earn stars by doing jobs, then trade them in — with a grown-up's OK where it matters. 🎉

## Highlights

- 📒 **Append-only earn ledger** with per-person, per-currency balances — nothing is silently overwritten.
- 🛒 **Reward shop** (per person) — a purple wallet hero (**"{NAME}'S {CURRENCY}"**, "N to go for {saving-toward}"), cost-badge tiles with **locked / affordable** states, a Redeem confirm sheet, and confetti on the way out.
- 🗂️ **Categories** — treats / screen / adventures / toys / privileges, filterable and set per reward.
- 💱 **Multi-currency** — custom currencies with symbols and colors, plus conversions ("**Trade**", e.g. 10 ⭐ → 1 💵).
- 🎯 **Saving-toward** — pin a reward per person, rendered as **bar or jar** progress with inline redeem; any household member can set it (kids pick their own).
- ✨ **Spot-award** — a parent hands out ad-hoc stars untied to any chore (optional note, no balance guard); the ledger row reads **"spot award — {reason}"**.
- ✔️ **Redeem → approve → debit** — redemptions go through parent approval before the ledger is debited.

## Where it works

| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ✅ |
| iPad | ✅ |

The **Rewards tab *is* the shop** on every surface — a person-tab strip picks whose shop and balance you're looking at.

## Settings

**Settings → Chores & rewards** — the same panel that configures chores holds your **currencies** and **conversion rates**. Per-reward settings (cost, category, saving-toward) live on each reward.

## Module

Rewards is a **sub-toggle of chores** (`settings.chores.rewards`, default **on**), flipped in **Settings → Modules**. It can never be on without [Chores](/features/chores/) — so a shop always has a way to earn.

## Notes

- 🏺 **"Rewards jar"** is the saving-toward jar/bar progress UI, **not** a separate object — it's just how a pinned reward renders.
- 🔒 **Capability-gated where it has stakes** — `reward.manage` (catalog, currencies, conversions), `reward.approve` (redemptions), `reward.grant` (spot-awards). Anyone may **redeem for themselves** and convert their own balance. See [Permissions](/concepts/permissions/).
- 🚧 **Milestone reward payouts** are deferred — the design is done, but auto-paying a [Goals](/features/goals/) milestone into the ledger hasn't shipped yet.
