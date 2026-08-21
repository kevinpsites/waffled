package app.waffled.feature.photos

import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The API slice, driven against a real MockWebServer through [ApiTestHarness].
 *
 * This is the reference for every later feature agent: build the client from the
 * harness, enqueue the response the SERVER actually sends, and assert on both the
 * parsed result and the recorded request.
 */
class PhotosApiTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: PhotosApi

    @Before
    fun setUp() {
        harness.start()
        // NOTE: `ApiTestHarness`'s KDoc suggests a `harness.client` — no such member
        // exists. Build the shared client from the harness's providers instead.
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = PhotosApi(client, harness.tokens)
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    // ---- list ----

    @Test
    fun `list unwraps the photos envelope`() = runTest {
        harness.enqueueJson(
            """
            {"photos":[
              {"id":"p1","imageUrl":"/media/ab/cd.jpg","caption":"Lake day","emoji":null,
               "colorHex":"#EC6049","memory":"Summer trip","takenAt":"2026-07-04T12:00:00Z",
               "isFavorite":true,"reactions":{"heart":2},
               "uploadedBy":{"personId":"per1","name":"Jerry","avatarEmoji":"S","colorHex":"#2F7FED"},
               "createdAt":"2026-07-05T09:00:00Z"}
            ]}
            """.trimIndent(),
        )

        val photos = api.list()

        assertEquals(1, photos.size)
        val p = photos.first()
        assertEquals("p1", p.id)
        assertEquals("Lake day", p.caption)
        assertEquals("Summer trip", p.memory)
        assertTrue(p.isFavorite)
        assertEquals(2, p.reactions["heart"])
        assertEquals("Jerry", p.uploadedBy?.name)
        assertEquals("/api/photos", harness.takeRequest().path)
    }

    @Test
    fun `list tolerates a photo with every optional field missing`() = runTest {
        harness.enqueueJson(
            """{"photos":[{"id":"p2","caption":"","isFavorite":false,"createdAt":"2026-01-01T00:00:00Z"}]}""",
        )

        val p = api.list().single()

        assertNull(p.imageUrl)
        assertNull(p.emoji)
        assertNull(p.memory)
        assertNull(p.uploadedBy)
        assertTrue(p.reactions.isEmpty())
    }

    @Test
    fun `list percent-encodes the memory filter`() = runTest {
        harness.enqueueJson("""{"photos":[]}""")

        api.list(memory = "Summer trip")

        assertEquals("/api/photos?memory=Summer%20trip", harness.takeRequest().path)
    }

    // ---- create ----

    @Test
    fun `create posts the body and returns the new id from the 201`() = runTest {
        // The server answers 201 with the id ONLY, not a full photo.
        harness.enqueueJson("""{"photo":{"id":"new-1"}}""", status = 201)

        val id = api.create(
            buildJsonObject {
                put("storageKey", "hh/ab/cd.jpg")
                put("caption", "Hi")
                put("isFavorite", false)
                put("memory", JsonNull)
            },
        )

        assertEquals("new-1", id)
        val request = harness.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/photos", request.path)
        val body = request.body.readUtf8()
        assertContains(body, "\"storageKey\":\"hh/ab/cd.jpg\"")
        // An explicit null must survive the encoder: the server treats a MISSING key as
        // "leave it alone", so an omitted `memory` would silently do nothing.
        assertContains(body, "\"memory\":null")
    }

    // ---- update ----

    @Test
    fun `update patches and returns the updated photo`() = runTest {
        harness.enqueueJson(
            """{"photo":{"id":"p1","caption":"Renamed","isFavorite":true,"createdAt":"2026-01-01T00:00:00Z"}}""",
        )

        val photo = api.update("p1", buildJsonObject { put("caption", JsonPrimitive("Renamed")) })

        assertEquals("Renamed", photo.caption)
        val request = harness.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("/api/photos/p1", request.path)
    }

    @Test
    fun `update sends an explicit null to clear the album`() = runTest {
        harness.enqueueJson(
            """{"photo":{"id":"p1","caption":"","isFavorite":false,"createdAt":"2026-01-01T00:00:00Z"}}""",
        )

        api.update("p1", buildJsonObject { put("memory", JsonNull) })

        assertContains(harness.takeRequest().body.readUtf8(), "\"memory\":null")
    }

    // ---- delete ----

    @Test
    fun `delete accepts a 204 with no body`() = runTest {
        harness.server.enqueue(okhttp3.mockwebserver.MockResponse().setResponseCode(204))

        api.delete("p1")

        val request = harness.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/api/photos/p1", request.path)
    }

    // ---- media upload ----

    @Test
    fun `uploadMedia posts base64 and returns the storage key`() = runTest {
        harness.enqueueJson(
            """{"key":"hh/ab/cd.jpg","url":"/media/ab/cd.jpg","contentType":"image/jpeg"}""",
            status = 201,
        )

        val uploaded = api.uploadMedia(base64Data = "QUJD", contentType = "image/jpeg")

        assertEquals("hh/ab/cd.jpg", uploaded.key)
        assertEquals("/media/ab/cd.jpg", uploaded.url)
        val request = harness.takeRequest()
        assertEquals("/api/media", request.path)
        val body = request.body.readUtf8()
        assertContains(body, "\"data\":\"QUJD\"")
        assertContains(body, "\"contentType\":\"image/jpeg\"")
    }

    // ---- errors + auth ----

    @Test
    fun `an error relays the server's own message`() = runTest {
        harness.enqueueError(400, "BadRequest", "an image url, an uploaded image, or an emoji is required")

        val failure = assertFailsWith<WaffledApiException> { api.create(buildJsonObject { }) }

        assertEquals(400, failure.status)
        assertEquals("an image url, an uploaded image, or an emoji is required", failure.userMessage)
    }

    @Test
    fun `a 401 refreshes once and replays the request with the fresh token`() = runTest {
        harness.enqueueUnauthorized()
        harness.enqueueJson("""{"photos":[]}""")

        val photos = api.list()

        assertTrue(photos.isEmpty())
        assertEquals(1, harness.refreshCount.get())
        harness.takeRequest() // the attempt that 401'd
        assertEquals("Bearer refreshed-access-token", harness.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun `a request carries the bearer token`() = runTest {
        harness.enqueueJson("""{"photos":[]}""")

        api.list()

        assertEquals("Bearer test-access-token", harness.takeRequest().getHeader("Authorization"))
    }
}
