package app.waffled.core.network

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The API returns media paths that may be relative (`/media/ab/cd.jpg`) or already
 * absolute. Every image-bearing feature — Photos, Meals recipe cards, Pantry, chore
 * proofs, the screensaver — needs the same resolution, so it lives here rather than
 * being re-derived five times.
 *
 * Twin of `MediaURL` in `Sync/MediaUpload.swift`.
 */
class MediaUrlTest {

    private val base = "http://10.0.2.2:8080"

    @Test
    fun joinsARelativePathToTheServerOrigin() {
        assertEquals("http://10.0.2.2:8080/media/ab/cd.jpg", MediaUrl.resolve("/media/ab/cd.jpg", base))
    }

    @Test
    fun addsTheMissingSlash() {
        assertEquals("http://10.0.2.2:8080/media/ab.jpg", MediaUrl.resolve("media/ab.jpg", base))
    }

    @Test
    fun doesNotDoubleTheSlashWhenTheBaseHasATrailingOne() {
        assertEquals(
            "http://10.0.2.2:8080/media/ab.jpg",
            MediaUrl.resolve("/media/ab.jpg", "http://10.0.2.2:8080/"),
        )
    }

    @Test
    fun leavesAnAbsoluteUrlAlone() {
        // Object storage may hand back a fully-qualified URL; don't mangle it.
        val abs = "https://cdn.example.com/x/y.jpg"
        assertEquals(abs, MediaUrl.resolve(abs, base))
        assertEquals("http://other/z.jpg", MediaUrl.resolve("http://other/z.jpg", base))
    }

    @Test
    fun blankOrNullPathsResolveToNull() {
        assertNull(MediaUrl.resolve(null, base))
        assertNull(MediaUrl.resolve("", base))
        assertNull(MediaUrl.resolve("   ", base))
    }

    @Test
    fun preservesQueryStringsSuchAsSignedParams() {
        assertEquals(
            "http://10.0.2.2:8080/media/a.jpg?v=2",
            MediaUrl.resolve("/media/a.jpg?v=2", base),
        )
    }

    @Test
    fun theCacheKeyIsTheStoragePathNotTheResolvedUrl() {
        // Caching on a resolved (and possibly signed/expiring) URL is what broke the web
        // screensaver: the URL changes on every load, so the cache never hits. Key on the
        // stable storage path instead.
        assertEquals(
            MediaUrl.cacheKey("/media/ab/cd.jpg"),
            MediaUrl.cacheKey("/media/ab/cd.jpg?token=expires-soon"),
        )
        assertEquals("/media/ab/cd.jpg", MediaUrl.cacheKey("/media/ab/cd.jpg?token=x"))
    }
}
