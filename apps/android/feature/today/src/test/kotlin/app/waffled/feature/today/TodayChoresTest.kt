package app.waffled.feature.today

import app.waffled.core.model.Person
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Port of `apps/ios/Tests/TodayChoresTests.swift`: the phone Today chores card — whose
 * chores it shows, and ticking them off in place.
 */

private var choreSeq = 0

private fun chore(
    title: String,
    person: String?,
    status: String = "pending",
    dueTime: String? = null,
    requiresApproval: Boolean = false,
    photo: Boolean = false,
) = TodayApi.ChoreInstance(
    id = "inst-${choreSeq++}", choreId = "chore-$choreSeq", choreTitle = title,
    personId = person, status = status, rewardAmount = 1, dueTime = dueTime,
    requiresApproval = requiresApproval, requiresPhoto = photo,
)

private fun rosterPerson(id: String, total: Int = 1) = TodayApi.PersonChores(
    id = id, name = id.replaceFirstChar { it.uppercase() }, avatarEmoji = "🙂",
    colorHex = "#2F7FED", total = total,
)

private fun member(id: String) = Person(id = id, name = id.replaceFirstChar { it.uppercase() }, memberType = "adult")

private class ChoreFeed {
    var instances: List<TodayApi.ChoreInstance>? = emptyList()
    var failWrites = false
    val writes = mutableListOf<Pair<String, Boolean>>()
    val requestedDates = mutableListOf<String>()
}

private fun model(
    feed: ChoreFeed,
    roster: List<TodayApi.PersonChores> = emptyList(),
    gate: CompletableDeferred<Unit>? = null,
) = DashboardModel(
    fetchMeals = { emptyList() }, fetchChores = { roster }, fetchGrocery = { emptyList() },
    fetchGoals = { emptyList() }, fetchRecap = { emptyList() }, fetchSuggestions = { emptyList() },
    fetchChoreInstances = { date ->
        feed.requestedDates += date
        feed.instances ?: offline()
    },
    setChoreComplete = { id, complete ->
        feed.writes += id to complete
        gate?.await()
        if (feed.failWrites) offline()
    },
)

class TodayChorePersonTest {
    private val members = setOf("me", "kid")

    @Test
    fun defaultsToTheSignedInPerson() {
        assertEquals("me", DashboardModel.chorePersonId("", currentPersonId = "me", fallbackId = "kid", memberIds = members))
    }

    @Test
    fun fallsBackWhenIdentityIsUnknown() {
        assertEquals("kid", DashboardModel.chorePersonId("", currentPersonId = null, fallbackId = "kid", memberIds = members))
    }

    @Test
    fun aRememberedPickWins() {
        assertEquals("kid", DashboardModel.chorePersonId("kid", currentPersonId = "me", fallbackId = "me", memberIds = members))
    }

    @Test
    fun familyIsAPick() {
        assertNull(
            DashboardModel.chorePersonId(
                DashboardModel.FAMILY_CHORES_KEY, currentPersonId = "me", fallbackId = "me", memberIds = members,
            ),
        )
    }

    @Test
    fun aPickWhoLeftTheHouseholdFallsBackToMe() {
        assertEquals("me", DashboardModel.chorePersonId("gone", currentPersonId = "me", fallbackId = "kid", memberIds = members))
    }

    @Test
    fun nobodyToShowIsFamily() {
        assertNull(DashboardModel.chorePersonId("", currentPersonId = null, fallbackId = null, memberIds = emptySet()))
    }
}

class TodayChoreListTest {

    @Test
    fun showsOnlyThatPersonsChoresPendingFirst() {
        val rows = listOf(
            chore("Dishes", "me", status = "done"),
            chore("Walk dog", "kid"),
            chore("Laundry", "me", dueTime = "18:00"),
            chore("Up for grabs", null),
            chore("Bins", "me", dueTime = "08:00"),
        )
        assertEquals(listOf("Bins", "Laundry", "Dishes"), DashboardModel.chores("me", rows).map { it.choreTitle })
    }

    @Test
    fun loadFetchesTodaysInstances() = runTest {
        val feed = ChoreFeed()
        feed.instances = listOf(chore("Bins", "me"))
        val m = model(feed)
        m.load("2026-09-14")
        assertEquals(listOf("2026-09-14"), feed.requestedDates)
        assertEquals(listOf("Bins"), m.choreInstances.map { it.choreTitle })
        assertTrue(m.choreInstancesState.isAuthoritative)
    }

