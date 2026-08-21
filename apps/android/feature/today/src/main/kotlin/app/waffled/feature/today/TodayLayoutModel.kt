package app.waffled.feature.today

import androidx.compose.runtime.Immutable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The Today card layout: which cards, in what order, and whether this member may edit the
 * shared family default.
 *
 * ⚠️ This reads and writes the **mobile** layout only. Web and mobile keep separate
 * configs — the web board is 3-column and reorder-only with a different card set, so
 * writing the web tier from the phone would silently reshape the other platform.
 *
 * Like [DashboardModel], plain `suspend` functions rather than a scope-owning ViewModel,
 * so the whole thing is drivable from a JVM test.
 */
class TodayLayoutModel(private val api: TodayApi) {

    @Immutable
    data class State(
        val order: List<String> = TodayCards.defaultOrder,
        val hidden: Set<String> = emptySet(),
        val canEditFamily: Boolean = false,
        /** Which tier the resolved layout came from: "user" | "family" | "default". */
        val source: String = "default",
        val loaded: Boolean = false,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /**
     * Fetch the resolved layout.
     *
     * A failed fetch leaves the previous state untouched — same rule as the REST cards:
     * a flaky network must not rearrange someone's home screen. The built-in default
     * order still applies on a cold start, so the dashboard renders either way.
     */
    suspend fun load() {
        val resp = runCatching { api.todayLayout() }.getOrNull() ?: return
        val hidden = resp.resolved.hidden.toSet()
        _state.value = State(
            order = TodayCards.applyFallbacks(resp.resolved.order, hidden),
            hidden = hidden,
            canEditFamily = resp.canEditFamily,
            source = resp.source,
            loaded = true,
        )
    }

    /** Save to a tier — "user" (your own arrangement) or "family" (the household default). */
    suspend fun save(scope: String, order: List<String>, hidden: Set<String>): Boolean {
        val ok = runCatching { api.saveTodayLayout(scope, order, hidden.toList()) }.isSuccess
        load()
        return ok
    }

    /** Drop a tier back to inheriting (user → family, family → the built-in default). */
    suspend fun reset(scope: String): Boolean {
        val ok = runCatching { api.resetTodayLayout(scope) }.isSuccess
        load()
        return ok
    }
}
