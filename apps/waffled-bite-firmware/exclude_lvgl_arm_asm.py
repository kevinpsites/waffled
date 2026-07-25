# pio's Library Dependency Finder compiles every .S file it finds under a
# library's src tree regardless of target arch — it doesn't know
# lv_blend_helium.S (ARM Helium/MVE) and lv_blend_neon.S (ARM NEON) are
# unreachable on this RISC-V target; LVGL's own #if guards inside those files
# correctly compile them down to nothing, but the assembler still tags the
# resulting (empty) object with a default float ABI that conflicts with the
# rest of the RISC-V build's ABI at link time:
#   ld: can't link soft-float modules with single-float modules
# Discovered when pinning platform= to 54.03.21-2 for the ESP32-P4 v1.3
# silicon bootloader-crash fix (see platformio.ini's [env:esp32-p4] comment) —
# the #develop toolchain this project used before apparently tolerated it.
# AddBuildMiddleware is pio's own documented mechanism for exactly this case
# (excluding specific source files a library's own manifest doesn't filter
# out for us) — cleaner than deleting the files from .pio/libdeps, which
# would just come back on the next fresh `pio run`.
Import("env")


def exclude_arm_simd_asm(node):
    path = str(node)
    if "blend/helium" in path or "blend/neon" in path:
        return None
    return node


env.AddBuildMiddleware(exclude_arm_simd_asm, "*/lvgl/src/draw/sw/blend/*.S")
