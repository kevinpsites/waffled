package app.waffled.feature.settingshousehold

import kotlinx.coroutines.test.runTest
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Ports of the Countdown cases of `AdminSettingsMutationTests.swift` (the Family Night cases belong to that panel).
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
}
