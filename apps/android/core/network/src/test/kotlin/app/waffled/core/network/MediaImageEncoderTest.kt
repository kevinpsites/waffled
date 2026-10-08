package app.waffled.core.network

import org.junit.Test
import kotlin.test.assertEquals

/**
 * The pure half of the upload encoder — the downscale arithmetic.
 *
 * The Bitmap/JPEG half needs a real Android runtime, so it stays behind a thin seam and
 * is verified on the emulator; this locks the maths that decides how big the upload is.
 */
class MediaImageEncoderTest {

    @Test
    fun `an image inside the cap is left alone`() {
        assertEquals(1200 to 800, MediaImageEncoder.targetSize(1200, 800, maxEdge = 2048))
    }

    @Test
    fun `a landscape image is scaled by its long edge`() {
        assertEquals(2048 to 1536, MediaImageEncoder.targetSize(4096, 3072, maxEdge = 2048))
    }

    @Test
    fun `a portrait image is scaled by its long edge too`() {
        assertEquals(1536 to 2048, MediaImageEncoder.targetSize(3072, 4096, maxEdge = 2048))
    }

    @Test
    fun `a very thin image never collapses to zero`() {
        val (w, h) = MediaImageEncoder.targetSize(10_000, 3, maxEdge = 2048)
        assertEquals(2048, w)
        assertEquals(1, h)
    }

    @Test
    fun `a degenerate size is returned untouched`() {
        assertEquals(0 to 0, MediaImageEncoder.targetSize(0, 0, maxEdge = 2048))
    }
}
