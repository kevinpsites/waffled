package app.waffled.feature.recipes

import androidx.compose.runtime.Immutable
import kotlinx.serialization.Serializable
import kotlin.math.roundToInt

/**
 * What is being cooked, minus every side effect — the Kotlin port of
 * `apps/ios/.../Features/Meals/CookSession.swift`.
 *
 * [CookSessionStore] owns one of these and wraps it in the alarm / notification /
 * persistence shell; the rules live here so they can be tested directly.
 *
 * **Immutable, unlike the Swift original.** Swift gets value semantics for free from a
 * `struct` with `mutating func`s; Kotlin does not, and a mutable object behind a
 * `StateFlow` never diffs, so Compose would silently miss every step change. Each mutator
 * therefore returns a new session, and `null` means "that dish isn't part of this
 * session" (Swift's `false`).
 */

/**
 * One dish being cooked — a recipe with its own method and, crucially, its own place in
 * it. A plate is several of these on the go at once, so bringing the side forward must
 * never rewind the main.
 */
@Immutable
@Serializable
data class CookDish(
    /** The recipe id — also how this dish's timers are keyed. */
    val id: String,
    val title: String,
    /**
     * `main` / `side` / `dessert` — the plate's free-text role; null when a recipe is
     * cooked on its own.
     */
    val role: String? = null,
    val steps: List<RecipeStepDTO> = emptyList(),
    val ingredients: List<RecipeIngredientDTO> = emptyList(),
    /** Where this dish is in its own method — kept while another dish is on screen. */
    val index: Int = 0,
    /**
     * Which of this dish's ingredients have gone in — per dish for the same reason [index]
     * is. Session-only: nothing about a tick is written to the server.
     */
    val ticked: Set<String> = emptySet(),
) {
    /** Clamp a step to one this dish actually has. */
    fun clamp(i: Int): Int = if (steps.isEmpty()) 0 else i.coerceIn(0, steps.size - 1)
}

/**
 * A dish's fetched method. Keeps the (pure) plate builder independent of the recipe detail
 * DTO the store fetches, so composing a plate is testable without a network.
 */
@Immutable
data class CookMethod(
    val title: String,
    val steps: List<RecipeStepDTO> = emptyList(),
    val ingredients: List<RecipeIngredientDTO> = emptyList(),
)

