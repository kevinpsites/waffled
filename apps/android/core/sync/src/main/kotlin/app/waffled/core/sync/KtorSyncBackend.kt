package app.waffled.core.sync

import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledHttp
import app.waffled.core.network.WaffledJson
import io.ktor.client.HttpClient
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The real backend behind [WaffledConnector].
 *
 * Two endpoints, and three things differ between them on purpose:
 *
 *  - **Method.** `GET /api/powersync/token` and `POST /api/powersync/crud` — see
 *    `apps/api/src/modules/powersync/powersync.ts:110` and `powersync-crud.ts:161`.
 *  - **Failure handling.** The token call may legitimately fail (signed out, server
 *    down): return null and let PowerSync retry. The CRUD call must **throw**, so
 *    PowerSync keeps the queued writes — swallowing there loses offline edits silently.
 *  - Both are issued through [WaffledHttp.authorized], which attaches the bearer token
 *    and refreshes once on a 401.
 */
class KtorSyncBackend(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) : SyncBackend {

    override suspend fun fetchPowerSyncToken(): PowerSyncTokenResponse? = runCatching {
        WaffledHttp.authorized(
            client = client,
            tokens = tokens,
            method = HttpMethod.Get,
            path = "api/powersync/token",
        ) { response ->
            WaffledJson.decodeFromString(
                PowerSyncTokenResponse.serializer(),
                response.bodyAsText(),
            )
        }
    }.getOrNull()

    override suspend fun uploadCrud(ops: List<CrudOpDto>) {
        val body: JsonObject = buildJsonObject {
            put("ops", WaffledJson.encodeToJsonElement(ListSerializer(CrudOpDto.serializer()), ops))
        }

        // Deliberately NOT wrapped in runCatching: `authorized` throws
        // WaffledApiException on a non-2xx, and that throw is what makes offline writes
        // safe — PowerSync keeps the transaction queued and replays it later.
        WaffledHttp.authorized(
            client = client,
            tokens = tokens,
            method = HttpMethod.Post,
            path = "api/powersync/crud",
            configure = {
                contentType(ContentType.Application.Json)
                setBody(body)
            },
        ) { }
    }
}
