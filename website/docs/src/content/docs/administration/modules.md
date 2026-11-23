---
title: Modules
description: Turn optional features on or off per household.
---

Waffled ships a small core plus a set of **optional features** you can turn on or off
**per household**. Toggle them in **Settings → Modules** (owner/admin only).

Enabling a module surfaces its **Today card**, its **nav entry**, and its **routes**.
Turn it off and those disappear. **Calendar** and **Today** are core and are **never
gated**.

## The module catalog

| Module | Default | What it is |
|---|---|---|
| Pantry | **OFF** | On-hand inventory |
| Chores | ON | Tasks & stars |
| Goals | ON | Goal tracking |
| Meals | ON | Recipes & planning |
| Lists | ON | Lists & groceries |
| Family Night | OFF | Recurring gathering |
| Rhythms | **OFF** | The things that should keep happening — [details](/features/rhythms/) |
| Weekly Planning | **OFF** | A guided session for deciding the week ahead — [details](/features/weekly-planning/) |
| Waffled-Bites | **OFF** | Kid companion device pairing + control panel — 🚧 running on the real board, not yet something you can buy, [details](/features/waffled-bites/) |
| Quotes | 🚧 planned | Not togglable yet |

## Rewards is not its own module

**Rewards** is a **sub-toggle of Chores** (`settings.chores.rewards`, default **on**),
not a standalone module. It can **never** be on without Chores — turn Chores off and
rewards goes with it.

## One flag for everyone

The on/off flag is **server-side and shared**: every client of the household honors it, and a
disabled module simply doesn't appear, rather than showing a broken entry.

## Building a new module

If you're a developer adding a module rather than an operator toggling one, see
[Building a module](/concepts/extensibility/) for the factory pattern, the module
gate, and how routes/nav/Today cards get wired up.

## See also

- [Permissions & roles](/concepts/permissions/) — who can toggle and use each module
- [Kiosk & devices](/administration/kiosk/) — how modules appear on a paired tablet
- [System health](/administration/system-health/) — confirm services are healthy
