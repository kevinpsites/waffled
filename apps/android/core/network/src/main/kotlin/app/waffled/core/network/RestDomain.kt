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
import java.time.Instant

/**
 * Holder for one REST-backed slice of state — the Compose twin of
 * `Features/Shared/RestDomain.swift`.
 *
 * The important rule, and the reason this type exists at all:
 *  - `apply(value)`   — real data (including an empty list, which means "genuinely none").
 *  - `apply(null)`    — the fetch FAILED. Keep whatever we already had, but still mark
 *                       loaded, so a card never blanks on a flaky network and never sits
 *                       on "Loading…" forever.
 *
 * Every snapshot also carries a [RestState], so a migrated screen can tell a stale,
 * offline or signed-out failure apart from an authoritative empty. Pass `Result`s to
 * [apply] to get the failure classified; the legacy `apply(null)`/[failed] path reports
 * stale (with a value) or error (without one). [isEmpty] decides Empty vs Ready.
 */
class RestDomain<T>(
    private val isEmpty: (T) -> Boolean = ::defaultIsEmpty,
) {

    /** `value` and `loaded` lead so existing destructuring keeps working. */
    data class Snapshot<T>(
        val value: T? = null,
        val loaded: Boolean = false,
        val rest: RestState = RestState.Loading,
    )

    private val _state = MutableStateFlow(Snapshot<T>())
    val state: StateFlow<Snapshot<T>> = _state.asStateFlow()

    /** Settable for optimistic local edits between fetches; the lifecycle is untouched. */
    var value: T?
        get() = _state.value.value
        set(newValue) = _state.update { it.copy(value = newValue) }

    val loaded: Boolean get() = _state.value.loaded
    val restState: RestState get() = _state.value.rest

    /**
     * The fetch SUCCEEDED and this is the answer — including `null`, which means
     * "genuinely nothing" for a nullable domain (no dinner planned tonight).
     */
    fun succeeded(newValue: T?, at: Instant = Instant.now()) {
        val empty = newValue == null || isEmpty(newValue)
        publish(newValue, if (empty) RestState.Empty(at) else RestState.Ready(at))
    }

    /**
     * The fetch FAILED. Keep whatever we already had, but mark loaded, so a card never
     * blanks on a flaky network and never sits on "Loading…" forever.
     */
    fun failed() = failWith(RestState.REFRESH_FAILED)

    /** The fetch failed with [error]; a 401 or a transport failure gets its own state. */
    fun failed(error: Throwable) {
        val prior = _state.value.rest.updatedAt
        when (RestFailureKind.of(error)) {
            RestFailureKind.SignInRequired -> publish(value, RestState.SignInRequired(prior))
            RestFailureKind.Offline -> publish(value, RestState.Offline(prior))
            RestFailureKind.Other -> failed()
        }
    }

    /**
     * Shorthand for the common list-shaped domain: a value means success, `null` means
     * the fetch failed.
     *
     * ⚠️ Do NOT use this for a domain holding one OPTIONAL thing — it cannot express
     * "succeeded, and there is nothing", so a deleted item would haunt the card forever
     * as every later refresh looked like a failure. Use [succeeded] / [failed] there.
     */
    fun apply(newValue: T?, at: Instant = Instant.now()) {
        if (newValue == null) failed() else succeeded(newValue, at)
    }

    /** Fold in a [RestFetch] result, classifying a failure. */
    @JvmName("applyResult")
    fun apply(result: Result<T>, at: Instant = Instant.now()) {
        result.fold(onSuccess = { succeeded(it, at) }, onFailure = { failed(it) })
    }

    /** A dated state stays put during a refresh; only a never-confirmed domain shows Loading. */
    fun beginLoading() {
        val rest = _state.value.rest
        if (rest is RestState.Queued || rest is RestState.Conflict) return
        if (rest.updatedAt == null) publish(value, RestState.Loading)
    }

    fun markQueued(pending: Int) =
        publish(value, RestState.Queued(maxOf(1, pending), _state.value.rest.updatedAt))

    fun markConflict(message: String) =
        publish(value, RestState.Conflict(message, _state.value.rest.updatedAt))

    /** An optimistic edit of the value alone. */
    fun mutate(transform: (T?) -> T?) = _state.update { it.copy(value = transform(it.value)) }

    /** Drop the value at an account or server boundary; it must never cross households. */
    fun reset() {
        _state.value = Snapshot()
    }

    private fun failWith(message: String) {
        val prior = _state.value.rest.updatedAt
        publish(value, if (prior != null) RestState.Stale(prior, message) else RestState.Error(message))
    }

    private fun publish(newValue: T?, rest: RestState) {
        _state.value = Snapshot(value = newValue, loaded = rest.loaded, rest = rest)
    }

    private companion object {
        fun defaultIsEmpty(value: Any?): Boolean = when (value) {
            null -> true
            is Collection<*> -> value.isEmpty()
            is Map<*, *> -> value.isEmpty()
            else -> false
        }
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

    /**
     * The server's error CODE (`{"error":"NoHousehold"}`), or null for a body that is not
     * a JSON object with a string `error`. Clients key behaviour on this, never on prose.
     */
    fun code(body: String?): String? = body?.let {
        runCatching {
            val error = lenient.parseToJsonElement(it).jsonObject["error"]?.jsonPrimitive
            error?.takeIf { p -> p.isString }?.content
        }.getOrNull()
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
