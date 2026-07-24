# Logo

`logo_96.png` is `apps/web/public/logo.png` (512×512, 244KB) resized to 96×96 (~12KB)
with `sips`:

```sh
sips -Z 96 --setProperty format png apps/web/public/logo.png --out logo_96.png
```

Baked as an LVGL 9 **RGB565** `lv_image_dsc_t` (`src/icons/wb_logo_96.c`, `wb_logo_96`
declared in `src/icons/wb_icons.h`) with `png_to_lvgl_rgb565.py` — unlike
`tools/icons/`'s A8 icons, this is the real multi-color mark, so there's no
per-tile recolor trick; RGB565 (no alpha) is enough since the source PNG has an
opaque background, not transparency:

```sh
python3 png_to_lvgl_rgb565.py logo_96.png ../../src/icons/wb_logo_96.c wb_logo_96 96 96
```

Used on `onboarding_screen.cpp` (above the "Set up your Waffled-Bite" title) and
`wifi_screen.cpp`'s "Connecting..." view. Not used anywhere else on-device yet — see
the firmware README's icons section for why the home/routine screens deliberately
don't show it (the design mock has no logo on the kid-facing screens at all).
