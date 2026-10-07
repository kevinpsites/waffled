package app.waffled.core.sync

import app.waffled.core.network.WaffledApiException
import com.powersync.PowerSyncDatabase
import com.powersync.connectors.PowerSyncBackendConnector
import com.powersync.connectors.PowerSyncCredentials
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable

/** One row operation drained from the local CRUD queue. */
@Serializable
data class CrudOpDto(
    val op: String,
    val table: String,
    val id: String,
    val data: Map<String, String?>? = null,
)

/** The two calls the connector needs, kept as a seam so it stays testable. */
interface SyncBackend {
    /** `POST /api/powersync/token` → the PowerSync endpoint + a short-lived token. */
    suspend fun fetchPowerSyncToken(): PowerSyncTokenResponse?

    /** `POST /api/powersync/crud` — forward one transaction's row ops. */
    suspend fun uploadCrud(ops: List<CrudOpDto>)
}

@Serializable
data class PowerSyncTokenResponse(
    val token: String,
    val powerSyncUrl: String? = null,
)

/**
 * Bridges PowerSync to the Waffled backend — the Kotlin twin of `WaffledConnector.swift`
 * and the web connector.
 *
 * - [fetchCredentials] exchanges the session token for a PowerSync token + URL.
 * - [uploadData] drains queued local writes and forwards each transaction's row ops,
 *   keyed on the client-generated id so the optimistic local row and the replicated
 *   server row are the same row.
 *
 * ⚠️ The `powerSyncUrl` comes from the SERVER. If the stack advertises a `localhost`
 * `POWERSYNC_PUBLIC_URL`, REST will work while sync silently sits at "Offline" — the
 * device cannot reach the server's idea of localhost. See the port plan §0.1.
 */
class WaffledConnector(
    private val backend: SyncBackend,
) : PowerSyncBackendConnector() {

    override suspend fun fetchCredentials(): PowerSyncCredentials? {
        val resp = backend.fetchPowerSyncToken() ?: return null
        val endpoint = resp.powerSyncUrl
        // No token/URL yet (not signed in) — returning null makes PowerSync retry once
        // one appears, rather than treating it as a hard failure.
        if (endpoint.isNullOrEmpty() || resp.token.isEmpty()) return null
        return PowerSyncCredentials(endpoint = endpoint, token = resp.token)
    }

    private val _lastRejection = MutableStateFlow<UploadRejection?>(null)

    /** The most recent transaction the server refused for good and that was dropped. */
    val lastRejection: StateFlow<UploadRejection?> = _lastRejection.asStateFlow()

    override suspend fun uploadData(database: PowerSyncDatabase) {
        drain {
            database.getNextCrudTransaction()?.let { tx ->
                object : CrudBatch {
                    override val ops = tx.crud.map { entry ->
                        CrudOpDto(
                            op = entry.op.toString(),
                            table = entry.table,
                            id = entry.id,
                            data = entry.opData,
                        )
                    }
                    override suspend fun complete() = tx.complete(null)
                }
            }
        }
    }

    internal suspend fun drain(next: suspend () -> CrudBatch?) {
        while (true) {
            val tx = next() ?: break
            // Throw on failure so PowerSync KEEPS the queue and retries — that is what
            // makes offline writes safe. The one exception is a refusal that can never
            // succeed: retrying it would wedge every write behind it. iOS and web rethrow
            // all of them and share that wedge.
            try {
                backend.uploadCrud(tx.ops)
            } catch (e: WaffledApiException) {
                if (!isPermanent(e.status)) throw e
                _lastRejection.value = UploadRejection(e.status, e.userMessage, tx.ops)
            }
            tx.complete()
        }
    }

    /** 4xx is the server's final word — except auth, timeouts and throttling, which pass. */
    private fun isPermanent(status: Int): Boolean =
        status in 400..499 && status !in RETRYABLE_4XX

    private companion object {
        val RETRYABLE_4XX = setOf(401, 403, 408, 429)
    }
}

/** One queued CRUD transaction — a seam so the drain loop is testable without PowerSync. */
internal interface CrudBatch {
    val ops: List<CrudOpDto>
    suspend fun complete()
}

/** A transaction the server refused with a non-retryable 4xx, dropped from the queue. */
data class UploadRejection(
    val status: Int,
    val message: String,
    val ops: List<CrudOpDto>,
)
