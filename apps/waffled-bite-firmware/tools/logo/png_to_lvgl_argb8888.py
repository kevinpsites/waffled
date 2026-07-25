#!/usr/bin/env python3
"""Converts an RGBA PNG (real alpha channel already baked in — see this
directory's README for the chroma-key steps that produce one from a flat
opaque source) into an LVGL 9 ARGB8888 lv_image_dsc_t C source file. For
full-color assets that need to sit directly on a non-white app background
instead of showing a white/cream rectangle — see png_to_lvgl_rgb565.py for
the plain-opaque version this was copied from.
"""
import subprocess
import sys

def png_to_c(png_path, c_path, var_name, width, height):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", png_path, "-pix_fmt", "rgba", "-f", "rawvideo", "-"],
        capture_output=True, check=True
    ).stdout
    expected = width * height * 4
    if len(raw) != expected:
        raise ValueError(f"{png_path}: got {len(raw)} bytes, expected {expected}")

    pixels = []
    for i in range(0, len(raw), 4):
        r, g, b, a = raw[i], raw[i + 1], raw[i + 2], raw[i + 3]
        # lv_color32_t byte order (src/misc/lv_color.h): blue, green, red, alpha.
        pixels.append(b)
        pixels.append(g)
        pixels.append(r)
        pixels.append(a)

    lines = []
    lines.append('#ifdef LV_LVGL_H_INCLUDE_SIMPLE\n#include "lvgl.h"\n#else\n#include "lvgl.h"\n#endif\n')
    lines.append(f"static const uint8_t {var_name}_map[] = {{")
    for i in range(0, len(pixels), 16):
        chunk = pixels[i:i+16]
        lines.append("  " + ",".join(str(v) for v in chunk) + ",")
    lines.append("};\n")
    lines.append(f"const lv_image_dsc_t {var_name} = {{")
    lines.append("  .header = {")
    lines.append("    .magic = LV_IMAGE_HEADER_MAGIC,")
    lines.append("    .cf = LV_COLOR_FORMAT_ARGB8888,")
    lines.append("    .flags = 0,")
    lines.append(f"    .w = {width},")
    lines.append(f"    .h = {height},")
    lines.append(f"    .stride = {width * 4},")
    lines.append("    .reserved_2 = 0,")
    lines.append("  },")
    lines.append(f"  .data_size = {len(pixels)},")
    lines.append(f"  .data = {var_name}_map,")
    lines.append("  .reserved = NULL,")
    lines.append("};")

    with open(c_path, "w") as f:
        f.write("\n".join(lines) + "\n")

if __name__ == "__main__":
    png_path, c_path, var_name, width, height = sys.argv[1:6]
    png_to_c(png_path, c_path, var_name, int(width), int(height))
