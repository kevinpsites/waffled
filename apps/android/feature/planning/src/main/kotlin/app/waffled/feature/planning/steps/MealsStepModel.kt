package app.waffled.feature.planning.steps

import app.waffled.core.network.WaffledApiException
import app.waffled.feature.lists.ListItemDTO
import app.waffled.feature.meals.PlanCardDTO
import app.waffled.feature.planning.api.PlanningFilledNight
import app.waffled.feature.planning.api.PlanningMealsCard
import app.waffled.feature.planning.api.PlanningMealsFill
import app.waffled.feature.planning.api.PlanningMealsGroceries
import app.waffled.feature.planning.api.PlanningMealsShopperResult
import app.waffled.feature.planning.api.PlanningMealsUndo
import app.waffled.feature.planning.api.PlanningMealsView
import app.waffled.feature.planning.api.PlanningNightDinner
import app.waffled.feature.planning.api.PlanningNightEvent
import app.waffled.feature.planning.api.PlanningShoppingTrip
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

// Weekly Planning · step 7 "Meals" — the model and its pure text. Port of iOS
// `MealsStepModel.swift`. THE STEP STORES NOTHING OF ITS OWN: everything on screen is the
// existing meal plan, and the session records only a crumb — which nights the app picked.

object PlanningMealsText {

    private val words = listOf("none", "one", "two", "three", "four", "five", "six", "seven")

    fun countWord(n: Int): String = words.getOrNull(n) ?: n.toString()

    // Calendar labels parsed as LocalDate: no zone can move them a day.
    private val shortDay = DateTimeFormatter.ofPattern("EEE", Locale.US)
    private val monthDayFmt = DateTimeFormatter.ofPattern("MMM d", Locale.US)
    private val clockFmt = DateTimeFormatter.ofPattern("h:mm a", Locale.US)

    fun dow(ymd: String): String = runCatching { LocalDate.parse(ymd).format(shortDay) }.getOrDefault(ymd)

    fun monthDay(ymd: String): String = runCatching { LocalDate.parse(ymd).format(monthDayFmt) }.getOrDefault(ymd)

    /** `startsAt` is a real instant, so the clock reads in the given (device) zone. */
    fun clock(e: PlanningNightEvent, zone: ZoneId = ZoneId.systemDefault()): String {
        if (e.allDay) return "All day"
        val instant = runCatching { Instant.parse(e.startsAt) }.getOrNull() ?: return ""
        return instant.atZone(zone).format(clockFmt)
    }

    fun attribution(d: PlanningNightDinner, auto: Boolean, eatingOut: Boolean): String? = when {
        d.cookName != null -> "${d.cookAvatar ?: "👤"} ${d.cookName}"
        auto -> "the app picked this"
        d.mealId != null -> "a whole plate"
        (d.minutes ?: 0) > 0 -> "${d.minutes} min"
        eatingOut -> "no cooking"
        else -> null
    }

    /**
     * A PLATE IS NEVER TAKEOUT: it is recipe-less with the plate's NAME as its title, so the
     * plate branch is checked first.
     */
    fun isEatingOut(d: PlanningNightDinner): Boolean {
        if (d.mealId != null || d.recipeId != null) return false
        val t = d.title?.lowercase() ?: return false
        return EATING_OUT.any { it.containsMatchIn(t) }
    }

    // COPY of iOS `TonightMeal.isEatingOut` (the spec), which lives in Today — not a planning
    // dependency. Meals' own `MealsFormat.isEatingOut` matches bare substrings ("eat", "out"),
    // so "Meatball subs" would read as takeout; reconcile the two rather than adopt it.
    private val EATING_OUT = listOf(
        Regex("""\b(eating|eat|dining|going)\s*out\b"""),
        Regex("""take\s*-?out"""),
        Regex("""\border(ing)?\s+in\b"""),
        Regex("""\bdelivery\b"""),
        Regex("""\btakeaway\b"""),
    )

    fun tripLabel(t: PlanningShoppingTrip?): String {
        if (t == null) return "Who's shopping?"
        val whenText = dow(t.dueOn) + (t.dueTime?.let { " $it" } ?: "")
        val name = t.personName ?: return "Up for grabs · $whenText"
        return "${t.personAvatar ?: "👤"} $name shops $whenText"
    }

