package app.waffled.feature.recipes

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The plate under construction — the Kotlin port of the `MealBuilderModelTests` suite in
 * `apps/ios/Tests/MealBuilderTests.swift`.
 *
 * The three rules that make a builder *look* finished while being broken: a lazy create
 * that fires twice, a servings tap that vanishes into an in-flight create, and a failed
 * write that stays painted on screen.
 */
class MealBuilderModelTest {

    /** A one-shot gate, so a test can hold a "server call" open while starting a second. */
    private class Gate {
        private val opened = CompletableDeferred<Unit>()
        suspend fun wait() = opened.await()
        fun open() {
            opened.complete(Unit)
        }

        val isOpen: Boolean get() = opened.isCompleted
    }

    /**
     * A stand-in plate server. Records every write so a test can assert what the ＋
     * actually sent, and counts creates so the lazy-create-once guard is observable.
     */
    private class FakePlateServer : MealBuilderApi {
        var creates = 0
        val createdNames = mutableListOf<String>()
        val added = mutableListOf<Triple<String, String, String?>>()
        val flattened = mutableListOf<String>()
        val patched = mutableListOf<Pair<String, CookAssignment>>()
        val removed = mutableListOf<String>()
        val updates = mutableListOf<Triple<String?, Int?, Boolean?>>()
        var addedToList = 0
        val scheduled = mutableListOf<Pair<String, String>>()
        val reordered = mutableListOf<List<String>>()

        /** Fail every write (the offline / rollback path). */
        var failing = false

        /** Held open so a test can drive two writes that are genuinely in flight at once. */
        var gate: (suspend () -> Unit)? = null

        var meal: MealDTO = plateFixture(dishes = emptyList())
            private set

        private fun boom(): Nothing = throw IllegalStateException("offline")

        override suspend fun fetch(id: String) = meal

        override suspend fun create(name: String, servings: Int): MealDTO {
            gate?.invoke()
            if (failing) boom()
            creates += 1
            createdNames += name
            meal = plateFixture(name = name, servings = servings)
            return meal
        }

        override suspend fun update(id: String, name: String?, servings: Int?, isSaved: Boolean?): MealDTO {
            if (failing) boom()
            updates += Triple(name, servings, isSaved)
            meal = plateFixture(
                meal.id, name ?: meal.name, servings ?: meal.servings,
                isSaved ?: meal.isSaved, dishes = meal.recipes,
            )
            return meal
        }

        override suspend fun addDish(id: String, recipeId: String, role: String?): MealDTO {
            if (failing) boom()
            added += Triple(id, recipeId, role)
            meal = plateFixture(
                meal.id, meal.name, meal.servings, meal.isSaved,
                dishes = meal.recipes + plateDish(
                    recipeId, recipeId, role = role ?: "side", sortOrder = meal.recipes.size,
                ),
            )
            return meal
        }

        override suspend fun flatten(id: String, savedMealId: String): MealDTO {
            if (failing) boom()
            flattened += savedMealId
            return meal
        }

        override suspend fun patchDish(
            id: String,
            recipeId: String,
            role: String?,
            cook: CookAssignment,
        ): MealDTO {
            if (failing) boom()
            patched += recipeId to cook
            return meal
        }

        override suspend fun removeDish(id: String, recipeId: String): MealDTO {
            if (failing) boom()
            removed += recipeId
            meal = plateFixture(
                meal.id, meal.name, meal.servings, meal.isSaved,
                dishes = meal.recipes.filter { it.recipeId != recipeId },
            )
            return meal
        }

        override suspend fun reorder(id: String, recipeIds: List<String>): MealDTO {
            if (failing) boom()
            reordered += recipeIds
            // sort_order becomes the position in the list, as the server does
            val byId = meal.recipes.associateBy { it.recipeId }
            meal = plateFixture(
                meal.id, meal.name, meal.servings, meal.isSaved,
                dishes = recipeIds.mapIndexedNotNull { i, rid ->
                    byId[rid]?.let { plateDish(it.recipeId, it.title ?: it.recipeId, it.role, i) }
                },
            )
            return meal
        }

