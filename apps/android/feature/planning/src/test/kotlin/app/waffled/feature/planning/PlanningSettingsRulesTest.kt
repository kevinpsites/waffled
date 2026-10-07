package app.waffled.feature.planning

import app.waffled.feature.planning.api.PlanningStep
import app.waffled.feature.planning.api.WeeklyPlanningConfig
import org.junit.Test
import kotlin.test.assertEquals

/** Which steps the settings panel offers as a switch, and which it names in prose. */
class PlanningSettingsRulesTest {

    private fun step(key: String, requiresModule: String? = null, available: Boolean = true) = PlanningStep(
        key = key, number = 1, title = key, ask = "?", primary = "OK", act = "A",
        requiresModule = requiresModule, available = available, status = "pending",
    )

    private val steps = listOf(
        step("calendar"),
        step("meals", requiresModule = "meals", available = false),
        step("goals", requiresModule = "goals", available = false),
        step("tasks", requiresModule = "chores"),
    )

    @Test fun `a module-off step is named, not switched — unless it was switched off by hand`() {
        val config = WeeklyPlanningConfig(0, "17:00", mapOf("goals" to false), true)
        assertEquals(listOf("calendar", "goals", "tasks"), choosableSteps(config, steps).map { it.key })
        assertEquals(listOf("meals"), stepsOffForModule(config, steps).map { it.key })
    }
}
