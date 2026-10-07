package app.waffled.feature.planning

import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledJson
import app.waffled.feature.lists.ListItemDTO
import app.waffled.feature.meals.PlanCardDTO
import app.waffled.feature.planning.api.PlanningFilledNight
import app.waffled.feature.planning.api.PlanningMealsCard
import app.waffled.feature.planning.api.PlanningMealsFill
import app.waffled.feature.planning.api.PlanningMealsGroceries
import app.waffled.feature.planning.api.PlanningMealsNight
import app.waffled.feature.planning.api.PlanningMealsShopper
import app.waffled.feature.planning.api.PlanningMealsShopperResult
import app.waffled.feature.planning.api.PlanningMealsUndo
import app.waffled.feature.planning.api.PlanningMealsView
import app.waffled.feature.planning.api.PlanningMealsWire
import app.waffled.feature.planning.api.PlanningNightDinner
import app.waffled.feature.planning.api.PlanningNightEvent
import app.waffled.feature.planning.api.PlanningShoppingTrip
import app.waffled.feature.planning.steps.PlanningMealsCrumb
import app.waffled.feature.planning.steps.PlanningMealsModel
import app.waffled.feature.planning.steps.PlanningMealsPlan
import app.waffled.feature.planning.steps.PlanningMealsStepStore
import app.waffled.feature.planning.steps.PlanningMealsText
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Test
import java.time.LocalDate
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNotSame
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

// Weekly Planning · step 7 (Meals). Port of iOS `PlanningMealsStepTests.swift`. Four things
// carry the weight: the THREE-WAY `cards` (OMIT the key, never a null); the undo KEEPING a
// night decided since; the shopper rule; and the receipt round-tripping `mealId`.

private val weekNights = """
[
  { "date": "2026-09-06", "events": [],
    "dinner": { "entryId": "e-sun", "title": "Pasta bake", "emoji": null, "recipeId": "r-pasta",
                "mealId": null, "imageUrl": null, "cookName": "Kevin", "cookAvatar": null,
                "cookColor": null, "minutes": null } },
  { "date": "2026-09-07", "events": [],
    "dinner": { "entryId": "e-mon", "title": "Fish tacos", "emoji": null, "recipeId": "r-tacos",
                "mealId": null, "imageUrl": null, "cookName": null, "cookAvatar": null,
                "cookColor": null, "minutes": null } },
  { "date": "2026-09-08", "events": [],
    "dinner": { "entryId": "e-tue", "title": "Leftovers", "emoji": null, "recipeId": null,
                "mealId": null, "imageUrl": null, "cookName": null, "cookAvatar": null,
                "cookColor": null, "minutes": null } },
  { "date": "2026-09-09",
    "events": [
      { "id": "ev-soccer", "title": "Soccer practice", "startsAt": "2026-09-09T22:30:00.000Z",
        "allDay": false, "personId": "p-lottie", "personName": "Lottie",
        "personColor": "#7A5AF8", "participantIds": [] }
    ],
    "dinner": null },
  { "date": "2026-09-10", "events": [],
    "dinner": { "entryId": "e-thu", "title": "Eating out", "emoji": null, "recipeId": null,
                "mealId": null, "imageUrl": null, "cookName": null, "cookAvatar": null,
                "cookColor": null, "minutes": null } },
  { "date": "2026-09-11", "events": [], "dinner": null },
  { "date": "2026-09-12", "events": [], "dinner": null }
]
"""

private val weekJson = """
{ "weekStart": "2026-09-06", "nights": $weekNights,
  "emptyDates": ["2026-09-09", "2026-09-11", "2026-09-12"],
  "groceries": { "items": 9, "checked": 2 }, "choresOn": true, "shopping": null }
"""

private val tripJson = """
{ "choreId": "c-groceries", "personId": "p-kevin", "personName": "Kevin", "personAvatar": "🧢",
  "personColor": "#EC6049", "dueOn": "2026-09-12", "dueTime": "09:00", "status": "pending" }
"""

private val shopperJson = """
{ "weekStart": "2026-09-06", "shopping": $tripJson,
  "view": { "weekStart": "2026-09-06", "nights": $weekNights,
            "emptyDates": ["2026-09-09", "2026-09-11", "2026-09-12"],
            "groceries": { "items": 9, "checked": 2 }, "choresOn": true, "shopping": $tripJson } }
"""

