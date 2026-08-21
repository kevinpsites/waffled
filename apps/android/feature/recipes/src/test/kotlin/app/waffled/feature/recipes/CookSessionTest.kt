package app.waffled.feature.recipes

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Cooking a PLATE — a named, multi-recipe meal ("BBQ Sunday" = BBQ Chicken + Potato Salad
 * + Coleslaw + Peach Cobbler) — means cooking several recipes at once: each dish keeps its
 * own place in its own method, and several timers run across different dishes at the same
 * time. That forces three things these tests pin down:
 *
 *  1. a timer is keyed by (dish, step), never by step alone — step 3 of the main and step
 *     3 of the side are different timers with different names;
 *  2. moving between dishes is NOT starting a new session, so it must never cancel the
 *     timers (or the pending notifications) of the dish you just left;
 *  3. a fired timer's notification carries the dish id, so tapping it lands on the dish
 *     that actually beeped.
 *
 * The Kotlin port of `apps/ios/Tests/CookSessionTests.swift`. Two deliberate shape changes
 * from Swift: [CookSession] is **immutable** (the mutators return a new session) so a
 * `StateFlow` of it diffs correctly for Compose, and the notification payload is a plain
 * `Map` so the round-trip is testable on the JVM — `CookTimerAlarm` adapts it to an
 * `Intent` at the edge.
 */
class CookSessionTest {

    // ---- fixtures --------------------------------------------------------------

    private fun step(n: Int, text: String, timer: Int? = null) =
        RecipeStepDTO(stepNumber = n, instruction = text, timerSeconds = timer)

    private fun ingredient(name: String) = RecipeIngredientDTO(id = "ing-$name", name = name)

    private fun dish(id: String, title: String, steps: Int = 4, role: String? = null) = CookDish(
        id = id,
        title = title,
        role = role,
        steps = (1..steps).map { step(it, "$title step $it") },
        ingredients = listOf(ingredient(title)),
    )

    private fun plateSession(
        dishes: List<CookDish>,
        id: String = "plate-1",
        name: String = "BBQ Sunday",
    ) = CookSession.of(plateId = id, title = name, dishes = dishes)!!

    private fun soloSession(d: CookDish) = CookSession.of(null, d.title, listOf(d))!!

    private fun dishDTO(recipeId: String, title: String?, role: String = "side", sortOrder: Int) =
        MealDishDTO(recipeId = recipeId, title = title, role = role, sortOrder = sortOrder)

    private fun mealDTO(dishes: List<MealDishDTO>, id: String = "plate-1", name: String = "BBQ Sunday") =
        MealDTO(
            id = id, name = name, servings = 4, isSaved = true,
            createdAt = "2026-08-01T00:00:00Z", recipeCount = dishes.size, recipes = dishes,
        )

    private fun method(title: String, steps: Int = 3) = CookMethod(
        title = title,
        steps = (1..steps).map { step(it, "$title step $it") },
        ingredients = listOf(ingredient(title)),
    )

    private fun timer(
        dish: String,
        dishTitle: String? = null,
        step: Int,
        number: Int? = null,
        secs: Int = 300,
    ) = CookTimer(
        id = "$dish-$step",
        dishId = dish,
        dishTitle = dishTitle,
        stepIndex = step,
        stepNumber = number ?: (step + 1),
        total = secs,
        fireAtMillis = secs * 1000L,
        running = true,
        firing = false,
        pausedRemaining = secs,
    )

    // ---- the session itself ----------------------------------------------------

    @Test
    fun theFirstDishIsTheOneOnScreen() {
        val s = plateSession(listOf(dish("main", "BBQ Chicken"), dish("side", "Potato Salad")))
        assertEquals("main", s.activeDishId)
        assertEquals("BBQ Chicken", s.activeDish?.title)
        assertTrue(s.isPlate)
    }

    /** A one-dish plate is still a plate — plateId decides, not the dish count. */
    @Test
    fun aOneDishPlateIsStillAPlate() {
        assertTrue(plateSession(listOf(dish("main", "BBQ Chicken"))).isPlate)
        assertFalse(soloSession(dish("r1", "Tacos")).isPlate)
    }

    @Test
    fun aSessionWithNoDishesCannotExist() {
        assertNull(CookSession.of("plate-1", "BBQ Sunday", emptyList()))
    }

    @Test
    fun switchingDishesPreservesEachDishesStep() {
        var s = plateSession(listOf(dish("main", "BBQ Chicken"), dish("side", "Potato Salad")))
        s = s.withIndex(3) // main is on step 4
        s = assertNotNull(s.activate("side"))
        assertEquals(0, s.index) // the side hasn't started
        s = s.withIndex(2) // side is on step 3
        s = assertNotNull(s.activate("main"))
        assertEquals(3, s.index) // …and the main is right where we left it
        s = assertNotNull(s.activate("side"))
        assertEquals(2, s.index)
    }

