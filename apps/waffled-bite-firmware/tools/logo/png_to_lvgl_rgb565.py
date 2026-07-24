#!/usr/bin/env python3
"""Converts an opaque PNG into an LVGL 9 RGB565 lv_image_dsc_t C source file.
For full-color assets (the logo) rather than single-color icons — see
png_to_lvgl_a8.py for the A8/tinted-icon path.
"""
import subprocess
import sys

def png_to_c(png_path, c_path, var_name, width, height):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", png_path, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
        capture_output=True, check=True
    ).stdout
    expected = width * height * 3
    if len(raw) != expected:
        raise ValueError(f"{png_path}: got {len(raw)} bytes, expected {expected}")

    pixels = []
    for i in range(0, len(raw), 3):
        r, g, b = raw[i], raw[i + 1], raw[i + 2]
        rgb565 = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
        pixels.append(rgb565 & 0xFF)
        pixels.append((rgb565 >> 8) & 0xFF)

    lines = []
    lines.append('#ifdef LV_LVGL_H_INCLUDE_SIMPLE\n#include "lvgl.h"\n#else\n#include "lvgl.h"\n#endif\n')
    lines.append(f"static const uint8_t {var_name}_map[] = {{")
    for i in range(0, len(pixels), 16):
        chunk = pixels[i:i+16]
        lines.append("  " + ",".join(str(b) for b in chunk) + ",")
    lines.append("};\n")
    lines.append(f"const lv_image_dsc_t {var_name} = {{")
    lines.append("  .header = {")
    lines.append("    .magic = LV_IMAGE_HEADER_MAGIC,")
    lines.append("    .cf = LV_COLOR_FORMAT_RGB565,")
    lines.append("    .flags = 0,")
    lines.append(f"    .w = {width},")
    lines.append(f"    .h = {height},")
    lines.append(f"    .stride = {width * 2},")
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
