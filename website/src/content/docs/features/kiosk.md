---
title: Kiosk & display
description: The shared-tablet experience — device pairing, a profile picker, optional PINs, and the ambient screensaver.
---

Kiosk is the ambient-hub half of Waffled — the same web app, running fullscreen on a spare tablet on the kitchen counter, turned into a family command center. Pair a device, pick your profile from a Netflix-style picker, and the app hands you a real per-person session; when nobody touches it, it drifts into a photo screensaver with the clock, weather, and your next event. It's the surface the whole family walks past a hundred times a day. 📺

## Highlights

- 🔗 **Device pairing** — pair with an admin code or a one-tap "use this device"; on iPad, promote a device to kiosk and pair by code in one move. Single-login mode (no pairing) stays the **default**.
- 👥 **Profile picker** — a per-profile picker where claiming a profile mints a **real per-person session** (the device-token model), so each person gets their own scoped view.
- 🔒 **Optional per-person PIN** — 4–8 digits, throttled — a wrong code shows "**N tries left**" (401), and too many trips a short lockout (429, ~30s window).
- 🔁 **Switch & return** — switch profile at any time, and an idle timeout returns the device to the picker on its own.
- 🚪 **Exit / un-pair without signing in** — leave kiosk mode or un-pair the device without needing a login, so a shared tablet is never stuck.
- ☀️ **Keep-awake while displaying** — the screen stays on while it's acting as the hub.
- 🖼️ **Ambient screensaver** — idle auto-start after N minutes, a photo slideshow with crossfade, chrome (clock · date · weather · next event · album), scheduled night dimming, and a live Preview. See [Photos & screensaver](/features/photos/).
- 🌅 **Branded cold-start cover** — a Waffled cover shows while the first sync lands, so a booting tablet never looks broken.

## Where it works

| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ❌ |
| iPad | ✅ |

The web build **is** the kiosk — run it fullscreen (PWA) on any counter tablet. iPad runs the full kiosk experience natively too. iPhone is **never** a kiosk: pairing, the profile picker, PINs, night-dimming, and keep-awake are all N/A there — the iPhone is a personal planner instead (see [Mobile app](/features/mobile/)).

## Settings

**Settings → Display & Kiosk** holds it all — screensaver source, speed, and shuffle; the idle timeout; night-dim schedule; and the live preview. Device **pairing** and per-person **PINs** are configured here too. For the operator's step-by-step how-to, see the [Kiosk & devices](/administration/kiosk/) admin page.

## Module

Kiosk is **core — never gated**. There's no module toggle; the picker and screensaver are always available on a paired device.

## Notes

- 🙋 **Opt-in profile picker** — the shared-kiosk profile picker on iPad is opt-in; a single persistent login stays the default, so you only take on PINs and switching when you actually want them.
- 🧭 **Setup lives elsewhere** — this page is the feature overview; first-run setup, pairing steps, and OIDC config are web/server-only and live in [Kiosk & devices](/administration/kiosk/).
- 🌐 **LAN-served** — run the tablet against your Waffled server's address; if you're serving over TLS, see [Reverse proxy & TLS](/install/reverse-proxy/).
- 🚧 **Offline PWA caching** for the web kiosk is partial/planned — on mobile you get a native app instead of the browser PWA.
