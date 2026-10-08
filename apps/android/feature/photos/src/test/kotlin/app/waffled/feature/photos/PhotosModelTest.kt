package app.waffled.feature.photos

import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The state holder, driven through the real API against MockWebServer.
 *
 * The translation of `apps/ios/.../Photos/PhotosModel.swift` — album derivation, the
 * per-album count, bulk move/delete, and the `RestDomain` failure semantics that keep a
 * flaky network from blanking the wall.
 */
class PhotosModelTest {

    private val harness = ApiTestHarness()
    private val refreshBus = RefreshBus()
    private lateinit var client: HttpClient
    private lateinit var model: PhotosModel

    // `WaffledDates.formatter` builds against the DEFAULT locale AND caches on
    // pattern+zone only, so whichever test formats first fixes the language for the whole
    // JVM. Every test class here pins it, so the cached formatter is always English.
    private val originalLocale = java.util.Locale.getDefault()

    @Before
    fun setUp() {
        java.util.Locale.setDefault(java.util.Locale.US)
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        model = PhotosModel(PhotosApi(client, harness.tokens), harness.baseUrl(), refreshBus = refreshBus)
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
        java.util.Locale.setDefault(originalLocale)
    }

    private fun photo(
        id: String,
        memory: String? = null,
        favorite: Boolean = false,
        imageUrl: String? = null,
    ) = """
        {"id":"$id","imageUrl":${imageUrl?.let { "\"$it\"" } ?: "null"},"caption":"",
         "memory":${memory?.let { "\"$it\"" } ?: "null"},"isFavorite":$favorite,
         "createdAt":"2026-01-01T00:00:00Z"}
    """.trimIndent()

    private fun enqueueWall(vararg photos: String) =
        harness.enqueueJson("""{"photos":[${photos.joinToString(",")}]}""")

    // ---- loading ----

    @Test
    fun `load populates the wall and marks it loaded`() = runTest {
        enqueueWall(photo("p1"), photo("p2"))

        model.load()

        assertEquals(listOf("p1", "p2"), model.photos.map { it.id })
        assertTrue(model.loaded)
        assertFalse(model.error)
    }

    @Test
    fun `a slow older load never overwrites a newer one`() = runTest {
        // Port of iOS PhotosModel's load generation: the last load STARTED wins.
        harness.server.enqueue(
            okhttp3.mockwebserver.MockResponse()
                .setHeader("Content-Type", "application/json")
                .setBody("""{"photos":[${photo("stale")}]}""")
                .setBodyDelay(400, java.util.concurrent.TimeUnit.MILLISECONDS),
        )
        enqueueWall(photo("fresh"))

        val older = async { model.load() }
        runCurrent()
        harness.takeRequest() // the older request has reached the server first
        model.load()
        older.await()

        assertEquals(listOf("fresh"), model.photos.map { it.id })
        assertFalse(model.loading)
    }

    @Test
    fun `an empty wall is genuinely empty, not a failure`() = runTest {
        enqueueWall()

        model.load()

        assertTrue(model.photos.isEmpty())
        assertTrue(model.loaded)
        assertFalse(model.error)
    }

    @Test
    fun `a failed refresh keeps the photos we already had and flags the error`() = runTest {
        enqueueWall(photo("p1"))
        model.load()

        harness.enqueueError(500, "ServerError", "boom")
        model.load()

        // RestDomain.apply(null) — a failed fetch must never blank a populated wall.
        assertEquals(listOf("p1"), model.photos.map { it.id })
        assertTrue(model.error)
        assertTrue(model.loaded)
    }

    @Test
    fun `a successful reload clears a previous error`() = runTest {
        harness.enqueueError(500, "ServerError", "boom")
        model.load()
        assertTrue(model.error)

        enqueueWall(photo("p1"))
        model.load()

        assertFalse(model.error)
    }

    // ---- albums ----

    @Test
    fun `albums are the distinct non-blank memories, sorted`() = runTest {
        enqueueWall(
            photo("p1", memory = "Summer trip"),
            photo("p2", memory = "Beach"),
            photo("p3", memory = "Summer trip"),
            photo("p4", memory = null),
            photo("p5", memory = ""),
        )

        model.load()

        assertEquals(listOf("Beach", "Summer trip"), model.albums)
    }

    @Test
    fun `countInAlbum counts only that album`() = runTest {
        enqueueWall(
            photo("p1", memory = "Beach"),
            photo("p2", memory = "Beach"),
            photo("p3", memory = "Summer trip"),
        )

        model.load()

        assertEquals(2, model.countInAlbum("Beach"))
        assertEquals(0, model.countInAlbum("Nope"))
    }

    // ---- the shown slice ----

    @Test
    fun `shown returns everything when no album is selected`() = runTest {
        enqueueWall(photo("p1", memory = "Beach"), photo("p2"))
        model.load()

        assertEquals(listOf("p1", "p2"), model.shown(null).map { it.id })
    }