    /** The undo only takes back what is untouched, so the copy names the nights it walked past. */
    fun keptSentence(dates: List<String>): String? {
        if (dates.isEmpty()) return null
        val one = dates.size == 1
        return "${countWord(dates.size)} ${if (one) "night was" else "nights were"} left alone — " +
            dates.joinToString(", ") { dow(it) } + " ${if (one) "has" else "have"} been decided since."
    }

    fun grocerySub(added: Int?): String =
        if (added == null) "built from what's planned so far · staples skipped" else "$added items added · staples skipped"

    /** What is left to buy, not the list's length: ticked items are already in the cart. */
    fun groceryPill(g: PlanningMealsGroceries): String {
        var s = "${g.items - g.checked} to buy · aisle order"
        if (g.checked > 0) s += " · ${g.checked} done"
        return s
    }

    fun fillTitle(empties: Int): String =
        if (empties == 1) "Fills the one empty night" else "Fills the ${countWord(empties)} empty nights"

    fun plannerNote(empties: Int): String {
        val one = empties == 1
        return "Planning the ${countWord(empties)} empty ${if (one) "night" else "nights"} — the rest stay as they are."
    }
}

/** The two translations between this step and the shared planner, narrowed to EMPTY nights. */
object PlanningMealsPlan {

    /** The planner's day chips. Rubbish is dropped rather than becoming some other day. */
    fun plannerDays(dates: List<String>): List<LocalDate> =
        dates.mapNotNull { runCatching { LocalDate.parse(it) }.getOrNull() }

    /** Dinners only, still-empty nights, one card per night, never an empty card. */
    fun cards(approved: List<PlanCardDTO>, emptyDates: List<String>): List<PlanningMealsCard> {
        val open = emptyDates.toSet()
        val taken = HashSet<String>()
        val out = mutableListOf<PlanningMealsCard>()
        for (card in approved) {
            if (card.date !in open || card.mealType != PlanningMealsModel.MEAL_TYPE || card.date in taken) continue
            val title = card.title.trim()
            if (card.recipeId == null && title.isEmpty()) continue
            taken += card.date
            out += PlanningMealsCard(date = card.date, mealType = PlanningMealsModel.MEAL_TYPE, title = title, recipeId = card.recipeId)
        }
        return out.sortedBy { it.date }
    }
}

data class PlanningMealsEventRow(val id: String, val title: String, val clock: String, val colorHex: String?)

data class PlanningMealsNightRow(
    val date: String,
    val dow: String,
    val monthDay: String,
    val events: List<PlanningMealsEventRow>,
    val dinner: PlanningNightDinner?,
    val auto: Boolean,
    val eatingOut: Boolean,
    val attribution: String?,
) {
    val fallbackEmoji: String get() = if (eatingOut) "🥡" else "🍽️"
}

data class PlanningMealsState(
    val view: PlanningMealsView? = null,
    val loaded: Boolean = false,
    /** ONE WRITE AT A TIME — fill, undo, shopper and a hand-picked night all move one week. */
    val busy: Boolean = false,
    val errorMessage: String? = null,
    /**
     * The auto-filled nights STILL undoable, each with the proof the server checks. ONLY A
     * FILL puts something here: a claim rebuilt from the crumb would be compared against
     * its own source row, so the undo would clear a night somebody changed.
     */
    val filled: List<PlanningFilledNight> = emptyList(),
    val autoMarks: List<String> = emptyList(),
    val kept: List<String> = emptyList(),
    val groceryAdded: Int? = null,
    val groceries: List<ListItemDTO>? = null,
    val groceryError: String? = null,
    val plannerOpen: Boolean = false,
    val rows: List<PlanningMealsNightRow> = emptyList(),
    val rev: Int = 0,
) {
    val autoDates: Set<String> get() = filled.mapTo(HashSet()) { it.date } + autoMarks

    val emptyDates: List<String> get() = view?.emptyDates.orEmpty()

    /** Null when there are no dates: the affirmative REPLACES the data, and [] is a claim. */
    val crumb: JsonObject?
        get() {
            val dates = autoDates.sorted()
            if (dates.isEmpty()) return null
            return JsonObject(mapOf("autoFilled" to JsonArray(dates.map(::JsonPrimitive))))
        }

    /** Passed back on every read and write so a renamed trip chore is still this week's. */
    val choreHint: String? get() = view?.shopping?.choreId

    val groceriesToBuy: List<ListItemDTO> get() = byAisle(groceries.orEmpty().filter { !it.checked })
    val groceriesInCart: List<ListItemDTO> get() = byAisle(groceries.orEmpty().filter { it.checked })

    private companion object {
        /** The board's aisle walking order. */
        val AISLES = listOf("Produce", "Dairy & Chilled", "Meat & Seafood", "Pantry", "Bakery", "Frozen", "Other")

        fun byAisle(items: List<ListItemDTO>): List<ListItemDTO> =
            items.withIndex()
                .sortedWith(compareBy({ AISLES.indexOf(it.value.aisle ?: "").let { i -> if (i < 0) AISLES.size else i } }, { it.index }))
                .map { it.value }
    }
}

