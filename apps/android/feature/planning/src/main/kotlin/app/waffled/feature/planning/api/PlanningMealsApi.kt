package app.waffled.feature.planning.api

import app.waffled.feature.meals.RecipeSummary
import io.ktor.http.HttpMethod
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Weekly Planning · step 7 "Meals" — wire types, its ONE read and three writes. Port of iOS
// `PlanningMealsAPI.swift`. THE STEP OWNS NO DATA: its own routes are the ones the Meals
// screen's endpoints can't compose (only the fill can refuse a decided night AND hand back
// a receipt). Every date stays a String — a household-local calendar label.

/** One calendar event on a night — the CONTEXT above the dish. Missing fields cost that field. */
@Serializable
data class PlanningNightEvent(
    val id: String,
    val title: String = "",
    val startsAt: String = "",
    val allDay: Boolean = false,
    val personId: String? = null,
    val personName: String? = null,
    /** Painted as the web paints it, so the platforms agree about the same night. */
    val personColor: String? = null,
    val participantIds: List<String> = emptyList(),
)

@Serializable
data class PlanningNightDinner(
    val entryId: String,
    val title: String? = null,
    val emoji: String? = null,
    val recipeId: String? = null,
    /** `recipeId == null && mealId != null` is the PLATE branch, checked before takeout. */
    val mealId: String? = null,
    val imageUrl: String? = null,
    val cookName: String? = null,
    val cookAvatar: String? = null,
    val cookColor: String? = null,
    val minutes: Int? = null,
)

@Serializable
data class PlanningMealsNight(
    val date: String,
    val events: List<PlanningNightEvent> = emptyList(),
    val dinner: PlanningNightDinner? = null,
)

/** The grocery line — ONE line, not a panel. Null ⇒ the lists module is off. */
@Serializable
data class PlanningMealsGroceries(val items: Int = 0, val checked: Int = 0)

/** Read back off a real one-off chore. `personId == null` ⇒ planned but up for grabs. */
@Serializable
data class PlanningShoppingTrip(
    val choreId: String,
    val personId: String? = null,
    val personName: String? = null,
    val personAvatar: String? = null,
    val personColor: String? = null,
    val dueOn: String,
    val dueTime: String? = null,
    val status: String = "pending",
)

@Serializable
data class PlanningMealsView(
    /** The week the SERVER named. ECHO IT; never recompute one here. */
    val weekStart: String = "",
    val nights: List<PlanningMealsNight> = emptyList(),
    val emptyDates: List<String> = emptyList(),
    val groceries: PlanningMealsGroceries? = null,
    /** False ⇒ chores is off: the plain line and NO shopper control. */
    val choresOn: Boolean = false,
    val shopping: PlanningShoppingTrip? = null,
)

/**
 * What a fill wrote — and the proof the undo needs. `mealId` IS PART OF THE PROOF: a filled
 * title and a hand-picked plate of that name agree on everything else.
 */
@Serializable
data class PlanningFilledNight(
    val date: String,
    val entryId: String,
    val recipeId: String? = null,
    val mealId: String? = null,
    val title: String? = null,
) {
    /** EXPLICIT null for every absent field, or `mealId` quietly stops travelling. */
    fun json(): JsonObject = buildJsonObject {
        put("date", date)
        put("entryId", entryId)
        put("recipeId", recipeId.orNull())
        put("mealId", mealId.orNull())
        put("title", title.orNull())
    }
}

@Serializable
data class PlanningMealsFill(
    val weekStart: String = "",
    val filled: List<PlanningFilledNight> = emptyList(),
    val view: PlanningMealsView,
)

@Serializable
data class PlanningMealsUndo(
    val weekStart: String = "",
    val cleared: List<String> = emptyList(),
    /** Nights left alone because somebody decided them since — reported, not undone. */
    val kept: List<String> = emptyList(),
    val view: PlanningMealsView,
)

@Serializable
data class PlanningMealsShopperResult(
    val weekStart: String = "",
    val shopping: PlanningShoppingTrip? = null,
    val view: PlanningMealsView,
)

