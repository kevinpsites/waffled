package app.waffled.feature.photos

import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledHttp
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import io.ktor.http.encodeURLQueryComponent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * The Photos + media slice of the API — the Kotlin port of the `photos` / `media`
 * endpoints in `apps/ios/.../Sync/WaffledAPI.swift`.
 *
 * Deliberately **not** a god-object client: each feature module owns the slice it calls,
 * so seventeen agents can work in parallel without contending over one file. Everything
 * shared (the Ktor client, the 401 refresh, error text) lives in `core:network`.
 */
class PhotosApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) {

    // ---- wire types ------------------------------------------------------------

    /** Who uploaded a photo — the display info for the detail sheet's "Added by" row. */
    @Serializable
    data class PhotoPerson(
        val personId: String,
        val name: String? = null,
        val avatarEmoji: String? = null,
        val colorHex: String? = null,
    )

    /**
     * One photo on the family wall.
     *
     * [imageUrl] is a stored-blob path (resolve through `MediaUrl.resolve`) or null, in
     * which case the tile is an emoji-on-gradient drawn from [emoji] + [colorHex].
     */
    @Serializable
    data class Photo(
        val id: String,
        val imageUrl: String? = null,
        val caption: String = "",
        val emoji: String? = null,
        val colorHex: String? = null,
        /** The album this photo belongs to. The server column is `memory`. */
        val memory: String? = null,
        val takenAt: String? = null,
        val isFavorite: Boolean = false,
        val reactions: Map<String, Int> = emptyMap(),
        val uploadedBy: PhotoPerson? = null,
        val createdAt: String = "",
    )

    /**
     * The result of a blob upload: the opaque storage key to persist as an entity's
     * `storageKey`, its resolved (relative) URL, and the stored content type.
     */
    @Serializable
    data class UploadedMedia(
        val key: String,
        val url: String,
        val contentType: String,
    )

    @Serializable private data class PhotoListEnvelope(val photos: List<Photo> = emptyList())
    @Serializable private data class PhotoEnvelope(val photo: Photo)
    @Serializable private data class NewPhotoEnvelope(val photo: NewPhoto) {
        @Serializable data class NewPhoto(val id: String)
    }

    @Serializable
    private data class MediaUploadBody(
        @SerialName("data") val data: String,
        val contentType: String,
    )

    // ---- photos ----------------------------------------------------------------

    /** Every photo on the wall, newest first; optionally scoped to one album. */
    suspend fun list(memory: String? = null): List<Photo> =
        send<PhotoListEnvelope>(HttpMethod.Get, "api/photos") {
            if (!memory.isNullOrBlank()) {
                // `%20`, not `+`: Ktor's default query encoding is form-style, and album
                // names are free text. Percent-encoding matches the iOS wire format and
                // survives any query parser, not only the form-decoding ones.
                url.encodedParameters.append(
                    "memory",
                    memory.encodeURLQueryComponent(spaceToPlus = false),
                )
            }
        }.photos

    /** One photo's full detail. */
    suspend fun get(id: String): Photo =
        send<PhotoEnvelope>(HttpMethod.Get, "api/photos/$id").photo

    /**
     * Create a photo — typically `{ storageKey, caption, memory, isFavorite }` for an
     * uploaded blob. Returns the new photo's id (the 201 carries the id ONLY).
     */
    suspend fun create(body: JsonObject): String =
        send<NewPhotoEnvelope>(HttpMethod.Post, "api/photos") { jsonBody(body) }.photo.id

    /**
     * Patch a photo (caption / memory / isFavorite / takenAt) and return the updated row.
     *
     * The body is a [JsonObject], not a data class, on purpose: the server distinguishes
     * a **missing** key ("leave it alone") from an explicit `null` ("clear it"), and
     * `WaffledJson` is configured with `explicitNulls = false`, so a nullable data-class
     * property would be silently omitted — and clearing an album would do nothing.
     */
    suspend fun update(id: String, body: JsonObject): Photo =
        send<PhotoEnvelope>(HttpMethod.Patch, "api/photos/$id") { jsonBody(body) }.photo

    /** Soft-delete a photo. The server answers 204 with an empty body. */
    suspend fun delete(id: String) {
        sendUnit(HttpMethod.Delete, "api/photos/$id")
    }

    // ---- media -----------------------------------------------------------------

    /**
     * Upload image bytes (base64) to the blob store.
     *
     * The container server buffers request bodies to a string, so uploads go as base64
     * inside JSON rather than as multipart. See `apps/api/src/modules/media/media.ts`.
     */
    suspend fun uploadMedia(base64Data: String, contentType: String): UploadedMedia =
        send<UploadedMedia>(HttpMethod.Post, "api/media") {
            contentType(ContentType.Application.Json)
            setBody(MediaUploadBody(data = base64Data, contentType = contentType))
        }

    // ---- the request helper every feature slice copies --------------------------

    /**
     * Build → authorise → send → unwrap, in one place.
     *
     * This is the pattern for every `…Api.kt` in the port, so it is worth reading once:
     *  - the bearer token is attached per request (it rotates, so it can't be baked into
     *    the client's `defaultRequest`);
     *  - the token that was actually sent is handed to [WaffledHttp.unwrap], which makes
     *    a **staggered** 401 cheap — a caller that is merely behind gets the current
     *    token instead of triggering a second refresh;
     *  - [WaffledHttp.unwrap] replays the request once through `retry` after a refresh,
     *    and turns a non-2xx into a `WaffledApiException` carrying the SERVER's message.
     *
     * Network work runs on [Dispatchers.IO] so a caller on the main thread is safe.
     */
    private suspend inline fun <reified T> send(
        method: HttpMethod,
        path: String,
        noinline configure: HttpRequestBuilder.() -> Unit = {},
    ): T = execute(method, path, configure) { it.body<T>() }

    /** As [send], for a response with no body to decode (a 204). */
    private suspend fun sendUnit(
        method: HttpMethod,
        path: String,
        configure: HttpRequestBuilder.() -> Unit = {},
    ) {
        // A 204 has no body at all, so the parse lambda must not touch it.
        execute(method, path, configure) { }
    }

    private suspend fun <T> execute(
        method: HttpMethod,
        path: String,
        configure: HttpRequestBuilder.() -> Unit,
        parse: suspend (HttpResponse) -> T,
    ): T = withContext(Dispatchers.IO) {
        val sentToken = tokens.accessToken()

        suspend fun attempt(token: String?): HttpResponse = client.request(path) {
            this.method = method
            if (token != null) header(HttpHeaders.Authorization, "Bearer $token")
            configure()
        }

        WaffledHttp.unwrap(
            response = attempt(sentToken),
            tokens = tokens,
            sentToken = sentToken,
            retry = { fresh -> attempt(fresh) },
            parse = parse,
        )
    }
}

/** Attach a pre-built JSON tree as the request body. */
private fun HttpRequestBuilder.jsonBody(body: JsonObject) {
    contentType(ContentType.Application.Json)
    setBody(body)
}