    @Test
    fun tickingCompletesOptimistically() = runTest {
        val feed = ChoreFeed()
        val bins = chore("Bins", "me")
        feed.instances = listOf(bins)
        val m = model(feed)
        m.load("2026-09-14")
        assertTrue(m.toggleChore(bins))
        assertEquals("done", m.choreInstances.first().status)
        assertEquals(listOf(true), feed.writes.map { it.second })
    }

    @Test
    fun approvalChoresWaitForAnOK() = runTest {
        val feed = ChoreFeed()
        val room = chore("Clean room", "kid", requiresApproval = true)
        feed.instances = listOf(room)
        val m = model(feed)
        m.load("2026-09-14")
        m.toggleChore(room)
        assertEquals("awaiting", m.choreInstances.first().status)
    }

    @Test
    fun untickingAnAwaitingChoreUncompletes() = runTest {
        val feed = ChoreFeed()
        val room = chore("Clean room", "kid", status = "awaiting", requiresApproval = true)
        feed.instances = listOf(room)
        val m = model(feed)
        m.load("2026-09-14")
        m.toggleChore(room)
        assertEquals("pending", m.choreInstances.first().status)
        assertEquals(listOf(false), feed.writes.map { it.second })
    }

    @Test
    fun aSecondTapWhileTheWriteIsInFlightIsIgnored() = runTest {
        val gate = CompletableDeferred<Unit>()
        val feed = ChoreFeed()
        val bins = chore("Bins", "me")
        feed.instances = listOf(bins)
        val m = model(feed, gate = gate)
        m.load("2026-09-14")

        val first = async { m.toggleChore(bins) }
        testScheduler.runCurrent()
        assertEquals(1, feed.writes.size)
        assertFalse(m.toggleChore(bins))
        gate.complete(Unit)
        assertTrue(first.await())
        assertEquals(1, feed.writes.size)
        assertEquals("done", m.choreInstances.first().status)
    }

    @Test
    fun onlyAnOpenPhotoChoreNeedsTheBoard() {
        assertTrue(DashboardModel.needsPhotoToFinish(chore("Garden", "me", photo = true)))
        assertFalse(DashboardModel.needsPhotoToFinish(chore("Garden", "me", status = "done", photo = true)))
        assertFalse(DashboardModel.needsPhotoToFinish(chore("Garden", "me", status = "awaiting", photo = true)))
        assertFalse(DashboardModel.needsPhotoToFinish(chore("Bins", "me")))
    }

    @Test
    fun aFailedWriteRollsBack() = runTest {
        val feed = ChoreFeed()
        val bins = chore("Bins", "me")
        feed.instances = listOf(bins)
        feed.failWrites = true
        val m = model(feed)
        m.load("2026-09-14")
        assertFalse(m.toggleChore(bins))
        assertEquals("pending", m.choreInstances.first().status)
    }
}

/**
 * The picker's people must not wait on sync: a fresh install or a sync hiccup leaves the
 * synced members empty while the chores call already knows everyone.
 */
class TodayChoreRosterTest {

    @Test
    fun offersTheChoresRosterWhenSyncHasNotDelivered() {
        val people = DashboardModel.chorePeople(emptyList(), listOf(rosterPerson("me"), rosterPerson("kid")))
        assertEquals(listOf("me", "kid"), people.map { it.id })
        assertEquals(listOf("Me", "Kid"), people.map { it.name })
    }

    @Test
    fun syncedMembersLeadAndTheRosterFillsTheGaps() {
        val people = DashboardModel.chorePeople(listOf(member("kid")), listOf(rosterPerson("me"), rosterPerson("kid")))
        assertEquals(listOf("kid", "me"), people.map { it.id })
    }

    @Test
    fun meResolvesFromTheRosterBeforeSyncArrives() {
        val ids = DashboardModel.chorePeople(emptyList(), listOf(rosterPerson("me"), rosterPerson("kid"))).map { it.id }.toSet()
        assertEquals("me", DashboardModel.chorePersonId("", currentPersonId = "me", fallbackId = null, memberIds = ids))
    }

    @Test
    fun loadKeepsPeopleWithNothingDueForThePicker() = runTest {
        val m = model(ChoreFeed(), roster = listOf(rosterPerson("me", total = 0), rosterPerson("kid", total = 2)))
        m.load("2026-09-14")
        assertEquals(listOf("kid"), m.chores.map { it.id })
        assertEquals(listOf("me", "kid"), m.choreRoster.value.map { it.id })
    }
}
