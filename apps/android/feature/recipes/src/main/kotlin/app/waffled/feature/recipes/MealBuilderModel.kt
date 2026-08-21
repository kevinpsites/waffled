package app.waffled.feature.recipes

import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * The plate writes the builder needs, as a seam so the model can be tested without a
 * server. [live] wires them to [RecipesApi], which owns every endpoint and DTO — nothing
 * here does its own networking.
 */
interface MealBuilderApi {
    suspend fun fetch(id: String): MealDTO
    suspend fun create(name: String, servings: Int): MealDTO
    suspend fun update(id: String, name: String?, servings: Int?, isSaved: Boolean?): MealDTO
    suspend fun addDish(id: String, recipeId: String, role: String?): MealDTO
    suspend fun flatten(id: String, savedMealId: String): MealDTO
    suspend fun patchDish(id: String, recipeId: String, role: String?, cook: CookAssignment): MealDTO
    suspend fun removeDish(id: String, recipeId: String): MealDTO

    /** The plate's dishes in their new order — one write for the whole plate. */
    suspend fun reorder(id: String, recipeIds: List<String>): MealDTO
    suspend fun addToList(id: String): Int
    suspend fun schedule(id: String, date: String, mealType: String, cookPersonId: String?)

    companion object {
        fun live(api: RecipesApi): MealBuilderApi = object : MealBuilderApi {
            override suspend fun fetch(id: String) = api.meal(id)
            override suspend fun create(name: String, servings: Int) =
                api.createMeal(name, servings)

            override suspend fun update(id: String, name: String?, servings: Int?, isSaved: Boolean?) =
                api.updateMeal(id, name, servings, isSaved)

            override suspend fun addDish(id: String, recipeId: String, role: String?) =
                api.addDish(id, recipeId, role)

            override suspend fun flatten(id: String, savedMealId: String) =
                api.flattenMeal(id, savedMealId)

            override suspend fun patchDish(
                id: String,
                recipeId: String,
                role: String?,
                cook: CookAssignment,
            ) = api.patchDish(id, recipeId, role, cook = cook)

            override suspend fun removeDish(id: String, recipeId: String) =
                api.removeDish(id, recipeId)

            override suspend fun reorder(id: String, recipeIds: List<String>) =
                api.reorderDishes(id, recipeIds)

            override suspend fun addToList(id: String) = api.addMealToGrocery(id)

            // The reply carries a plate, but for a SAVED plate that is the *copy* the
            // server scheduled — not this one — so it is deliberately dropped rather than
            // repainted over the builder.
            override suspend fun schedule(
                id: String,
                date: String,
                mealType: String,
                cookPersonId: String?,
            ) {
                api.scheduleMeal(id, date, mealType, cookPersonId)
            }
        }
    }
}

/**
 * The plate under construction — the Kotlin port of
 * `apps/ios/.../Features/Meals/MealBuilderModel.swift`.
 *
 * Methods are plain `suspend` functions rather than `viewModelScope.launch` calls so the
 * whole state machine is drivable from a JVM test with no main-dispatcher rule — the same
 * shape `PhotosModel` uses.
 *
 * Three rules make this look finished while being broken, and each has a test:
 *  - the plate is created **lazily and exactly once**, even when a rename and an add race;
 *  - a write that fails **rolls back** whatever was painted optimistically and says so;
 *  - an **older** reply never repaints over a newer one (every mutation answers with the
 *    whole plate, true as of its own commit, and nothing refetches to self-heal).
 */
