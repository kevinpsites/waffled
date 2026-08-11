// Share list — QR sizing rules.
//
// A QR is only useful if a phone camera can actually read it off the screen, and
// that is a function of how many CSS pixels each module gets, not of how nice the
// code looks. A long grocery list pushes the QR to a high version (more modules in
// the same box) until the modules are sub-pixel and the code is unscannable — it
// still *renders*, which is what makes this failure sneaky.
//
// Measured on the real thing: a 45-item list is 1,137 bytes → version 28, 129×129
// modules. Drawn at 160px that is 1.24 px per module, which no phone will read.
//
// So: draw it big, at native resolution, with a proper quiet zone — and when the
// list is still too long to encode legibly, say so instead of showing a code that
// cannot work. Copy and the share sheet have no length limit and always work.

/** On-screen size of the QR. 320 keeps the modal's QR-beside-text row under its
 *  560px max width (320 + 200 text + 18 gap = 538). */
export const QR_DISPLAY_PX = 320

/** CSS px per module needed for a phone camera to read the code off a screen.
 *  3 is the usual rule of thumb; below ~2 it is hopeless. */
export const MIN_PX_PER_MODULE = 3

/** The spec's quiet zone is 4 modules. `qrcode` defaults to 4 but the original
 *  port passed margin:1, which itself hurts scanning — pinned here so it can't
 *  drift back. */
export const QR_MARGIN_MODULES = 4

/** Lowest error correction → fewest modules for a given payload, i.e. the most
 *  scannable code. A phone screen is a clean, undamaged source; the redundancy
 *  that higher levels buy is not worth the extra density here. */
export const QR_ERROR_CORRECTION = 'L' as const

/**
 * Can a code with this many modules per side be read at `displayPx` on screen?
 * `moduleCount` is the QR's width in modules (e.g. 129 for a version-28 code).
 */
export function qrIsScannable(moduleCount: number, displayPx: number = QR_DISPLAY_PX): boolean {
  if (!Number.isFinite(moduleCount) || moduleCount <= 0) return false
  return displayPx / moduleCount >= MIN_PX_PER_MODULE
}

/**
 * Bitmap size to generate so each module lands on whole device pixels — the image
 * is then displayed at `displayPx` CSS px. Generating at the display size and
 * letting the browser upscale (or generating larger and letting it downscale, as
 * the original did) blurs module edges, which is its own scanning problem.
 */
export function qrBitmapPx(devicePixelRatio: number, displayPx: number = QR_DISPLAY_PX): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? Math.min(devicePixelRatio, 3) : 1
  return Math.round(displayPx * dpr)
}
