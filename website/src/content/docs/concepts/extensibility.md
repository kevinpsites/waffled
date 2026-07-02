---
title: Extensibility & modules
description: How Kinnook grows — built-in toggle modules and external integrations.
---

How features get added to Kinnook beyond the core app, and how self-hosters / the
community can build on top of it. Two supported patterns; a third we deliberately
avoid.

## The three patterns

| | **A — built-in toggle module** | **B — external integration** | **(C) true in-process plugin** |
|---|---|---|---|
| Where the code runs | *Inside* Kinnook (ships in the image) | A *separate* program / container | Loaded into the running Kinnook server |
| Who writes it | Contributed to Kinnook's source (PR or fork) | Anyone, independently | A third party, no fork |
| Its UI | Renders **inside** Kinnook (Today card, a tab) | Its **own** separate window/app (or headless) | Inside Kinnook |
| How a household "gets" it | Toggle it on in Settings → Modules | Run the program + paste an API key | (n/a) |
| Status | **Supported** | **Supported** (needs API keys, below) | **Not pursued** |

**Key constraint that decides everything:** an external program (B) can never render
UI *inside* Kinnook's own screens. It has its own UI or runs headless, and talks to Kinnook
only through the REST API. (This is exactly how Immich works — immich-frame, immich-go,
Home-Assistant integrations, etc. are all *external apps using an API key*; Immich has
**no** in-process plugin system. So "Immich plugins" == pattern B.)

**Decision rule for any new feature:** *Does it need to appear inside Kinnook's own
interface (a Today card, a tab) or reach into other Kinnook features (meals, persons)?*
- **Yes → built-in toggle module (A).** To share it with others, contribute it to the
  repo (ships off-by-default; each household toggles it on). "Contribute" ≠ "must be
  officially blessed" — it just has to be in the codebase people run (official or a fork).
- **No (it can stand on its own UI or run headless) → external integration (B).** Publish
  your standalone app/script; others point it at their Kinnook with an API key.

We do **not** build (C), a runtime plugin loader (dynamic third-party code inside the
server). It needs sandboxing/versioning/security machinery that's overkill and risky for
a family hub — and Immich itself doesn't attempt it. A + B cover the same ground.

## Kinnook's strategy

1. **Pluggable optional modules + a "Modules" settings tab (pattern A).** Core stays lean;
   optional/personal/community features ship in the app but are **opt-in per household**.
   A module = a registry entry + (usually) a table or two + API routes + a Today card
   and/or a nav screen. Enablement lives in `households.settings.modules` (jsonb, same
   pattern as onboarding); the catalog is a static list known to both backend and web;
   Today cards, nav entries, and routes **gate** on whether the module is enabled.
2. **Per-user API keys + scopes (pattern B).** The integration surface for external tools
   (see the roadmap "Public API" entry). Lets the operator — and the people they share
   with — build their own integrations. Built-in modules should also expose their data over
   the API so external tools can *feed* them.

### Web vs iOS
The on/off flag is **server-side and shared** (`households.settings.modules`), so both
clients know which modules are enabled — no duplicate config. But **each platform renders
its own native UI**: a module's web card is React; its iOS card is Swift. Enabling a module
surfaces it on whichever client has implemented it (a module with no iOS screen simply
doesn't show on iOS — graceful). Data: a module that needs to work **offline on iOS** must
add its tables to the **PowerSync** sync rules; otherwise iOS uses the **REST** endpoints
(online-only), like chores do today.

So the framework gives: **one shared toggle + shared API/data + per-client native UI** —
which matches how Kinnook is already built (the API is the contract; web and iOS are
independent consumers).

## First modules (Kevin's use cases)
All three want to live *inside* Kinnook (Today card / tabs / meal-plan integration), so all
three are **pattern A** (built-in, toggle-able). External companions can *feed* them via
API keys (B) once that ships.

- **Pantry / food inventory** (first to build) — on-hand items beyond "expected staples,"
  with quantities + locations; feeds meal planning ("use this soon," leftovers) and ties to
  grocery (buy → stock, cook → deplete). Broadly useful → likely core-tier. B bonus: update
  from a barcode-scanner script.
- **Family Night** (SHIPPED web 2026-07-01) — a recurring (default Mon) family gathering with a
  fully generic, customizable agenda of "parts" that auto-rotate among members (override per
  week) + a Today card + an optional weekly calendar event. Kept generic (no faith presets) so
  it fits any family; renamed from the earlier "Family Home Evening (FHE)" concept.
- **Daily quote / snippet** — preloadable daily content on the Today tab; smallest module
  (a `quotes` table + a card + import) and the cleanest A+B demo (external source posts the
  day's quote via API key).
