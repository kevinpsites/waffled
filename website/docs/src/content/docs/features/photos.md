---
title: Photos & memories
description: A shared family photo wall plus the ambient screensaver that turns an idle kiosk into a rotating photo frame.
---

![The photos gallery — family albums that double as the kiosk screensaver](/screenshots/photos.png)

Photos is your family's shared wall of memories — and the visual identity of an idle counter tablet. Upload the photos everyone loves, sort them into albums, then point the ambient screensaver at one so the kitchen kiosk turns into a rotating photo frame between glances. It's the calm, glanceable face of the whole app. 🖼️

## Highlights

- 🧱 **Family wall** — an aspect-preserving grid of everyone's photos, one shared surface for the whole household.
- ⬆️ **Upload anything** — downscaled JPEG with a 10 MB cap; multi-upload with a per-photo **caption · album · favorite**; the native PHPicker on iOS and a **drag-and-drop zone** on web.
- 🗂️ **Albums** — filter chips built from each photo's album, so you can jump straight to "Cabin 2025" or "Birthdays".
- ✏️ **Edit a photo** — caption, album, date (→ `takenAt`), and favorite, all in place.
- ✅ **Multi-select** — bulk **move-to-album** or **delete**, plus a per-tile delete with a confirm.
- 📺 **Screensaver source** — set an album (or favorites, or everything) as the ambient slideshow; a photo-only **"Play"** slideshow runs with no chrome at all.
- 🍳 **Shared pipeline** — recipe hero images ride the same upload path, so what you learn here works over in [Meals & recipes](/features/meals/).

## Where it works

| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone | ⚠️ |
| iPad | ✅ |

Drag-and-drop upload is **web-only** — iPhone and iPad use the native picker instead. The screensaver's ambient **chrome** (clock · date · weather · next event · album name) shows on Web and iPad; iPhone offers only a bare manual **"Play"** with no chrome. Slow-zoom (Ken-Burns) motion is **iOS-only**.

## Settings

**Settings → Display & Kiosk** — the screensaver reads from your household's kiosk/display config:

- **`photoSource`** — `all` · `favorites` · `album` (default **all**), with **`photoAlbum`** naming the album when you pick `album`.
- **`photoShuffle`** — randomize order (default **off**).
- **`photoInterval`** — seconds between photos (default **10**, clamped **3–120**).
- **`nightDim`** — `{ enabled` default **off**`, start 22:00, end 07:00 }` so the tablet dims overnight.
- **Idle auto-start** — the screensaver kicks in after N idle minutes, with a **live Preview** right in settings.

## Module

Photos and the screensaver are **core — never gated**. There's no module toggle; the wall and the ambient frame are always available.

## Notes

- 🌤️ **Weather in the chrome** comes from Open-Meteo — no API key required.
- 📱 **iPhone is deliberately lean** — it gets the wall, upload, and a chrome-free "Play", but not the ambient clock/weather/event overlay. Reach for [Kiosk & display](/features/kiosk/) on a tablet for the full frame.
- 🎞️ **Ken-Burns slow-zoom is iOS-only** — the web screensaver crossfades without the zoom.
- 🚧 **Shared-album import** (Google Photos / iCloud) is planned — for now, upload lands photos directly.
