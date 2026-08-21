package app.waffled.feature.recipes

import androidx.compose.runtime.Immutable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable

/**
 * The endpoints Cook Mode needs, as a seam so the store is drivable from a JVM test.
 * `live` wires them to [RecipesApi].
 */
interface CookApi {
    suspend fun recipeDetail(id: String): RecipeDetailDTO
    suspend fun meal(id: String): MealDTO
    suspend fun markCooked(id: String)
    suspend fun pantryForRecipe(recipeId: String): List<RecipeMatch>

    companion object {
        fun live(api: RecipesApi): CookApi = object : CookApi {
            override suspend fun recipeDetail(id: String) = api.detail(id)
            override suspend fun meal(id: String) = api.meal(id)
            override suspend fun markCooked(id: String) {
                api.markCooked(id)
            }

            override suspend fun pantryForRecipe(recipeId: String) = api.pantryForRecipe(recipeId)
        }
    }
}

/**
 * The out-of-app alarm: an exact wall-clock alarm plus the notification it posts.
 *
 * A seam, because scheduling one needs `AlarmManager`, a `BroadcastReceiver` and (on API
 * 33+) a runtime permission — none of which exist in a JVM test. The real implementation
 * is [CookTimerAlarm]; the store only ever asks for "wake me at this instant, under this
 * id, saying this".
 */
interface CookAlarm {
    /**
     * (Re)schedule a timer's alert. Re-adding under the same id **replaces**, so calling
     * this on start, on resume and on +1:00 is idempotent.
     */
    fun schedule(timer: CookTimer, link: CookTimerLink)

    /** Drop a pending alert. */
    fun cancel(timerId: String)

    /** Silence anything currently ringing (leaving Cook Mode). */
    fun stop()
}

/** A no-op alarm — the default in tests and anywhere notifications aren't wanted. */
object NoCookAlarm : CookAlarm {
    override fun schedule(timer: CookTimer, link: CookTimerLink) = Unit
    override fun cancel(timerId: String) = Unit
    override fun stop() = Unit
}

/**
 * Where a live session is written so it survives the process being killed.
 *
 * This is the difference between "the timer keeps counting while the app is backgrounded"
 * (an in-memory coroutine would manage that) and "the timer is still right after Android
 * reclaims the app mid-simmer" (only an absolute instant on disk can). A seam so the JVM
 * test can prove the restore without a `Context`.
 */
interface CookStateStore {
    fun load(): CookPersistedState?
    fun save(state: CookPersistedState?)
}

/** The snapshot written after every mutation. Timers carry absolute instants. */
@Serializable
data class CookPersistedState(
    val session: CookSession? = null,
    val timers: List<CookTimer> = emptyList(),
)

/** An in-memory store — the default, and what the tests drive. */
class InMemoryCookStateStore(private var state: CookPersistedState? = null) : CookStateStore {
    override fun load(): CookPersistedState? = state
    override fun save(state: CookPersistedState?) {
        this.state = state
    }
}

/**
 * The active Cook Mode session — the Kotlin port of
 * `apps/ios/.../Features/Meals/CookSessionStore.swift`.
 *
 * Hoisted out of any screen deliberately: Cook Mode has to survive whatever the navigation
 * does when the app backgrounds and returns, and it owns the running [timers] plus the
 * alarm, so a timer keeps counting across backgrounding. It is also the target a tapped
 * timer notification deep-links into.
 *
 * A session is **one or more dishes** ([CookSession]): a plate is cooked as several
 * recipes at once, each holding its own step position, with timers running across all of
 * them. A recipe cooked on its own is simply a one-dish, plate-less session — which is why
 * [start] still means exactly what it always did.
 *
 * Two Android-specific guarantees the iOS original didn't need:
 *  - every mutation is written to [CookStateStore], so the session and its timers come
 *    back after the process is killed;
 *  - [now] is injectable, so "does a timer survive an hour of wall clock" is a unit test
 *    rather than an hour of waiting.
 */
