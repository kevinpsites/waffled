# Nook documentation

Nook is a **self-hosted family hub** — a shared operating system for a household's
calendar, chores, goals, meals, lists, photos, and an AI "add anything" capture bar —
rendered across an always-on kitchen **kiosk**, a full **web** app, and a native **iOS**
app, all backed by one Postgres source of truth you run yourself with Docker Compose.

This folder is the **product/user documentation** (Immich-style). For engineering
internals see the sibling docs: [`../ARCHITECTURE.md`](../ARCHITECTURE.md),
[`../DATA_MODEL.md`](../DATA_MODEL.md), [`../TESTING.md`](../TESTING.md),
[`../RECIPE_FORMAT.md`](../RECIPE_FORMAT.md), and the project plan in
[`../../ROADMAP.md`](../../ROADMAP.md).

## Contents

| Page | What's inside |
| --- | --- |
| [Overview](./overview.md) | What Nook is, the three surfaces, the core ideas |
| [Quick start](./quick-start.md) | `git clone` → `./nook up` → first-run setup; adding people; SSO; Google Calendar |
| [**Feature support matrix**](./features.md) | **Every feature and whether it's supported on Web/Kiosk vs Mobile** (the headline doc) |
| [Roadmap status](./roadmap.md) | What's done, partial, and planned |

## Legend (used throughout)

| Symbol | Meaning |
| :---: | --- |
| ✅ | Supported |
| 🟡 | Partial / limited |
| 🚧 | Planned (on the roadmap, not built) |
| ❌ | Not supported / not applicable |
| ⬜ | Not yet assessed (left for the mobile owner to fill in) |

> **Surfaces.** "**Web / Kiosk**" is the React app — the same build powers the always-on
> tablet kiosk and a desktop browser. "**Mobile**" is the native iOS app. The Web/Kiosk
> column is filled in here; the Mobile column is intentionally left **⬜** for the mobile
> owner to complete.
