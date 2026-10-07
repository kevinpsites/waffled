package app.waffled.core.network

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import java.io.IOException
import java.net.UnknownHostException
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Port of `RestStateContractTests` in `apps/ios/Tests/RestDataStateTests.swift`: the
 * truthful lifecycle for REST-only data. `Empty`/`Ready` are authoritative server answers;
 * every other terminal state says why a value must not be shown as an authoritative empty.
 */
private val fixtureDate: Instant = Instant.ofEpochSecond(1_785_500_000)

private class Rejected : Exception("rejected")

private fun domain() = RestDomain<List<Int>>(isEmpty = { it.isEmpty() })

class RestStateContractTest {

    @Test
    fun expiredAuthenticationHasAnExplicitRecoveryState() {
        val d = domain()
        d.apply(Result.failure(WaffledApiException(401, "Expired")))
        assertEquals(RestState.SignInRequired(updatedAt = null), d.restState)
    }

    @Test
    fun pendingWritesNeverHideFailedReads() {
        val failures = listOf(
            RestState.Error("Failed"),
            RestState.Offline(null),
            RestState.Stale(fixtureDate, "Old"),
        )
        for (failure in failures) {
            for (pending in listOf(
                RestState.Queued(1, fixtureDate),
                RestState.Conflict("Conflict", fixtureDate),
            )) {
                assertEquals(failure, RestState.combined(listOf(pending, failure)))
                assertEquals(failure, RestState.combined(listOf(failure, pending)))
            }
        }
    }

    @Test
    fun successfulEmptyIsAuthoritative() {
        val d = domain()
        d.apply(emptyList(), at = fixtureDate)
        assertEquals(RestState.Empty(fixtureDate), d.restState)
        assertTrue(d.restState.isAuthoritative)
    }

    @Test
    fun initialServerFailureIsAnErrorNotEmpty() {
        val d = domain()
        d.apply(Result.failure(Rejected()), at = fixtureDate)
        assertIs<RestState.Error>(d.restState)
        assertFalse(d.restState.isAuthoritative)
    }

    @Test
    fun failedRefreshKeepsValueAndBecomesStale() {
        val d = domain()
        d.apply(listOf(1, 2), at = fixtureDate)

        d.apply(Result.failure(Rejected()))

        assertEquals(listOf(1, 2), d.value)
        val state = assertIs<RestState.Stale>(d.restState)
        assertEquals(fixtureDate, state.updatedAt)
    }

    @Test
    fun networkFailureIsOfflineNotGenericError() {
        val d = domain()
        d.apply(Result.failure(UnknownHostException("waffled.local")))
        assertEquals(RestState.Offline(null), d.restState)
    }

    @Test
    fun aWrappedNetworkFailureIsStillOffline() {
        val d = domain()
        d.apply(Result.failure(IllegalStateException("wrapped", java.net.ConnectException("refused"))))
        assertEquals(RestState.Offline(null), d.restState)
    }

    @Test
    fun queuedAndConflictAreExplicitStates() {
        val d = domain()
        d.apply(listOf(1), at = fixtureDate)

        d.markQueued(2)
        assertEquals(RestState.Queued(2, fixtureDate), d.restState)

        d.markConflict("Changed on another device")
        assertEquals(RestState.Conflict("Changed on another device", fixtureDate), d.restState)
    }

    @Test
    fun partialScreenFailureDoesNotBorrowSuccessfulSiblingsTimestamp() {
        val state = RestState.combined(listOf(RestState.Empty(fixtureDate), RestState.Error("Couldn’t load")))
        assertEquals(RestState.Error("Couldn’t load"), state)
        assertNull(state.updatedAt)
        assertFalse(state.isAuthoritative)
    }

    @Test
    fun staleDomainDoesNotBorrowANewerSiblingTimestamp() {
        val freshAt = fixtureDate.plusSeconds(3_600)
        val state = RestState.combined(
            listOf(RestState.Ready(freshAt), RestState.Stale(fixtureDate, "Chores couldn’t refresh.")),
        )
        assertEquals(RestState.Stale(fixtureDate, "Chores couldn’t refresh."), state)
    }

