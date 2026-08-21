package app.waffled.feature.pantry

import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The pantry view-model: what gets derived once per load, and how the list is filtered
 * and sorted afterwards.
 *
 * The two things worth guarding here are the **allergen union** (a household avoid-list
 * ∪ every member's own allergens — get it wrong and someone isn't warned) and the fact
 * that every per-row derived value, `daysToExpiry` above all, is computed at load and
 * only looked up afterwards. On iOS, doing that date math inside the sort comparator
 * janked on every search keystroke.
 */
class PantryModelTest {

    private val harness = ApiTestHarness()
    private val zone: ZoneId = ZoneId.of("America/New_York")
    private val today = LocalDate.of(2026, 8, 21)
    private lateinit var client: HttpClient
    private lateinit var bus: RefreshBus
    private lateinit var model: PantryModel

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        bus = RefreshBus()
        model = PantryModel(
            api = PantryApi(client, harness.tokens),
            baseUrl = harness.baseUrl(),
            zone = zone,
            refreshBus = bus,
            clock = { today },
        )
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    // ---- fixtures --------------------------------------------------------------------

    private fun payload(
        items: String,
        locations: String = """["Freezer","Fridge","Pantry"]""",
        avoid: String = "[]",
        people: String = "{}",
        lowThreshold: String = "1.0",
        staleMonths: String = "6.0",
        showOnToday: String = "true",
    ) = """
        {"items":$items,"locations":$locations,"showOnToday":$showOnToday,
         "avoidAllergens":$avoid,"allergenPeople":$people,"lowThreshold":$lowThreshold,
         "locationIcons":{"Fridge":"🧊"},"staleMonths":$staleMonths}
    """.trimIndent()

