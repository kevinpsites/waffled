package app.waffled.feature.settingshousehold

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlin.math.abs

/**
 * The household "N sleeps vs N days" wording and the birthday window. Optimistic: the
 * control moves at once and rolls back, with a message, if the server refuses.
 */
class CountdownSettingsModel(
    private val fetch: suspend () -> CountdownConfig,
    private val setSleeps: suspend (Boolean) -> Unit,
    private val setHorizon: suspend (Int) -> Unit,
) {
    data class State(
        val sleeps: Boolean = false,
        val birthdayHorizon: Int = 183,
        val loaded: Boolean = false,
        val busy: Boolean = false,
        val errorMessage: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    suspend fun load() {
        _state.update { it.copy(errorMessage = null) }
        try {
            val c = fetch()
            _state.update { it.copy(sleeps = c.sleeps, birthdayHorizon = c.birthdayHorizonDays, loaded = true) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            _state.update { it.copy(errorMessage = "Couldn’t load Countdown settings.") }
        }
    }

    suspend fun changeSleeps(enabled: Boolean) {
        val s = _state.value
        if (s.busy || enabled == s.sleeps) return
        _state.update { it.copy(sleeps = enabled, busy = true, errorMessage = null) }
        try {
            setSleeps(enabled)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            _state.update {
                it.copy(
                    sleeps = s.sleeps,
                    errorMessage = "The Countdown wording wasn’t changed. Check your connection and try again.",
                )
            }
        } finally {
            _state.update { it.copy(busy = false) }
        }
    }

    suspend fun changeHorizon(days: Int) {
        val s = _state.value
        if (s.busy || days == s.birthdayHorizon) return
        _state.update { it.copy(birthdayHorizon = days, busy = true, errorMessage = null) }
        try {
            setHorizon(days)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            _state.update {
                it.copy(
                    birthdayHorizon = s.birthdayHorizon,
                    errorMessage = "The birthday window wasn’t changed. Check your connection and try again.",
                )
            }
        } finally {
            _state.update { it.copy(busy = false) }
        }
    }

    companion object {
        val horizonOptions: List<Pair<String, Int>> =
            listOf("1 month" to 31, "3 months" to 92, "6 months" to 183, "1 year" to 366)

        /** The preset nearest the stored value — the server accepts any 1…366. */
        fun horizonLabel(days: Int): String =
            horizonOptions.minByOrNull { abs(it.second - days) }?.first ?: "6 months"
    }
}

/**
 * The stored chore-photo manager. A confirmed delete updates the local list and tells the
 * caller to refresh its count; a failure leaves every visible row in place.
 */
class StoredProofsModel(
    proofs: List<SettingsHouseholdApi.StoredProof>,
    private val deleteProof: suspend (String) -> Unit,
    private val clearProofs: suspend () -> Int,
    private val onChanged: suspend () -> Unit,
) {
    data class State(
        val proofs: List<SettingsHouseholdApi.StoredProof> = emptyList(),
        val busy: Boolean = false,
        val errorMessage: String? = null,
    )

    private val _state = MutableStateFlow(State(proofs = proofs))
    val state: StateFlow<State> = _state.asStateFlow()

    suspend fun delete(proof: SettingsHouseholdApi.StoredProof): Boolean =
        mutate("Couldn’t delete this photo. Check your connection and try again.") {
            deleteProof(proof.instanceId)
            _state.update { s -> s.copy(proofs = s.proofs.filterNot { it.id == proof.id }) }
        }

    suspend fun clearAll(): Boolean =
        mutate("Couldn’t clear stored photos. Check your connection and try again.") {
            clearProofs()
            _state.update { it.copy(proofs = emptyList()) }
        }

    fun dismissError() = _state.update { it.copy(errorMessage = null) }

    private suspend fun mutate(failure: String, block: suspend () -> Unit): Boolean {
        if (_state.value.busy) return false
        _state.update { it.copy(busy = true, errorMessage = null) }
        return try {
            block()
            onChanged()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            _state.update { it.copy(errorMessage = failure) }
            false
        } finally {
            _state.update { it.copy(busy = false) }
        }
    }
}