    @Test
    fun theStepIndexIsClampedToTheActiveDishesOwnMethod() {
        var s = plateSession(
            listOf(dish("main", "BBQ Chicken", steps = 4), dish("dessert", "Peach Cobbler", steps = 2)),
        )
        s = s.withIndex(99)
        assertEquals(3, s.index)
        s = assertNotNull(s.activate("dessert"))
        s = s.withIndex(99)
        assertEquals(1, s.index) // the cobbler only has two steps
        s = s.withIndex(-4)
        assertEquals(0, s.index)
    }

    @Test
    fun activatingADishThatIsNotOnThePlateChangesNothing() {
        val s = plateSession(listOf(dish("main", "BBQ Chicken")))
        assertNull(s.activate("nope"))
        assertEquals("main", s.activeDishId)
        assertFalse(s.contains("nope"))
        assertTrue(s.contains("main"))
    }

    /** Jumping goes to a dish AND that dish's step in one move. */
    @Test
    fun jumpMovesDishAndStep() {
        var s = plateSession(listOf(dish("main", "BBQ Chicken"), dish("side", "Potato Salad")))
        s = assertNotNull(s.jump("side", 2))
        assertEquals("side", s.activeDishId)
        assertEquals(2, s.index)
        // The main is untouched — a jump doesn't rewind the dish you left.
        s = assertNotNull(s.activate("main"))
        assertEquals(0, s.index)
    }

    @Test
    fun aPlateBuildsInSortOrderTakingEachDishesMethod() {
        val meal = mealDTO(
            listOf(
                dishDTO("side", "Potato Salad", sortOrder = 2),
                dishDTO("main", "BBQ Chicken", role = "main", sortOrder = 1),
            ),
        )
        val s = assertNotNull(
            CookSession.plate(
                meal,
                mapOf("main" to method("BBQ Chicken", steps = 5), "side" to method("Potato Salad")),
            ),
        )
        assertEquals(listOf("main", "side"), s.dishes.map { it.id })
        assertEquals("main", s.activeDishId)
        assertEquals("BBQ Sunday", s.title)
        assertEquals("plate-1", s.plateId)
        assertEquals(5, s.dishes.first().steps.size)
        assertEquals("main", s.dishes.first().role)
        assertEquals(1, s.dishes.last().ingredients.size)
    }

    /** A dish whose method didn't load is skipped, not fatal. */
    @Test
    fun aPlateSkipsUnloadableDishes() {
        val meal = mealDTO(
            listOf(
                dishDTO("main", "BBQ Chicken", role = "main", sortOrder = 1),
                dishDTO("side", "Potato Salad", sortOrder = 2),
            ),
        )
        val s = assertNotNull(CookSession.plate(meal, mapOf("side" to method("Potato Salad"))))
        assertEquals(listOf("side"), s.dishes.map { it.id })
        assertEquals("side", s.activeDishId)
    }

    @Test
    fun aPlateWithNothingLoadableIsNoSessionAtAll() {
        val meal = mealDTO(listOf(dishDTO("main", "BBQ Chicken", role = "main", sortOrder = 1)))
        assertNull(CookSession.plate(meal, emptyMap()))
    }

    /** Sorting is stable, so equal sortOrders keep their arrival order. */
    @Test
    fun equalSortOrdersKeepTheirArrivalOrder() {
        val meal = mealDTO(
            listOf(dishDTO("b", "B", sortOrder = 0), dishDTO("a", "A", sortOrder = 0)),
        )
        val s = assertNotNull(
            CookSession.plate(meal, mapOf("a" to method("A"), "b" to method("B"))),
        )
        assertEquals(listOf("b", "a"), s.dishes.map { it.id })
    }

    @Test
    fun aDishWithNoTitleOfItsOwnFallsBackToTheRecipes() {
        val meal = mealDTO(listOf(dishDTO("main", null, role = "main", sortOrder = 1)))
        val s = assertNotNull(CookSession.plate(meal, mapOf("main" to method("BBQ Chicken"))))
        assertEquals("BBQ Chicken", s.dishes.first().title)
    }

    // ---- timers keyed by dish --------------------------------------------------

    @Test
    fun theSameStepNumberOnTwoDishesIsTwoDifferentTimers() {
        val a = timer("main", "BBQ Chicken", step = 2)
        val b = timer("side", "Potato Salad", step = 2)
        assertNotEquals(a.key, b.key)
        assertEquals(CookTimer.Key("main", 2), a.key)
        assertEquals(listOf(b.id), CookSession.timers(listOf(a, b), "side").map { it.id })
    }

    /** A plate's timer names its dish; a lone recipe's just names the step. */
    @Test
    fun aTimerLabelNamesTheDishOnAPlate() {
        val onAPlate = timer("side", "Potato Salad", step = 1, number = 2)
        assertEquals("Step 2", onAPlate.stepLabel)
        assertEquals("Potato Salad · Step 2", onAPlate.label)
        assertEquals("Potato Salad · Step 2 · 5-minute timer", onAPlate.displayName)

        val alone = timer("r1", step = 1, number = 2)
        assertEquals("Step 2", alone.label)
        assertEquals("Step 2 · 5-minute timer", alone.displayName)
    }

