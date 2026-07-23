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
| Waffled-Bites | **OFF** | Kid companion device pairing + control panel — 🚧 pending hardware bring-up, [details](/features/waffled-bites/) |
| Quotes | 🚧 planned | Not togglable yet |

## Rewards is not its own module

**Rewards** is a **sub-toggle of Chores** (`settings.chores.rewards`, default **on**),
not a standalone module. It can **never** be on without Chores — turn Chores off and
rewards goes with it.

## One flag, both clients

The on/off flag is **server-side and shared**, so **both web and iOS** honor it. Each
client renders its own **native UI**, though — a module that has no iOS screen simply
**doesn't appear on iOS**, gracefully, rather than showing a broken entry.

## Data note: offline vs online-only on iOS

A module that must work **offline on iOS** needs its tables in the **PowerSync sync
rules**. Without that, it's **online-only REST** (this is how **Chores** works today —
it's REST-only on iOS). Keep this in mind when deciding whether a module is truly
usable offline on the phone.

## Building a new module

If you're a developer adding a module rather than an operator toggling one, see
[Building a module](/concepts/extensibility/) for the factory pattern, the module
gate, and how routes/nav/Today cards get wired up.

## See also

- [Permissions & roles](/concepts/permissions/) — who can toggle and use each module
- [Kiosk & devices](/administration/kiosk/) — how modules appear on a paired tablet
- [System health](/administration/system-health/) — confirm services are healthy