class MealBuilderModel(
    private val api: MealBuilderApi,
    existing: MealDTO? = null,
    /**
     * Bumped after every write so other REST-backed screens re-fetch. Meals aren't
     * synced, so nothing else would ever hear about a change. Optional so a test can
     * leave it out.
     */
    private val refreshBus: RefreshBus? = null,
) {

    /** Everything the builder screen repaints from, in one value. */
    data class State(
        val meal: MealDTO? = null,
        val groups: List<PlateGroup> = PlateRoles.groups(emptyList()),
        val servings: Int = 4,
        val isSaved: Boolean = false,
        val busy: Boolean = false,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /**
     * Bound to the inline name field. Committed on submit / focus loss, not per
     * keystroke — a debounce here would make the lazy-create guard a timing race.
     */
    private val _name = MutableStateFlow("")
    val nameState: StateFlow<String> = _name.asStateFlow()
    var name: String
        get() = _name.value
        set(value) {
            _name.value = value
        }

    /** A transient message for the toast. */
    private val _message = MutableStateFlow<String?>(null)
    val messageState: StateFlow<String?> = _message.asStateFlow()
    var message: String?
        get() = _message.value
        set(value) {
            _message.value = value
        }

    /** null until the plate exists server-side (it is created lazily). */
    var mealId: String? = null
        private set

    val meal: MealDTO? get() = _state.value.meal
    val groups: List<PlateGroup> get() = _state.value.groups
    val servings: Int get() = _state.value.servings
    val isSaved: Boolean get() = _state.value.isSaved
    val busy: Boolean get() = _state.value.busy

    val isEmpty: Boolean get() = meal?.recipes.isNullOrEmpty()
    val toBuy: Int get() = meal?.toBuy ?: 0
    val totalMinutes: Int? get() = meal?.totalMinutes

    val displayName: String get() = name.trim().ifEmpty { NEW_NAME }

    /** The in-flight create, shared so a fast rename-then-add fires ONE POST. */
    private var createInFlight: CompletableDeferred<MealDTO>? = null

    /**
     * Which write is newest. Every mutation answers with the whole plate, true as of its
     * own commit — repainting from an older reply resurrects a removed dish, and it does
     * not self-heal (nothing refetches).
     */
    private var seq = 0

    /** The name the server last confirmed, so a blur with no edit doesn't PATCH. */
    private var committedName: String? = null

    init {
        if (existing != null) adopt(existing)
    }

    /** Adopt a whole plate (opening an existing one, or reloading it). */
    fun adopt(m: MealDTO) {
        mealId = m.id
        _state.update { it.copy(meal = m, groups = PlateRoles.groups(m.recipes), servings = m.servings, isSaved = m.isSaved) }
        _name.value = m.name
        committedName = m.name
    }

    /** Repaint from a write's reply — unless a newer write has gone out since. */
    fun applyIfCurrent(updated: MealDTO, seq: Int) {
        if (seq != this.seq) return
        mealId = updated.id
        _state.update { it.copy(meal = updated, groups = PlateRoles.groups(updated.recipes)) }
    }

    suspend fun reload() {
        val id = mealId ?: return
        runCatching { api.fetch(id) }.getOrNull()?.let(::adopt)
    }

    // ---- writes ----------------------------------------------------------------

    /**
     * Add a recipe under an explicit role: the group whose ＋ was tapped.
     *
     * Sending none files everything under the server default (the web's "＋ always filed
     * under Sides" bug) and a bare re-add can wipe an existing dish's role and cook.
     */
    suspend fun addRecipe(recipeId: String, role: PlateRole) {
        run { id -> api.addDish(id, recipeId, role.key) }
    }

    /**
     * A saved plate added here FLATTENS — its dishes arrive as individual, editable rows
     * keeping their own roles. Meals never nest.
     */
    suspend fun addSavedMeal(savedMealId: String) {
        run { id -> api.flatten(id, savedMealId) }
    }

    suspend fun removeDish(recipeId: String) {
        run { id -> api.removeDish(id, recipeId) }
    }

    /**
     * Re-file a dish from the row menu — no position was chosen, so only the role changes
     * and it keeps its place in the plate's order.
     */
    suspend fun moveDish(recipeId: String, role: PlateRole) {
        run { id -> api.patchDish(id, recipeId, role.key, CookAssignment.Unchanged) }
    }

    /**
     * Apply a drop: the role AND the plate's new order. Two writes, because the role lives
     * on the dish and the order is plate-wide; the second answers with the plate, so
     * that's the one the screen repaints from.
     */
    suspend fun apply(move: PlateReorder.Move) {
        run { id ->
            api.patchDish(id, move.id, move.role.key, CookAssignment.Unchanged)
            api.reorder(id, move.order)
        }
    }

    /**
     * null = "Nobody". The server distinguishes an absent cook (leave it alone) from an
     * explicit null (clear it), so this must say [CookAssignment.Clear].
     */
    suspend fun assignCook(recipeId: String, personId: String?) {
        val cook = personId?.let { CookAssignment.Person(it) } ?: CookAssignment.Clear
        run { id -> api.patchDish(id, recipeId, null, cook) }
    }

    suspend fun changeServings(next: Int) {
        val n = maxOf(1, next)
        if (n == servings) return
        val previous = servings
        _state.update { it.copy(servings = n) }
        // Nothing exists AND nothing is being created — the number rides along on the lazy
        // create when one eventually happens, so there's nothing to write yet.
        //
        // A create already in flight is a different case and used to fall in here too:
        // `ensureId` captured `servings` before the tap, so the new number was neither
        // sent nor folded in, and nothing ever re-synced it — the bar said 5 while the
        // server held 4, right through Schedule and Add-to-list. `run` waits on the
        // in-flight create and then PATCHes, so it just has to be allowed through.
        if (mealId == null && createInFlight == null) return
        run(rollback = { _state.update { it.copy(servings = previous) } }) { id ->
            api.update(id, null, n, null)
        }
    }

    /**
     * "Keep in library". Applied the moment it is flipped — a state, not a pending action
     * waiting on Schedule or Add-to-list.
     */
    suspend fun toggleSaved() {
        val next = !isSaved
        val previous = isSaved
        _state.update { it.copy(isSaved = next) }
        run(rollback = { _state.update { it.copy(isSaved = previous) } }) { id ->
            api.update(id, null, null, next)
        }
    }

    /**
     * Commit the inline name edit (on submit / focus loss). Creates the plate if this is
     * the first thing that happened on the screen.
     */
    suspend fun commitRename() {
        val next = name.trim()
        if (next.isEmpty()) {
            _name.value = committedName ?: meal?.name.orEmpty()
            return
        }
        if (next == committedName) return
        val previous = committedName.orEmpty()
        val ok = run(rollback = { _name.value = previous }) { id ->
            // The lazy create may have just used this very name — don't PATCH it back.
            val current = meal
            if (current != null && current.name == next) current else api.update(id, next, null, null)
        }
        // Only on success. A rejected name that still counted as "confirmed" would be
        // painted straight back the next time the (now-empty) field lost focus.
        if (ok) committedName = meal?.name ?: next
    }

    /** Put the whole plate's shopping on the grocery list without scheduling it. */
    suspend fun addToGrocery() {
        val id = mealId
        if (id == null || isEmpty) {
            message = "Add a dish first."
            return
        }
        _state.update { it.copy(busy = true) }
        message = try {
            val added = api.addToList(id)
            invalidate()
            if (added == 1) "Added 1 item to the grocery list" else "Added $added items to the grocery list"
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            "Couldn’t add this plate to the list."
        }
        _state.update { it.copy(busy = false) }
    }

    /**
     * Put the plate on a day + slot. Returns false if it couldn't.
     *
     * Deliberately does NOT repaint from the reply: scheduling a **saved** plate copies
     * it, so the plate that comes back is next week's copy, not this one.
     *
     * The date and slot are parameters, not something this screen chooses: picking a night
     * is the planner's job, and `feature:recipes` deliberately does not own a week grid.
     */
    suspend fun schedule(date: String, mealType: String, cookPersonId: String? = null): Boolean {
        val id = mealId
        if (id == null || isEmpty) {
            message = "Add a dish first."
            return false
        }
        return try {
            api.schedule(id, date, mealType, cookPersonId)
            invalidate()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            message = "Couldn’t schedule this plate."
            false
        }
    }

    private fun invalidate() {
        refreshBus?.bump(RefreshDomain.Meals)
    }

    // ---- plumbing --------------------------------------------------------------

    /**
     * Run a write against the plate, creating it first if this is a fresh one, and repaint
     * from the response.
     *
     * [rollback] restores whatever the caller painted optimistically — without it a
     * rejected rename / toggle / servings change stays on screen, silently, until a
     * reload.
     */
    private suspend fun run(
        rollback: (() -> Unit)? = null,
        fn: suspend (String) -> MealDTO,
    ): Boolean {
        seq += 1
        val mine = seq
        _state.update { it.copy(busy = true) }
        var ok = true
        try {
            val id = ensureId()
            applyIfCurrent(fn(id), mine)
            invalidate()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Deliberately NOT gated on `mine == seq`: a write that failed still failed,
            // and staying quiet because something else went out afterwards is how the
            // web's silent-failure bug happened.
            rollback?.invoke()
            message = WRITE_FAILED
            ok = false
        }
        if (mine == seq) _state.update { it.copy(busy = false) }
        return ok
    }

    /**
     * The plate's id, creating it on first use. One create, ever — a rename and an add
     * racing each other share the same in-flight result rather than both POSTing.
     */
    private suspend fun ensureId(): String {
        mealId?.let { return it }
        createInFlight?.let { return it.await().id }

        val pending = CompletableDeferred<MealDTO>()
        createInFlight = pending
        try {
            val created = api.create(displayName, servings)
            mealId = created.id
            _state.update { it.copy(meal = created, groups = PlateRoles.groups(created.recipes)) }
            committedName = created.name
            pending.complete(created)
            return created.id
        } catch (e: Throwable) {
            createInFlight = null
            pending.completeExceptionally(e)
            throw e
        }
    }

    companion object {
        /** The name a plate gets when someone starts adding dishes without naming it. */
        const val NEW_NAME = "New meal"
        const val WRITE_FAILED = "Couldn’t save that — check your connection and try again."

        /** "≈ 1h 15m" for the footer. Hands-on + cooking across the whole plate. */
        fun hoursMinutes(total: Int?): String {
            if (total == null || total <= 0) return "—"
            val h = total / 60
            val m = total % 60
            return when {
                h == 0 -> "${m}m"
                m == 0 -> "${h}h"
                else -> "${h}h ${m}m"
            }
        }
    }
}
