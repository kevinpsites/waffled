---
title: Overview
description: What Waffled is, its two surfaces, and the core ideas behind it.
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

You run it yourself, with **zero external dependencies** required: download one
`compose.yaml` and `docker compose up -d` brings up the [Docker install](/install/docker/).
Everything optional (AI providers, Google Calendar, SSO, push) is opt-in via configuration.

## Two surfaces, one web app

| Surface | Role | Notes |
| --- | --- | --- |
| **Counter Kiosk** | Always-on tablet (1280×800) in the kitchen | Same web build in fullscreen/PWA mode; ambient screensaver; profile picker + optional PINs |
| **Web / PWA** | Full management & setup dashboard, and the phone experience | The React SPA served by the `waffled` app; first-run setup wizard, all admin/settings; installable to a phone's home screen |

The Kiosk and Web are the **same application** (the "Web / Kiosk" column in the feature
matrix). There is no separate native client: the Mac and iOS apps were removed in 0.16.

## Core ideas

- **One household, one source of truth.** A Postgres database is authoritative. Every
  request is scoped to a household via a JWT (`sub → identity → person → household`).
- **Self-hosted, portable.** Two containers: the `waffled` app (api in lambda-api /
  TypeScript, which also serves the web app and media) and Postgres, started by one
  compose file. Build from source or pull the multi-arch image from GHCR.
- **Pluggable AI.** The "Add anything" bar and the meal/recipe/calendar AI features run
  through one provider interface — Anthropic, OpenAI-compatible, or a local Ollama model —
  chosen per household in Settings. Keys live only in the server env; the app degrades to
  a deterministic on-device heuristic when no provider is configured.
- **Bring your own identity (optionally).** Built-in email/password auth out of the box;
  attach any OpenID-Connect provider later (invite-gated) without touching features.
- **Yours to extend.** Optional features are toggleable **modules**, and a scoped public REST
  API (admin-issued keys) lets external tools read and write your data. Nothing is held back
  behind a paid tier.

## Where to go next

- Ready to install? → [Quick start](/getting-started/quick-start/)
- Want the full capability list? → [Feature matrix](/reference/features/)
- Curious how it grows? → [Extensibility & modules](/concepts/extensibility/)
- Tracking progress? → the [roadmap status](https://github.com/evan-ribbey/waffled-remix/blob/main/docs/product/roadmap.md)