private val filledWeekJson = """
{ "weekStart": "2026-09-06",
  "nights": [
    { "date": "2026-09-06", "events": [],
      "dinner": { "entryId": "e-sun", "title": "Pasta bake", "recipeId": "r-pasta", "mealId": null,
                  "cookName": "Kevin", "minutes": null } },
    { "date": "2026-09-07", "events": [],
      "dinner": { "entryId": "e-mon", "title": "Fish tacos", "recipeId": "r-tacos", "mealId": null } },
    { "date": "2026-09-08", "events": [],
      "dinner": { "entryId": "e-tue", "title": "Leftovers", "recipeId": null, "mealId": null } },
    { "date": "2026-09-09", "events": [],
      "dinner": { "entryId": "e-wed", "title": "Chili", "recipeId": "r-chili", "mealId": null } },
    { "date": "2026-09-10", "events": [],
      "dinner": { "entryId": "e-thu", "title": "Eating out", "recipeId": null, "mealId": null } },
    { "date": "2026-09-11", "events": [],
      "dinner": { "entryId": "e-fri", "title": "Stir fry", "recipeId": "r-stir", "mealId": null } },
    { "date": "2026-09-12", "events": [],
      "dinner": { "entryId": "e-sat", "title": "Soup", "recipeId": "r-soup", "mealId": null } }
  ],
  "emptyDates": [], "groceries": { "items": 14, "checked": 2 }, "choresOn": true, "shopping": null }
"""

private val fillJson = """
{ "weekStart": "2026-09-06",
  "filled": [
    { "date": "2026-09-09", "entryId": "e-wed", "recipeId": "r-chili", "mealId": null, "title": null },
    { "date": "2026-09-11", "entryId": "e-fri", "recipeId": "r-stir", "mealId": null, "title": null },
    { "date": "2026-09-12", "entryId": "e-sat", "recipeId": "r-soup", "mealId": null, "title": null }
  ],
  "view": $filledWeekJson }
"""

private val undoJson = """
{ "weekStart": "2026-09-06", "cleared": ["2026-09-09", "2026-09-12"], "kept": ["2026-09-11"],
  "view": { "weekStart": "2026-09-06",
    "nights": [
      { "date": "2026-09-06", "events": [], "dinner": { "entryId": "e-sun", "title": "Pasta bake", "recipeId": "r-pasta" } },
      { "date": "2026-09-07", "events": [], "dinner": { "entryId": "e-mon", "title": "Fish tacos", "recipeId": "r-tacos" } },
      { "date": "2026-09-08", "events": [], "dinner": { "entryId": "e-tue", "title": "Leftovers", "recipeId": null } },
      { "date": "2026-09-09", "events": [], "dinner": null },
      { "date": "2026-09-10", "events": [], "dinner": { "entryId": "e-thu", "title": "Eating out", "recipeId": null } },
      { "date": "2026-09-11", "events": [], "dinner": { "entryId": "e-fri", "title": "Grandma’s", "recipeId": null } },
      { "date": "2026-09-12", "events": [], "dinner": null }
    ],
    "emptyDates": ["2026-09-09", "2026-09-12"], "groceries": { "items": 11, "checked": 2 },
    "choresOn": true, "shopping": null } }
"""

private val plateNightJson = """
{ "date": "2026-09-09", "events": [],
  "dinner": { "entryId": "e-wed", "title": "Takeout Tuesday", "emoji": null, "recipeId": null,
              "mealId": "m-copy-1", "imageUrl": null, "cookName": null, "cookAvatar": null,
              "cookColor": null, "minutes": null } }
"""

private fun <T> decode(serializer: kotlinx.serialization.KSerializer<T>, text: String): T =
    WaffledJson.decodeFromString(serializer, text)

private fun decodedWeek(): PlanningMealsView = decode(PlanningMealsView.serializer(), weekJson)

private const val W = "2026-09-06"

private class MealsRejected : Exception("rejected")

private class MealsFeed {
    var view = decodedWeek()
    val fillResult = decode(PlanningMealsFill.serializer(), fillJson)
    val undoResult = decode(PlanningMealsUndo.serializer(), undoJson)
    val shopperResult = decode(PlanningMealsShopperResult.serializer(), shopperJson)

    var fetchFails = false
    var fillFails = false
    var shopperForbidden = false
    var fillGate: CompletableDeferred<Unit>? = null
    var fillEntered = false

    var fetchCount = 0
    val fillBodies = mutableListOf<JsonObject>()
    val undoBodies = mutableListOf<JsonObject>()
    val shopperChoreIds = mutableListOf<String?>()
    val plannedSlots = mutableListOf<Triple<String, String?, String?>>()
    val clearedSlots = mutableListOf<String>()
    val addedGroceries = mutableListOf<String>()
    var addGroceryFails = false
    var groceryItems: List<ListItemDTO> = emptyList()
    val groceryWeeks = mutableListOf<String>()
    val checkedGroceries = mutableListOf<Pair<String, Boolean>>()
    var checkGroceryFails = false

