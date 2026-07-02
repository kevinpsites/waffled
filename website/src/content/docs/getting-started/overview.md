---
title: Overview
description: What Kinnook is, its three surfaces, and the core ideas behind it.
---

## What Kinnook is

Kinnook is a **self-hosted family operating system**. One household, one source of truth for
everything a family coordinates day to day:

- 📅 **Calendar** with optional two-way Google Calendar sync
- ✅ **Chores & stars** with a full earn → redeem → approve economy
- 🎯 **Goals & rewards** (individual and shared)
- 🍽️ **Meals & recipes** with an auto-built grocery list
- 🧺 **Lists & groceries** (aisle-grouped, meal-aware)
- 🖼️ **Photos & memories** with an ambient screensaver
- ✨ An **AI "Add anything" capture bar** that routes natural language to the right place

You run it yourself — `git clone` + `docker compose up` — with **zero external
dependencies** required. Everything optional (AI providers, Google Calendar, SSO, push)
is opt-in via configuration.

## The three surfaces

| Surface | Role | Notes |
| --- | --- | --- |
| **Counter Kiosk** | Always-on tablet (1280×800) in the kitchen | Same web build in fullscreen/PWA mode; ambient screensaver; profile picker + optional PINs |
| **Web** | Full management & setup dashboard | The React SPA served by Caddy; first-run setup wizard, all admin/settings |
| **iOS** | Native Swift/SwiftUI capture companion | Offline-first read + write over PowerSync; native sign-in + local notifications |

The Kiosk and Web are the **same application** (this is the "Web / Kiosk" column in the
feature matrix); iOS is a separate native client (the "Mobile" column).

## Core ideas

- **One household, one source of truth.** A Postgres database is authoritative. Every
  request is scoped to a household via a JWT (`sub → identity → person → household`).
- **Self-hosted, portable.** A small Docker Compose stack: Postgres · PowerSync · api
  (lambda-api / TypeScript) · Caddy. Build from source or pull multi-arch images from GHCR.
- **Offline-first where it matters.** PowerSync mirrors data to local SQLite so the iOS
  app and the kiosk's calendar keep working through network blips and reconnect cleanly.
- **Pluggable AI.** The "Add anything" bar and the meal/recipe/calendar AI features run
  through one provider interface — Anthropic, OpenAI-compatible, or a local Ollama model —
  chosen per household in Settings. Keys live only in the server env; the app degrades to
  a deterministic on-device heuristic when no provider is configured or you're offline.
- **Bring your own identity (optionally).** Built-in email/password auth out of the box;
  attach any OpenID-Connect provider later (invite-gated) without touching features.

## Where to go next

- New to running it? → [Quick start](/getting-started/quick-start/)
- Want the full capability list? → [Feature matrix](/reference/features/)
- Curious how it grows? → [Extensibility & modules](/concepts/extensibility/)
- Tracking progress? → the [roadmap status](https://github.com/OWNER/nook/blob/main/docs/product/roadmap.md)
