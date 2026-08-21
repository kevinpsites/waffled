package app.waffled.feature.recipes

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Switching dishes is not starting a session — the Kotlin port of the
 * `CookSessionStoreTests` suite in `apps/ios/Tests/CookSessionTests.swift`, plus the
 * Android-only cases for the two things this platform has to prove for itself: that a
 * timer survives the **process** dying, and that every schedule/cancel actually reaches
 * the alarm.
 */
class CookSessionStoreTest {

    // ---- fakes -----------------------------------------------------------------

    private class FakeAlarm : CookAlarm {
        val scheduled = mutableListOf<Pair<String, CookTimerLink>>()
        val cancelled = mutableListOf<String>()
        var stopped = 0

        override fun schedule(timer: CookTimer, link: CookTimerLink) {
            scheduled += timer.id to link
        }

        override fun cancel(timerId: String) {
            cancelled += timerId
        }

        override fun stop() {
            stopped += 1
        }
    }

    private class FakeCookApi(
        val details: Map<String, RecipeDetailDTO> = emptyMap(),
        val meals: Map<String, MealDTO> = emptyMap(),
    ) : CookApi {
        val cooked = mutableListOf<String>()
        var matches: List<RecipeMatch> = emptyList()

        override suspend fun recipeDetail(id: String) =
            details[id] ?: error("no such recipe $id")

        override suspend fun meal(id: String) = meals[id] ?: error("no such meal $id")

        override suspend fun markCooked(id: String) {
            cooked += id
        }

        override suspend fun pantryForRecipe(recipeId: String) = matches
    }

    /** A clock the test moves by hand. */
    private class FakeClock(var millis: Long = 0L) {
        operator fun invoke(): Long = millis
    }

    // ---- fixtures --------------------------------------------------------------

    private fun step(n: Int, text: String, timer: Int? = null) =
        RecipeStepDTO(stepNumber = n, instruction = text, timerSeconds = timer)

    private fun dish(id: String, title: String, steps: Int = 4, role: String? = null) = CookDish(
        id = id,
        title = title,
        role = role,
        steps = (1..steps).map { step(it, "$title step $it") },
        ingredients = listOf(RecipeIngredientDTO(id = "ing-$title", name = title)),
    )

    private var timerSeq = 0
    private val alarm = FakeAlarm()
    private val clock = FakeClock()
    private val persistence = InMemoryCookStateStore()

    private fun store(api: CookApi = FakeCookApi()) = CookSessionStore(
        api = api,
        alarm = alarm,
        persistence = persistence,
        now = clock::invoke,
        newTimerId = { "t${++timerSeq}" },
    )

    private fun plateStore(api: CookApi = FakeCookApi()): CookSessionStore {
        val s = store(api)
        s.start(
            CookSession.of(
                "plate-1", "BBQ Sunday",
                listOf(dish("main", "BBQ Chicken", role = "main"), dish("side", "Potato Salad", role = "side")),
            )!!,
        )
        return s
    }

    // ---- the iOS suite ---------------------------------------------------------

    @Test
    fun timersSurviveADishSwitch() {
        val store = plateStore()
        val t = assertNotNull(store.startTimer(secs = 600, stepIndex = 2, stepNumber = 3))
        assertEquals("main", t.dishId)
        assertEquals("BBQ Chicken", t.dishTitle) // a plate's timers name their dish

        store.switchToDish("side")

        assertEquals("side", store.activeDishId)
        assertEquals(1, store.timers.size)
        assertEquals(t.id, store.timers.first().id)
        assertTrue(store.timers.first().running)
        assertTrue(alarm.cancelled.isEmpty())
    }

    @Test
    fun timersAccumulateAcrossDishesAndTheDockCanTellThemApart() {
        val store = plateStore()
        store.startTimer(600, stepIndex = 2, stepNumber = 3)
        store.switchToDish("side")
        store.startTimer(300, stepIndex = 2, stepNumber = 3) // same step, other dish

        assertEquals(2, store.timers.size)
        assertEquals(2, store.timers.map { it.key }.toSet().size)
        assertEquals(1, store.dishTimers("main").size)
        assertEquals("Potato Salad", store.dishTimers("side").first().dishTitle)
    }

    /** Cooking a recipe that's already on the plate switches to it, plate intact. */
    @Test
    fun cookingAPlateDishSwitchesInsteadOfReplacing() {
        val store = plateStore()
        store.startTimer(600, stepIndex = 1, stepNumber = 2)

        // What the recipe detail's Cook button does — with a recipe already on the plate.
        store.start("side", "Potato Salad", listOf(step(1, "Boil"), step(2, "Chop")), emptyList())

        assertTrue(store.isPlate) // still cooking the whole plate
        assertEquals(2, store.dishes.size)
        assertEquals("side", store.activeDishId)
        assertEquals(1, store.timers.size) // …and the main's timer is untouched
    }