    fun model() = PlanningMealsModel(
        fetchView = { _, _ ->
            fetchCount += 1
            if (fetchFails) throw MealsRejected()
            view
        },
        fill = { weekStart, cards ->
            fillBodies += PlanningMealsWire.fillBody(weekStart, cards)
            fillGate?.let {
                fillEntered = true
                it.await()
            }
            if (fillFails) throw MealsRejected()
            view = fillResult.view
            fillResult
        },
        undo = { weekStart, filled ->
            undoBodies += PlanningMealsWire.undoBody(weekStart, filled)
            view = undoResult.view
            undoResult
        },
        setShopper = { _, _, _, _, choreId ->
            shopperChoreIds += choreId
            if (shopperForbidden) throw WaffledApiException(403, "Forbidden")
            view = shopperResult.view
            shopperResult
        },
        planSlot = { date, recipeId, title -> plannedSlots += Triple(date, recipeId, title) },
        planPlate = { date, _ -> plannedSlots += Triple(date, null, "plate") },
        clearSlot = { clearedSlots += it },
        addGrocery = {
            if (addGroceryFails) throw MealsRejected()
            addedGroceries += it
        },
        fetchGroceries = {
            groceryWeeks += it
            groceryItems
        },
        checkGrocery = { id, checked ->
            checkedGroceries += id to checked
            if (checkGroceryFails) throw MealsRejected()
        },
    )
}

private fun groceryItems(): List<ListItemDTO> = WaffledJson.decodeFromString(
    """
    [{"id":"i-2","name":"Eggs","quantity":null,"checked":true,"aisle":"Dairy & Chilled"},
     {"id":"i-1","name":"Milk","quantity":"1 gal","checked":false,"aisle":"Dairy & Chilled"}]
    """,
)

private fun planCard(date: String, title: String, recipeId: String?, mealType: String = "dinner") =
    PlanCardDTO(date = date, mealType = mealType, title = title, recipeId = recipeId)

private fun autoFilled(vararg dates: String) =
    buildJsonObject { put("autoFilled", JsonArray(dates.map(::JsonPrimitive))) }

class PlanningMealsWireTest {

    @Test fun `omits the cards key entirely when the server should draft`() {
        val body = PlanningMealsWire.fillBody(W, null)
        // Absent, not null: a present null writes NOTHING while still answering 200.
        assertFalse("cards" in body)
        assertEquals(setOf("weekStart"), body.keys)
        assertFalse(body.toString().contains("cards"))
    }

    @Test fun `sends an approved week as a real array`() {
        val body = PlanningMealsWire.fillBody(
            W,
            listOf(
                PlanningMealsCard(date = "2026-09-09", title = "Approved 3"),
                PlanningMealsCard(date = "2026-09-11", recipeId = "r-chili"),
            ),
        )
        val sent = body["cards"]!!.jsonArray
        assertEquals(2, sent.size)
        assertEquals(
            buildJsonObject {
                put("date", "2026-09-09"); put("mealType", "dinner"); put("title", "Approved 3"); put("recipeId", JsonNull)
            },
            sent[0],
        )
        assertEquals(
            buildJsonObject {
                put("date", "2026-09-11"); put("mealType", "dinner"); put("title", ""); put("recipeId", "r-chili")
            },
            sent[1],
        )
    }

    @Test fun `an empty approved week stays present and empty`() {
        assertEquals(JsonArray(emptyList()), PlanningMealsWire.fillBody(W, emptyList())["cards"])
    }

    @Test fun `the undo round-trips every dimension of the receipt including mealId`() {
        val claim = decode(
            PlanningFilledNight.serializer(),
            """{ "date": "2026-09-09", "entryId": "e-wed", "recipeId": null, "mealId": "m-copy-1", "title": "BBQ Sunday" }""",
        )
        val body = PlanningMealsWire.undoBody(W, listOf(claim))
        assertEquals(JsonPrimitive(W), body["weekStart"])
        assertEquals(
            JsonArray(
                listOf(
                    buildJsonObject {
                        put("date", "2026-09-09"); put("entryId", "e-wed"); put("recipeId", JsonNull)
                        put("mealId", "m-copy-1"); put("title", "BBQ Sunday")
                    },
                ),
            ),
            body["filled"],
        )
    }

    @Test fun `the undo writes explicit nulls rather than omitting fields`() {
        val claim = decode(
            PlanningFilledNight.serializer(),
            """{ "date": "2026-09-11", "entryId": "e-fri", "recipeId": "r-stir", "mealId": null, "title": null }""",
        )
        val one = PlanningMealsWire.undoBody("w", listOf(claim))["filled"]!!.jsonArray[0].jsonObject
        assertEquals(JsonNull, one["mealId"])
        assertEquals(JsonNull, one["title"])
        assertEquals(5, one.size)
    }

    @Test fun `clearing the trip sends explicit nulls`() {
        val body = PlanningMealsWire.shopperBody(W, dueOn = null, personId = null, dueTime = null, choreId = "c-1")
        assertEquals(JsonNull, body["dueOn"])
        assertEquals(JsonNull, body["personId"])
        assertEquals(JsonNull, body["dueTime"])
        assertEquals(JsonPrimitive("c-1"), body["choreId"])
    }

