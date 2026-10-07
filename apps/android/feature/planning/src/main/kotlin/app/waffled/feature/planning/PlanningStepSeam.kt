package app.waffled.feature.planning

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.unit.dp
import app.waffled.core.design.WaffledEmptyState
import app.waffled.feature.planning.api.LooseEndRoute
import app.waffled.feature.planning.api.PlanningStep
import app.waffled.feature.planning.steps.CalendarStepBody
import app.waffled.feature.planning.steps.ConnectionStepBody
import app.waffled.feature.planning.steps.FamilyNightStepBody
import app.waffled.feature.planning.steps.GoalsStepBody
import app.waffled.feature.planning.steps.HorizonStepBody
import app.waffled.feature.planning.steps.KidsStepBody
import app.waffled.feature.planning.steps.LooseEndsStepBody
import app.waffled.feature.planning.steps.MealsStepBody
import app.waffled.feature.planning.steps.MealsStepFooterExtra
import app.waffled.feature.planning.steps.RecapStepBody
import app.waffled.feature.planning.steps.TasksStepBody
import kotlinx.serialization.json.JsonObject

// THE CONTRACT BETWEEN THE SHELL AND A STEP. The shell owns the chrome; a step owns only
// what goes between. All ten keys point at ten functions in ten files under `steps`, so
// building a step means rewriting that step's own file and nothing else. Port of iOS
// `PlanningStepSeam.swift` (web: `planning/registry.ts`).

@Immutable
class PlanningStepProps(
    val step: PlanningStep,
    val sessionId: String,
    /**
     * The week being planned (`YYYY-MM-DD`). ALWAYS use this rather than computing a week
     * on the device: the server owns the boundary, and planning runs entirely over REST.
     */
    val weekStart: String,
    /** Raw dependencies: build your step's API slice and models from these. */
    val env: PlanningEnvironment,
    /**
     * Attach the crumb this step wants kept on the session record; null clears it. Never a
     * copy of module data. ONLY PERSISTED WHEN THE STEP IS ANSWERED, so it is a hint, not
     * the authority: a mid-step write calls the step's own route.
     */
    val setDecisionData: (JsonObject?) -> Unit,
    /** Re-read the session view. */
    val refresh: () -> Unit,
    /** The SHELL's own write is in flight. */
    val busy: Boolean,
    /** Everything step 1 routed this session. Read by the shell's banner, not by bodies. */
    val routes: List<LooseEndRoute>,
    /** SHOW another step without moving the cross-device pointer (a recap row is a link). */
    val goToStep: (String) -> Unit,
    /**
     * Lend the banner this step's own verb, or null to withdraw it. A step WITHOUT a
     * composer lends nothing: a button reading "Make a goal" that only ticks the note off
     * promises an action it doesn't perform.
     */
    val lendVerb: (PlanningHandoffVerb?) -> Unit,
    /** A write THIS STEP owns is in flight, so Skip and the affirmative go cold until it lands. */
    val reportBusy: (Boolean) -> Unit,
)

/** One verb, lent to the shell's banner by the step on screen. */
class PlanningHandoffVerb(
    val label: String,
    /**
     * Open this step's own composer seeded with the note's words, then call `done` with
     * whether something was really created. A CANCELLED composer must report false, or the
     * note is settled and the only record that the thing needs doing is gone.
     */
    val run: (note: String, done: (Boolean) -> Unit) -> Unit,
)

/** A step whose body isn't built yet: still walk-past-able, and answering it is real. */
@Composable
fun PlanningStepPlaceholder(step: PlanningStep) {
    WaffledEmptyState(
        emoji = "🚧",
        title = step.title,
        message = "This step isn't on Android yet — it's on the web session. You can still skip it or mark it done.",
        top = 24.dp,
    )
}

/**
 * THE REGISTRY. The `else` is not dead code: the catalog is server-owned, so a newer server
 * can name a step this build has never heard of.
 */
@Composable
fun PlanningStepBody(props: PlanningStepProps) {
    when (props.step.key) {
        PlanningStepKeys.LOOSE_ENDS -> LooseEndsStepBody(props)
        PlanningStepKeys.CALENDAR -> CalendarStepBody(props)
        PlanningStepKeys.HORIZON -> HorizonStepBody(props)
        PlanningStepKeys.FAMILY_NIGHT -> FamilyNightStepBody(props)
        PlanningStepKeys.CONNECTION -> ConnectionStepBody(props)
        PlanningStepKeys.GOALS -> GoalsStepBody(props)
        PlanningStepKeys.MEALS -> MealsStepBody(props)
        PlanningStepKeys.TASKS -> TasksStepBody(props)
        PlanningStepKeys.KIDS -> KidsStepBody(props)
        PlanningStepKeys.RECAP -> RecapStepBody(props)
        else -> PlanningStepPlaceholder(props.step)
    }
}

/** One more control in the footer beside Skip and the affirmative. Only Meals uses it. */
@Composable
fun PlanningStepFooterExtra(props: PlanningStepProps) {
    when (props.step.key) {
        PlanningStepKeys.MEALS -> MealsStepFooterExtra(props)
        else -> Unit
    }
}

/** The ten catalog keys, in the server's catalog order. The ORDER itself is server-owned. */
object PlanningStepKeys {
    const val LOOSE_ENDS = "looseEnds"
    const val CALENDAR = "calendar"
    const val HORIZON = "horizon"
    const val FAMILY_NIGHT = "familyNight"
    const val CONNECTION = "connection"
    const val GOALS = "goals"
    const val MEALS = "meals"
    const val TASKS = "tasks"
    const val KIDS = "kids"
    const val RECAP = "recap"

    val all = listOf(LOOSE_ENDS, CALENDAR, HORIZON, FAMILY_NIGHT, CONNECTION, GOALS, MEALS, TASKS, KIDS, RECAP)
}