    @Test
    fun cookingAnUnrelatedRecipeReplacesTheSessionAndDropsItsTimers() {
        val store = plateStore()
        val t = assertNotNull(store.startTimer(600, stepIndex = 1, stepNumber = 2))

        store.start("other", "Pancakes", listOf(step(1, "Whisk")), emptyList())

        assertFalse(store.isPlate)
        assertEquals(listOf("other"), store.dishes.map { it.id })
        assertTrue(store.timers.isEmpty())
        // and the dropped timer's pending alert really went with it
        assertTrue(alarm.cancelled.contains(t.id))
    }

    @Test
    fun reTappingTheRecipeAlreadyCookingKeepsItsTimersAndItsStep() {
        val store = store()
        val steps = listOf(step(1, "a"), step(2, "b"), step(3, "c"))
        store.start("r1", "Tacos", steps, emptyList())
        store.index = 2
        store.startTimer(60, stepIndex = 2, stepNumber = 3)

        store.start("r1", "Tacos", steps, emptyList())

        assertEquals(2, store.index)
        assertEquals(1, store.timers.size)
    }

    @Test
    fun aLoneRecipesTimersDoNotCarryADishName() {
        val store = store()
        store.start("r1", "Tacos", listOf(step(1, "a")), emptyList())
        val t = assertNotNull(store.startTimer(60, stepIndex = 0, stepNumber = 1))
        assertNull(t.dishTitle)
        assertEquals("Step 1", t.label)
    }

    @Test
    fun endingTheSessionCancelsEveryDishesTimers() {
        val store = plateStore()
        store.startTimer(600, stepIndex = 1, stepNumber = 2)
        store.switchToDish("side")
        store.startTimer(600, stepIndex = 1, stepNumber = 2)
        assertEquals(2, store.timers.size)

        store.end()

        assertTrue(store.timers.isEmpty())
        assertFalse(store.isActive)
        assertTrue(store.dishes.isEmpty())
        assertEquals(2, alarm.cancelled.size)
        assertEquals(1, alarm.stopped)
    }

    /** Tapping another dish's timer jumps to THAT dish's step. */
    @Test
    fun jumpingToATimerMovesItsOwnDish() {
        val store = plateStore()
        val t = assertNotNull(store.startTimer(600, stepIndex = 2, stepNumber = 3))
        store.switchToDish("side")
        store.index = 1

        store.jump(t)

        assertEquals("main", store.activeDishId)
        assertEquals(2, store.index)
        // The side kept its own place rather than being dragged to step 3.
        store.switchToDish("side")
        assertEquals(1, store.index)
    }

    /** A fired timer's notification reopens its dish at its step. */
    @Test
    fun aNotificationOpensTheRightDish() = runTest {
        val store = plateStore()
        store.index = 3

        store.openFromNotification(CookTimerLink("side", 2, "plate-1"))

        assertEquals("side", store.activeDishId)
        assertEquals(2, store.index)
        assertTrue(store.isPlate)
    }

    /** A notification for a dish we aren't cooking re-fetches its whole plate. */
    @Test
    fun aNotificationForAnUnloadedPlateFetchesIt() = runTest {
        val meal = MealDTO(
            id = "plate-9", name = "Taco Night",
            recipes = listOf(MealDishDTO("r1", "Tacos", role = "main", sortOrder = 0)),
        )
        val api = FakeCookApi(
            details = mapOf(
                "r1" to RecipeDetailDTO(
                    recipe = RecipeSummary("r1", "Tacos"),
                    steps = listOf(step(1, "a"), step(2, "b"), step(3, "c")),
                ),
            ),
            meals = mapOf("plate-9" to meal),
        )
        val store = store(api)

        store.openFromNotification(CookTimerLink("r1", 2, "plate-9"))

        assertEquals("plate-9", store.session?.plateId)
        assertEquals("r1", store.activeDishId)
        assertEquals(2, store.index)
    }

    /** With no plate named, the single recipe is fetched instead. */
    @Test
    fun aNotificationForALoneRecipeFetchesJustThatRecipe() = runTest {
        val api = FakeCookApi(
            details = mapOf(
                "r1" to RecipeDetailDTO(
                    recipe = RecipeSummary("r1", "Tacos"),
                    steps = listOf(step(1, "a"), step(2, "b")),
                ),
            ),
        )
        val store = store(api)

        store.openFromNotification(CookTimerLink("r1", 1, null))

        assertFalse(store.isPlate)
        assertEquals("r1", store.activeDishId)
        assertEquals(1, store.index)
    }

