# Nook — Family Hub

A shared family operating system rendered across three surfaces:

- **Counter Kiosk** — always-on tablet (1280×800), full read/write, ambient display. Runs as the web app in fullscreen/PWA mode.
- **iOS app** — native Swift/SwiftUI capture companion. Offline-first (read + write).
- **Web app** — full management/setup dashboard. Static SPA on S3 + CloudFront.

One household, one source of truth: calendar (2-way Google sync), chores & stars,
goals & rewards, meals & recipes, lists, photos, and an AI "Add anything" capture bar.

## Repo layout

```
infra/
  terraform/   AWS + Auth0 as code
  compose/     self-hosted runtime (Postgres, PowerSync, api, worker, Caddy, backup)
apps/
  api/         backend (lambda-api), shares image with worker
  worker/      calendar sync, cron, recurring chores, recap, APNs
  web/         React SPA (also the kiosk layout)
  kiosk/        kiosk PWA shell (thin wrapper over web)
ios/           native Swift app
packages/      shared types + design tokens
docs/          ARCHITECTURE.md (decision record)
```

## Start here

1. Read `docs/ARCHITECTURE.md` — the decisions and why.
2. Work `BOOTSTRAP.md` — one-time console setup (Google, Apple, Auth0, AWS) that produces the secrets IaC consumes.
3. Follow `ROADMAP.md` — bite-sized, committable chunks, in order.

## The stack in one breath

Self-hosted Docker Compose now (portable to managed later via env swap) · Postgres
system-of-record · PowerSync for iOS offline · Auth0 for identity (Google + Apple) ·
Google Calendar authoritative for Google-origin events, Nook authoritative for native
fields · 2–5 min calendar polling · Tailscale ingress now, public ingress when we
onboard non-household users · Terraform + Compose, everything in this repo.
