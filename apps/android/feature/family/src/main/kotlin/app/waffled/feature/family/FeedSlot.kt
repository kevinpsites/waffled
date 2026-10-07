package app.waffled.feature.family

import app.waffled.core.network.RestDomain
import kotlinx.coroutines.CancellationException

/**
 * One REST feed on a Family surface: the [RestDomain] value plus whether the LAST fetch
 * failed, which `RestDomain` alone cannot say (a failure keeps the prior value and marks
 * loaded, exactly like a success). That bit is what keeps a failed read from rendering
 * "All caught up" or "No goals yet".
 *
 * TODO(RestState): replace with `core:network` RestState once it lands; it adds the
 * offline / stale / sign-in-required distinctions this flattens into one flag.
 */
internal class FeedSlot<T> {
    private val domain = RestDomain<List<T>>()
    var failed: Boolean = false
        private set

    val value: List<T> get() = domain.value ?: emptyList()
    val hasValue: Boolean get() = domain.value != null
    val loaded: Boolean get() = domain.loaded
    val authoritative: Boolean get() = loaded && !failed

    fun succeeded(rows: List<T>) {
        domain.succeeded(rows)
        failed = false
    }

    fun failed() {
        domain.failed()
        failed = true
    }

    fun apply(result: Result<List<T>>) = result.fold(::succeeded) { failed() }

    fun edit(transform: (List<T>) -> List<T>) {
        if (domain.value != null) domain.succeeded(transform(value))
    }

    fun reset() {
        domain.reset()
        failed = false
    }

    /**
     * The tile line for this feed: "Loading…" before the first answer, the value once
     * confirmed, a hedged value after a failed refresh, and "Couldn’t load" when nothing
     * was ever confirmed — never a confident empty.
     */
    fun subtitle(value: String): String = when {
        !loaded -> "Loading…"
        !failed -> value
        hasValue -> if (value.isEmpty()) "May be out of date" else "May be out of date · $value"
        else -> "Couldn’t load"
    }
}

/** Runs a fetch, turning any failure except cancellation into a [Result.failure]. */
internal suspend fun <T> fetchResult(block: suspend () -> T): Result<T> = try {
    Result.success(block())
} catch (e: CancellationException) {
    throw e
} catch (e: Throwable) {
    Result.failure(e)
}
