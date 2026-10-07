package app.waffled.feature.planning

import app.waffled.core.auth.KeyValueStore
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.TokenProvider
import app.waffled.core.sync.SyncManager
import app.waffled.feature.planning.api.PlanningApi
import app.waffled.feature.planning.api.PlanningHttp
import io.ktor.client.HttpClient

/**
 * What the app hands Weekly Planning: RAW dependencies, not prebuilt step APIs, so a step
 * builds its own `Planning<Step>Api` (or another feature's model) from [client]/[tokens]
 * without anyone editing this class. Built once by the `app` module.
 */
class PlanningEnvironment(
    val client: HttpClient,
    val tokens: TokenProvider,
    /** Events, members, the household zone and the module gate. */
    val sync: SyncManager,
    val refreshBus: RefreshBus,
    /** The server origin, for media URLs (`MediaUrl.resolve`). */
    val baseUrl: String,
    /** Persists "Leave for now" on this device. */
    val store: KeyValueStore,
    /** The tablet kiosk draws the footer's "· next" hint and drops the back chevron. */
    val isKiosk: Boolean = false,
) {
    /** Shared by every planning API slice. */
    val http: PlanningHttp by lazy { PlanningHttp(client, tokens) }
    val api: PlanningApi by lazy { PlanningApi(client, tokens) }

    fun newModel(): PlanningModel = PlanningModel(api, store)
}
