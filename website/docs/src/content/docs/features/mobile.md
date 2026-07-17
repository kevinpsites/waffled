---
title: Mobile app
description: Waffled's native iOS companion — a personal planner on iPhone, a family-hub kiosk on iPad, with an offline-first calendar.
---

![The native iOS app — the Today screen with events, countdowns and tonight’s dinner](/screenshots/iphone-home.png)

Mobile is Waffled's native iOS companion — one universal SwiftUI binary that is a personal planner on your iPhone and a family-hub kiosk on your iPad, chosen automatically by the device. It's built for capture on the go and an always-on counter display, with a calendar that keeps working through network blips. Sign in once, and the app points itself at your own Waffled server. 📱

## Get the app

<a href="https://apps.apple.com/app/waffled/id6787621452" rel="noopener"><img src="/app-store-badge.svg" alt="Download on the App Store" width="168" height="56" /></a>

Waffled is a **free download on the App Store** — one universal app for iPhone and iPad. Install it, enter your server's address (see [Settings](#settings) below), and sign in with your normal Waffled account. The app talks only to *your* server — there's no Waffled cloud account.

## Highlights

- 📱 **One universal app, two idioms** — iPhone gets the personal-planner idiom (bottom tabs); iPad gets the family-hub idiom (side rail, wide layouts + screensaver) — picked automatically by device idiom, no separate download.
- 🔐 **Native sign-in** — email/password plus OIDC SSO through a web auth session, a Keychain token store, and silent 401 refresh so you stay signed in.
- 📅 **Offline-first calendar** — the calendar reads and writes through a local SQLite mirror with queued writes (PowerSync), so it survives network blips and reconnects cleanly.
- 🌐 **Fresh everywhere else** — chores, rewards, goals, lists, meals, pantry, and photos are online REST, kept current by an in-app refresh bus.
- 🔔 **Local event reminders** — scheduled straight from the events mirror with no push server (64-pending cap).
- 📷 **Native pickers & scanner** — a native photo picker (PHPicker) and a native barcode scanner (AVFoundation) for Pantry.
- ✨ **AI capture bar** — the "Add anything" bar with an on-device heuristic that keeps working offline.
- 🖼️ **Full iPad kiosk** — on iPad you get the whole kiosk experience: profile picker, PIN, and the screensaver with an iOS-only Ken-Burns slow-zoom. See [Kiosk & display](/features/kiosk/).

## Where it works

| Surface | Support |
|---|---|
| iPhone | ✅ |
| iPad | ✅ |

On **iPhone** the app is a personal planner — bottom tabs, capture-first. On **iPad** it's a family hub and kiosk — side rail, wide layouts, and the screensaver. Web/Kiosk users are on the web app instead; this page is the mobile surface, so see the rest of the docs (starting with [Kiosk & display](/features/kiosk/)) for the browser experience.

## Settings

In-app **Settings → About** holds the **server address** — point the app at your Waffled server's base URL (your machine's LAN IP or hostname; see [Reverse proxy & TLS](/install/reverse-proxy/)). Notifications are local, under **Settings → Notifications**.

## Module

The app renders native screens for whatever modules are **enabled server-side** — a module with no iOS screen simply doesn't appear (it degrades gracefully). Calendar and Today are always present. Module toggles themselves live in the web app's Settings → Modules.

## Notes

- 🌊 **Only the calendar is truly offline** — the events domain reads/writes through blips; everything else needs a connection.
- 🚧 **Chore reminders are blocked** until chores join the PowerSync schema — chores are REST-only on iOS today, so they can't yet schedule local reminders like [Calendar](/features/calendar/) events do.
- 🛡️ **Server-side capabilities still apply** — the app shows what your account is allowed to see; see [Permissions](/concepts/permissions/).
- 🍏 **Distribution** — shipped via the [App Store](https://apps.apple.com/app/waffled/id6787621452) (Xcode Cloud builds; pre-release builds via TestFlight). Bundle id `app.waffled`.