class PlanningMealsModel(
    private val fetchView: suspend (weekStart: String, choreId: String?) -> PlanningMealsView,
    private val fill: suspend (weekStart: String, cards: List<PlanningMealsCard>?) -> PlanningMealsFill,
    private val undo: suspend (weekStart: String, filled: List<PlanningFilledNight>) -> PlanningMealsUndo,
    private val setShopper: suspend (
        weekStart: String,
        dueOn: String?,
        personId: String?,
        dueTime: String?,
        choreId: String?,
    ) -> PlanningMealsShopperResult,
    private val planSlot: suspend (date: String, recipeId: String?, title: String?) -> Unit,
    /** A PLATE night: scheduling a saved plate COPIES it, so it can't go through [planSlot]. */
    private val planPlate: suspend (date: String, mealId: String) -> Unit,
    private val clearSlot: suspend (date: String) -> Unit,
    private val addGrocery: suspend (name: String) -> Unit,
    private val fetchGroceries: suspend (weekStart: String) -> List<ListItemDTO>,
    private val checkGrocery: suspend (id: String, checked: Boolean) -> Unit,
) {
    private val _state = MutableStateFlow(PlanningMealsState())
    val state: StateFlow<PlanningMealsState> = _state.asStateFlow()
    val current: PlanningMealsState get() = _state.value

    fun dismissError() = _state.update { it.copy(errorMessage = null) }

    // ---- reads ----

    suspend fun enter(weekStart: String, seed: List<String>) {
        if (current.loaded) reread(weekStart) else load(weekStart, seed)
    }

    /** A FAILED fetch still sets `loaded`, so the step says what went wrong. */
    suspend fun load(weekStart: String, seed: List<String>) {
        val fresh = attempt { fetchView(weekStart, null) }
        if (fresh != null) {
            // The crumb restores the MARKS, never the undo.
            val stillPlanned = fresh.nights.filter { it.dinner != null }.mapTo(HashSet()) { it.date }
            _state.update { it.copy(autoMarks = seed.filter { d -> d in stillPlanned }) }
            apply(fresh)
        } else if (current.view == null) {
            _state.update { it.copy(errorMessage = "Couldn’t read this week’s meals — reload and try again.") }
        }
        _state.update { it.copy(loaded = true) }
    }

    suspend fun reread(weekStart: String) {
        attempt { fetchView(weekStart, current.choreHint) }?.let(::apply)
    }

    /** Adds to the running grocery list, then re-reads. True only when it landed. */
    suspend fun addGrocery(name: String, weekStart: String): Boolean {
        val trimmed = name.trim()
        if (trimmed.isEmpty() || current.busy) return false
        _state.update { it.copy(errorMessage = null) }
        val ok = attempt { addGrocery.invoke(trimmed); true } ?: false
        if (!ok) {
            _state.update { it.copy(errorMessage = "Couldn’t add that to the grocery list — try again.") }
            return false
        }
        reread(weekStart)
        return true
    }

    // ---- the week's grocery list ----

    suspend fun loadGroceries(weekStart: String) {
        _state.update { it.copy(groceryError = null) }
        val items = attempt { fetchGroceries(weekStart) }
        _state.update {
            if (items != null) it.copy(groceries = items) else it.copy(groceryError = "Couldn’t read the grocery list — try again.")
        }
    }

    /** Flips the row at once and puts it back if the write doesn't land. */
    suspend fun setGroceryChecked(item: ListItemDTO, weekStart: String): Boolean {
        val checked = !item.checked
        flipGrocery(item.id, checked)
        _state.update { it.copy(groceryError = null) }
        val ok = attempt { checkGrocery(item.id, checked); true } ?: false
        if (!ok) {
            flipGrocery(item.id, item.checked)
            _state.update { it.copy(groceryError = "${item.name} didn’t change — try again.") }
            return false
        }
        reread(weekStart)
        return true
    }

    private fun flipGrocery(id: String, checked: Boolean) = _state.update { s ->
        s.copy(groceries = s.groceries?.map { if (it.id == id) it.copy(checked = checked) else it })
    }

    // ---- the planner the footer opens ----

    /** OPENS THE PLANNER and writes nothing: a week nobody approved is not a decision. */
    fun openPlanner() {
        val s = current
        if (s.view == null || s.busy || s.emptyDates.isEmpty()) return
        _state.update { it.copy(plannerOpen = true) }
    }

    fun setPlanner(open: Boolean) = _state.update { it.copy(plannerOpen = open) }

    /** Applied through THIS STEP's fill, which alone refuses a decided night and returns a receipt. */
    suspend fun applyPlan(weekStart: String, approved: List<PlanCardDTO>): Boolean {
        val cards = PlanningMealsPlan.cards(approved, current.emptyDates)
        _state.update { it.copy(plannerOpen = false) }
        // NEVER `cards: []`: the route answers 200 having written nothing.
        if (cards.isEmpty()) {
            _state.update { it.copy(errorMessage = "Nothing in that plan landed on an empty night — the week was left as it is.") }
            return false
        }
        return planTheRest(weekStart, cards)
    }

    // ---- the fill and its undo ----

    /** `cards` null means the KEY IS ABSENT (the server drafts), never a null. */
    suspend fun planTheRest(weekStart: String, cards: List<PlanningMealsCard>? = null): Boolean {
        if (current.busy) {
            _state.update { it.copy(errorMessage = "Something else was still saving — the week wasn’t planned. Try again.") }
            return false
        }
        val before = current.view?.groceries?.items
        _state.update { it.copy(busy = true, errorMessage = null, kept = emptyList()) }
        try {
            val r = try {
                fill(weekStart, cards)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                _state.update { it.copy(errorMessage = "That didn’t take — try again.") }
                return false
            }
            val fresh = r.filled.mapTo(HashSet()) { it.date }
            val after = r.view.groceries?.items
            // Only knowable when lists was on for BOTH reads; "we don't know" is not "0 added".
            val added = if (before != null && after != null) after - before else null
            _state.update { s ->
                s.copy(
                    filled = (s.filled.filter { it.date !in fresh } + r.filled).sortedBy { it.date },
                    autoMarks = s.autoMarks.filter { it !in fresh },
                    groceryAdded = if (r.filled.isNotEmpty() && (added ?: 0) > 0) added else null,
                )
            }
            apply(r.view)
            return true
        } finally {
            _state.update { it.copy(busy = false) }
        }
    }

    /** Only clears what is still untouched: a night decided since comes back in `kept`. */
    suspend fun undoTheFill(weekStart: String): Boolean {
        val s0 = current
        if (s0.busy || s0.filled.isEmpty()) return false
        _state.update { it.copy(busy = true, errorMessage = null, kept = emptyList(), groceryAdded = null) }
        try {
            val r = try {
                undo(weekStart, s0.filled)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                _state.update { it.copy(errorMessage = "That didn’t take — try again.") }
                return false
            }
            val settled = r.cleared.toSet() + r.kept
            _state.update { s ->
                s.copy(
                    kept = r.kept,
                    filled = s.filled.filter { it.date !in settled },
                    autoMarks = s.autoMarks.filter { it !in settled },
                )
            }
            apply(r.view)
            return true
        } finally {
            _state.update { it.copy(busy = false) }
        }
    }

    // ---- a night, decided by hand ----

    suspend fun planNight(weekStart: String, date: String, recipeId: String?, title: String?): Boolean =
        handWrite(weekStart, date, "that night wasn’t planned") { planSlot(date, recipeId, title) }

    suspend fun planNightAsPlate(weekStart: String, date: String, mealId: String): Boolean =
        handWrite(weekStart, date, "that night wasn’t planned") { planPlate(date, mealId) }

    suspend fun clearNight(weekStart: String, date: String): Boolean =
        handWrite(weekStart, date, "that night wasn’t cleared") { clearSlot(date) }

    /** Assign / move / hand over / clear (`dueOn` null). A FAILED write neither refetches nor mutates. */
    suspend fun setShopper(weekStart: String, dueOn: String?, personId: String?, dueTime: String?): Boolean {
        if (current.busy) {
            _state.update { it.copy(errorMessage = "Something else was still saving — the trip wasn’t changed. Try again.") }
            return false
        }
        _state.update { it.copy(busy = true, errorMessage = null) }
        try {
            val r = setShopper.invoke(weekStart, dueOn, personId, dueTime, current.choreHint)
            apply(r.view)
            return true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val forbidden = e is WaffledApiException && (e.status == 401 || e.status == 403)
            _state.update {
                it.copy(
                    errorMessage = if (forbidden) {
                        "Only a parent can hand the shopping to somebody else."
                    } else {
                        "That didn’t take — the trip stayed as it was."
                    },
                )
            }
            return false
        } finally {
            _state.update { it.copy(busy = false) }
        }
    }

    // ---- internals ----

    /** Refuse while busy WITH A MESSAGE — the picker has already closed. */
    private suspend fun handWrite(weekStart: String, date: String, failure: String, work: suspend () -> Unit): Boolean {
        if (current.busy) {
            _state.update { it.copy(errorMessage = "Something else was still saving — $failure. Try again.") }
            return false
        }
        _state.update { it.copy(busy = true, errorMessage = null) }
        try {
            try {
                work()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                _state.update { it.copy(errorMessage = "That didn’t take — try again.") }
                return false
            }
            // FORGETTING THE ✨ IS ITSELF A CHANGE, so it lands before the re-read: a failed
            // re-read keeps the previous view and would leave the crumb naming this night.
            _state.update { s ->
                s.copy(
                    filled = s.filled.filter { it.date != date },
                    autoMarks = s.autoMarks.filter { it != date },
                    kept = emptyList(),
                    groceryAdded = null,
                )
            }
            rebuildRows()
            // Still busy through the re-read, so the shell's Skip stays cold until it lands.
            reread(weekStart)
            return true
        } finally {
            _state.update { it.copy(busy = false) }
        }
    }

    private fun apply(fresh: PlanningMealsView) {
        _state.update { it.copy(view = fresh) }
        rebuildRows()
    }

    /** `auto` changes the ATTRIBUTION, so it is folded in here — date work once per load. */
    private fun rebuildRows() = _state.update { s ->
        val view = s.view
        val auto = s.autoDates
        val rows = view?.nights.orEmpty().map { night ->
            val dinner = night.dinner
            val out = dinner?.let(PlanningMealsText::isEatingOut) ?: false
            val isAuto = night.date in auto
            PlanningMealsNightRow(
                date = night.date,
                dow = PlanningMealsText.dow(night.date),
                monthDay = PlanningMealsText.monthDay(night.date),
                events = night.events.map { PlanningMealsEventRow(it.id, it.title, PlanningMealsText.clock(it), it.personColor) },
                dinner = dinner,
                auto = isAuto,
                eatingOut = out,
                attribution = dinner?.let { PlanningMealsText.attribution(it, isAuto, out) },
            )
        }
        s.copy(rows = rows, rev = s.rev + 1)
    }

    private suspend fun <T> attempt(call: suspend () -> T): T? = try {
        call()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    companion object {
        const val MEAL_TYPE = "dinner"
    }
}

/**
 * WHY THIS EXISTS: the shell renders the step's BODY and its FOOTER control as sibling
 * trees, so a `remember`ed model in either is invisible to the other. Single slot, keyed by
 * session + week: a different key REPLACES the model, so a stepped week can't inherit the
 * last week's ✨ marks. Main-thread only, like the composables that call it.
 */
object PlanningMealsStepStore {
    private var key = ""
    private var model: PlanningMealsModel? = null

    fun key(sessionId: String, weekStart: String): String = "$sessionId|$weekStart"

    fun model(sessionId: String, weekStart: String, make: () -> PlanningMealsModel): PlanningMealsModel {
        val wanted = key(sessionId, weekStart)
        model?.takeIf { key == wanted }?.let { return it }
        return make().also {
            key = wanted
            model = it
        }
    }

    fun reset() {
        key = ""
        model = null
    }
}

object PlanningMealsCrumb {
    private val day = Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")

    /** `step.data` is free-form by the time it comes back, so it is filtered, not trusted. */
    fun dates(data: JsonObject?): List<String> {
        val raw = data?.get("autoFilled") as? JsonArray ?: return emptyList()
        return raw.mapNotNull { v -> (v as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { day.matches(it) } }
    }
}