    @Test fun `handing the trip to somebody else needs chore manage`() {
        assertFalse(PlanningMealsShopper.mayAssign("p-wally", "p-kevin", canManage = false))
        assertTrue(PlanningMealsShopper.mayAssign("p-wally", "p-kevin", canManage = true))
    }

    @Test fun `putting it on yourself or up for grabs needs nothing`() {
        assertTrue(PlanningMealsShopper.mayAssign("p-kevin", "p-kevin", canManage = false))
        assertTrue(PlanningMealsShopper.mayAssign(null, "p-kevin", canManage = false))
        assertTrue(PlanningMealsShopper.mayAssign(null, null, canManage = false))
    }

    @Test fun `a device with no person cannot claim the trip for itself`() {
        assertFalse(PlanningMealsShopper.mayAssign("p-kevin", null, canManage = false))
    }
}

class PlanningMealsDecodingTest {

    @Test fun `decodes the week the server named`() {
        val view = decodedWeek()
        assertEquals(W, view.weekStart)
        assertEquals(
            listOf("2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12"),
            view.nights.map { it.date },
        )
        assertEquals(listOf("2026-09-09", "2026-09-11", "2026-09-12"), view.emptyDates)
        assertEquals("Pasta bake", view.nights[0].dinner?.title)
        assertEquals("Kevin", view.nights[0].dinner?.cookName)
        assertNull(view.nights[1].dinner?.cookName)
        assertNull(view.nights[1].dinner?.minutes)
        assertEquals(9, view.groceries?.items)
        assertEquals(2, view.groceries?.checked)
        assertTrue(view.choresOn)
        assertNull(view.shopping)
    }

    @Test fun `keeps the night's events with their colour inputs`() {
        val wed = decodedWeek().nights[3]
        assertEquals(listOf("Soccer practice"), wed.events.map { it.title })
        assertEquals("#7A5AF8", wed.events[0].personColor)
        assertTrue(wed.events[0].participantIds.isEmpty())
        assertFalse(wed.events[0].allDay)
    }

    @Test fun `a payload missing an array costs that array and not the week`() {
        val view = decode(
            PlanningMealsView.serializer(),
            """
            { "weekStart": "2026-09-06",
              "nights": [
                { "date": "2026-09-06" },
                { "date": "2026-09-07",
                  "events": [ { "id": "ev-1", "title": "Dance", "startsAt": "2026-09-07T23:00:00.000Z", "allDay": false } ] }
              ] }
            """,
        )
        assertEquals(2, view.nights.size)
        assertTrue(view.nights[0].events.isEmpty())
        assertTrue(view.nights[1].events[0].participantIds.isEmpty())
        assertTrue(view.emptyDates.isEmpty())
        assertFalse(view.choresOn)
        assertNull(view.groceries)
    }

    @Test fun `decodes the fill receipt with mealId null on every claim`() {
        val fill = decode(PlanningMealsFill.serializer(), fillJson)
        assertEquals(listOf("2026-09-09", "2026-09-11", "2026-09-12"), fill.filled.map { it.date })
        assertTrue(fill.filled.all { it.mealId == null })
        assertTrue(fill.view.emptyDates.isEmpty())
    }

    @Test fun `a plate is never takeout however it is named`() {
        val dinner = decode(PlanningMealsNight.serializer(), plateNightJson).dinner!!
        assertEquals("m-copy-1", dinner.mealId)
        assertFalse(PlanningMealsText.isEatingOut(dinner))
        assertEquals("a whole plate", PlanningMealsText.attribution(dinner, auto = false, eatingOut = false))
    }

    @Test fun `a recipe-less takeout title still reads as takeout`() {
        val dinner = decode(
            PlanningNightDinner.serializer(),
            """{ "entryId": "e-thu", "title": "Eating out", "recipeId": null, "mealId": null }""",
        )
        assertTrue(PlanningMealsText.isEatingOut(dinner))
        assertEquals("no cooking", PlanningMealsText.attribution(dinner, auto = false, eatingOut = true))
    }

    @Test fun `a named dish that merely contains eat or out is not takeout`() {
        listOf("Leftovers", "Grandma’s", "Try something new", "Meatball subs", "Trout tacos", "Wheat noodles").forEach { title ->
            assertFalse(PlanningMealsText.isEatingOut(PlanningNightDinner(entryId = "e", title = title)), title)
        }
    }

    @Test fun `the takeout phrasings the spec names all read as takeout`() {
        listOf("Eating out", "Takeout", "Take-out Friday", "Order in", "Delivery", "Takeaway", "Dining out").forEach { title ->
            assertTrue(PlanningMealsText.isEatingOut(PlanningNightDinner(entryId = "e", title = title)), title)
        }
    }
}

class PlanningMealsTextTest {

    @Test fun `small counts read as words`() {
        assertEquals("three", PlanningMealsText.countWord(3))
        assertEquals("one", PlanningMealsText.countWord(1))
        assertEquals("9", PlanningMealsText.countWord(9))
    }

