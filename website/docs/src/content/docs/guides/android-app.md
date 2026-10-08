---
title: Install the Android app
description: Connect the native Android app to your Waffled server on a phone, an emulator, or a shared kitchen tablet.
---

Waffled has a native Android app for phones and tablets. Like the iPhone and iPad apps it
talks only to **your** server — there is no Waffled cloud account — and it keeps your
calendar and family list available offline. On a phone it is a personal planner with
bottom tabs; on a tablet it can also run as a shared kiosk.

Health Connect auto-fill for goals (the Android counterpart of
[Apple Health → goals](/features/apple-health/)) is **not** in this release.

## 1. Get the app onto the device

Install the Waffled APK on the phone or tablet. Android asks you to allow installs from
the app you opened it with the first time.

## 2. Point it at your server

On the sign-in screen, tap **Server: … · Change** at the bottom, enter your server's base
address (with its port, if it has one), and tap **Use this server**. Then sign in with your
normal Waffled account (email and password, or SSO if your server has it on). Once you are
signed in you can change it later under **Settings → About**.

| Where the app runs | Server address to enter |
| --- | --- |
| A real phone or tablet on your Wi-Fi | `http://<your-server-LAN-IP>:8080` (or your hostname) |
| The Android Studio emulator, server on the same computer | `http://10.0.2.2:8080` |
| Anywhere on the internet | `https://your-hostname` |

Inside the emulator, `localhost` means the emulator itself. `10.0.2.2` is how it reaches
the computer it runs on.

### Plain `http://` is for your home network only

The app accepts a plain `http://` address only when it is a **home-network address**
(a private LAN IP in the `10.x.x.x`, `172.16–31.x.x` or `192.168.x.x` ranges, loopback, or a `.local` name; the emulator's
`10.0.2.2`). For anything on the public internet it insists on `https://`.

> **Warning.** Plain `http://` sends your password and session in the clear. That is fine
> on a network you trust. Do not forward a plain-HTTP port to the internet; put the server
> behind [a reverse proxy with TLS](/install/reverse-proxy/) instead.

If the app loads but everything says **Offline**, the server is advertising a sync address
the device cannot reach (usually `localhost`). Use the server's LAN address — see
[Troubleshooting](/operations/troubleshooting/).

## 3. Allow what you want to use

Android asks for each permission the first time a feature needs it:

- **Notifications** — for event reminders. They are scheduled on the device from your
  calendar, with no push server involved. Decline and reminders simply don't fire.
- **Microphone** — only for dictation in the "Add anything" capture bar. Typing always works.

## 4. (Tablet) Use it as a shared kiosk

A tablet can sit on the counter as the family display, the same as an iPad:

1. Sign in as an admin, then open **Settings → Display & Kiosk**.
2. Pair the tablet with a one-time code, or promote the tablet directly.
3. The **profile picker** appears; give each person an optional 4–8 digit PIN to gate it.
4. Set the photo **screensaver** source, interval and night dimming.

The full walkthrough, which applies to every kind of tablet, is
[Set up a kitchen kiosk](/guides/kitchen-kiosk/); the pairing model is in
[Kiosk & devices](/administration/kiosk/). A phone is never a kiosk.

## Which features are there?

Almost everything the iPhone and iPad apps do; see the
[Android availability](/reference/features/#android-availability) table.