        override suspend fun addToList(id: String): Int {
            if (failing) boom()
            addedToList += 1
            return 4
        }

        override suspend fun schedule(id: String, date: String, mealType: String, cookPersonId: String?) {
            if (failing) boom()
            scheduled += date to mealType
        }
    }

    /** The plate is created lazily: opening the builder must not POST an empty meal. */
    @Test
    fun opensWithoutCreatingAPlate() {
        val server = FakePlateServer()
        MealBuilderModel(server)
        assertEquals(0, server.creates)
    }

    /**
     * One create, ever. A fast rename-then-add fires two writes that both need an id;
     * the create must be shared, not raced.
     */
    @Test
    fun renameThenAddCreatesThePlateOnlyOnce() = runTest {
        val server = FakePlateServer()
        val opened = Gate()
        server.gate = { opened.wait() }
        val m = MealBuilderModel(server)
        m.name = "BBQ Sunday"

        val rename = async { m.commitRename() }
        val add = async { m.addRecipe("chicken", PlateRoles.main) }
        opened.open()
        rename.await()
        add.await()

        assertEquals(1, server.creates)
        assertEquals(listOf("BBQ Sunday"), server.createdNames)
        assertEquals(1, server.added.size)
    }

    /**
     * A SERVES tap while the lazy create is still in flight must not vanish.
     *
     * `ensureId` captures the servings it creates with *before* the tap, so the new number
     * was neither sent nor folded in — and nothing re-syncs it, so the bar read 6 while
     * the server held 4 for the rest of the session, including through Schedule and
     * Add-to-list.
     */
    @Test
    fun servingsTappedDuringTheCreateStillReachTheServer() = runTest {
        val server = FakePlateServer()
        val arrived = Gate()
        val opened = Gate()
        // Two gates, not one: `arrived` reports that the create has actually reached the
        // server, `opened` releases it. Without that this is a scheduling race — when the
        // bump runs first there is no create in flight to fold it into.
        server.gate = {
            arrived.open()
            opened.wait()
        }
        val m = MealBuilderModel(server)

        val add = async { m.addRecipe("chicken", PlateRoles.main) }
        arrived.wait()
        assertTrue(arrived.isOpen, "the create never reached the server")
        val bump = async { m.changeServings(6) }
        opened.open()
        add.await()
        bump.await()

        assertEquals(1, server.creates)
        assertEquals(6, m.servings)
        // the PATCH that carries the new number
        assertTrue(server.updates.any { it.second == 6 })
    }

    /**
     * With no plate and no create in flight there is nothing to write — the number rides
     * along on the create that a later add will trigger.
     */
    @Test
    fun servingsOnAnUntouchedPlateStillCreateNothing() = runTest {
        val server = FakePlateServer()
        val m = MealBuilderModel(server)
        m.changeServings(6)
        assertEquals(0, server.creates)
        assertTrue(server.updates.isEmpty())
        m.addRecipe("chicken", PlateRoles.main)
        assertEquals(1, server.creates) // and the create carries it
        assertEquals(6, m.meal?.servings)
    }

    /**
     * Naming nothing still gives the plate a name — the placeholder invites a name rather
     * than making you clear "New meal" first.
     */
    @Test
    fun anUnnamedPlateIsCreatedWithTheDefaultName() = runTest {
        val server = FakePlateServer()
        val m = MealBuilderModel(server)
        m.addRecipe("chicken", PlateRoles.main)
        assertEquals(listOf(MealBuilderModel.NEW_NAME), server.createdNames)
    }

    /**
     * The ＋ carries the role of the group it sits in. Filing everything under Sides is
     * exactly the defect the web shipped ("I can't drag it to Main" was really "＋ ignores
     * where I am"), and an explicit role also avoids the bare re-add that wipes a dish's
     * role, cook and position.
     */
    @Test
    fun addingFromARoleSlotFilesTheDishUnderThatRole() = runTest {
        val server = FakePlateServer()
        val m = MealBuilderModel(server)
        m.addRecipe("chicken", PlateRoles.main)
        m.addRecipe("cobbler", PlateRoles.dessert)
        assertEquals(listOf("main", "dessert"), server.added.map { it.third })
        assertEquals(listOf("main", "dessert"), m.meal?.recipes?.map { it.role })
    }

