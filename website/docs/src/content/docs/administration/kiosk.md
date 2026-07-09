---
title: Kiosk & devices
description: Pair a tablet, set up the profile picker and PINs, manage devices.
---

This is the **operator how-to** for running a tablet as a family kiosk. For the
feature overview (what the kiosk *is*), see [the kiosk feature page](/features/kiosk/).

## You don't have to pair

**Single-login is the default.** A tablet can just **stay signed in** as one account —
no pairing needed. Pairing is only what you do when you want the **Netflix-style
profile picker** so each family member acts as themselves.

## Pair a tablet

Pair in **Settings → Display & Kiosk**, two ways:

1. **Pairing code** — an admin mints a **one-time pairing code** and enters it on the
   tablet.
2. **"Use this device" / promote** — turn the current admin session's browser into a
   kiosk in **one tap**.

On iPad, both work: **one-tap promote** and **pair-by-code**.

Under the hood, a paired device holds a **long-lived secret** that it exchanges for a
**short-lived device token** — so the tablet stays paired without a stored password.

## The profile picker

Once paired, the tablet shows the profile picker. **Tapping a profile mints a real
per-person session** — everything that person does is attributed to them (see
[Permissions & roles](/concepts/permissions/)).

### Per-person PIN

You can set an optional **PIN (4–8 digits)** on a person in **Settings**. PIN entry is
**throttled**: it shows **"N tries left"** and then a lockout.

| Env var | Default | Meaning |
|---|---|---|
| `KIOSK_PIN_MAX_ATTEMPTS` | `5` | Tries before lockout |
| `KIOSK_PIN_LOCKOUT_SECONDS` | `30` | Lockout duration |

## Manage devices

In **Settings → Display & Kiosk** you can:

- **List** paired devices
- **Rename** a device
- **Revoke** a device

**Exiting kiosk mode / un-pairing needs no sign-in** — you can always drop a tablet
back out of kiosk mode from the device itself.

## Screensaver

Screensaver settings (source, speed, shuffle, idle timeout, night-dim, preview) are
configured here too. See [Photos & screensaver](/features/photos/) for what each
setting does.

## Real-device tips

- Set the tablet's **server address** to the **Mac/host LAN IP**, and make sure
  **`POWERSYNC_PUBLIC_URL` matches** it — see
  [Reverse proxy & TLS](/install/reverse-proxy/). A mismatch shows an **"Offline"**
  banner (see [Troubleshooting](/operations/troubleshooting/)).
- **Web camera / barcode scanning** needs a **secure context** — HTTPS or `localhost`.
- **iPhone is never a kiosk** — kiosk mode is for tablets.
- 🚧 **PWA offline caching** for the web kiosk is partial/planned.

## See also

- [Users & members](/administration/users/) — create the profiles that show in the picker
- [Photos & screensaver](/features/photos/) — screensaver configuration
- [Reverse proxy & TLS](/install/reverse-proxy/) — get the server address right
- [Troubleshooting](/operations/troubleshooting/) — fix the "Offline" banner
