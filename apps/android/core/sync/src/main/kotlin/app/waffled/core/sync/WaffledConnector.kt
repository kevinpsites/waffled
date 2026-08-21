package app.waffled.core.sync

import com.powersync.PowerSyncDatabase
import com.powersync.connectors.PowerSyncBackendConnector
import com.powersync.connectors.PowerSyncCredentials
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

    override suspend fun uploadData(database: PowerSyncDatabase) {
        while (true) {
            val tx = database.getNextCrudTransaction() ?: break

            val ops = tx.crud.map { entry ->
                CrudOpDto(
                    op = entry.op.toString(),
                    table = entry.table,
                    id = entry.id,
                    data = entry.opData,
                )
            }

            // Throw on failure so PowerSync KEEPS the queue and retries — that is what
            // makes offline writes safe. Swallowing here would silently drop them.
            backend.uploadCrud(ops)
            tx.complete(null)
        }
    }
}