    /** A saved plate added to the plate under construction FLATTENS — meals never nest. */
    @Test
    fun addingASavedPlateFlattensIt() = runTest {
        val server = FakePlateServer()
        val m = MealBuilderModel(server)
        m.addSavedMeal("saved-plate")
        assertEquals(listOf("saved-plate"), server.flattened)
        assertTrue(server.added.isEmpty())
    }

    /**
     * "Nobody" must clear the cook explicitly — the server distinguishes an absent cook
     * (leave it alone) from an explicit null, so `Unchanged` would silently make
     * un-assigning impossible.
     */
    @Test
    fun pickingNobodyClearsTheCook() = runTest {
        val server = FakePlateServer()
        val m = MealBuilderModel(server)
        m.addRecipe("chicken", PlateRoles.main)
        m.assignCook("chicken", "kevin")
        m.assignCook("chicken", null)
        assertEquals(
            listOf<CookAssignment>(CookAssignment.Person("kevin"), CookAssignment.Clear),
            server.patched.map { it.second },
        )
    }

    /** A drop writes the role AND the plate's whole new order. */
    @Test
    fun applyingADropWritesBothTheRoleAndTheOrder() = runTest {
        val server = FakePlateServer()
        val m = MealBuilderModel(server)
        m.addRecipe("a", PlateRoles.main)
        m.addRecipe("b", PlateRoles.side)
        m.apply(PlateReorder.Move("a", PlateRoles.side, listOf("b", "a")))
        assertEquals("a" to CookAssignment.Unchanged, server.patched.last())
        assertEquals(listOf(listOf("b", "a")), server.reordered)
    }

    /** Removing a dish takes it off the plate the screen repaints from. */
    @Test
    fun removingADishTakesItOffThePlate() = runTest {
        val server = FakePlateServer()
        val m = MealBuilderModel(server)
        m.addRecipe("chicken", PlateRoles.main)
        m.removeDish("chicken")
        assertEquals(listOf("chicken"), server.removed)
        assertTrue(m.isEmpty)
    }

    /**
     * A failed write rolls the optimistic paint back and says so — a rename or a library
     * toggle that stayed on screen after the server rejected it is how the web's
     * silent-failure bug happened.
     */
    @Test
    fun aFailedToggleRollsBackAndReportsIt() = runTest {
        val server = FakePlateServer()
        val m = MealBuilderModel(server)
        m.addRecipe("chicken", PlateRoles.main)
        server.failing = true
        m.toggleSaved()
        assertFalse(m.isSaved)
        assertNotNull(m.message)
    }

    /**
     * A rename that never reached the server must not come back as if it had. The
     * rollback restores the field, but the "last confirmed name" has to stay unconfirmed
     * too — otherwise the next blur repaints the rejected name from it.
     */
    @Test
    fun aFailedRenameOnAFreshPlateDoesNotResurrectTheName() = runTest {
        val server = FakePlateServer()
        server.failing = true
        val m = MealBuilderModel(server)
        m.name = "BBQ Sunday"
        m.commitRename()
        assertEquals(0, server.creates)
        assertTrue(m.name.isEmpty())
        // A second blur on the now-empty field restores the last CONFIRMED name — and
        // nothing was ever confirmed.
        m.commitRename()
        assertTrue(m.name.isEmpty())
    }

    /**
     * Two writes in flight, each answering with the whole plate: the older reply must not
     * repaint over the newer one (it would resurrect a removed dish, and it does not
     * self-heal — nothing refetches).
     */
    @Test
    fun aStaleReplyDoesNotRepaintOverANewerOne() = runTest {
        val server = FakePlateServer()
        val m = MealBuilderModel(server)
        m.addRecipe("chicken", PlateRoles.main)
        m.applyIfCurrent(plateFixture("plate-1", name = "stale"), seq = 0)
        assertTrue(m.meal?.name != "stale")
    }

