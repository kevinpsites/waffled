package app.waffled.core.network

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The twin of `Features/Shared/RestDomain.swift` — small, but load-bearing: it is the
 * primitive behind every REST-backed card, and ~80% of Waffled is REST rather than
 * PowerSync.
 *
 * The whole point is the distinction between "the fetch failed" and "there is genuinely
 * nothing here". Get it wrong and cards either blank out on a flaky network or sit on
 * "Loading…" forever.
 */
class RestDomainTest {

    @Test
    fun startsEmptyAndNotLoaded() {
        val d = RestDomain<List<String>>()
        assertEquals(null, d.value)
        assertFalse(d.loaded)
    }

    @Test
    fun applyingAValueMarksLoaded() {
        val d = RestDomain<List<String>>()
        d.apply(listOf("a"))
        assertEquals(listOf("a"), d.value)
        assertTrue(d.loaded)
    }

    @Test
    fun applyingEmptyIsAGenuineEmptyNotAFailure() {
        val d = RestDomain<List<String>>()
        d.apply(emptyList())
        assertEquals(emptyList(), d.value)
        assertTrue(d.loaded)
    }

    @Test
    fun failedFetchKeepsThePriorValueButStillMarksLoaded() {
        val d = RestDomain<List<String>>()
        d.apply(listOf("keep", "me"))

        d.apply(null) // the fetch failed

        // Never blank a populated card just because one refresh failed...
        assertEquals(listOf("keep", "me"), d.value)
        // ...and never sit on "Loading…" forever either.
        assertTrue(d.loaded)
    }

    @Test
    fun firstFetchFailingStillLeavesTheCardOutOfTheLoadingState() {
        val d = RestDomain<List<String>>()
        d.apply(null)
        assertEquals(null, d.value)
        assertTrue(d.loaded)
    }

    @Test
    fun emitsToCollectors() = runTest {
        val d = RestDomain<List<String>>()
        d.apply(listOf("x"))
        assertEquals(listOf("x"), d.state.first().value)
    }

    // ---- the nullable-single case ----
    //
    // `apply(null)` means "the fetch failed", which is right for a list. But a domain
    // holding ONE optional thing — tonight's dinner, say — needs to say "the fetch
    // succeeded and there is no dinner", and that is a different statement. Collapsing
    // them means a deleted dinner haunts the card forever, because every later refresh
    // looks like a failure and keeps the stale value.

    @Test
    fun succeededWithNullClearsTheValue() {
        val d = RestDomain<String?>()
        d.succeeded("Lasagne")
        assertEquals("Lasagne", d.value)

        d.succeeded(null) // the meal was deleted server-side
        assertEquals(null, d.value)
        assertTrue(d.loaded)
    }

    @Test
    fun failedKeepsThePriorValueEvenForANullableDomain() {
        val d = RestDomain<String?>()
        d.succeeded("Lasagne")

        d.failed()

        assertEquals("Lasagne", d.value, "a flaky network must not clear the card")
        assertTrue(d.loaded)
    }

    @Test
    fun failedOnAFreshDomainStillLeavesLoadingBehind() {
        val d = RestDomain<String?>()
        d.failed()
        assertEquals(null, d.value)
        assertTrue(d.loaded)
    }

    @Test
    fun applyRemainsTheShorthandForTheListCase() {
        // apply(x) == succeeded(x); apply(null) == failed(). Kept because it reads well
        // for the common non-nullable domain.
        val d = RestDomain<List<String>>()
        d.apply(listOf("a"))
        d.apply(null)
        assertEquals(listOf("a"), d.value)
        assertTrue(d.loaded)
    }
}

/**
 * Twin of `Sync/APIErrorText.swift`: relay what the server said rather than guessing.
 */
class ApiErrorTextTest {

    @Test
    fun prefersTheServersMessage() {
        val body = """{"error":"conflict","message":"That week is already planned."}"""
        assertEquals("That week is already planned.", ApiErrorText.from(body, status = 409))
    }

    @Test
    fun fallsBackToTheErrorFieldWhenThereIsNoMessage() {
        assertEquals("conflict", ApiErrorText.from("""{"error":"conflict"}""", status = 409))
    }

    @Test
    fun fallsBackToAStatusPhraseWhenTheBodyIsUnusable() {
        assertEquals("Something went wrong (500).", ApiErrorText.from("<html>oops", status = 500))
        assertEquals("Something went wrong (500).", ApiErrorText.from(null, status = 500))
    }

    @Test
    fun blankServerStringsAreIgnored() {
        val body = """{"error":"  ","message":""}"""
        assertEquals("Something went wrong (400).", ApiErrorText.from(body, status = 400))
    }
}

/**
 * Twin of the `*Rev` counters on the iOS SyncManager. Non-synced (REST) data has no
 * reactive query, so a bump on this bus is how a write tells every interested screen to
 * re-fetch.
 */
class RefreshBusTest {

    @Test
    fun bumpNotifiesSubscribersOfThatDomainOnly() = runTest {
        val bus = RefreshBus()
        val before = bus.revisionOf(RefreshDomain.Chores)

        bus.bump(RefreshDomain.Chores)

        assertEquals(before + 1, bus.revisionOf(RefreshDomain.Chores))
        assertEquals(0, bus.revisionOf(RefreshDomain.Goals))
    }

    @Test
    fun revisionsAreIndependentPerDomain() = runTest {
        val bus = RefreshBus()
        bus.bump(RefreshDomain.Lists)
        bus.bump(RefreshDomain.Lists)
        bus.bump(RefreshDomain.Rewards)

        assertEquals(2, bus.revisionOf(RefreshDomain.Lists))
        assertEquals(1, bus.revisionOf(RefreshDomain.Rewards))
        assertEquals(0, bus.revisionOf(RefreshDomain.Modules))
    }

    @Test
    fun eventsStreamCarriesTheBumpedDomain() = runTest {
        val bus = RefreshBus()
        bus.bump(RefreshDomain.Goals)
        assertEquals(RefreshDomain.Goals, bus.events.first())
    }
}
