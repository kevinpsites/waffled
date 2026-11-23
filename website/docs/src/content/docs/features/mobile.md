---
title: Phone & PWA
description: Use Waffled on a phone or tablet through the web app, installed to the home screen as a PWA.
---

Waffled has no separate mobile app: the web app is built to work on a phone. Open your
server's address in the phone's browser, sign in, and install it to the home screen so it
launches fullscreen like an app. The same build also runs the always-on [kitchen
kiosk](/features/kiosk/).

> The native iOS and Mac apps were removed in 0.16. The web app covers the same ground, minus
> offline editing.

## Install it to the home screen

- **iPhone / iPad (Safari):** Share, then **Add to Home Screen**.
- **Android (Chrome):** the menu, then **Install app** (or **Add to Home screen**).
- **Desktop (Chrome / Edge):** the install icon in the address bar.

Open `http://<host-ip>:8080` on the same network, or your public hostname if you set up a
[reverse proxy](/install/reverse-proxy/). Sign in with your normal Waffled account: email and
password, or SSO if your admin turned it on.

## What works

- The full app: calendar, chores, rewards, goals, lists, meals, pantry, photos and the AI
  [capture bar](/features/capture/) for quick "Add anything" entries on the go.
- Phone layouts for every screen, with the bottom-tab navigation on small screens.
- Everything stays current through the web app's own refresh; there is nothing to sync.

## Good to know

- **It needs a connection.** There is no offline mode: the app reads and writes through the
  server, so a phone away from your network needs a reachable address (a hostname with HTTPS,
  or a VPN such as Tailscale).
- **Camera features need HTTPS.** The barcode scanner and photo capture need a secure context,
  so on a plain `http://` LAN address the browser blocks the camera. Use a hostname with HTTPS
  to get them.
- **No local reminders.** Calendar reminders ride your Google or [Outlook](/administration/outlook-calendar/)
  account's own notifications.
- **Apple Health goal syncing is gone** along with the iOS app; log goal progress in Waffled.
- **Permissions still apply.** The app shows what your account is allowed to see; see
  [Permissions](/concepts/permissions/).