@Immutable
@Serializable
data class CookSession(
    /**
     * The plate these dishes came from; null ⇒ one recipe cooked on its own.
     *
     * A ONE-dish plate is still a plate (its timers name the dish, and a tapped
     * notification re-opens the plate), so this — never `dishes.size` — is the test for
     * "is a plate".
     */
    val plateId: String?,
    /** The plate's name, or the lone recipe's title. */
    val title: String,
    val dishes: List<CookDish>,
    val activeDishId: String,
    /**
     * Where a timer jump pulled you off, so one tap can put you back.
     *
     * A fired timer moves you to ITS dish and ITS step, which is right — the beeping pan
     * is the live one — but it costs you the place you were reading. On a plate that's a
     * dish you can at least tab back to; when the timer belongs to the dish you're already
     * on, nothing else remembers.
     */
    val returnMark: Mark? = null,
) {

    @Immutable
    @Serializable
    data class Mark(val dishId: String, val step: Int)

    val isPlate: Boolean get() = plateId != null

    private val activeSlot: Int get() = dishes.indexOfFirst { it.id == activeDishId }
    val activeDish: CookDish? get() = dishes.getOrNull(activeSlot)
    val steps: List<RecipeStepDTO> get() = activeDish?.steps.orEmpty()
    val ingredients: List<RecipeIngredientDTO> get() = activeDish?.ingredients.orEmpty()

    /**
     * The step the dish *on screen* is on. Every dish keeps its own, so this reads through
     * to the active one; [withIndex] writes through (clamped to that dish's method).
     */
    val index: Int get() = activeDish?.index ?: 0

    /** Has this ingredient gone in? Reads the dish on screen, like [index]. */
    fun isTicked(key: String): Boolean = activeDish?.ticked?.contains(key) ?: false

    /** Tick an ingredient off, or put it back. */
    fun toggleTick(key: String): CookSession {
        val i = activeSlot
        if (i < 0) return this
        val d = dishes[i]
        val updated = dishes.toMutableList()
        updated[i] = d.copy(ticked = if (key in d.ticked) d.ticked - key else d.ticked + key)
        return copy(dishes = updated)
    }

    /** Ticks on the dish's OWN listed rows; a step-only chip doesn't count towards the list. */
    val tickedCount: Int get() = ingredients.count { isTicked(it.id) }

    fun contains(dishId: String): Boolean = dishes.any { it.id == dishId }

    /** Move the dish on screen to [newIndex], clamped to its own method. */
    fun withIndex(newIndex: Int): CookSession {
        val i = activeSlot
        if (i < 0) return this
        val updated = dishes.toMutableList()
        updated[i] = updated[i].copy(index = updated[i].clamp(newIndex))
        return copy(dishes = updated)
    }

    /**
     * Bring another dish on screen; its own step is restored untouched. null ⇒ that dish
     * isn't part of this session.
     */
    fun activate(dishId: String): CookSession? =
        if (contains(dishId)) copy(activeDishId = dishId) else null

    /**
     * Go to a dish AND a step inside it — what a fired timer, or a tap in the dock, does.
     *
     * Deliberately one call: setting the index first would move the *outgoing* dish's
     * pointer instead.
     */
    fun jump(dishId: String, step: Int): CookSession? {
        val i = dishes.indexOfFirst { it.id == dishId }
        if (i < 0) return null
        val wasDish = activeDishId
        val wasStep = index
        val clamped = dishes[i].clamp(step)
        // A jump that lands where you already stand is not a journey — offering a way
        // "back" to the step you're reading would be noise.
        val moved = wasDish != dishId || wasStep != clamped
        val updated = dishes.toMutableList()
        updated[i] = updated[i].copy(index = clamped)
        return copy(
            dishes = updated,
            activeDishId = dishId,
            returnMark = if (moved) Mark(wasDish, wasStep) else returnMark,
        )
    }

    /** Take the offer: return to the dish and step the last jump pulled you off. */
    fun goBack(): CookSession? {
        val mark = returnMark ?: return null
        val i = dishes.indexOfFirst { it.id == mark.dishId }
        if (i < 0) return null
        val updated = dishes.toMutableList()
        updated[i] = updated[i].copy(index = updated[i].clamp(mark.step))
        return copy(dishes = updated, activeDishId = mark.dishId, returnMark = null)
    }

    /** The × on the pill — forget the offer, stay put. */
    fun dismissReturn(): CookSession = copy(returnMark = null)

    /**
     * The offer to show, or null.
     *
     * Deliberately hidden once you're standing on it: you may well have walked back
     * yourself, and a button pointing at your own feet is worse than no button. Otherwise
     * it stays until used or dismissed.
     */
    val pendingReturn: Mark?
        get() = returnMark?.takeUnless { it.dishId == activeDishId && it.step == index }

    /** The dish a pending offer points at, for the pill's label. */
    val pendingReturnTitle: String?
        get() = pendingReturn?.let { m -> dishes.firstOrNull { it.id == m.dishId }?.title }

    companion object {
        /**
         * Tie a step's free-text ingredient to the recipe row whose name it contains —
         * longest name wins. Text matching no row keys off itself so it is still tickable.
         * Mirrors `ingredientKey` in the web CookMode.tsx and iOS `CookSession`.
         */
        fun ingredientKey(chip: String, ingredients: List<RecipeIngredientDTO>): String {
            val text = chip.trim().lowercase()
            val match = ingredients
                .map { it to it.name.trim().lowercase() }
                .filter { (_, name) -> name.isNotEmpty() && namesWordIn(text, name) }
                .maxByOrNull { (_, name) -> name.length }
            return match?.first?.id ?: "text:$text"
        }

        /**
         * Does [name] appear in [text] starting where a word starts? Plain containment
         * matches "oil" inside "boiling". The END is left unchecked so a plural still
         * finds its singular. Both sides are already lowercased.
         */
        fun namesWordIn(text: String, name: String): Boolean {
            var from = 0
            while (true) {
                val at = text.indexOf(name, from)
                if (at < 0) return false
                if (at == 0 || !text[at - 1].isLetterOrDigit()) return true
                from = at + 1
            }
        }

        /** "3 tbsp", or "" when the row has no parsed amount. */
        fun amountText(ing: RecipeIngredientDTO): String {
            val amt = ing.amount ?: return ""
            return RecipeAmount.format(amt) + (ing.unit?.let { " $it" } ?: "")
        }

        /**
         * The editor writes a picked ingredient with no per-step amount as its bare name,
         * so a chip that IS a row's name borrows that row's measurement; anything else is
         * the author's own words. Mirrors `chipLabel` in the web CookMode.tsx.
         */
        fun chipLabel(chip: String, ingredients: List<RecipeIngredientDTO>): String {
            val text = chip.trim()
            val lc = text.lowercase()
            val row = ingredients.firstOrNull { it.name.trim().lowercase() == lc } ?: return chip
            val amt = amountText(row)
            return if (amt.isEmpty()) chip else "$amt $text"
        }

        /** The overview list's name column; an unparsed import keeps its quantity in `display`. */
        fun listName(ing: RecipeIngredientDTO): String {
            ing.sub?.let { return it }
            if (ing.amount == null && !ing.display.isNullOrEmpty()) return ing.display
            return ing.name
        }

        /** null when there's nothing to cook — a session always has at least one dish. */
        fun of(plateId: String?, title: String, dishes: List<CookDish>): CookSession? {
            val first = dishes.firstOrNull() ?: return null
            return CookSession(plateId, title, dishes, first.id)
        }

        /**
         * The timers belonging to one dish.
         *
         * Timers live in ONE flat list across the whole plate (they all keep running
         * whichever dish you're looking at) — this is how the dish tabs and the dock slice
         * it.
         */
        fun timers(all: List<CookTimer>, dishId: String): List<CookTimer> =
            all.filter { it.dishId == dishId }

        /**
         * Build a session for a whole plate.
         *
         * Dishes come out in `sortOrder` (never trust arrival order — Kotlin's `sortedBy`
         * is stable, so equal orders keep theirs), and a dish whose method failed to load
         * is skipped rather than sinking the plate: one unreachable side shouldn't stop you
         * cooking dinner. null ⇒ nothing loaded, so there is nothing to cook.
         */
        fun plate(meal: MealDTO, methods: Map<String, CookMethod>): CookSession? {
            val dishes = meal.recipes
                .sortedBy { it.sortOrder }
                .mapNotNull { d ->
                    val m = methods[d.recipeId] ?: return@mapNotNull null
                    CookDish(
                        id = d.recipeId,
                        title = d.title ?: m.title,
                        role = d.role,
                        steps = m.steps,
                        ingredients = m.ingredients,
                    )
                }
            return of(meal.id, meal.name, dishes)
        }
    }
}

