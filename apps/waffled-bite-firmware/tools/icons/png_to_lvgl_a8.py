#!/usr/bin/env python3
"""Converts a PNG (with alpha) into an LVGL 9 A8 lv_image_dsc_t C source file.
Uses ffmpeg to decode the PNG to raw RGBA, then keeps only the alpha byte per
pixel — these icons are single flat-color strokes/fills on transparent
backgrounds, so alpha alone fully describes the shape; LVGL's A8 image path
recolors the whole thing to the object's style_image_recolor color at draw
time (see lv_draw_sw_img.c's `cf == LV_COLOR_FORMAT_A8` branch), so no RGB
data is needed at all.
"""
import subprocess
import sys
import struct

def png_to_c(png_path, c_path, var_name, width, height):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", png_path, "-pix_fmt", "rgba", "-f", "rawvideo", "-"],
        capture_output=True, check=True
    ).stdout
    expected = width * height * 4
    if len(raw) != expected:
        raise ValueError(f"{png_path}: got {len(raw)} bytes, expected {expected}")
    alpha = bytes(raw[i * 4 + 3] for i in range(width * height))

    lines = []
    lines.append(f'#ifdef LV_LVGL_H_INCLUDE_SIMPLE\n#include "lvgl.h"\n#else\n#include "lvgl.h"\n#endif\n')
    lines.append(f"static const uint8_t {var_name}_map[] = {{")
    for i in range(0, len(alpha), 16):
        chunk = alpha[i:i+16]
        lines.append("  " + ",".join(str(b) for b in chunk) + ",")
    lines.append("};\n")
    lines.append(f"const lv_image_dsc_t {var_name} = {{")
    lines.append("  .header = {")
    lines.append("    .magic = LV_IMAGE_HEADER_MAGIC,")
    lines.append("    .cf = LV_COLOR_FORMAT_A8,")
    lines.append("    .flags = 0,")
    lines.append(f"    .w = {width},")
    lines.append(f"    .h = {height},")
    lines.append(f"    .stride = {width},")
    lines.append("    .reserved_2 = 0,")
    lines.append("  },")
    lines.append(f"  .data_size = {width * height},")
    lines.append(f"  .data = {var_name}_map,")
    lines.append("  .reserved = NULL,")
    lines.append("};")

    with open(c_path, "w") as f:
        f.write("\n".join(lines) + "\n")

if __name__ == "__main__":
    png_path, c_path, var_name, width, height = sys.argv[1:6]
    png_to_c(png_path, c_path, var_name, int(width), int(height))