    @Test fun `the kept note names the nights it walked past`() {
        assertNull(PlanningMealsText.keptSentence(emptyList()))
        assertEquals("one night was left alone — Fri has been decided since.", PlanningMealsText.keptSentence(listOf("2026-09-11")))
        assertEquals(
            "two nights were left alone — Fri, Sat have been decided since.",
            PlanningMealsText.keptSentence(listOf("2026-09-11", "2026-09-12")),
        )
    }

    @Test fun `the trip pill says up for grabs rather than nothing`() {
        assertEquals("Who's shopping?", PlanningMealsText.tripLabel(null))
        val unassigned = decode(
            PlanningShoppingTrip.serializer(),
            """{ "choreId": "c-1", "personId": null, "personName": null, "personAvatar": null,
                 "personColor": null, "dueOn": "2026-09-12", "dueTime": "09:00", "status": "pending" }""",
        )
        assertEquals("Up for grabs · Sat 09:00", PlanningMealsText.tripLabel(unassigned))
        val assigned = decode(
            PlanningShoppingTrip.serializer(),
            """{ "choreId": "c-1", "personId": "p-kevin", "personName": "Kevin", "personAvatar": "🧢",
                 "personColor": "#EC6049", "dueOn": "2026-09-12", "dueTime": null, "status": "pending" }""",
        )
        assertEquals("🧢 Kevin shops Sat", PlanningMealsText.tripLabel(assigned))
    }

    @Test fun `the grocery line only claims what was measured`() {
        assertEquals("built from what's planned so far · staples skipped", PlanningMealsText.grocerySub(null))
        assertEquals("5 items added · staples skipped", PlanningMealsText.grocerySub(5))
    }

    @Test fun `the grocery pill counts what is left to buy`() {
        assertEquals("7 to buy · aisle order · 2 done", PlanningMealsText.groceryPill(PlanningMealsGroceries(9, 2)))
        assertEquals("4 to buy · aisle order", PlanningMealsText.groceryPill(PlanningMealsGroceries(4, 0)))
    }

    @Test fun `an all-day event says so and an unreadable instant says nothing`() {
        val allDay = decode(
            PlanningNightEvent.serializer(),
            """{ "id": "ev-1", "title": "School closed", "startsAt": "2026-09-09T00:00:00.000Z", "allDay": true, "participantIds": [] }""",
        )
        assertEquals("All day", PlanningMealsText.clock(allDay))
        val unreadable = decode(
            PlanningNightEvent.serializer(),
            """{ "id": "ev-2", "title": "Odd one", "startsAt": "not a timestamp", "allDay": false }""",
        )
        assertEquals("", PlanningMealsText.clock(unreadable))
    }

    @Test fun `day labels are read as calendar labels`() {
        assertEquals("Sun", PlanningMealsText.dow("2026-09-06"))
        assertEquals("Sep 6", PlanningMealsText.monthDay("2026-09-06"))
    }

    @Test fun `the crumb reads only real days out of whatever the session kept`() {
        val data = buildJsonObject {
            put(
                "autoFilled",
                JsonArray(
                    listOf(JsonPrimitive("2026-09-09"), JsonPrimitive("nope"), JsonPrimitive(7), JsonPrimitive("2026-9-9"), JsonPrimitive("2026-09-12")),
                ),
            )
        }
        assertEquals(listOf("2026-09-09", "2026-09-12"), PlanningMealsCrumb.dates(data))
        assertTrue(PlanningMealsCrumb.dates(null).isEmpty())
        assertTrue(PlanningMealsCrumb.dates(buildJsonObject { put("autoFilled", "2026-09-09") }).isEmpty())
    }
}

class PlanningMealsModelTest {

    @Test fun `adding a grocery trims it and re-reads the line`() = runTest {
        val feed = MealsFeed()
        val model = feed.model()
        model.load(W, emptyList())
        val reads = feed.fetchCount
        assertTrue(model.addGrocery("  Paper towels ", W))
        assertEquals(listOf("Paper towels"), feed.addedGroceries)
        assertEquals(reads + 1, feed.fetchCount)
    }

    @Test fun `the grocery list reads the planned week's items`() = runTest {
        val feed = MealsFeed().apply { groceryItems = groceryItems() }
        val model = feed.model()
        model.loadGroceries(W)
        assertEquals(listOf(W), feed.groceryWeeks)
        assertEquals(listOf("Milk"), model.current.groceriesToBuy.map { it.name })
        assertEquals(listOf("Eggs"), model.current.groceriesInCart.map { it.name })
    }

