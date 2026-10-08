package app.waffled.feature.settings

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * The stored chore-photo manager. A row only leaves the list once the server confirms the
 * delete, and the parent is told only then — a failed delete keeps the photo visible.
 */
class StoredProofsModel(
    proofs: List<SettingsApi.StoredProof>,
    private val deleteProof: suspend (String) -> Unit,
    private val clearProofs: suspend () -> Int,
    private val onChanged: suspend () -> Unit,
) {
    data class State(
        val proofs: List<SettingsApi.StoredProof>,
        val busy: Boolean = false,
        val errorMessage: String? = null,
    )

    private val _state = MutableStateFlow(State(proofs))
    val state: StateFlow<State> = _state.asStateFlow()

    val proofs get() = _state.value.proofs
    val busy get() = _state.value.busy
    val errorMessage get() = _state.value.errorMessage

    suspend fun delete(proof: SettingsApi.StoredProof): Boolean = mutate(
        failure = "Couldn’t delete this photo. Check your connection and try again.",
        action = { deleteProof(proof.instanceId) },
        apply = { list -> list.filter { it.instanceId != proof.instanceId } },
    )

    suspend fun clearAll(): Boolean = mutate(
        failure = "Couldn’t clear stored photos. Check your connection and try again.",
        action = { clearProofs() },
        apply = { emptyList() },
    )

    fun dismissError() = _state.update { it.copy(errorMessage = null) }

    private suspend fun mutate(
        failure: String,
        action: suspend () -> Unit,
        apply: (List<SettingsApi.StoredProof>) -> List<SettingsApi.StoredProof>,
    ): Boolean {
        if (busy) return false
        _state.update { it.copy(busy = true, errorMessage = null) }
        val ok = runCatching { action() }.isSuccess
        _state.update {
            if (ok) it.copy(proofs = apply(it.proofs), busy = false)
            else it.copy(busy = false, errorMessage = failure)
        }
        if (ok) onChanged()
        return ok
    }
}
