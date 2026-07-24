# Icon pipeline

The `.svg` files here are the real icon set from the "Waffled Buddy" design mock
(claude.ai/design project `fb5fb8fb-ed6b-4edd-a02f-bfedc8035966`, "Waffled Buddy
icons/*.svg" — pulled via the Claude Design MCP, not redrawn/approximated). Each is a
24×24 viewBox, single-color stroke (or fill, for `star.svg`) line icon on a transparent
background — `fill:none; stroke:#1c1a18; stroke-width:1.9` for the stroked ones.

They're baked into `src/icons/*.c` as LVGL 9 **A8** (alpha-only) `lv_image_dsc_t`
constants — no RGB data at all, since these icons carry no color of their own. LVGL's
software renderer fills an A8 image's shape using the drawing object's
`style_image_recolor` color (see the vendored `lv_draw_sw_img.c`'s
`cf == LV_COLOR_FORMAT_A8` branch), so one baked asset can be tinted to whichever
tile/screen it's placed on at runtime — see `home_screen.cpp`'s `make_icon()`.

No LVGL image-converter tool was used (`lv_img_conv`'s current npm release doesn't
install cleanly — peer-dependency conflicts in its own devDependencies — and its actual
output format wasn't verified against LVGL 9's `lv_image_header_t`). Instead:

1. **Rasterize** each SVG to a PNG at the target pixel size with
   [`rsvg-convert`](https://gitlab.gnome.org/GNOME/librsvg) (`brew install librsvg`):
   ```sh
   rsvg-convert -w 32 -h 32 sun.svg -o sun_32.png
   ```
2. **Convert** the PNG to a `.c` file with `png_to_lvgl_a8.py` (stdlib-only — decodes via
   `ffmpeg -pix_fmt rgba -f rawvideo`, keeps just the alpha byte per pixel, and hand-packs
   `lv_image_header_t`'s bitfields via a plain C designated initializer — no third-party
   LVGL tooling needed):
   ```sh
   python3 png_to_lvgl_a8.py sun_32.png ../src/icons/wb_icon_sun_32.c wb_icon_sun_32 32 32
   ```
3. Declare the new constant in `src/icons/wb_icons.h` (`extern const lv_image_dsc_t ...`).

Current bake sizes (chosen to match the mock's own SVG use, then rounded): 32×32 for the
three routine-tile icons + chores' broom, 40×40 for the grown-up-controls tiles
(sound/nightlight/timer/bedtime), 24×24 for the settings gear, 18×18 for stars/back/
close/check. `moon` is baked twice (32 for the Evening tile, 40 for the Nightlight
control) rather than scaled at runtime, to stay crisp — LVGL image scaling blurs a raster
source; a second bake is a few hundred bytes for a plainly better result.

Icons vendored but **not yet wired into any screen**: `check` (18px — the done-check
badge on home_screen.cpp still uses `LV_SYMBOL_OK`, a reasonable built-in stand-in),
`close`/`back` (18px — quiet/wake/routine-detail/sounds/nightlight screens still use
`LV_SYMBOL_LEFT`/text; picking these up is a straightforward follow-up using the exact
same `make_icon()` pattern). `bell`/`chev`/`pause`/`play`/`plus`/`send`/`stop` came in
the same icon set but have no on-device use yet.