    @Test
    fun multipleStaleDomainsUseTheOldestTimestamp() {
        val state = RestState.combined(
            listOf(
                RestState.Stale(fixtureDate.plusSeconds(1_800), "Feed couldn’t refresh."),
                RestState.Ready(fixtureDate.plusSeconds(3_600)),
                RestState.Stale(fixtureDate, "Feed couldn’t refresh."),
            ),
        )
        assertEquals(RestState.Stale(fixtureDate, "Feed couldn’t refresh."), state)
    }

    @Test
    fun multipleStaleDomainsAreOrderIndependentAndUseAggregateCopyWhenMessagesDiffer() {
        val oldest = RestState.Stale(fixtureDate, "Chores couldn’t refresh.")
        val newer = RestState.Stale(fixtureDate.plusSeconds(1_800), "Goals couldn’t refresh.")
        val expected = RestState.Stale(fixtureDate, "Some data couldn’t be refreshed.")
        assertEquals(expected, RestState.combined(listOf(oldest, newer)))
        assertEquals(expected, RestState.combined(listOf(newer, oldest)))
    }

    @Test
    fun loadingDoesNotHideKnownFailures() {
        val error = RestState.Error("Couldn’t load")
        val loading = RestState.Loading
        assertEquals(error, RestState.combined(listOf(error, loading)))
        assertEquals(error, RestState.combined(listOf(loading, error)))
        assertEquals(error, RestState.combined(listOf(RestState.Ready(fixtureDate), error, loading)))
        assertEquals(error, RestState.combined(listOf(RestState.Ready(fixtureDate), error)))
    }

    @Test
    fun offlineDomainDoesNotBorrowAFreshSiblingsTimestamp() {
        val state = RestState.combined(listOf(RestState.Offline(null), RestState.Ready(fixtureDate)))
        assertEquals(RestState.Offline(null), state)
    }

    @Test
    fun unknownOfflineTimestampDominatesDatedOfflineSiblings() {
        val state = RestState.combined(listOf(RestState.Offline(fixtureDate), RestState.Offline(null)))
        assertEquals(RestState.Offline(null), state)
    }

    @Test
    fun multipleDatedOfflineDomainsUseTheOldestTimestamp() {
        val state = RestState.combined(
            listOf(RestState.Offline(fixtureDate.plusSeconds(1_800)), RestState.Offline(fixtureDate)),
        )
        assertEquals(RestState.Offline(fixtureDate), state)
    }

    @Test
    fun mixedOfflineAndStaleDomainsUseTheOldestFailureTimestampInEitherOrder() {
        val offline = RestState.Offline(fixtureDate.plusSeconds(1_800))
        val stale = RestState.Stale(fixtureDate, "Couldn’t refresh.")
        assertEquals(RestState.Offline(fixtureDate), RestState.combined(listOf(offline, stale)))
        assertEquals(RestState.Offline(fixtureDate), RestState.combined(listOf(stale, offline)))
    }

    @Test
    fun unknownFailureTimestampDominatesMixedOfflineAggregation() {
        val offline = RestState.Offline(fixtureDate)
        val error = RestState.Error("Couldn’t load")
        assertEquals(RestState.Offline(null), RestState.combined(listOf(offline, error)))
        assertEquals(RestState.Offline(null), RestState.combined(listOf(error, offline)))
    }

    // ---- Android-side additions: the legacy API and the fetch wrapper ----

    @Test
    fun theLegacyNullFailureBecomesStaleOrError() {
        val d = domain()
        d.apply(null)
        assertIs<RestState.Error>(d.restState)
        assertTrue(d.loaded, "the legacy contract: a failed first load still leaves Loading")

        d.apply(listOf(1), at = fixtureDate)
        d.failed()
        assertEquals(fixtureDate, assertIs<RestState.Stale>(d.restState).updatedAt)
    }