    @Test fun `ticking a grocery off moves it to the cart and re-reads the count`() = runTest {
        val feed = MealsFeed().apply { groceryItems = groceryItems() }
        val model = feed.model()
        model.load(W, emptyList())
        model.loadGroceries(W)
        val reads = feed.fetchCount
        val milk = model.current.groceriesToBuy.first()
        assertTrue(model.setGroceryChecked(milk, W))
        assertEquals(listOf("i-1" to true), feed.checkedGroceries)
        assertTrue(model.current.groceriesToBuy.isEmpty())
        assertEquals(setOf("Eggs", "Milk"), model.current.groceriesInCart.map { it.name }.toSet())
        assertEquals(reads + 1, feed.fetchCount)
    }

    @Test fun `a tick that does not land puts the item back and says so`() = runTest {
        val feed = MealsFeed().apply {
            groceryItems = groceryItems()
            checkGroceryFails = true
        }
        val model = feed.model()
        model.loadGroceries(W)
        assertFalse(model.setGroceryChecked(model.current.groceriesToBuy.first(), W))
        assertEquals(listOf("Milk"), model.current.groceriesToBuy.map { it.name })
        assertNotNull(model.current.groceryError)
    }

    @Test fun `a blank or failed grocery add reports it did not land`() = runTest {
        val feed = MealsFeed()
        val model = feed.model()
        model.load(W, emptyList())
        assertFalse(model.addGrocery("   ", W))
        assertTrue(feed.addedGroceries.isEmpty())
        feed.addGroceryFails = true
        assertFalse(model.addGrocery("Milk", W))
        assertNotNull(model.current.errorMessage)
    }

    @Test fun `a failed read keeps the week it already had and still loads`() = runTest {
        val feed = MealsFeed()
        val model = feed.model()
        model.load(W, emptyList())
        feed.fetchFails = true
        model.reread(W)
        assertTrue(model.current.loaded)
        assertEquals(7, model.current.rows.size)
        assertEquals("Pasta bake", model.current.rows[0].dinner?.title)
    }

    @Test fun `the crumb is null until the app has actually picked a night`() = runTest {
        val model = MealsFeed().model()
        model.load(W, emptyList())
        assertNull(model.current.crumb)
    }

    @Test fun `the crumb restores the marks but never the undo`() = runTest {
        val model = MealsFeed().model()
        model.load(W, listOf("2026-09-06", "2026-09-09"))
        assertEquals(listOf("2026-09-06"), model.current.autoMarks)
        assertTrue(model.current.rows[0].auto)
        assertEquals("👤 Kevin", model.current.rows[0].attribution)
        assertEquals(autoFilled("2026-09-06"), model.current.crumb)
        assertTrue(model.current.filled.isEmpty())
    }

    @Test fun `filling marks the nights, measures the groceries and arms the undo`() = runTest {
        val feed = MealsFeed()
        val model = feed.model()
        model.load(W, emptyList())
        assertTrue(model.planTheRest(W))
        assertEquals(1, feed.fillBodies.size)
        assertFalse("cards" in feed.fillBodies[0])
        assertEquals(listOf("2026-09-09", "2026-09-11", "2026-09-12"), model.current.filled.map { it.date })
        assertEquals(autoFilled("2026-09-09", "2026-09-11", "2026-09-12"), model.current.crumb)
        assertEquals(5, model.current.groceryAdded)
        val wed = model.current.rows.first { it.date == "2026-09-09" }
        assertTrue(wed.auto)
        assertEquals("the app picked this", wed.attribution)
        assertTrue(model.current.emptyDates.isEmpty())
    }

    @Test fun `undo keeps a night somebody decided since and says so`() = runTest {
        val feed = MealsFeed()
        val model = feed.model()
        model.load(W, emptyList())
        model.planTheRest(W)
        assertTrue(model.undoTheFill(W))
        assertEquals(3, feed.undoBodies[0]["filled"]!!.jsonArray.size)
        assertEquals(listOf("2026-09-11"), model.current.kept)
        assertTrue(model.current.filled.isEmpty())
        assertTrue(model.current.autoMarks.isEmpty())
        val fri = model.current.rows.first { it.date == "2026-09-11" }
        assertEquals("Grandma’s", fri.dinner?.title)
        assertFalse(fri.auto)
        assertEquals("one night was left alone — Fri has been decided since.", PlanningMealsText.keptSentence(model.current.kept))
        assertNull(model.current.crumb)
    }

    @Test fun `a failed fill changes nothing and says why`() = runTest {
        val feed = MealsFeed().apply { fillFails = true }
        val model = feed.model()
        model.load(W, emptyList())
        assertFalse(model.planTheRest(W))
        assertTrue(model.current.filled.isEmpty())
        assertNotNull(model.current.errorMessage)
        assertEquals(1, feed.fetchCount)
        assertEquals(listOf("2026-09-09", "2026-09-11", "2026-09-12"), model.current.emptyDates)
    }

    @Test fun `undo does nothing without a live receipt`() = runTest {
        val feed = MealsFeed()
        val model = feed.model()
        model.load(W, listOf("2026-09-06"))
        assertFalse(model.undoTheFill(W))
        assertTrue(feed.undoBodies.isEmpty())
    }

