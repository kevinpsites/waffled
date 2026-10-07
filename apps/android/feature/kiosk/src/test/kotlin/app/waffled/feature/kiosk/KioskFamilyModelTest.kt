package app.waffled.feature.kiosk

import app.waffled.core.network.RestState
import app.waffled.feature.family.FamilyApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/** Port of `KioskFamilyRestStateTests` (RestDataStateTests.swift). */
class KioskFamilyModelTest {

    private val maya = FamilyApi.PersonChores(id = "person-1", name = "Maya", avatarEmoji = "🧒", colorHex = "#7C6FCD", total = 3, done = 1, stars = 12)
    private val mayaStars = FamilyApi.FamilyStars(name = "Maya", stars = 12)

    @Test fun startsLoadingRatherThanPretendingRestDataIsEmpty() {
        val model = KioskFamilyModel(fetchChores = { emptyList() }, fetchStars = { emptyList() })
        assertEquals(RestState.Loading, model.state.value.rest)
        assertFalse(model.state.value.rest.isAuthoritative)
    }

    @Test fun successfulEmptyResponseIsAuthoritative() = runTest {
        val model = KioskFamilyModel(fetchChores = { emptyList() }, fetchStars = { emptyList() })
        model.load(choresEnabled = true)
        assertIs<RestState.Empty>(model.state.value.rest)
        assertTrue(model.state.value.rest.isAuthoritative)
    }

    @Test fun initialFailureCannotMasqueradeAsEmpty() = runTest {
        val model = KioskFamilyModel(fetchChores = { error("rejected") }, fetchStars = { error("rejected") })
        model.load(choresEnabled = true)
        assertIs<RestState.Error>(model.state.value.rest)
        assertFalse(model.state.value.rest.isAuthoritative)
    }

    @Test fun failedRefreshKeepsConfirmedChoresAndStars() = runTest {
        var fail = false
        val model = KioskFamilyModel(
            fetchChores = { if (fail) error("rejected") else listOf(maya) },
            fetchStars = { if (fail) error("rejected") else listOf(mayaStars) },
        )
        model.load(choresEnabled = true)
        fail = true
        model.load(choresEnabled = true)
        assertEquals(listOf("person-1"), model.state.value.chores.map { it.id })
        assertEquals(listOf("Maya"), model.state.value.stars.map { it.name })
        assertIs<RestState.Stale>(model.state.value.rest)
    }

    @Test fun disabledKioskChoresAreNeitherFetchedNorAggregated() = runTest {
        var choreCalls = 0
        var starCalls = 0
        val model = KioskFamilyModel(
            fetchChores = { choreCalls++; error("rejected") },
            fetchStars = { starCalls++; emptyList() },
        )
        model.load(choresEnabled = true)
        assertFalse(model.state.value.rest.isAuthoritative)
        model.load(choresEnabled = false)
        assertEquals(1, choreCalls)
        assertEquals(2, starCalls)
        assertIs<RestState.Empty>(model.state.value.rest)
    }

    @Test fun disablingKioskChoresHidesPreviouslyConfirmedRowsWithoutRefetchingThem() = runTest {
        var choreCalls = 0
        val model = KioskFamilyModel(fetchChores = { choreCalls++; listOf(maya) }, fetchStars = { emptyList() })
        model.load(choresEnabled = true)
        assertEquals(listOf("person-1"), model.state.value.chores.map { it.id })
        model.load(choresEnabled = false)
        assertEquals(1, choreCalls)
        assertTrue(model.state.value.chores.isEmpty())
        assertTrue(model.state.value.rest.isAuthoritative)
    }

    @Test fun lateEnabledChoreLoadCannotRepublishRowsAfterModuleIsDisabled() = runTest {
        val deferred = CompletableDeferred<List<FamilyApi.PersonChores>>()
        val started = CompletableDeferred<Unit>()
        var choreCalls = 0
        val model = KioskFamilyModel(
            fetchChores = { choreCalls++; started.complete(Unit); deferred.await() },
            fetchStars = { emptyList() },
        )
        val old = launch { model.load(choresEnabled = true) }
        started.await()
        model.load(choresEnabled = false)
        deferred.complete(listOf(maya))
        old.join()
        assertEquals(1, choreCalls)
        assertTrue(model.state.value.chores.isEmpty())
        assertTrue(model.state.value.rest.isAuthoritative)
    }

    @Test fun coreStarsFailureStillCountsWhenKioskChoresAreDisabled() = runTest {
        val model = KioskFamilyModel(fetchChores = { emptyList() }, fetchStars = { error("rejected") })
        model.load(choresEnabled = false)
        assertIs<RestState.Error>(model.state.value.rest)
        assertFalse(model.state.value.rest.isAuthoritative)
    }

    @Test fun personCardJoinsChoresAndStarsByIdAndName() {
        val card = KioskFamilyModel.Snapshot(chores = listOf(maya), stars = listOf(mayaStars)).card("person-1", "Maya")
        assertEquals(1, card.choresDone)
        assertEquals(3, card.choresTotal)
        assertEquals(12, card.stars)
        val nobody = KioskFamilyModel.Snapshot().card("x", "Nobody")
        assertEquals(0, nobody.choresTotal)
        assertEquals(null, nobody.stars)
    }
}