    // ---- starting a plate ------------------------------------------------------

    @Test
    fun startingAPlateFetchesEveryDishesMethod() = runTest {
        val meal = MealDTO(
            id = "plate-9", name = "BBQ Sunday",
            recipes = listOf(
                MealDishDTO("side", "Potato Salad", role = "side", sortOrder = 2),
                MealDishDTO("main", "BBQ Chicken", role = "main", sortOrder = 1),
            ),
        )
        val api = FakeCookApi(
            details = mapOf(
                "main" to RecipeDetailDTO(RecipeSummary("main", "BBQ Chicken"), steps = listOf(step(1, "a"))),
                "side" to RecipeDetailDTO(RecipeSummary("side", "Potato Salad"), steps = listOf(step(1, "b"))),
            ),
            meals = mapOf("plate-9" to meal),
        )
        val store = store(api)
        store.startPlate(meal)
        assertEquals(listOf("main", "side"), store.dishes.map { it.id })
    }

    /** Re-starting the plate already cooking keeps its timers and per-dish progress. */
    @Test
    fun reStartingTheSamePlateIsANoOp() = runTest {
        val store = plateStore()
        val t = assertNotNull(store.startTimer(600, stepIndex = 1, stepNumber = 2))
        store.startPlate(MealDTO(id = "plate-1", name = "BBQ Sunday"))
        assertEquals(listOf(t.id), store.timers.map { it.id })
        assertEquals(2, store.dishes.size)
    }

    // ---- getting back ----------------------------------------------------------

    @Test
    fun theStoreOffersTheWayBackAfterATimerJump() {
        val store = plateStore()
        store.index = 3
        val t = assertNotNull(store.startTimer(600, stepIndex = 1, stepNumber = 2))
        store.switchToDish("side")
        store.index = 2
        store.jump(t)

        assertEquals("Potato Salad", store.pendingReturnTitle)
        assertEquals("side", store.pendingReturn?.dishId)
        assertEquals(2, store.pendingReturn?.step)
        store.goBack()
        assertEquals("side", store.activeDishId)
        assertEquals(2, store.index)
        assertNull(store.pendingReturn)
    }

    @Test
    fun dismissingTheOfferLeavesYouWhereYouAre() {
        val store = plateStore()
        store.index = 3
        val t = assertNotNull(store.startTimer(600, stepIndex = 1, stepNumber = 2))
        store.switchToDish("side")
        store.jump(t)
        store.dismissReturn()
        assertNull(store.pendingReturn)
        assertEquals("main", store.activeDishId)
    }

    // ---- surviving the process dying (Android-only) ----------------------------

    /**
     * The behaviour the whole feature turns on: an in-memory coroutine dies with the
     * process, so a timer has to be an absolute instant on disk. Kill the store, build a
     * fresh one over the same persistence, and the timer must come back counting from the
     * wall clock — not restarted, not lost.
     */
    @Test
    fun aTimerSurvivesTheProcessBeingKilled() {
        clock.millis = 1_000_000L
        val first = plateStore()
        val t = assertNotNull(first.startTimer(secs = 600, stepIndex = 2, stepNumber = 3))
        assertEquals(1_600_000L, t.fireAtMillis)

        // …the process dies. Four minutes pass. A new store comes up over the same disk.
        clock.millis = 1_240_000L
        val revived = store()
        revived.restore()

        assertEquals("BBQ Sunday", revived.title)
        assertEquals("main", revived.activeDishId)
        val back = revived.timers.single()
        assertEquals(t.id, back.id)
        assertEquals(360, back.remaining(clock.millis)) // six of the ten minutes left
        assertFalse(back.firing)
    }

    /** A timer that came due while the app was dead comes back already ringing. */
    @Test
    fun aTimerThatFiredWhileTheAppWasDeadComesBackRinging() {
        clock.millis = 1_000_000L
        plateStore().startTimer(secs = 60, stepIndex = 0, stepNumber = 1)

        clock.millis = 5_000_000L
        val revived = store()
        revived.restore()

        assertTrue(revived.timers.single().firing)
        assertEquals(0, revived.timers.single().remaining(clock.millis))
    }

    /** Each dish's own place survives too — that is what makes a plate resumable. */
    @Test
    fun everyDishesStepSurvivesTheProcessBeingKilled() {
        val first = plateStore()
        first.index = 3
        first.switchToDish("side")
        first.index = 2

        val revived = store()
        revived.restore()

        assertEquals("side", revived.activeDishId)
        assertEquals(2, revived.index)
        revived.switchToDish("main")
        assertEquals(3, revived.index)
    }

