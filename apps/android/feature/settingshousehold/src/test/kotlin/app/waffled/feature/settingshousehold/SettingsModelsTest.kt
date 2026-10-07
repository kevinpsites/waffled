package app.waffled.feature.settingshousehold

import kotlinx.coroutines.test.runTest
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Ports of `StoredProofsModelTests.swift` and the Countdown cases of
 * `AdminSettingsMutationTests.swift` (the Family Night cases belong to that panel).
 */
class SettingsModelsTest {

    private class Rejected : Exception("rejected")

    // ---- Countdowns ----

    @Test
    fun failedCountdownPreferenceRollsBackOptimisticControl() = runTest {
        val model = CountdownSettingsModel(
            fetch = { CountdownConfig(sleeps = false, birthdayHorizonDays = 183) },
            setSleeps = { throw Rejected() },
            setHorizon = { },
        )
        model.load()

        model.changeSleeps(true)

        assertFalse(model.state.value.sleeps)
        assertNotNull(model.state.value.errorMessage)
    }

    @Test
    fun failedCountdownHorizonKeepsConfirmedValue() = runTest {
        val model = CountdownSettingsModel(
            fetch = { CountdownConfig(sleeps = false, birthdayHorizonDays = 183) },
            setSleeps = { },
            setHorizon = { throw Rejected() },
        )
        model.load()

        model.changeHorizon(366)

        assertEquals(183, model.state.value.birthdayHorizon)
        assertNotNull(model.state.value.errorMessage)
    }

    @Test
    fun successfulCountdownChangeSticks() = runTest {
        var sent: Int? = null
        val model = CountdownSettingsModel(
            fetch = { CountdownConfig(sleeps = false, birthdayHorizonDays = 183) },
            setSleeps = { },
            setHorizon = { sent = it },
        )
        model.load()
        assertTrue(model.state.value.loaded)

        model.changeHorizon(92)

        assertEquals(92, sent)
        assertEquals(92, model.state.value.birthdayHorizon)
        assertNull(model.state.value.errorMessage)
        assertFalse(model.state.value.busy)
    }

    @Test
    fun failedCountdownLoadSaysSo() = runTest {
        val model = CountdownSettingsModel(fetch = { throw Rejected() }, setSleeps = {}, setHorizon = {})
        model.load()
        assertFalse(model.state.value.loaded)
        assertEquals("Couldn’t load Countdown settings.", model.state.value.errorMessage)
    }

    @Test
    fun horizonLabelSnapsToTheNearestPreset() {
        assertEquals("6 months", CountdownSettingsModel.horizonLabel(183))
        assertEquals("1 month", CountdownSettingsModel.horizonLabel(20))
        assertEquals("1 year", CountdownSettingsModel.horizonLabel(300))
    }

    // ---- Stored proofs ----

    private fun proof(id: String) = SettingsHouseholdApi.StoredProof(
        instanceId = id,
        choreTitle = "Put away dishes",
        emoji = "dishwasher",
        personName = "Avery",
        proofUrl = "/media/proofs/$id.jpg",
        completedAt = "2026-07-25T12:00:00.000Z",
    )

    @Test
    fun failedSingleDeleteKeepsProofAndReportsFailure() = runTest {
        val item = proof("proof-1")
        var changes = 0
        val model = StoredProofsModel(
            proofs = listOf(item),
            deleteProof = { throw Rejected() },
            clearProofs = { 0 },
            onChanged = { changes++ },
        )

        val deleted = model.delete(item)

        assertFalse(deleted)
        assertEquals(listOf("proof-1"), model.state.value.proofs.map { it.id })
        assertEquals(
            "Couldn’t delete this photo. Check your connection and try again.",
            model.state.value.errorMessage,
        )
        assertFalse(model.state.value.busy)
        assertEquals(0, changes)
    }

    @Test
    fun successfulSingleDeleteRemovesProofAndNotifiesParent() = runTest {
        val first = proof("proof-1")
        val second = proof("proof-2")
        var changes = 0
        val deletedIds = mutableListOf<String>()
        val model = StoredProofsModel(
            proofs = listOf(first, second),
            deleteProof = { deletedIds += it },
            clearProofs = { 0 },
            onChanged = { changes++ },
        )

        val deleted = model.delete(first)

        assertTrue(deleted)
        assertEquals(listOf("proof-1"), deletedIds)
        assertEquals(listOf("proof-2"), model.state.value.proofs.map { it.id })
        assertNull(model.state.value.errorMessage)
        assertEquals(1, changes)
    }

    @Test
    fun failedClearAllKeepsProofsAndReportsFailure() = runTest {
        var changes = 0
        val model = StoredProofsModel(
            proofs = listOf(proof("proof-1"), proof("proof-2")),
            deleteProof = { },
            clearProofs = { throw Rejected() },
            onChanged = { changes++ },
        )

        val cleared = model.clearAll()

        assertFalse(cleared)
        assertEquals(listOf("proof-1", "proof-2"), model.state.value.proofs.map { it.id })
        assertEquals(
            "Couldn’t clear stored photos. Check your connection and try again.",
            model.state.value.errorMessage,
        )
        assertFalse(model.state.value.busy)
        assertEquals(0, changes)
    }

    @Test
    fun successfulClearAllRemovesProofsAndNotifiesParent() = runTest {
        var changes = 0
        var clearCount = 0
        val model = StoredProofsModel(
            proofs = listOf(proof("proof-1"), proof("proof-2")),
            deleteProof = { },
            clearProofs = { clearCount++; 2 },
            onChanged = { changes++ },
        )

        val cleared = model.clearAll()

        assertTrue(cleared)
        assertEquals(1, clearCount)
        assertTrue(model.state.value.proofs.isEmpty())
        assertNull(model.state.value.errorMessage)
        assertEquals(1, changes)
    }
}
