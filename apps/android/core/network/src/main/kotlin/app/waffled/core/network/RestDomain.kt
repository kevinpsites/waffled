package app.waffled.core.network

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Holder for one REST-backed slice of state — the Compose twin of
 * `Features/Shared/RestDomain.swift`.
 *
 * The important rule, and the reason this type exists at all:
 *  - `apply(value)`   — real data (including an empty list, which means "genuinely none").
 *  - `apply(null)`    — the fetch FAILED. Keep whatever we already had, but still mark
 *                       loaded, so a card never blanks on a flaky network and never sits
 *                       on "Loading…" forever.
 */
class RestDomain<T> {

    data class Snapshot<T>(val value: T? = null, val loaded: Boolean = false)

    private val _state = MutableStateFlow(Snapshot<T>())
    val state: StateFlow<Snapshot<T>> = _state.asStateFlow()

    val value: T? get() = _state.value.value
    val loaded: Boolean get() = _state.value.loaded

    fun apply(newValue: T?) {
        _state.update { prior ->
            // A failed fetch keeps the prior value; a real one replaces it.
            Snapshot(value = newValue ?: prior.value, loaded = true)
        }
    }

    fun reset() {
        _state.value = Snapshot()
    }
}

/**
 * Turn a server error body into something worth showing a user.
 *
 * Relay what the server actually said — it knows why the request failed and we don't.
 * Twin of `Sync/APIErrorText.swift`.
 */
object ApiErrorText {

    private val lenient = Json { ignoreUnknownKeys = true; isLenient = true }

    fun from(body: String?, status: Int): String {
        val fromServer = body?.let(::extractServerText)
        return fromServer ?: "Something went wrong ($status)."
    }

    private fun extractServerText(body: String): String? = runCatching {
        val obj = lenient.parseToJsonElement(body).jsonObject
        // `message` is the human-facing one; `error` is the code, used as a fallback.
        val message = obj["message"]?.jsonPrimitive?.contentOrNullBlankSafe()
        val error = obj["error"]?.jsonPrimitive?.contentOrNullBlankSafe()
        message ?: error
    }.getOrNull()

    private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullBlankSafe(): String? =
        content.trim().takeIf { it.isNotEmpty() }
}

/** The REST slices that a write can invalidate. */
enum class RefreshDomain { Chores, Rewards, Goals, Lists, Modules, Meals, Pantry, Photos }

/**
 * The invalidation bus — the twin of the iOS SyncManager's `choresRev`/`goalsRev`/…
 * counters.
 *
 * Non-synced data has no reactive query, so after a write the writer bumps the relevant
 * domain and every screen watching it re-fetches. Collect [events], or observe
 * [revisionOf] as a key.
 */
class RefreshBus {

    private val revisions = MutableStateFlow(mapOf<RefreshDomain, Int>())
    val state: StateFlow<Map<RefreshDomain, Int>> = revisions.asStateFlow()

    private val _events = MutableSharedFlow<RefreshDomain>(replay = 1, extraBufferCapacity = 16)
    val events: SharedFlow<RefreshDomain> = _events.asSharedFlow()

    fun bump(domain: RefreshDomain) {
        revisions.update { it + (domain to (it[domain] ?: 0) + 1) }
        _events.tryEmit(domain)
    }

    fun revisionOf(domain: RefreshDomain): Int = revisions.value[domain] ?: 0
}