    @Test
    fun snapshotsCarryTheRestState() {
        val d = domain()
        assertEquals(RestState.Loading, d.state.value.rest)
        d.apply(listOf(1), at = fixtureDate)
        assertEquals(RestState.Ready(fixtureDate), d.state.value.rest)
        assertTrue(d.state.value.loaded)
    }

    @Test
    fun beginLoadingOnlyShowsLoadingWhenNothingWasEverConfirmed() {
        val d = domain()
        d.apply(Result.failure(Rejected()))
        d.beginLoading()
        assertEquals(RestState.Loading, d.restState)

        d.apply(listOf(1), at = fixtureDate)
        d.beginLoading()
        assertEquals(RestState.Ready(fixtureDate), d.restState, "a refresh keeps the dated state")
    }

    @Test
    fun anOptimisticMutationKeepsTheLifecycle() {
        val d = domain()
        d.apply(listOf(1), at = fixtureDate)
        d.mutate { it.orEmpty() + 2 }
        assertEquals(listOf(1, 2), d.value)
        assertEquals(RestState.Ready(fixtureDate), d.restState)
    }

    @Test
    fun resetDropsValueAndState() {
        val d = domain()
        d.apply(listOf(1), at = fixtureDate)
        d.reset()
        assertNull(d.value)
        assertEquals(RestState.Loading, d.restState)
    }

    @Test
    fun restFetchCapturesFailuresButNotCancellation() = runTest {
        assertEquals(Result.success(3), RestFetch.result { 3 })
        assertTrue(RestFetch.result { throw IOException("down") }.isFailure)
        assertFailsWith<CancellationException> { RestFetch.result { throw CancellationException("left") } }
    }

    @Test
    fun aDisabledFetchIsNeverCalled() = runTest {
        var called = false
        assertNull(RestFetch.result(enabled = false) { called = true })
        assertFalse(called)
    }
}

/** The recovery copy `RestStateNotice` renders — the text half of the iOS view. */
class RestNoticeTest {

    private val at: (Instant) -> String = { "9:41 AM" }

    @Test
    fun authoritativeAndLoadingStatesShowNoNotice() {
        assertNull(RestNotice.of(RestState.Loading, at))
        assertNull(RestNotice.of(RestState.Empty(fixtureDate), at))
        assertNull(RestNotice.of(RestState.Ready(fixtureDate), at))
    }

    @Test
    fun staleSaysWhenTheSavedDataIsFrom() {
        val n = RestNotice.of(RestState.Stale(fixtureDate, "Couldn’t refresh this data."), at)!!
        assertEquals("Showing saved data", n.title)
        assertEquals("Couldn’t refresh this data. Last updated 9:41 AM.", n.message)
        assertTrue(n.canRetry)
    }

    @Test
    fun offlineWithAndWithoutSavedData() {
        assertEquals("Showing data saved at 9:41 AM.", RestNotice.of(RestState.Offline(fixtureDate), at)!!.message)
        val bare = RestNotice.of(RestState.Offline(null), at)!!
        assertEquals("Can’t reach Waffled", bare.title)
        assertEquals("Check your connection and that your household server is available.", bare.message)
    }

    @Test
    fun queuedPluralises() {
        assertEquals("1 change queued to sync.", RestNotice.of(RestState.Queued(1, null), at)!!.message)
        assertEquals("3 changes queued to sync.", RestNotice.of(RestState.Queued(3, null), at)!!.message)
        assertFalse(RestNotice.of(RestState.Queued(1, null), at)!!.canRetry)
    }

    @Test
    fun signInRequiredCannotRetry() {
        val n = RestNotice.of(RestState.SignInRequired(null), at)!!
        assertEquals("Sign in again", n.title)
        assertFalse(n.canRetry)
    }

    @Test
    fun errorRelaysItsMessage() {
        val n = RestNotice.of(RestState.Error("Couldn’t refresh this data."), at)!!
        assertEquals("Couldn’t load", n.title)
        assertEquals("Couldn’t refresh this data.", n.message)
        assertEquals(RestNotice.Tone.Danger, n.tone)
    }
}