    @Test fun `deciding a night by hand stops it being an auto-fill`() = runTest {
        val feed = MealsFeed()
        val model = feed.model()
        model.load(W, emptyList())
        model.planTheRest(W)
        assertEquals(3, model.current.filled.size)
        assertTrue(model.planNight(W, "2026-09-11", recipeId = "r-curry", title = null))
        assertEquals(listOf("2026-09-11"), feed.plannedSlots.map { it.first })
        assertEquals("r-curry", feed.plannedSlots[0].second)
        assertEquals(listOf("2026-09-09", "2026-09-12"), model.current.filled.map { it.date })
        assertEquals(autoFilled("2026-09-09", "2026-09-12"), model.current.crumb)
    }

    @Test fun `a hand write forgets the star even if the re-read fails`() = runTest {
        val feed = MealsFeed()
        val model = feed.model()
        model.load(W, emptyList())
        model.planTheRest(W)
        feed.fetchFails = true
        assertTrue(model.planNight(W, "2026-09-11", recipeId = "r-curry", title = null))
        val fri = model.current.rows.first { it.date == "2026-09-11" }
        assertFalse(fri.auto)
        assertTrue(fri.attribution != "the app picked this")
        assertEquals(autoFilled("2026-09-09", "2026-09-12"), model.current.crumb)
    }

    @Test fun `clearing a night goes through the meals screen's own delete`() = runTest {
        val feed = MealsFeed()
        val model = feed.model()
        model.load(W, emptyList())
        assertTrue(model.clearNight(W, "2026-09-08"))
        assertEquals(listOf("2026-09-08"), feed.clearedSlots)
    }

    @Test fun `assigning the trip reads it back off the chore and keeps its id for next time`() = runTest {
        val feed = MealsFeed()
        val model = feed.model()
        model.load(W, emptyList())
        assertNull(model.current.choreHint)
        assertTrue(model.setShopper(W, dueOn = "2026-09-12", personId = "p-kevin", dueTime = "09:00"))
        assertEquals("c-groceries", model.current.view?.shopping?.choreId)
        assertEquals("Kevin", model.current.view?.shopping?.personName)
        assertEquals("🧢 Kevin shops Sat 09:00", PlanningMealsText.tripLabel(model.current.view?.shopping))
        assertEquals(1, feed.fetchCount)
        assertEquals("c-groceries", model.current.choreHint)
        assertTrue(model.setShopper(W, dueOn = "2026-09-11", personId = null, dueTime = null))
        assertEquals(listOf(null, "c-groceries"), feed.shopperChoreIds)
    }

    @Test fun `a refused shopper write leaves the trip alone and does not refetch`() = runTest {
        val feed = MealsFeed().apply { shopperForbidden = true }
        val model = feed.model()
        model.load(W, emptyList())
        assertFalse(model.setShopper(W, dueOn = "2026-09-12", personId = "p-wally", dueTime = "09:00"))
        assertEquals("Only a parent can hand the shopping to somebody else.", model.current.errorMessage)
        assertNull(model.current.view?.shopping)
        assertEquals(1, feed.fetchCount)
        assertEquals(listOf<String?>(null), feed.shopperChoreIds)
    }

    @Test fun `one write at a time and the second says so rather than returning quietly`() = runTest {
        val feed = MealsFeed()
        val model = feed.model()
        model.load(W, emptyList())
        val gate = CompletableDeferred<Unit>()
        feed.fillGate = gate
        var landed = false
        val first = launch { landed = model.planTheRest(W) }
        runCurrent()
        assertTrue(feed.fillEntered)

        val second = model.planTheRest(W)

        gate.complete(Unit)
        first.join()
        assertTrue(landed)
        assertFalse(second)
        assertEquals(1, feed.fillBodies.size)
        assertNotNull(model.current.errorMessage)
    }
}

class PlanningMealsStepStoreTest {

    @Test fun `the body and the footer get the same model`() {
        PlanningMealsStepStore.reset()
        val feed = MealsFeed()
        val body = PlanningMealsStepStore.model("s-1", W) { feed.model() }
        val footer = PlanningMealsStepStore.model("s-1", W) { feed.model() }
        assertSame(body, footer)
        PlanningMealsStepStore.reset()
    }

    @Test fun `stepping to another week cannot inherit the last week's marks`() {
        PlanningMealsStepStore.reset()
        val feed = MealsFeed()
        val first = PlanningMealsStepStore.model("s-1", W) { feed.model() }
        val next = PlanningMealsStepStore.model("s-2", "2026-09-13") { feed.model() }
        assertNotSame(first, next)
        val again = PlanningMealsStepStore.model("s-1", W) { feed.model() }
        assertNotSame(first, again)
        PlanningMealsStepStore.reset()
    }

