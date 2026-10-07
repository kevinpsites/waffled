package app.waffled.feature.settings

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** The rows and columns of the role → capability grid, with iOS `PermissionsCard` copy. */
object PermissionsGrid {
    val roles = listOf("adult", "teen", "kid")
    val capabilities = listOf("chore.manage", "chore.approve", "reward.manage", "reward.approve")

    private val roleLabels = mapOf("adult" to "Adults", "teen" to "Teens", "kid" to "Kids")
    private val capLabels = mapOf(
        "chore.manage" to "Manage chores",
        "chore.approve" to "Approve chores",
        "reward.manage" to "Manage rewards",
        "reward.approve" to "Approve redemptions",
    )
    private val capSubs = mapOf(
        "chore.manage" to "Create & edit chores for everyone",
        "chore.approve" to "OK or send back finished chores",
        "reward.manage" to "Add & edit rewards and currencies",
        "reward.approve" to "OK or deny reward redemptions",
    )

    fun roleLabel(role: String) = roleLabels[role] ?: role.replaceFirstChar { it.uppercase() }
    fun capabilityLabel(cap: String) = capLabels[cap] ?: cap
    fun capabilitySubtitle(cap: String) = capSubs[cap].orEmpty()
}

/**
 * The permissions card's state. Any failed load (a non-admin's 403) hides the card, so
 * it gates itself. Each toggle saves the WHOLE matrix and reverts on failure.
 */
class PermissionsMatrixModel(
    private val fetch: suspend () -> Map<String, Map<String, Boolean>>,
    private val save: suspend (Map<String, Map<String, Boolean>>) -> Map<String, Map<String, Boolean>>,
) {
    data class State(
        val matrix: Map<String, Map<String, Boolean>>? = null,
        val hidden: Boolean = false,
        val saving: Boolean = false,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    val matrix get() = _state.value.matrix
    val hidden get() = _state.value.hidden
    val saving get() = _state.value.saving

    suspend fun load() {
        if (matrix != null || hidden) return
        val loaded = runCatching { fetch() }.getOrNull()
        _state.update { if (loaded == null) it.copy(hidden = true) else it.copy(matrix = loaded) }
    }

    suspend fun toggle(role: String, capability: String) {
        val prev = matrix ?: return
        if (saving) return
        val row = prev[role].orEmpty()
        val next = prev + (role to row + (capability to !(row[capability] ?: false)))
        _state.update { it.copy(matrix = next, saving = true) }
        val saved = runCatching { save(next) }.getOrNull()
        _state.update { it.copy(matrix = saved ?: prev, saving = false) }
    }
}
