---
title: Set up a kitchen kiosk
description: Turn a spare tablet into an always-on family display.
---

You'll end up with a wall- or counter-mounted tablet showing the hub, with a
Netflix-style profile picker and an ambient photo screensaver — the always-on
family display Waffled is built around.

This guide stitches together a few reference pages; follow it top to bottom and
cross-link out for the deep detail.

## 1. Make the server reachable from the tablet

A kiosk tablet talks to the server over your network, so the server has to be reachable at a
real address — not `localhost`. On a home network that is just the host's LAN IP on the
published port (`http://192.168.1.20:8080`); reserve that IP in your router so it doesn't
change. For a hostname and HTTPS, see [Reverse proxy & TLS](/install/reverse-proxy/).

## 2. Open the app on the tablet

On the tablet's browser, open:

```
http://<your-host>:8080
```

Then **Add to Home Screen** (or use the browser's fullscreen/PWA mode) so it
launches chromeless like a native app.

## 3. Pair the device

Open **Settings → Display & Kiosk** and pair the tablet one of two ways:

- **Pairing code** — an admin mints a one-time code; enter it on the tablet.
- **Promote this device** — tap **"use this device"** to promote it directly.

Pairing unlocks the **profile picker**: tapping a profile mints a real,
person-scoped session. Prefer one shared login? **Single-login (no pairing)** is
the default and works fine too. Full walkthrough:
[Kiosk & devices](/administration/kiosk/).

## 4. (Optional) Add per-person PINs

For the picker, give each person a **4–8 digit PIN** on their card so switching
profiles is gated. See [Kiosk & display](/features/kiosk/).

## 5. Configure the ambient screensaver

Still in **Settings → Display & Kiosk**, set up the screensaver that kicks in
after the idle timeout:

- **Source** — all photos, favorites, or a specific album.
- **Interval** — how long each photo shows.
- **Night dimming** — dim the display during quiet hours.

Details and album setup: [Photos & screensaver](/features/photos/).

## 6. Pick the right device

- **Any tablet** — the web PWA works great: iPad, Android, or a Fire tablet.
- **A phone is never a kiosk** — it's a personal device, not a shared display.

## Verify

You're done when, on the tablet:

- The hub loads with real data (not an empty screen or a connection error).
- The **profile picker** appears (if you paired).
- The **screensaver** kicks in after the idle timeout.

## Notes

- Web **camera / barcode scanning** needs HTTPS or `localhost` — plain
  `http://<ip>` won't grant camera access. Use a hostname with auto-TLS (see
  [Reverse proxy & TLS](/install/reverse-proxy/)) if you want scanning on a web
  kiosk.
- More on device pairing and sessions:
  [Kiosk & devices](/administration/kiosk/) and
  [Kiosk & display](/features/kiosk/).