    @Test fun `the key is spelled in exactly one place`() {
        assertEquals("s-1|2026-09-06", PlanningMealsStepStore.key("s-1", W))
    }
}

class PlanningMealsPlannerTest {

    @Test fun `the control opens the planner and writes nothing by itself`() = runTest {
        val feed = MealsFeed()
        val model = feed.model()
        model.load(W, emptyList())
        assertFalse(model.current.plannerOpen)
        model.openPlanner()
        assertTrue(model.current.plannerOpen)
        assertTrue(feed.fillBodies.isEmpty())
        assertTrue(model.current.filled.isEmpty())
    }

    @Test fun `a full week cannot open the planner`() = runTest {
        val feed = MealsFeed().apply {
            view = decode(
                PlanningMealsView.serializer(),
                """{ "weekStart": "2026-09-06", "nights": [], "emptyDates": [], "groceries": null, "choresOn": false, "shopping": null }""",
            )
        }
        val model = feed.model()
        model.load(W, emptyList())
        model.openPlanner()
        assertFalse(model.current.plannerOpen)
    }

    @Test fun `the sheet can close itself`() = runTest {
        val model = MealsFeed().model()
        model.load(W, emptyList())
        model.openPlanner()
        model.setPlanner(false)
        assertFalse(model.current.plannerOpen)
    }

    @Test fun `the approved week travels as a real array and closes the planner`() = runTest {
        val feed = MealsFeed()
        val model = feed.model()
        model.load(W, emptyList())
        model.openPlanner()
        val landed = model.applyPlan(
            W,
            listOf(
                planCard("2026-09-09", "Sheet-pan chicken", "r-sheet"),
                planCard("2026-09-11", "Chili", null),
                planCard("2026-09-12", "Ramen", "r-ramen"),
            ),
        )
        assertTrue(landed)
        assertFalse(model.current.plannerOpen)
        assertEquals(3, feed.fillBodies[0]["cards"]!!.jsonArray.size)
        assertEquals(listOf("2026-09-09", "2026-09-11", "2026-09-12"), model.current.filled.map { it.date })
    }

    @Test fun `an approved week that narrows to nothing is never sent`() = runTest {
        val feed = MealsFeed()
        val model = feed.model()
        model.load(W, emptyList())
        model.openPlanner()
        val landed = model.applyPlan(W, listOf(planCard("2026-09-06", "Nope", null), planCard("2026-09-07", "Also nope", null)))
        assertFalse(landed)
        assertTrue(feed.fillBodies.isEmpty())
        assertFalse(model.current.plannerOpen)
        assertNotNull(model.current.errorMessage)
    }

    @Test fun `the empty nights become planner days that round-trip`() {
        val days = PlanningMealsPlan.plannerDays(listOf("2026-09-09", "2026-09-11", "2026-09-12"))
        assertEquals(listOf(LocalDate.of(2026, 9, 9), LocalDate.of(2026, 9, 11), LocalDate.of(2026, 9, 12)), days)
        assertEquals(listOf("2026-09-09", "2026-09-11", "2026-09-12"), days.map { it.toString() })
    }

    @Test fun `rubbish in is dropped rather than becoming some other day`() {
        assertTrue(PlanningMealsPlan.plannerDays(listOf("not-a-day", "")).isEmpty())
    }

    @Test fun `only dinners on still-empty nights travel`() {
        val cards = PlanningMealsPlan.cards(
            listOf(
                planCard("2026-09-09", "Sheet-pan chicken", "r-sheet"),
                planCard("2026-09-07", "Already decided", null),
                planCard("2026-09-11", "Lunchtime soup", null, mealType = "lunch"),
                planCard("2026-09-12", "Ramen", "r-ramen"),
            ),
            emptyDates = listOf("2026-09-09", "2026-09-11", "2026-09-12"),
        )
        assertEquals(listOf("2026-09-09", "2026-09-12"), cards.map { it.date })
        assertTrue(cards.all { it.mealType == "dinner" })
        assertEquals("r-sheet", cards[0].recipeId)
        assertEquals("Sheet-pan chicken", cards[0].title)
        val bare = PlanningMealsPlan.cards(listOf(planCard("2026-09-11", "Chili", null)), listOf("2026-09-11"))
        assertEquals(1, bare.size)
        assertNull(bare[0].recipeId)
        assertEquals("Chili", bare[0].title)
    }

    @Test fun `a card with nothing on it is dropped`() {
        assertTrue(PlanningMealsPlan.cards(listOf(planCard("2026-09-09", "   ", null)), listOf("2026-09-09")).isEmpty())
    }

    @Test fun `the note names how many nights are in play and what is left alone`() {
        assertEquals("Planning the three empty nights — the rest stay as they are.", PlanningMealsText.plannerNote(3))
        assertEquals("Planning the one empty night — the rest stay as they are.", PlanningMealsText.plannerNote(1))
    }
}