    private fun item(
        id: String,
        name: String,
        amount: String = "2",
        location: String = "Pantry",
        expiresOn: String? = null,
        addedOn: String? = null,
        usedUp: Boolean = false,
        allergens: String? = null,
        lowAt: String? = null,
        isMeal: Boolean = false,
        brand: String? = null,
        createdAt: String? = null,
        imageUrl: String? = null,
    ) = buildString {
        append("""{"id":"$id","name":"$name","amount":"$amount","unit":"","location":"$location",""")
        append(""""note":"","usedUp":$usedUp,"isMeal":$isMeal""")
        expiresOn?.let { append(""","expiresOn":"$it"""") }
        addedOn?.let { append(""","addedOn":"$it"""") }
        allergens?.let { append(""","allergens":$it""") }
        lowAt?.let { append(""","lowAt":$it""") }
        brand?.let { append(""","brand":"$it"""") }
        createdAt?.let { append(""","createdAt":"$it"""") }
        imageUrl?.let { append(""","imageUrl":"$it"""") }
        append("}")
    }

    private suspend fun load(body: String) {
        harness.enqueueJson(body)
        model.load()
    }

    // ---- the allergen union ------------------------------------------------------------

    @Test
    fun `the avoid-set unions the household list with every member's allergens`() = runTest {
        load(
            payload(
                items = "[]",
                avoid = """["gluten"]""",
                people = """{"peanut":["Jerry"],"milk":["Elaine"]}""",
            ),
        )

        assertEquals(setOf("gluten", "peanut", "milk"), model.avoidSet)
    }

    @Test
    fun `a per-person allergen flags an item even with an empty household avoid-list`() = runTest {
        // The override bug: no declared avoid-list, but a kid with a peanut allergy.
        load(
            payload(
                items = "[${item("i1", "Peanut butter", allergens = """["peanut"]""")}]",
                avoid = "[]",
                people = """{"peanut":["Jerry"]}""",
            ),
        )

        val row = model.rows.single()
        assertEquals(listOf("peanut"), row.flagged)
        assertEquals(listOf("Jerry"), row.affects)
    }

    @Test
    fun `an allergen nobody in the household reacts to is carried but not flagged`() = runTest {
        load(
            payload(
                items = "[${item("i1", "Yogurt", allergens = """["milk"]""")}]",
                avoid = """["gluten"]""",
                people = """{"peanut":["Jerry"]}""",
            ),
        )

        val row = model.rows.single()
        assertEquals(listOf("milk"), row.item.allergens)
        assertTrue(row.flagged.isEmpty())
        assertTrue(row.affects.isEmpty())
    }

    @Test
    fun `affects names everyone the flagged allergens touch, once each`() = runTest {
        load(
            payload(
                items = "[${item("i1", "Trail mix", allergens = """["peanut","milk"]""")}]",
                avoid = "[]",
                people = """{"peanut":["Jerry","Elaine"],"milk":["Elaine"]}""",
            ),
        )

        assertEquals(listOf("Elaine", "Jerry"), model.rows.single().affects)
    }

    // ---- expiry derivation, computed once per load ----------------------------------------

    @Test
    fun `daysToExpiry is derived at load, relative to the household's today`() = runTest {
        load(
            payload(
                items = """[
                    ${item("past", "Milk", expiresOn = "2026-08-19")},
                    ${item("today", "Cream", expiresOn = "2026-08-21")},
                    ${item("soon", "Yogurt", expiresOn = "2026-08-24")},
                    ${item("later", "Rice", expiresOn = "2026-12-01")},
                    ${item("none", "Flour")}
                ]""",
            ),
        )

        val byId = model.rows.associateBy { it.id }
        assertEquals(-2, byId.getValue("past").daysToExpiry)
        assertEquals(0, byId.getValue("today").daysToExpiry)
        assertEquals(3, byId.getValue("soon").daysToExpiry)
        assertEquals(102, byId.getValue("later").daysToExpiry)
        // No best-by date is NOT "expires today".
        assertNull(byId.getValue("none").daysToExpiry)
    }

    @Test
    fun `use-soon is three days or fewer, including already past`() = runTest {
        load(
            payload(
                items = """[
                    ${item("past", "Milk", expiresOn = "2026-08-19")},
                    ${item("soon", "Yogurt", expiresOn = "2026-08-24")},
                    ${item("later", "Rice", expiresOn = "2026-08-25")},
                    ${item("none", "Flour")}
                ]""",
            ),
        )

        val byId = model.rows.associateBy { it.id }
        assertTrue(byId.getValue("past").isSoon)
        assertTrue(byId.getValue("soon").isSoon)
        assertFalse(byId.getValue("later").isSoon)
        assertFalse(byId.getValue("none").isSoon)
    }

    @Test
    fun `the expiry label and tone are precomputed, not recomputed per frame`() = runTest {
        load(
            payload(
                items = """[
                    ${item("past", "Milk", expiresOn = "2026-08-19")},
                    ${item("today", "Cream", expiresOn = "2026-08-21")},
                    ${item("one", "Yogurt", expiresOn = "2026-08-22")},
                    ${item("later", "Rice", expiresOn = "2026-12-01")}
                ]""",
            ),
        )

        val byId = model.rows.associateBy { it.id }
        assertEquals("Expired", byId.getValue("past").expiryLabel)
        assertEquals(ExpiryTone.Danger, byId.getValue("past").expiryTone)
        assertEquals("Today", byId.getValue("today").expiryLabel)
        assertEquals(ExpiryTone.Warn, byId.getValue("today").expiryTone)
        // Singular, not "1 days".
        assertEquals("1 day", byId.getValue("one").expiryLabel)
        assertEquals("1 day left", byId.getValue("one").expiryLabelLong)
        assertEquals("Dec 1", byId.getValue("later").expiryLabel)
        assertEquals(ExpiryTone.Plain, byId.getValue("later").expiryTone)
    }

    @Test
    fun `days on hand and the been-a-while flag come off the household threshold`() = runTest {
        load(
            payload(
                items = """[
                    ${item("old", "Cumin", addedOn = "2025-08-20")},
                    ${item("fresh", "Bread", addedOn = "2026-08-14")},
                    ${item("undated", "Salt")}
                ]""",
                staleMonths = "6.0",
            ),
        )

        val byId = model.rows.associateBy { it.id }
        assertEquals(366, byId.getValue("old").daysOnHand)
        assertTrue(byId.getValue("old").isOld)
        assertEquals("1 yr", byId.getValue("old").ageLabel)
        assertEquals(7, byId.getValue("fresh").daysOnHand)
        assertFalse(byId.getValue("fresh").isOld)
        // Nothing to measure from — an item with no added-date is never "been a while".
        assertNull(byId.getValue("undated").daysOnHand)
        assertFalse(byId.getValue("undated").isOld)
    }

    // ---- running low -----------------------------------------------------------------------

    @Test
    fun `running low uses the item's own threshold, falling back to the household's`() = runTest {
        load(
            payload(
                items = """[
                    ${item("low", "Milk", amount = "1")},
                    ${item("fine", "Rice", amount = "4")},
                    ${item("ownThreshold", "Nappies", amount = "3", lowAt = "5")},
                    ${item("text", "Flour", amount = "a pinch")}
                ]""",
                lowThreshold = "1.0",
            ),
        )

        val byId = model.rows.associateBy { it.id }
        assertTrue(byId.getValue("low").isLow)
        assertFalse(byId.getValue("fine").isLow)
        assertTrue(byId.getValue("ownThreshold").isLow)
        // Free text isn't a count, so it can't be "low".
        assertFalse(byId.getValue("text").isLow)
    }

    // ---- sections ----------------------------------------------------------------------------

    @Test
    fun `an item in an unconfigured place is bucketed as Other`() = runTest {
        load(
            payload(
                items = """[
                    ${item("a", "Peas", location = "Freezer")},
                    ${item("b", "Bolts", location = "Garage shelf")}
                ]""",
            ),
        )

        val byId = model.rows.associateBy { it.id }
        assertEquals("Freezer", byId.getValue("a").section)
        assertEquals(PantrySections.OTHER, byId.getValue("b").section)
    }

    // ---- filtering, searching, sorting ---------------------------------------------------------

    @Test
    fun `search matches the name or the brand, and ignores case`() = runTest {
        load(
            payload(
                items = """[
                    ${item("a", "Greek yogurt", brand = "Fage")},
                    ${item("b", "Rice")}
                ]""",
            ),
        )

        assertEquals(listOf("a"), model.shown(query = "FAGE").map { it.id })
        assertEquals(listOf("a"), model.shown(query = "yog").map { it.id })
        assertTrue(model.shown(query = "zzz").isEmpty())
    }

    @Test
    fun `used-up items are kept out of the on-hand list and get their own bucket`() = runTest {
        load(
            payload(
                items = """[
                    ${item("on", "Rice")},
                    ${item("off", "Milk", usedUp = true)}
                ]""",
            ),
        )

        assertEquals(listOf("on"), model.shown().map { it.id })
        assertEquals(listOf("off"), model.usedUp().map { it.id })
    }

    @Test
    fun `each filter narrows to its own group`() = runTest {
        load(
            payload(
                items = """[
                    ${item("soon", "Yogurt", expiresOn = "2026-08-22")},
                    ${item("low", "Milk", amount = "1")},
                    ${item("old", "Cumin", addedOn = "2025-08-21")},
                    ${item("fridge", "Butter", amount = "5", location = "Fridge")}
                ]""",
            ),
        )

        assertEquals(listOf("soon"), model.shown(filter = PantryFilter.UseSoon).map { it.id })
        assertEquals(listOf("low"), model.shown(filter = PantryFilter.RunningLow).map { it.id })
        assertEquals(listOf("old"), model.shown(filter = PantryFilter.BeenAWhile).map { it.id })
        assertEquals(
            listOf("fridge"),
            model.shown(filter = PantryFilter.Location("Fridge")).map { it.id },
        )
    }

    @Test
    fun `counts drive the filter chips, over on-hand items only`() = runTest {
        load(
            payload(
                items = """[
                    ${item("soon", "Yogurt", expiresOn = "2026-08-22", location = "Fridge")},
                    ${item("low", "Milk", amount = "1", location = "Fridge")},
                    ${item("old", "Cumin", addedOn = "2025-08-21")},
                    ${item("gone", "Bread", usedUp = true)}
                ]""",
            ),
        )

        val counts = model.counts()
        assertEquals(3, counts.all)
        assertEquals(1, counts.useSoon)
        assertEquals(1, counts.runningLow)
        assertEquals(1, counts.beenAWhile)
        assertEquals(2, counts.byLocation["Fridge"])
        assertEquals(1, counts.byLocation["Pantry"])
    }

    @Test
    fun `the expiring sort puts dated items first, soonest first, then names`() = runTest {
        load(
            payload(
                items = """[
                    ${item("noDateB", "Bananas")},
                    ${item("late", "Rice", expiresOn = "2026-09-01")},
                    ${item("noDateA", "Apples")},
                    ${item("earlyB", "Butter", expiresOn = "2026-08-22")},
                    ${item("earlyA", "Almonds", expiresOn = "2026-08-22")}
                ]""",
            ),
        )

        assertEquals(
            listOf("earlyA", "earlyB", "late", "noDateA", "noDateB"),
            model.shown(sort = PantrySort.Expiring).map { it.id },
        )
    }

    @Test
    fun `A to Z sorts by name, case-insensitively`() = runTest {
        load(
            payload(
                items = """[
                    ${item("b", "banana")},
                    ${item("a", "Apple")},
                    ${item("c", "Cherry")}
                ]""",
            ),
        )

        assertEquals(listOf("a", "b", "c"), model.shown(sort = PantrySort.Az).map { it.id })
    }

    @Test
    fun `Recent is newest-logged first and Oldest is earliest-added first`() = runTest {
        load(
            payload(
                items = """[
                    ${item("old", "Rice", addedOn = "2026-01-01", createdAt = "2026-01-01T00:00:00Z")},
                    ${item("new", "Milk", addedOn = "2026-08-01", createdAt = "2026-08-01T00:00:00Z")}
                ]""",
            ),
        )

        assertEquals(listOf("new", "old"), model.shown(sort = PantrySort.Recent).map { it.id })
        assertEquals(listOf("old", "new"), model.shown(sort = PantrySort.Oldest).map { it.id })
    }

    // ---- images ----------------------------------------------------------------------------------

    @Test
    fun `a photo is cached on its storage path, never on the resolved URL`() = runTest {
        load(payload(items = "[${item("a", "Coke", imageUrl = "/media/ab/cd.jpg?sig=expires-soon")}]"))

        val row = model.rows.single()
        assertContains(row.imageUrl.orEmpty(), "/media/ab/cd.jpg")
        // The signature is an expiry, not an identity — keying on it means the cache
        // never hits, which is how expiring URLs broke the photo screensaver on web.
        assertEquals("/media/ab/cd.jpg", row.imageCacheKey)
    }

    @Test
    fun `an item with no photo falls back to a name-derived emoji`() = runTest {
        load(payload(items = "[${item("a", "Whole milk")}]"))

        val row = model.rows.single()
        assertNull(row.imageUrl)
        assertEquals("🥛", row.emoji)
    }

    // ---- load failure --------------------------------------------------------------------------------

    @Test
    fun `a failed refresh keeps the last good list rather than blanking the screen`() = runTest {
        load(payload(items = "[${item("a", "Rice")}]"))
        assertEquals(1, model.rows.size)

        harness.enqueueError(500, "ServerError", "boom")
        model.load()

        assertEquals(1, model.rows.size)
        assertTrue(model.loaded)
        assertTrue(model.error)
    }

    @Test
    fun `an empty pantry is a real answer, not a failure`() = runTest {
        load(payload(items = "[]"))

        assertTrue(model.rows.isEmpty())
        assertTrue(model.loaded)
        assertFalse(model.error)
    }

    // ---- writes ---------------------------------------------------------------------------------------

    @Test
    fun `stepping a countable amount patches the new value`() = runTest {
        load(payload(items = "[${item("a", "Rice", amount = "2")}]"))

        harness.enqueueJson("""{"item":{"id":"a","name":"Rice","amount":"3","unit":"","location":"Pantry","note":"","usedUp":false}}""")
        model.adjust(model.rows.single(), 1.0)

        harness.takeRequest() // the initial list
        val request = harness.takeRequest()
        assertEquals("PATCH", request.method)
        assertContains(request.body.readUtf8(), "\"amount\":\"3\"")
        assertEquals("3", model.rows.single().item.amount)
    }

    @Test
    fun `stepping the last one down marks it used up instead of going to zero`() = runTest {
        load(payload(items = "[${item("a", "Rice", amount = "1")}]"))

        harness.enqueueJson("""{"item":{"id":"a","name":"Rice","amount":"1","unit":"","location":"Pantry","note":"","usedUp":true}}""")
        model.adjust(model.rows.single(), -1.0)

        harness.takeRequest()
        assertContains(harness.takeRequest().body.readUtf8(), "\"usedUp\":true")
    }

    @Test
    fun `deleting is optimistic and reverts when the server refuses`() = runTest {
        load(payload(items = "[${item("a", "Rice")},${item("b", "Milk")}]"))

        harness.enqueueError(404, "NotFound", "item not found")
        model.delete(model.rows.first { it.id == "a" })

        // The row comes back — the server never accepted the change.
        assertEquals(setOf("a", "b"), model.rows.map { it.id }.toSet())
    }

    @Test
    fun `a successful delete drops the row and invalidates the pantry domain`() = runTest {
        load(payload(items = "[${item("a", "Rice")},${item("b", "Milk")}]"))

        harness.enqueueNoContent()
        model.delete(model.rows.first { it.id == "a" })

        assertEquals(listOf("b"), model.rows.map { it.id })
        assertEquals(1, bus.revisionOf(RefreshDomain.Pantry))
    }

    @Test
    fun `a replaced item is re-derived, not just swapped in`() = runTest {
        load(payload(items = "[${item("a", "Rice")}]"))

        model.replace(
            PantryApi.Item(
                id = "a",
                name = "Rice",
                amount = "1",
                location = "Pantry",
                expiresOn = "2026-08-22",
            ),
        )

        val row = model.rows.single()
        assertEquals(1, row.daysToExpiry)
        assertTrue(row.isSoon)
        assertTrue(row.isLow)
    }
}