/**
 * One concurrent cook-mode timer.
 *
 * Counts down off an absolute wall-clock instant ([fireAtMillis]) rather than an in-memory
 * coroutine, so it stays accurate across backgrounding **and across the process being
 * killed**: on restore, remaining is simply recomputed from the clock. The on-screen
 * ticker only *reads* [remaining]; it never owns the source of truth.
 *
 * Every derived value takes `now` as a parameter. That is not ceremony — it is the only
 * way the behaviour the whole feature turns on is testable on the JVM.
 */
@Immutable
@Serializable
data class CookTimer(
    /**
     * Stable identity, and the tag the scheduled alarm + notification are filed under, so
     * re-scheduling under the same id replaces rather than duplicates.
     */
    val id: String,
    /**
     * Which dish (recipe id) this timer belongs to. A plate cooks several dishes at once,
     * so "step 3" on its own names nothing — a timer is keyed by (dish, step).
     */
    val dishId: String,
    /**
     * The dish's name, on a plate. null ⇒ one recipe cooked alone, where repeating its
     * title in every timer label would just be noise.
     */
    val dishTitle: String? = null,
    /** Where "Jump to step" lands, *within that dish*. */
    val stepIndex: Int,
    /** The step's own number, as printed ("Step 3"). */
    val stepNumber: Int,
    /** Seconds, for the +1:00 / restart math. */
    val total: Int,
    /** The absolute instant it hits zero. */
    val fireAtMillis: Long,
    /** false = paused. */
    val running: Boolean = true,
    /** true = ringing, shows the alarm overlay. */
    val firing: Boolean = false,
    /** Remaining when paused — so resume re-anchors [fireAtMillis] from this, not the clock. */
    val pausedRemaining: Int,
) {

    /**
     * What a timer is really identified by: (dish, step). Step 3 of the main and step 3 of
     * the side are two different timers, on two different pans.
     */
    @Immutable
    data class Key(val dishId: String, val stepIndex: Int)

    val key: Key get() = Key(dishId, stepIndex)

    /** Live seconds remaining, clamped at zero. Paused timers read the frozen value. */
    fun remaining(now: Long): Int {
        if (!running) return maxOf(0, pausedRemaining)
        return maxOf(0, ((fireAtMillis - now) / 1000.0).roundToInt())
    }

    /**
     * Has this timer just come due? False for a paused one, and false for one already
     * ringing — the alarm fires once per timer, not once per tick.
     */
    fun hasElapsed(now: Long): Boolean = running && !firing && now >= fireAtMillis

    /** Freeze what's left. */
    fun paused(now: Long): CookTimer =
        copy(running = false, firing = false, pausedRemaining = remaining(now))

    /** Re-anchor the instant from what was left, not from the original total. */
    fun resumed(now: Long): CookTimer =
        copy(running = true, firing = false, fireAtMillis = now + maxOf(0, pausedRemaining) * 1000L)

    /** "+1:00". On a ringing timer this also stops the alarm — that's the point of it. */
    fun plusMinute(now: Long): CookTimer =
        if (running) copy(fireAtMillis = maxOf(now, fireAtMillis) + 60_000L, firing = false)
        else copy(pausedRemaining = maxOf(0, pausedRemaining) + 60, firing = false)

    /** The short form, for buttons — "Step 3". */
    val stepLabel: String get() = "Step $stepNumber"

    /**
     * Dish-qualified on a plate — "Potato Salad · Step 2" — so the dock and the lock
     * screen say which dish is beeping; the bare step alone when cooking one recipe.
     */
    val label: String get() = dishTitle?.let { "$it · $stepLabel" } ?: stepLabel

    /**
     * A self-describing name combining the dish, the step and this timer's duration — e.g.
     * "Potato Salad · Step 5 · 3-minute timer". Several timers can ring at once, so both
     * the in-app alarm and the background notification use this to say *which* is up.
     */
    val displayName: String
        get() {
            val m = total / 60
            val s = total % 60
            val duration = when {
                m > 0 && s == 0 -> "$m-minute"
                m == 0 -> "$s-second"
                else -> mmss(total)
            }
            return "$label · $duration timer"
        }

    companion object {
        fun mmss(secs: Int): String {
            val s = maxOf(0, secs)
            return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
        }
    }
}

