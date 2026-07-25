# Offline mascot

`waffled-down-source.png` (1254×1254, opaque RGB, no alpha) is a sad, unplugged
waffle-iron mascot with a broken WiFi symbol, supplied directly by the user for
`offline_screen.cpp`'s "can't reach the server" state.

## Removing the background

The source has a flat near-white background (`#FEFEFE`) baked in, not real
transparency — showing it on-device drew a visible white box around the mascot
instead of it sitting directly on the app's cream background. Direct request to fix
this. Chroma-keyed with ffmpeg's `colorkey` filter, tuned tight enough to leave the
mascot's own cream-colored body intact (its body is close to white by design, so a
loose threshold eats into it — confirmed by trial: `similarity=0.12` visibly hollowed
out the body outline; `0.02` with a small blend for edge antialiasing did not):

```sh
ffmpeg -i waffled-down-source.png -vf "colorkey=0xFEFEFE:0.02:0.025" mascot_transparent.png
```

Resized to 320×320 with alpha preserved (`sips` silently drops alpha on some
resizes — `ffmpeg scale` doesn't):

```sh
ffmpeg -i mascot_transparent.png -vf "scale=320:320" waffled_down_320_alpha.png
```

## Baking

Baked as an LVGL 9 **ARGB8888** `lv_image_dsc_t` (`src/icons/wb_offline_mascot_320.c`,
`wb_offline_mascot_320` declared in `src/icons/wb_icons.h`) — reusing
`tools/logo/`'s `png_to_lvgl_argb8888.py` directly (see that directory's README for
why full-color + real alpha needs a different bake than `tools/icons/`'s A8 icons or
`tools/logo/`'s older opaque RGB565 path):

```sh
python3 ../logo/png_to_lvgl_argb8888.py waffled_down_320_alpha.png ../../src/icons/wb_offline_mascot_320.c wb_offline_mascot_320 320 320
```

Used on `offline_screen.cpp` only — semi-large on the left side of the split layout,
with the "Can't reach the server" message and action buttons on the right.
