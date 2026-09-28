---
title: Overview
description: What Waffled is, its three surfaces, and the core ideas behind it.
---

## What Waffled is

Waffled is a **self-hosted family operating system**. One household, one source of truth for
everything a family coordinates day to day:

- 📅 **Calendar** with optional two-way Google or Outlook sync, plus read-only ICS feeds
- ✅ **Chores & stars** with a full earn → redeem → approve economy
- 🎯 **Goals & rewards** (individual and shared)
- 🍽️ **Meals & recipes** with a step-by-step cook mode and an auto-built grocery list
- 🧺 **Lists & groceries** (aisle-grouped, meal-aware, saveable as templates)
- 🥫 **Pantry** with a barcode scanner, low-stock/expiry nudges, and allergen warnings *(optional module)*
- 🔁 **Rhythms** — the things that should keep happening (the air filter, trash night, a quarterly visit), with one place to confirm each is handled *(optional module)*
- 🖼️ **Photos & memories** with an ambient screensaver
- ✨ An **AI "Add anything" capture bar** that routes natural language to the right place

You run it yourself, with **zero external dependencies** required: on a Mac with Apple
silicon, [download Waffled for Mac](/install/mac/) and open it — no Docker, no Terminal;
anywhere else, `git clone` + `./waffled up` brings up the [Docker install](/install/docker/).
Everything optional (AI providers, Google Calendar, SSO, push) is opt-in via configuration.

## The three surfaces

| Surface | Role | Notes |
| --- | --- | --- |
| **Counter Kiosk** | Always-on tablet (1280×800) in the kitchen | Same web build in fullscreen/PWA mode; ambient screensaver; profile picker + optional PINs |
| **Web** | Full management & setup dashboard | The React SPA served by Caddy; first-run setup wizard, all admin/settings |
| **iOS (iPhone + iPad)** | Native universal SwiftUI app — a personal planner on iPhone, a family hub on iPad | [Free on the App Store](https://apps.apple.com/app/waffled/id6787621452); offline-first calendar over PowerSync; native sign-in + local notifications; an iPad can double as the kiosk |

The Kiosk and Web are the **same application** (the "Web / Kiosk" column in the feature
matrix); iOS is a separate native client — one universal binary whose iPhone and iPad
experiences are the matrix's "iPhone" and "iPad" columns.

## Core ideas

- **One household, one source of truth.** A Postgres database is authoritative. Every
  request is scoped to a household via a JWT (`sub → identity → person → household`).
- **Self-hosted, portable.** One server — Postgres · PowerSync · api (lambda-api /
  TypeScript) · Caddy — run two ways: as a small Docker Compose stack (build from source or
  pull multi-arch images from GHCR), or natively by the [Mac app](/install/mac/), which
  carries all four inside one download. Same api, same migrations, same web app.
- **Offline-first where it matters.** PowerSync mirrors data to local SQLite so the iOS
  app and the kiosk's calendar keep working through network blips and reconnect cleanly.
- **Pluggable AI.** The "Add anything" bar and the meal/recipe/calendar AI features run
  through one provider interface — Anthropic, OpenAI-compatible, or a local Ollama model —
  chosen per household in Settings. Keys live only in the server env; the app degrades to
  a deterministic on-device heuristic when no provider is configured or you're offline.
- **Bring your own identity (optionally).** Built-in email/password auth out of the box;
  attach any OpenID-Connect provider later (invite-gated) without touching features.
- **Yours to extend.** Optional features are toggleable **modules**, and a scoped public REST
  API (admin-issued keys) lets external tools read and write your data. Nothing is held back
  behind a paid tier.

## Where to go next

- On a Mac? → [Mac install](/install/mac/)
- Anywhere else? → [Quick start](/getting-started/quick-start/)
- Want the full capability list? → [Feature matrix](/reference/features/)
- Curious how it grows? → [Extensibility & modules](/concepts/extensibility/)
- Tracking progress? → the [roadmap status](https://github.com/kevinpsites/waffled/blob/main/docs/product/roadmap.md)