/**
 * The link payload a fired cook-timer notification carries, so tapping it re-opens Cook
 * Mode on the DISH that beeped — at the right step, and with the rest of its plate (and
 * their running timers) intact.
 *
 * Modelled as a plain `Map` rather than an `Intent`/`Bundle` so the round-trip is testable
 * on the JVM; [CookTimerAlarm] adapts it to intent extras at the edge, and nothing here
 * imports a view type.
 */
@Immutable
data class CookTimerLink(
    /** The recipe whose timer fired: one dish of a plate, or the lone recipe. */
    val dishId: String,
    val stepIndex: Int,
    /**
     * The plate that dish belongs to, when it has one, so re-opening restores the whole
     * plate rather than just that one recipe.
     */
    val plateId: String? = null,
) {

    /** The extras a scheduled timer notification carries. */
    fun payload(timerId: String): Map<String, Any?> = buildMap {
        put(KEY_DISH, dishId)
        // The pre-plates key, still WRITTEN with the dish id: a notification queued by an
        // older build (or sitting in the OS queue across an app update) must keep
        // deep-linking rather than becoming an inert tap.
        put(KEY_RECIPE, dishId)
        put(KEY_STEP, stepIndex)
        put(KEY_TIMER, timerId)
        if (plateId != null) put(KEY_PLATE, plateId)
    }

    companion object {
        const val KEY_DISH = "cookDishId"
        const val KEY_RECIPE = "cookRecipeId"
        const val KEY_STEP = "cookStepIndex"
        const val KEY_PLATE = "cookPlateId"
        const val KEY_TIMER = "cookTimerId"

        /**
         * Read one back off a tapped notification; null ⇒ not one of ours (an event
         * reminder, say), so the caller falls through to its other handlers.
         */
        fun from(payload: Map<String, Any?>): CookTimerLink? {
            val dish = payload[KEY_DISH] as? String ?: payload[KEY_RECIPE] as? String ?: return null
            return CookTimerLink(
                dishId = dish,
                stepIndex = (payload[KEY_STEP] as? Int) ?: 0,
                plateId = payload[KEY_PLATE] as? String,
            )
        }
    }
}