class CookSessionStore(
    private val api: CookApi,
    private val alarm: CookAlarm = NoCookAlarm,
    private val persistence: CookStateStore = InMemoryCookStateStore(),
    private val now: () -> Long = System::currentTimeMillis,
    /** Timer ids are opaque; injectable so a test gets deterministic ones. */
    private val newTimerId: () -> String = { "waffled.cook." + java.util.UUID.randomUUID() },
) {

    /** Everything Cook Mode repaints from, in one value. */
    @Immutable
    data class State(
        val session: CookSession? = null,
        /**
         * Every running / paused / ringing timer in the session, ACROSS all its dishes —
         * one flat list, each entry naming the dish it belongs to. Flat (rather than per
         * dish) because the dock shows the whole plate at once and the ticker reads it
         * every second; [dishTimers] slices it when a single dish is what's wanted.
         */
        val timers: List<CookTimer> = emptyList(),
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /**
     * A recipe's cook that needs a "Used from your pantry" confirm.
     *
     * Set by [finish] when the server finds on-hand pantry matches. The confirm sheet
     * itself belongs to the pantry feature, so this is left for the host to present — see
     * the module's public surface.
     */
    @Immutable
    data class PantryReconcile(val recipeId: String, val title: String, val matches: List<RecipeMatch>)

    private val _pendingPantryReconcile = MutableStateFlow<PantryReconcile?>(null)
    val pendingPantryReconcile: StateFlow<PantryReconcile?> = _pendingPantryReconcile.asStateFlow()

    val session: CookSession? get() = _state.value.session
    val timers: List<CookTimer> get() = _state.value.timers

    /** A live session ⇒ present Cook Mode. */
    val isActive: Boolean get() = session != null

    /** The plate's name, or the lone recipe's title — Cook Mode's top bar. */
    val title: String get() = session?.title.orEmpty()
    val dishes: List<CookDish> get() = session?.dishes.orEmpty()
    val activeDishId: String? get() = session?.activeDishId
    val activeDish: CookDish? get() = session?.activeDish

    /** True while cooking a plate — the dish tabs show, and timers name their dish. */
    val isPlate: Boolean get() = session?.isPlate ?: false
    val steps: List<RecipeStepDTO> get() = session?.steps.orEmpty()
    val ingredients: List<RecipeIngredientDTO> get() = session?.ingredients.orEmpty()

    /**
     * The step Cook Mode is showing *for the dish on screen*. Lives in the session (and
     * therefore per dish) so it survives a teardown of the presenting screen AND so
     * switching dishes doesn't lose anyone's place.
     */
    var index: Int
        get() = session?.index ?: 0
        set(value) {
            mutate { it.withIndex(value) }
        }

    /** One dish's timers — the tab badges and any per-dish view. */
    fun dishTimers(dishId: String): List<CookTimer> = CookSession.timers(timers, dishId)

    /**
     * Bring back whatever was cooking when the process died.
     *
     * Timers are recomputed from their absolute instants rather than resumed, so one that
     * came due while the app was gone comes back already ringing.
     */
    fun restore() {
        val saved = persistence.load() ?: return
        if (saved.session == null) return
        val t = now()
        _state.value = State(
            session = saved.session,
            timers = saved.timers.map { if (it.hasElapsed(t)) it.copy(firing = true) else it },
        )
    }

    // ---- starting --------------------------------------------------------------

    /**
     * Begin cooking a recipe (the Cook Mode button). A lone recipe is just a one-dish,
     * plate-less session.
     *
     * Re-tapping the recipe that's already cooking is a no-op so its running timers and
     * step position are kept — and, since a plate's dishes are recipes too, tapping Cook
     * on a recipe that's already ON the active plate brings that dish forward instead of
     * tearing the plate (and the other dishes' timers) down.
     */
    fun start(
        id: String,
        title: String,
        steps: List<RecipeStepDTO>,
        ingredients: List<RecipeIngredientDTO>,
    ) {
        if (session?.contains(id) == true) {
            switchToDish(id)
            return
        }
        val dish = CookDish(id = id, title = title, steps = steps, ingredients = ingredients)
        val s = CookSession.of(null, title, listOf(dish)) ?: return
        start(s)
    }

    /**
     * Begin a genuinely new session. The outgoing one's pending alerts are cancelled and
     * its timers dropped — that food is off the counter.
     *
     * This and [end] are the ONLY paths that clear timers: moving between a plate's dishes
     * never does, which is exactly what used to make a multi-dish plate impossible to cook.
     */
    fun start(session: CookSession) {
        for (t in timers) alarm.cancel(t.id)
        _state.value = State(session = session, timers = emptyList())
        persist()
    }

    /**
     * Cook a whole plate: every dish, each with its own steps and its own place in them.
     *
     * The methods are fetched **concurrently** up front so the dish tabs are ready the
     * moment Cook Mode opens — a four-dish plate fetched serially is four round-trips of
     * staring at a spinner. Re-starting the plate already cooking is a no-op (timers +
     * per-dish progress kept); a dish whose recipe won't load is skipped by
     * [CookSession.plate].
     */
    suspend fun startPlate(meal: MealDTO) {
        if (session?.plateId == meal.id) return
        val s = CookSession.plate(meal, methods(meal)) ?: return
        start(s)
    }

    /** Same, given only the plate's id (a plate card, or a tapped timer notification). */
    suspend fun startPlate(mealId: String) {
        if (session?.plateId == mealId) return
        val meal = runCatching { api.meal(mealId) }.getOrNull() ?: return
        startPlate(meal)
    }

    /**
     * Fetch every dish's steps + ingredients at once. `MealDishDTO` carries the plate's
     * framing (role, order, cook) but not the method, so each dish needs its own detail
     * call.
     */
    private suspend fun methods(meal: MealDTO): Map<String, CookMethod> = coroutineScope {
        meal.recipes.map { d ->
            async {
                val detail = runCatching { api.recipeDetail(d.recipeId) }.getOrNull()
                d.recipeId to detail?.let {
                    CookMethod(it.recipe.title, it.steps, it.ingredients)
                }
            }
        }.awaitAll().mapNotNull { (id, m) -> m?.let { id to it } }.toMap()
    }

    // ---- moving around ---------------------------------------------------------

    /**
     * Bring another of the plate's dishes on screen. Its own step is restored, and every
     * timer — including the one on the dish you just left — keeps running.
     */
    fun switchToDish(dishId: String) {
        mutate { it.activate(dishId) }
    }

    /**
     * Go to the dish a timer belongs to, at that timer's step. One call on purpose: a tap
     * on ANOTHER dish's timer in the dock must move that dish, never the current one.
     */
    fun jump(timer: CookTimer) {
        mutate { it.jump(timer.dishId, timer.stepIndex) }
    }

    // ---- getting back ----------------------------------------------------------

    /**
     * Where the last timer jump pulled you off, if you aren't already back there — the
     * screen offers one tap to return.
     */
    val pendingReturn: CookSession.Mark? get() = session?.pendingReturn

    /** The dish that offer points at, for the label. */
    val pendingReturnTitle: String? get() = session?.pendingReturnTitle

    /** Take the offer — restores the dish AND its step. */
    fun goBack() {
        mutate { it.goBack() }
    }

    /** The pill's × — forget the offer without moving. */
    fun dismissReturn() {
        mutate { it.dismissReturn() }
    }

    // ---- timers ----------------------------------------------------------------

    /**
     * Start a timer on the dish that's on screen.
     *
     * Timers are keyed by **(dish, step)** — step 3 of the main and step 3 of the side are
     * different timers — and on a plate the name carries the dish, so the dock, the alarm
     * and the lock screen all say which pan is beeping. null ⇒ nothing is cooking.
     */
    fun startTimer(secs: Int, stepIndex: Int, stepNumber: Int): CookTimer? {
        val dish = session?.activeDish ?: return null
        val t = CookTimer(
            id = newTimerId(),
            dishId = dish.id,
            // Only a plate qualifies its timers; naming the one recipe you're cooking in
            // every label would just be noise.
            dishTitle = if (isPlate) dish.title else null,
            stepIndex = stepIndex,
            stepNumber = stepNumber,
            total = secs,
            fireAtMillis = now() + secs * 1000L,
            running = true,
            firing = false,
            pausedRemaining = secs,
        )
        _state.value = _state.value.copy(timers = timers + t)
        schedule(t)
        persist()
        return t
    }

    /** (Re)schedule a timer's out-of-app alert — on start, on resume, and on +1:00. */
    fun schedule(t: CookTimer) {
        if (!t.running) {
            // A paused timer has no instant to ring at.
            alarm.cancel(t.id)
            return
        }
        alarm.schedule(t, CookTimerLink(t.dishId, t.stepIndex, session?.plateId))
    }

    /** Replace one timer in the flat list and re-sync its alert. */
    private fun replace(t: CookTimer) {
        _state.value = _state.value.copy(timers = timers.map { if (it.id == t.id) t else it })
        schedule(t)
        persist()
    }

    fun pauseTimer(t: CookTimer) = replace(t.paused(now()))

    fun resumeTimer(t: CookTimer) = replace(t.resumed(now()))

    fun addMinute(t: CookTimer) = replace(t.plusMinute(now()))

    /**
     * Re-read every running timer against the clock and mark the newly-due ones ringing.
     *
     * The single place elapsing is decided — driven by the on-screen ticker while Cook Mode
     * is up, and once on [restore] so a timer that came due while the process was dead
     * comes back already ringing.
     */
    fun tick(): Boolean {
        val t = now()
        if (timers.none { it.hasElapsed(t) }) return false
        _state.value = _state.value.copy(
            timers = timers.map { if (it.hasElapsed(t)) it.copy(firing = true) else it },
        )
        persist()
        return true
    }

    /** Drop a timer and its pending alert (dock ✕ / alarm Dismiss). */
    fun removeTimer(t: CookTimer) {
        alarm.cancel(t.id)
        _state.value = _state.value.copy(timers = timers.filterNot { it.id == t.id })
        persist()
    }

    // ---- notifications, ending -------------------------------------------------

    /**
     * A fired cook-timer notification was tapped: (re)present Cook Mode for the dish that
     * beeped and jump to its step.
     *
     * If that dish is already in the live session we just move to it (keeping every other
     * timer); otherwise we re-fetch — the whole plate when the timer named one, else the
     * single recipe — and present that.
     */
    suspend fun openFromNotification(link: CookTimerLink) {
        if (session?.contains(link.dishId) == true) {
            mutate { it.jump(link.dishId, link.stepIndex) }
            return
        }
        if (link.plateId != null) {
            startPlate(link.plateId)
            if (session?.contains(link.dishId) == true) {
                mutate { it.jump(link.dishId, link.stepIndex) }
                return
            }
        }
        val d = runCatching { api.recipeDetail(link.dishId) }.getOrNull() ?: return
        start(link.dishId, d.recipe.title, d.steps, d.ingredients)
        mutate { it.jump(link.dishId, link.stepIndex) }
    }

    /**
     * Leave Cook Mode (the ✕). An explicit user action, so every dish's pending timer
     * notification is cancelled here — the background / teardown path never calls this.
     */
    fun end() {
        for (t in timers) alarm.cancel(t.id)
        alarm.stop()
        _state.value = State()
        persist()
    }

    /**
     * Finish & mark cooked (last step). Records the cook of the dish **on screen** by id —
     * independent of the (possibly torn-down) recipe detail — closes Cook Mode, then offers
     * the "Used from your pantry" reconcile when the server finds on-hand matches.
     *
     * NOTE: on a plate this finishes the *session*, marking the dish you're looking at
     * cooked. Finishing one dish and rolling on to the next (with a reconcile each) is
     * deliberately out of scope: the reconcile is per recipe, and combining several dishes'
     * matches risks double-decrementing a shared pantry item.
     */
    suspend fun finish() {
        val dish = session?.activeDish
        if (dish == null) {
            end()
            return
        }
        val id = dish.id
        val title = dish.title
        end() // close Cook Mode straight away
        try {
            runCatching { api.markCooked(id) }
            val matches = runCatching { api.pantryForRecipe(id) }.getOrNull().orEmpty()
            if (matches.isNotEmpty()) {
                _pendingPantryReconcile.value = PantryReconcile(id, title, matches)
            }
        } catch (e: CancellationException) {
            throw e
        }
    }

    /** The host has presented (or dismissed) the reconcile sheet. */
    fun clearPantryReconcile() {
        _pendingPantryReconcile.value = null
    }

    // ---- plumbing --------------------------------------------------------------

    /** Apply a session transform, ignoring the ones that resolve to "not possible". */
    private fun mutate(transform: (CookSession) -> CookSession?) {
        val current = session ?: return
        val next = transform(current) ?: return
        _state.value = _state.value.copy(session = next)
        persist()
    }

    private fun persist() {
        val s = _state.value
        persistence.save(if (s.session == null) null else CookPersistedState(s.session, s.timers))
    }
}
