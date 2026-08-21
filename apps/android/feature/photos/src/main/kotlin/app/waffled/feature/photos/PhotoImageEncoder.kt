package app.waffled.feature.photos

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import java.io.ByteArrayOutputStream
import java.util.Base64
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Downscale + JPEG-encode + base64 a picked image for `POST /api/media`.
 *
 * ⚠️ **This belongs in `core:network`, not here.** The port plan (§0.4) lists
 * `MediaUpload` — "downscale to 2048px long edge → JPEG → base64, 10 MB decoded cap" —
 * as Phase 0 work alongside `MediaURL`; `MediaUrl.kt` landed but the encoder did not.
 * Every other image-uploading feature (recipes, chore proof, pantry) needs exactly this,
 * so it should be lifted into `core:network` and this file deleted. It is module-local
 * only because the `core` modules are frozen — reported to the integrator.
 *
 * Twin of `apps/ios/.../Sync/MediaUpload.swift` (`MediaImage`).
 *
 * `java.util.Base64` is used rather than `android.util.Base64` so the encoding path is
 * real code in a JVM unit test instead of a stubbed-out Android class.
 */
object PhotoImageEncoder {

    /** Long-edge cap, matching the web kiosk and iOS (2048px). */
    const val MAX_EDGE = 2048

    /** The server's hard cap on the DECODED image bytes (`/api/media` answers 413). */
    const val MAX_DECODED_BYTES = 10 * 1024 * 1024

    /** JPEG quality ladder, tried in order at each size. Matches iOS. */
    private val QUALITIES = intArrayOf(85, 60, 40)

    /** Encoded bytes ready to POST. */
    data class Encoded(val base64: String, val contentType: String)

    class TooLargeException : Exception("That image is too large to upload. Try a smaller photo.")

    /**
     * The size to render an image of [width]×[height] at, so its long edge is at most
     * [maxEdge]. Never upscales, and never collapses a dimension to zero.
     *
     * Pure, so it is the part this module unit-tests; the Bitmap work around it needs a
     * real Android runtime.
     */
    fun targetSize(width: Int, height: Int, maxEdge: Int = MAX_EDGE): Pair<Int, Int> {
        if (width <= 0 || height <= 0) return width to height
        val edge = max(width, height)
        if (edge <= maxEdge) return width to height
        val scale = maxEdge.toDouble() / edge
        return max(1, (width * scale).roundToInt()) to max(1, (height * scale).roundToInt())
    }

    /**
     * Read [uri], downscale it, and JPEG-encode under the server's cap.
     *
     * Strategy (iOS parity): fit the long edge to [MAX_EDGE], then walk the quality
     * ladder; if it still won't fit, halve the long edge and try the ladder again, up to
     * six passes, before giving up with a friendly error.
     */
    fun encode(context: Context, uri: Uri): Encoded {
        val source = decodeDownsampled(context, uri) ?: throw TooLargeException()
        var working = scaleTo(source, MAX_EDGE)

        repeat(6) { pass ->
            if (pass > 0) {
                val edge = max(working.width, working.height)
                val next = max(320, edge / 2)
                if (next >= edge) return@repeat
                working = scaleTo(working, next)
            }
            for (quality in QUALITIES) {
                val bytes = jpeg(working, quality)
                if (bytes.size <= MAX_DECODED_BYTES) {
                    return Encoded(
                        base64 = Base64.getEncoder().encodeToString(bytes),
                        contentType = "image/jpeg",
                    )
                }
            }
        }
        throw TooLargeException()
    }

    /**
     * Decode with `inSampleSize` so a 50MP photo never lands in memory at full size —
     * an Android-specific step iOS doesn't need (UIImage decodes lazily).
     */
    private fun decodeDownsampled(context: Context, uri: Uri): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_EDGE) sample *= 2

        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        return context.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, options)
        }
    }

    private fun scaleTo(bitmap: Bitmap, maxEdge: Int): Bitmap {
        val (w, h) = targetSize(bitmap.width, bitmap.height, maxEdge)
        if (w == bitmap.width && h == bitmap.height) return bitmap
        return bitmap.scale(w, h)
    }

    private fun jpeg(bitmap: Bitmap, quality: Int): ByteArray =
        ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, quality, it) }.toByteArray()

    @Suppress("DEPRECATION")
    private fun Bitmap.scale(width: Int, height: Int): Bitmap =
        Bitmap.createScaledBitmap(this, width, height, true)
}