    @Test
    fun namesADurationInWholeMinutesSecondsOrMmss() {
        assertEquals("Step 1 · 30-second timer", timer("r", step = 0, number = 1, secs = 30).displayName)
        assertEquals("Step 1 · 1:30 timer", timer("r", step = 0, number = 1, secs = 90).displayName)
        assertEquals("0:05", CookTimer.mmss(5))
        assertEquals("10:00", CookTimer.mmss(600))
        assertEquals("0:00", CookTimer.mmss(-9))
    }

    // ---- counting down across process death ------------------------------------

    /**
     * A running timer counts off an **absolute wall-clock instant**, never an in-memory
     * coroutine, so it stays correct across backgrounding and across the process being
     * killed and restarted. The clock is a parameter precisely so that is testable.
     */
    @Test
    fun aRunningTimerCountsOffTheWallClock() {
        val t = timer("r", step = 0, secs = 600).copy(fireAtMillis = 1_000_000L)
        assertEquals(600, t.remaining(400_000L))
        assertEquals(60, t.remaining(940_000L))
        // Past its instant, and long past it, it is simply zero — never negative.
        assertEquals(0, t.remaining(1_000_000L))
        assertEquals(0, t.remaining(9_000_000L))
    }

    /** A paused timer reads the frozen value, whatever the clock has done since. */
    @Test
    fun aPausedTimerIgnoresTheClock() {
        val t = timer("r", step = 0, secs = 600)
            .copy(running = false, pausedRemaining = 125, fireAtMillis = 0L)
        assertEquals(125, t.remaining(9_000_000L))
    }

    /** Resuming re-anchors the instant from what was left, not from the original total. */
    @Test
    fun resumingReAnchorsFromWhatWasLeft() {
        val paused = timer("r", step = 0, secs = 600).copy(running = false, pausedRemaining = 90)
        val resumed = paused.resumed(now = 5_000L)
        assertTrue(resumed.running)
        assertEquals(95_000L, resumed.fireAtMillis)
        assertEquals(90, resumed.remaining(5_000L))
    }

    @Test
    fun pausingFreezesWhatWasLeft() {
        val running = timer("r", step = 0, secs = 600).copy(fireAtMillis = 100_000L)
        val paused = running.paused(now = 40_000L)
        assertFalse(paused.running)
        assertEquals(60, paused.pausedRemaining)
    }

    /** "+1:00" pushes the instant out and never resurrects a fired timer's alarm. */
    @Test
    fun addingAMinutePushesTheInstantOut() {
        val t = timer("r", step = 0, secs = 60).copy(fireAtMillis = 60_000L, firing = true)
        val more = t.plusMinute(now = 60_000L)
        assertEquals(120_000L, more.fireAtMillis)
        assertFalse(more.firing)
        assertTrue(more.running)
    }

    /** A paused timer's "+1:00" moves the frozen value, not the clock. */
    @Test
    fun addingAMinuteToAPausedTimerMovesTheFrozenValue() {
        val t = timer("r", step = 0, secs = 600).copy(running = false, pausedRemaining = 30)
        assertEquals(90, t.plusMinute(now = 0L).pausedRemaining)
    }

    /** Only a RUNNING timer whose instant has passed is ringing. */
    @Test
    fun onlyARunningTimerPastItsInstantIsRinging() {
        val running = timer("r", step = 0, secs = 60).copy(fireAtMillis = 60_000L)
        assertFalse(running.hasElapsed(59_000L))
        assertTrue(running.hasElapsed(60_000L))
        assertFalse(running.copy(running = false).hasElapsed(99_000L))
        // Already ringing is not "newly elapsed" — the alarm fires once.
        assertFalse(running.copy(firing = true).hasElapsed(99_000L))
    }

    // ---- the notification round-trip -------------------------------------------

    @Test
    fun theDishAndItsPlateRoundTripThroughTheNotificationPayload() {
        val link = CookTimerLink("side", 2, "plate-1")
        val info = link.payload(timerId = "waffled.cook.abc")
        assertEquals("waffled.cook.abc", info[CookTimerLink.KEY_TIMER])
        assertEquals(link, CookTimerLink.from(info))
    }

    @Test
    fun aLoneRecipeRoundTripsWithNoPlate() {
        val link = CookTimerLink("r1", 0, null)
        assertEquals(link, CookTimerLink.from(link.payload("t")))
    }

    /** A payload from before plates (recipe id only) still deep-links. */
    @Test
    fun aLegacyPayloadStillDecodes() {
        val info = mapOf<String, Any?>(
            "cookRecipeId" to "r1",
            "cookStepIndex" to 3,
            "cookTimerId" to "t",
        )
        assertEquals(CookTimerLink("r1", 3, null), CookTimerLink.from(info))
    }

    /** Someone else's notification is not a cook timer. */
    @Test
    fun aForeignPayloadIsIgnored() {
        assertNull(CookTimerLink.from(mapOf("eventId" to "e1")))
    }
}