/** Only the four fields the fill writes. The step plans DINNERS; another meal is dropped. */
data class PlanningMealsCard(
    val date: String,
    val mealType: String = "dinner",
    val title: String = "",
    val recipeId: String? = null,
) {
    fun json(): JsonObject = buildJsonObject {
        put("date", date)
        put("mealType", mealType)
        put("title", title)
        put("recipeId", recipeId.orNull())
    }
}

private fun String?.orNull() = this?.let(::JsonPrimitive) ?: JsonNull

/** The three bodies as PURE FUNCTIONS, so the one easy to get catastrophically wrong is testable. */
object PlanningMealsWire {

    /**
     * `cards` IS THREE-WAY: null ⇒ the key is ABSENT (the server drafts); a list applies the
     * approved week; a present non-list writes NOTHING. So never send a null here, and pass
     * an empty list through rather than collapsing it to absent.
     */
    fun fillBody(weekStart: String, cards: List<PlanningMealsCard>?): JsonObject = buildJsonObject {
        put("weekStart", weekStart)
        if (cards != null) put("cards", JsonArray(cards.map { it.json() }))
    }

    fun undoBody(weekStart: String, filled: List<PlanningFilledNight>): JsonObject = buildJsonObject {
        put("weekStart", weekStart)
        put("filled", JsonArray(filled.map { it.json() }))
    }

    /**
     * EXPLICIT NULLS, all of them: `dueOn` null is "no trip this week", `personId` null is
     * "up for grabs", `dueTime` null is "no set time" — none means "leave it".
     */
    fun shopperBody(weekStart: String, dueOn: String?, personId: String?, dueTime: String?, choreId: String?): JsonObject =
        buildJsonObject {
            put("weekStart", weekStart)
            put("dueOn", dueOn.orNull())
            put("personId", personId.orNull())
            put("dueTime", dueTime.orNull())
            put("choreId", choreId.orNull())
        }
}

/** Who may be handed the trip — the CHORES rule: somebody ELSE is `chore.manage`. */
object PlanningMealsShopper {
    fun mayAssign(personId: String?, myPersonId: String?, canManage: Boolean): Boolean {
        if (canManage) return true
        if (personId == null) return true
        // A device with no person of its own (a kiosk identity) cannot claim "that's me".
        return myPersonId != null && personId == myPersonId
    }
}

class PlanningMealsApi(private val http: PlanningHttp) {

    @Serializable private data class RecipesEnvelope(val recipes: List<RecipeSummary> = emptyList())

    /** `choreId` is a HINT that keeps a renamed chore recognised instead of spawning a second. */
    suspend fun view(weekStart: String, choreId: String? = null): PlanningMealsView =
        http.get("api/weekly-planning/meals" + PlanningHttp.query("weekStart" to weekStart, "choreId" to choreId))

    suspend fun fill(weekStart: String, cards: List<PlanningMealsCard>?): PlanningMealsFill =
        http.send(HttpMethod.Post, "api/weekly-planning/meals/fill", PlanningMealsWire.fillBody(weekStart, cards))

    suspend fun undo(weekStart: String, filled: List<PlanningFilledNight>): PlanningMealsUndo =
        http.send(HttpMethod.Post, "api/weekly-planning/meals/undo", PlanningMealsWire.undoBody(weekStart, filled))

    /** An upsert, ONE chore per week; `dueOn` null clears it. 400 outside the week, 403 for others. */
    suspend fun setShopper(
        weekStart: String,
        dueOn: String?,
        personId: String?,
        dueTime: String?,
        choreId: String?,
    ): PlanningMealsShopperResult = http.send(
        HttpMethod.Put,
        "api/weekly-planning/meals/shopper",
        PlanningMealsWire.shopperBody(weekStart, dueOn, personId, dueTime, choreId),
    )

    /**
     * The recipe library, for the night picker and the planner's manual pick. Read here
     * because the recipes feature (and its picker) is not a planning dependency.
     */
    suspend fun recipes(): List<RecipeSummary> = http.get<RecipesEnvelope>("api/recipes").recipes
}