    @Test
    fun `shown filters to the selected album`() = runTest {
        enqueueWall(photo("p1", memory = "Beach"), photo("p2", memory = "Summer trip"))
        model.load()

        assertEquals(listOf("p1"), model.shown("Beach").map { it.id })
    }

    // ---- derived per-row values (the documented perf trap) ----

    @Test
    fun `rows resolve the media url once per load and cache on the storage path`() = runTest {
        enqueueWall(photo("p1", imageUrl = "/media/ab/cd.jpg?sig=expiring"))
        model.load()

        val row = model.photos.single()
        assertEquals(harness.baseUrl() + "/media/ab/cd.jpg?sig=expiring", row.resolvedImageUrl)
        // Keyed on the storage PATH, not the signed URL — otherwise the cache never hits.
        assertEquals("/media/ab/cd.jpg", row.imageCacheKey)
    }

    @Test
    fun `a photo with no image has no resolved url and no cache key`() = runTest {
        enqueueWall(photo("p1"))
        model.load()

        assertNull(model.photos.single().resolvedImageUrl)
        assertNull(model.photos.single().imageCacheKey)
    }

    @Test
    fun `each row carries a precomputed date label`() = runTest {
        harness.enqueueJson(
            """{"photos":[{"id":"p1","caption":"","isFavorite":false,
               "takenAt":"2026-07-04T12:00:00Z","createdAt":"2026-08-01T00:00:00Z"}]}""",
        )
        model.load()

        // taken_at wins over created_at, and the label is formatted at LOAD time.
        val label = requireNotNull(model.photos.single().dateLabel)
        assertContains(label, "2026")
        assertContains(label, "Jul")
    }

    // ---- bulk actions ----

    @Test
    fun `move patches every id with the album and reloads`() = runTest {
        enqueueWall(photo("p1"), photo("p2"))
        model.load()

        harness.enqueueJson("""{"photo":${photo("p1", memory = "Beach")}}""")
        harness.enqueueJson("""{"photo":${photo("p2", memory = "Beach")}}""")
        enqueueWall(photo("p1", memory = "Beach"), photo("p2", memory = "Beach"))

        val ok = model.move(setOf("p1", "p2"), album = "Beach")

        assertTrue(ok)
        harness.takeRequest() // the initial load
        val first = harness.takeRequest()
        assertEquals("PATCH", first.method)
        assertContains(first.body.readUtf8(), "\"memory\":\"Beach\"")
        harness.takeRequest() // the second PATCH
        assertEquals("/api/photos", harness.takeRequest().path) // the reload
        assertEquals(listOf("Beach", "Beach"), model.photos.map { it.memory })
    }

    @Test
    fun `move with a blank album sends an explicit null to remove it`() = runTest {
        enqueueWall(photo("p1", memory = "Beach"))
        model.load()

        harness.enqueueJson("""{"photo":${photo("p1")}}""")
        enqueueWall(photo("p1"))

        model.move(setOf("p1"), album = "   ")

        harness.takeRequest() // the initial load
        assertContains(harness.takeRequest().body.readUtf8(), "\"memory\":null")
    }

    @Test
    fun `move reports failure but still reloads`() = runTest {
        enqueueWall(photo("p1"), photo("p2"))
        model.load()

        harness.enqueueError(403, "Forbidden", "nope")
        harness.enqueueJson("""{"photo":${photo("p2", memory = "Beach")}}""")
        enqueueWall(photo("p1"), photo("p2", memory = "Beach"))

        val ok = model.move(setOf("p1", "p2"), album = "Beach")

        assertFalse(ok)
        // Whatever DID land is reflected — the wall reloads either way.
        assertEquals(listOf(null, "Beach"), model.photos.map { it.memory })
    }

    @Test
    fun `delete removes every id and reloads`() = runTest {
        enqueueWall(photo("p1"), photo("p2"))
        model.load()

        harness.server.enqueue(okhttp3.mockwebserver.MockResponse().setResponseCode(204))
        enqueueWall(photo("p2"))

        val ok = model.delete(setOf("p1"))

        assertTrue(ok)
        assertEquals(listOf("p2"), model.photos.map { it.id })
    }

    // ---- invalidation ----

    @Test
    fun `a write bumps the Photos domain so other screens re-fetch`() = runTest {
        enqueueWall(photo("p1"))
        model.load()
        val before = refreshBus.revisionOf(RefreshDomain.Photos)

        harness.server.enqueue(okhttp3.mockwebserver.MockResponse().setResponseCode(204))
        enqueueWall()
        model.delete(setOf("p1"))

        assertEquals(before + 1, refreshBus.revisionOf(RefreshDomain.Photos))
    }

    @Test
    fun `a plain load does not bump the bus`() = runTest {
        enqueueWall(photo("p1"))
        model.load()

        assertEquals(0, refreshBus.revisionOf(RefreshDomain.Photos))
    }

    @Test
    fun `delete reports failure`() = runTest {
        enqueueWall(photo("p1"))
        model.load()

        harness.enqueueError(404, "NotFound", "photo not found")
        enqueueWall(photo("p1"))

        assertFalse(model.delete(setOf("p1")))
    }
}