    /** Ending Cook Mode clears the disk too — a finished cook must not come back. */
    @Test
    fun endingClearsWhatWasSaved() {
        val store = plateStore()
        store.startTimer(600, stepIndex = 0, stepNumber = 1)
        store.end()

        val revived = store()
        revived.restore()
        assertFalse(revived.isActive)
        assertTrue(revived.timers.isEmpty())
    }

    /** Nothing saved is simply nothing to restore. */
    @Test
    fun restoringWithNothingSavedDoesNothing() {
        val revived = store()
        revived.restore()
        assertFalse(revived.isActive)
    }

    // ---- pause / resume / +1:00 ------------------------------------------------

    @Test
    fun pausingCancelsThePendingAlertAndResumingRebooksIt() {
        clock.millis = 0L
        val store = plateStore()
        val t = assertNotNull(store.startTimer(600, stepIndex = 0, stepNumber = 1))
        assertEquals(listOf(t.id), alarm.scheduled.map { it.first })

        store.pauseTimer(store.timers.single())
        assertFalse(store.timers.single().running)
        assertTrue(alarm.cancelled.contains(t.id))

        clock.millis = 120_000L
        store.resumeTimer(store.timers.single())
        val resumed = store.timers.single()
        assertTrue(resumed.running)
        // The full ten minutes are still left — pausing froze it, it didn't keep running.
        assertEquals(600, resumed.remaining(clock.millis))
        assertEquals(2, alarm.scheduled.size)
    }

    @Test
    fun addingAMinuteRebooksTheAlertAndStopsTheRinging() {
        clock.millis = 0L
        val store = plateStore()
        store.startTimer(60, stepIndex = 0, stepNumber = 1)
        clock.millis = 60_000L
        assertTrue(store.tick())
        assertTrue(store.timers.single().firing)

        store.addMinute(store.timers.single())
        assertFalse(store.timers.single().firing)
        assertEquals(60, store.timers.single().remaining(clock.millis))
    }

    /** The ticker only reports a change when something actually came due. */
    @Test
    fun tickingWithNothingDueChangesNothing() {
        clock.millis = 0L
        val store = plateStore()
        store.startTimer(600, stepIndex = 0, stepNumber = 1)
        clock.millis = 59_000L
        assertFalse(store.tick())
        assertFalse(store.timers.single().firing)
    }

    /** The alarm carries the dish AND its plate, so a tap re-opens the whole plate. */
    @Test
    fun theScheduledAlertNamesTheDishAndItsPlate() {
        val store = plateStore()
        store.switchToDish("side")
        store.startTimer(600, stepIndex = 1, stepNumber = 2)
        val (_, link) = alarm.scheduled.single()
        assertEquals(CookTimerLink("side", 1, "plate-1"), link)
    }

    @Test
    fun removingATimerDropsItsPendingAlert() {
        val store = plateStore()
        val t = assertNotNull(store.startTimer(600, stepIndex = 0, stepNumber = 1))
        store.removeTimer(t)
        assertTrue(store.timers.isEmpty())
        assertEquals(listOf(t.id), alarm.cancelled)
    }

    /** With nothing cooking there is no dish to hang a timer on. */
    @Test
    fun aTimerNeedsSomethingToBeCooking() {
        assertNull(store().startTimer(600, stepIndex = 0, stepNumber = 1))
    }

    // ---- finishing -------------------------------------------------------------

    /**
     * Finishing records the cook of the dish on screen by id — independent of any screen
     * that may already be torn down — and offers the pantry reconcile only when the server
     * actually matched something.
     */
    @Test
    fun finishingMarksTheDishOnScreenCookedAndOffersTheReconcile() = runTest {
        val api = FakeCookApi()
        api.matches = listOf(RecipeMatch(id = "p1", name = "Beef", suggested = "used_up"))
        val store = plateStore(api)
        store.switchToDish("side")

        store.finish()

        assertEquals(listOf("side"), api.cooked)
        assertFalse(store.isActive)
        assertEquals("Potato Salad", store.pendingPantryReconcile.value?.title)
        store.clearPantryReconcile()
        assertNull(store.pendingPantryReconcile.value)
    }

    /** No matches (or the pantry module off) ⇒ no sheet at all. */
    @Test
    fun finishingWithNoPantryMatchesOffersNothing() = runTest {
        val api = FakeCookApi()
        val store = plateStore(api)
        store.finish()
        assertEquals(listOf("main"), api.cooked)
        assertNull(store.pendingPantryReconcile.value)
    }

    /** Finishing with nothing cooking just closes. */
    @Test
    fun finishingAnEmptySessionJustCloses() = runTest {
        val api = FakeCookApi()
        val store = store(api)
        store.finish()
        assertFalse(store.isActive)
        assertTrue(api.cooked.isEmpty())
    }
}
