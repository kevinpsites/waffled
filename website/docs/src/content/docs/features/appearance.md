---
title: Appearance & dark mode
description: Choose Light, Dark, or Match system, and a typeface — saved per device.
---

Waffled ships with a **warm dark theme** alongside the original light one. Pick how it looks
from **Settings → Appearance**.

## Choosing a theme
- **Light** — the warm-white canvas Waffled has always had.
- **Dark** — a *warm* dark: soft charcoals rather than cold black-and-blue.
- **Match system** — follow your device's own light/dark setting automatically, including when
  it flips on a schedule (e.g. sundown).

The choice **saves on that device only** and applies **instantly** — no reload, no server
round-trip. Set it once on the kitchen kiosk and once on your phone; they're independent.

## Choosing a typeface
Below the themes, **Typeface on this device** changes the lettering across the whole app. It's
also in **Settings → Display & Kiosk**, so you can set it on the wall tablet itself. Each option
draws a clock, a heading and a line of text in its own typeface, so pick the one you can read from
where you stand:

| Typeface | Font | Good for |
|---|---|---|
| **Classic** | The theme's own | The default look. |
| **Clear** | Lexend | Wide letters and a tall x-height: the easiest to read from across the room. |
| **Hyperlegible** | Atkinson Hyperlegible Next | Every letter is distinct (I l 1, 0 O), for low vision and quick glances. |
| **Friendly** | Nunito | Rounded and warm; the clock and headings stay crisp. |
| **Early reader** | Andika | Single-storey *a* and *g*, the shapes kids learn to write, for new readers. |

Like the theme, the typeface is **saved on that device only**, applies instantly and works with any
theme. The fonts ship with Waffled, so they work with no internet access. Web and kiosk only for now.

## What "warm dark" means
Dark mode isn't just an inversion. Only two things really change:

- **Surfaces and text** move to warm charcoals — the canvas gets darker than the cards, so
  raised surfaces still read as raised (elevation is preserved, just inverted).
- **Pale tints** (the soft backgrounds behind a person's name, a status pill, an AI chip)
  become low-opacity **washes** of the same color instead of solid pastels.

Everything else — the **coral** primary, the **gold** stars, the **violet** AI accent, and each
family member's **personal color** — stays exactly the same in both themes. That's deliberate:
keeping the accent hues fixed is what makes the app still feel like Waffled with the lights off.

## Where it works
| Surface | Support |
|---|---|
| Web / Kiosk | ✅ |
| iPhone / iPad | ✅ |

Dark mode is available on the web, the kitchen kiosk display, and the iPhone/iPad app. The phone
and iPad mirror the exact same warm-dark palette and the same **Settings → Appearance** control
(Light / Dark / Match system, saved per device), so a screen reads the same with the lights off on
your phone as it does on the wall.

## Notes
- **Match system** uses your device/browser's `prefers-color-scheme`; no account setting is
  involved, so each device can differ.
- Looking for the calendar's colors instead? Person colors, the **family color**, and the
  solid-vs-tinted **event style** live with the household, not the device — see
  [Colors on the calendar](/features/calendar/#colors-on-the-calendar).
- Because the preference lives on the device, signing in as a different family member on the
  same kiosk keeps that kiosk's chosen theme.