    /** Adding the plate to the grocery list reports how many rows it actually added. */
    @Test
    fun addingToTheListReportsWhatItAdded() = runTest {
        val server = FakePlateServer()
        val m = MealBuilderModel(server)
        m.addRecipe("chicken", PlateRoles.main)
        m.addToGrocery()
        assertEquals(1, server.addedToList)
        assertTrue(m.message?.contains("4") == true)
    }

    /** An empty plate has nothing to shop for and nothing to schedule. */
    @Test
    fun anEmptyPlateRefusesToShopOrSchedule() = runTest {
        val server = FakePlateServer()
        val m = MealBuilderModel(server)
        m.addToGrocery()
        assertEquals("Add a dish first.", m.message)
        assertEquals(0, server.addedToList)
        assertFalse(m.schedule("2026-08-16", "dinner"))
        assertTrue(server.scheduled.isEmpty())
    }

    /**
     * Scheduling deliberately does NOT repaint from the reply: scheduling a **saved**
     * plate copies it server-side, so what comes back is next week's copy, not this one.
     */
    @Test
    fun schedulingPutsThePlateOnADayAndSlot() = runTest {
        val server = FakePlateServer()
        val m = MealBuilderModel(server)
        m.addRecipe("chicken", PlateRoles.main)
        assertTrue(m.schedule("2026-08-16", "dinner", "kevin"))
        assertEquals(listOf("2026-08-16" to "dinner"), server.scheduled)
    }

    /** Adopting an existing plate seeds every field the screen reads. */
    @Test
    fun adoptingAnExistingPlateSeedsTheScreen() {
        val server = FakePlateServer()
        val existing = plateFixture(
            "m9", name = "Taco Night", servings = 8, isSaved = true,
            dishes = listOf(plateDish("r1", "Tacos", role = "main")),
        )
        val m = MealBuilderModel(server, existing)
        assertEquals("Taco Night", m.name)
        assertEquals(8, m.servings)
        assertTrue(m.isSaved)
        assertEquals(listOf("r1"), m.groups.first().dishes.map { it.recipeId })
    }

    /** Blurring the name field without editing it must not PATCH. */
    @Test
    fun blurringAnUneditedNameWritesNothing() = runTest {
        val server = FakePlateServer()
        val m = MealBuilderModel(server, plateFixture("m9", name = "Taco Night"))
        m.commitRename()
        assertTrue(server.updates.isEmpty())
    }

    /** Clearing the name entirely restores the last confirmed one rather than saving "". */
    @Test
    fun clearingTheNameRestoresTheConfirmedOne() = runTest {
        val server = FakePlateServer()
        val m = MealBuilderModel(server, plateFixture("m9", name = "Taco Night"))
        m.name = "   "
        m.commitRename()
        assertEquals("Taco Night", m.name)
        assertTrue(server.updates.isEmpty())
    }

    @Test
    fun anUnnamedPlateDisplaysThePlaceholderName() {
        val m = MealBuilderModel(FakePlateServer())
        assertEquals(MealBuilderModel.NEW_NAME, m.displayName)
        m.name = "  BBQ  "
        assertEquals("BBQ", m.displayName)
    }

    /** Reloading adopts whatever the server now holds. */
    @Test
    fun reloadingAdoptsTheServersPlate() = runTest {
        val server = FakePlateServer()
        val m = MealBuilderModel(server, plateFixture("plate-1", name = "old"))
        m.reload()
        assertEquals(server.meal.name, m.meal?.name)
    }

    /** With no plate yet there is nothing to reload — and no reason to create one. */
    @Test
    fun reloadingAFreshPlateCreatesNothing() = runTest {
        val server = FakePlateServer()
        val m = MealBuilderModel(server)
        m.reload()
        assertEquals(0, server.creates)
        assertNull(m.meal)
    }
}
