# Logo

`waffled-logo-source.png` (1254×1254, opaque RGB, no alpha) is a higher-resolution
version of the Waffled mark than `apps/web/public/logo.png` (512×512) — supplied
directly by the user for a crisper on-device bake, particularly for the boot
screen's bigger logo (see below). Same mark, not a redesign.

## Removing the background

The source has a flat cream background (`#F8F1E9`) baked in, not real transparency —
showing it on-device drew a visible box around the mark instead of it sitting
directly on the app's own cream background. Direct request to fix this. Chroma-keyed
with ffmpeg's `colorkey` filter, tuned tight enough to leave the mark's own
near-white/cream body intact (its cream is only ~10-12 RGB units away from the
background — a much smaller margin than `tools/mascot/`'s source, which is why this
needed a lower similarity than that one), then alpha-blurred slightly to smooth the
source's subtle paper-grain texture (visible as static in the transparent regions
otherwise — checked by compositing onto solid magenta, the worst case; it's
imperceptible once composited onto the app's actual cream background, which is much
closer to the source's own tones):

```sh
ffmpeg -i waffled-logo-source.png -filter_complex \
  "[0:v]colorkey=0xF8F1E9:0.012:0.02,format=rgba[keyed];[keyed]alphaextract,format=gray,gblur=sigma=1.5[a];[0:v]format=rgba[rgb];[rgb][a]alphamerge" \
  logo_transparent.png
```

Resized to each needed size with alpha preserved (`sips` silently drops alpha on
some resizes — `ffmpeg scale` doesn't):

```sh
ffmpeg -i logo_transparent.png -vf "scale=96:96"   logo_96_alpha.png
ffmpeg -i logo_transparent.png -vf "scale=40:40"   logo_40_alpha.png
ffmpeg -i logo_transparent.png -vf "scale=160:160" logo_160_alpha.png
```

## Baking

Baked as an LVGL 9 **ARGB8888** `lv_image_dsc_t` (`src/icons/wb_logo_{40,96,160}.c`,
declared in `src/icons/wb_icons.h`) with `png_to_lvgl_argb8888.py` — unlike the
opaque `png_to_lvgl_rgb565.py` version this replaced, this one carries a real alpha
channel per pixel so LVGL's software renderer blends it against whatever's actually
behind it instead of painting an opaque rectangle:

```sh
python3 png_to_lvgl_argb8888.py logo_96_alpha.png  ../../src/icons/wb_logo_96.c  wb_logo_96  96 96
python3 png_to_lvgl_argb8888.py logo_40_alpha.png  ../../src/icons/wb_logo_40.c  wb_logo_40  40 40
python3 png_to_lvgl_argb8888.py logo_160_alpha.png ../../src/icons/wb_logo_160.c wb_logo_160 160 160
```

`png_to_lvgl_rgb565.py` (the plain-opaque version) is kept for any future asset that
genuinely has an opaque background by design — nothing currently uses it.

## Usage

- `wb_logo_96` — `onboarding_screen.cpp` (above "Set up your Waffled-Bite"),
  `wifi_screen.cpp`'s "Connecting..." view.
- `wb_logo_40` — small mark next to the home screen's clock (`home_screen.cpp`).
- `wb_logo_160` — `main.cpp`'s boot screen (shown before the WiFi-connect attempt at
  power-on) — bigger than the other two on request, since that screen is otherwise
  fairly bare (logo + "Waffled" + "Connecting...").
