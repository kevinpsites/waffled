package app.waffled.core.network

import kotlinx.coroutines.CancellationException
import java.io.IOException
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * Truthful lifecycle for data that exists only behind REST — the twin of `RestState` in
 * `Features/Shared/RestDomain.swift`. [Empty] and [Ready] are authoritative server
 * answers; every other terminal state tells the UI why the value must not be presented
 * as an authoritative empty result.
 */
sealed interface RestState {
    data object Loading : RestState
    data class Empty(override val updatedAt: Instant) : RestState
    data class Ready(override val updatedAt: Instant) : RestState
    data class Stale(override val updatedAt: Instant, val message: String) : RestState
    data class Offline(override val updatedAt: Instant?) : RestState
    data class Queued(val pending: Int, override val updatedAt: Instant?) : RestState
    data class Conflict(val message: String, override val updatedAt: Instant?) : RestState
    data class Error(val message: String) : RestState
    data class SignInRequired(override val updatedAt: Instant?) : RestState

    val updatedAt: Instant? get() = null

    val loaded: Boolean get() = this !is Loading

    /** Only these are fresh enough to justify "All caught up" / "No chores today" copy. */
    val isAuthoritative: Boolean get() = this is Empty || this is Ready

    companion object {
        const val REFRESH_FAILED = "Couldn’t refresh this data."
        private const val SOME_FAILED = "Some data couldn’t be refreshed."

        /**
         * One state for a screen built from several domains. Read failures outrank queued
         * writes and conflicts; failed domains never borrow a sibling's timestamp, so an
         * unknown age stays unknown and dated failures report the oldest.
         */
        fun combined(states: List<RestState>): RestState {
            if (states.isEmpty()) return Loading
            val latest = states.mapNotNull { it.updatedAt }.maxOrNull()

            states.firstOrNull { it is SignInRequired }?.let { return it }

            if (states.any { it is Offline }) {
                val failedDates = mutableListOf<Instant>()
                var unknownFailureAge = false
                for (state in states) {
                    when (state) {
                        is Offline -> state.updatedAt?.let(failedDates::add) ?: run { unknownFailureAge = true }
                        is Stale -> failedDates += state.updatedAt
                        is Error -> unknownFailureAge = true
                        else -> Unit
                    }
                }
                return Offline(if (unknownFailureAge) null else failedDates.minOrNull())
            }

            // A failed first load has no saved timestamp, even beside fresh siblings.
            states.firstOrNull { it is Error }?.let { return it }

            val stale = states.filterIsInstance<Stale>()
            stale.minByOrNull { it.updatedAt }?.let { oldest ->
                val message = if (stale.map { it.message }.toSet().size == 1) oldest.message else SOME_FAILED
                return Stale(oldest.updatedAt, message)
            }

            states.firstOrNull { it is Conflict }?.let { return it }
            states.firstOrNull { it is Queued }?.let { return it }
            if (states.any { it is Loading }) return Loading

            val date = latest ?: Instant.now()
            return if (states.any { it is Ready }) Ready(date) else Empty(date)
        }
    }
}

/**
 * Runs a fetch and captures its outcome, so a screen can fan requests out and apply every
 * response together once they settle. Cancellation is rethrown, never captured: a screen
 * that is left mid-load must not mark its domains as failed.
 */
object RestFetch {

    suspend fun <T> result(fetch: suspend () -> T): Result<T> =
        try {
            Result.success(fetch())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Result.failure(e)
        }

    /** Null when [enabled] is false — a disabled module's endpoint is never called. */
    suspend fun <T> result(enabled: Boolean, fetch: suspend () -> T): Result<T>? =
        if (enabled) result(fetch) else null
}

internal enum class RestFailureKind {
    SignInRequired, Offline, Other;

    companion object {
        fun of(error: Throwable): RestFailureKind {
            if (error is WaffledApiException && error.status == 401) return SignInRequired
            // Ktor wraps transport failures, so the cause chain decides.
            var cause: Throwable? = error
            while (cause != null) {
                if (cause is IOException) return Offline
                cause = cause.cause.takeIf { it !== cause }
            }
            return Other
        }
    }
}

/**
 * The recovery copy for a non-authoritative state — the text half of the iOS
 * `RestStateNotice`, kept free of Compose so it is testable and shared.
 */
data class RestNotice(
    val title: String,
    val message: String,
    val tone: Tone,
    val canRetry: Boolean,
) {
    /** Each surface maps a tone to its own theme token. */
    enum class Tone { Warn, Muted, Success, Primary, Danger }

    companion object {
        private val shortTime: DateTimeFormatter = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)

        fun defaultTime(instant: Instant): String = shortTime.format(instant.atZone(ZoneId.systemDefault()))

        /** Null for the states that need no notice: loading, empty and ready. */
        fun of(state: RestState, time: (Instant) -> String = ::defaultTime): RestNotice? = when (state) {
            is RestState.Stale -> RestNotice(
                "Showing saved data", "${state.message} Last updated ${time(state.updatedAt)}.",
                Tone.Warn, canRetry = true,
            )
            is RestState.Offline -> RestNotice(
                "Can’t reach Waffled",
                state.updatedAt?.let { "Showing data saved at ${time(it)}." }
                    ?: "Check your connection and that your household server is available.",
                Tone.Muted, canRetry = true,
            )
            is RestState.Queued -> RestNotice(
                "Saved on this device",
                "${state.pending} change${if (state.pending == 1) "" else "s"} queued to sync.",
                Tone.Success, canRetry = false,
            )
            is RestState.Conflict -> RestNotice("Needs review", state.message, Tone.Primary, canRetry = true)
            is RestState.SignInRequired -> RestNotice(
                "Sign in again", "Your session expired. Sign out in Settings, then sign in again.",
                Tone.Danger, canRetry = false,
            )
            is RestState.Error -> RestNotice("Couldn’t load", state.message, Tone.Danger, canRetry = true)
            RestState.Loading, is RestState.Empty, is RestState.Ready -> null
        }
    }
}
