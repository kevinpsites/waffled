package app.waffled.feature.capture

import app.waffled.core.model.Capability
import app.waffled.core.model.Currency
import app.waffled.core.model.Person
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

import java.time.ZoneId
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Records every call; each answer is configurable per test. */
private class FakeService : CaptureService {
    val calls = mutableListOf<String>()
    private val log = mutableListOf<Pair<String, Map<String, Any?>>>()
    var parseResult: CaptureParseResult? = null
    var parseGate: CompletableDeferred<Unit>? = null
    var resolveResult: CaptureResolveResponse? = CaptureResolveResponse()
    var commitMessage = "Done"
    var failWith: Exception? = null
    var lists = listOf(CaptureList("g", "Groceries", listType = "grocery"), CaptureList("c", "Camping", listType = "custom"))
    var recipes = listOf(CaptureRecipeRef("r1", "Tacos"), CaptureRecipeRef("r2", "Fish tacos"))

    private fun record(name: String, body: Map<String, Any?> = emptyMap()) {
        calls += name
        log += name to body
        failWith?.let { throw it }
    }

    override suspend fun parse(text: String): CaptureParseResult {
        calls += "parse"
        parseGate?.await()
        return parseResult ?: throw WaffledApiException(503, "offline")
    }
    override suspend fun warm() { calls += "warm" }
    override suspend fun resolve(verb: String, targetKind: String?, description: String, args: Map<String, JsonElement>): CaptureResolveResponse {
        calls += "resolve"
        log += "resolve" to mapOf("verb" to verb, "targetKind" to targetKind, "description" to description, "args" to args)
        return resolveResult ?: throw WaffledApiException(503, "offline")
    }
    override suspend fun commitMutate(verb: String, targetKind: String?, targetId: String, args: Map<String, JsonElement>, meta: Map<String, JsonElement>?): String {
        record("commitMutate", mapOf("targetId" to targetId, "meta" to meta))
        return commitMessage
    }
    override suspend fun lists() = lists.also { calls += "lists" }
    override suspend fun currencies() = listOf(Currency("stars", "Stars", "★")).also { calls += "currencies" }
    override suspend fun recipes() = recipes.also { calls += "recipes" }
    override suspend fun createEvent(title: String, startsAtIso: String, endsAtIso: String?, allDay: Boolean, personIds: List<String>, timezone: String?, rrule: String?, recurrenceEndAt: String?) =
        record("createEvent", mapOf("title" to title, "startsAt" to startsAtIso, "endsAt" to endsAtIso, "allDay" to allDay, "personIds" to personIds, "rrule" to rrule, "until" to recurrenceEndAt))
    override suspend fun addGroceryItem(name: String) = record("addGroceryItem", mapOf("name" to name))
    override suspend fun createChore(title: String, personId: String?, rewardAmount: Int?, rewardCurrency: String?, rrule: String?) =
        record("createChore", mapOf("title" to title, "personId" to personId, "rewardAmount" to rewardAmount, "rrule" to rrule))
    override suspend fun planMeal(date: String, mealType: String, recipeId: String?, title: String?) =
        record("planMeal", mapOf("date" to date, "mealType" to mealType, "recipeId" to recipeId, "title" to title))
    override suspend fun createList(name: String): CaptureList {
        record("createList", mapOf("name" to name))
        return CaptureList("new", name)
    }
    override suspend fun addListItem(listId: String, name: String, quantity: String?) =
        record("addListItem", mapOf("listId" to listId, "name" to name, "quantity" to quantity))
    override suspend fun createCountdown(title: String, date: String, emoji: String?) =
        record("createCountdown", mapOf("title" to title, "date" to date, "emoji" to emoji))
    override suspend fun createPerson(name: String, memberType: String, avatarEmoji: String?, birthday: String?, isAdmin: Boolean) =
        record("createPerson", mapOf("name" to name, "memberType" to memberType))
    override suspend fun createGoal(title: String, goalType: String, trackingMode: String, targetValue: Double?, unit: String?, deadline: String?, participantIds: List<String>) =
        record("createGoal", mapOf("title" to title, "goalType" to goalType, "targetValue" to targetValue, "unit" to unit, "deadline" to deadline, "participantIds" to participantIds))
    override suspend fun createPantryItem(name: String, amount: String?, unit: String?, location: String, expiresOn: String?, lowAt: Double?) =
        record("createPantryItem", mapOf("name" to name, "location" to location))
    override suspend fun createReward(title: String, emoji: String?, cost: Int?, requiresApproval: Boolean?) =
        record("createReward", mapOf("title" to title, "cost" to cost))

    fun last(name: String): Map<String, Any?> = log.last { it.first == name }.second
}

private val zone = ZoneId.of("America/Denver")

// Thursday, June 11 2026, 9:00 AM in Denver — the parser suite's pinned "now".
private val now: Instant = LocalDate.of(2026, 6, 11).atTime(9, 0).atZone(zone).toInstant()

private val kevin = Person(id = "p-kevin", name = "Kevin", isAdmin = true)
private val wally = Person(id = "p-wally", name = "Wally", memberType = "kid")

private fun env(
    current: Person = kevin,
    goalsOn: Boolean = true,
    pantryOn: Boolean = true,
    rewardsOn: Boolean = true,
) = CaptureEnvironment(listOf(kevin, wally), current.id, zone, goalsOn, pantryOn, rewardsOn)

private class Rig(scope: TestScope, environment: CaptureEnvironment = env()) {
    val service = FakeService()
    val bus = RefreshBus()
    val model = CaptureModel(service, scope, bus) { now }.also { it.updateEnvironment(environment) }
    val s get() = model.state.value
}

private fun TestScope.rig(environment: CaptureEnvironment = env()) = Rig(this, environment)

private fun TestScope.typeAndParse(r: Rig, text: String) {
    r.model.setText(text)
    r.model.parse()
    advanceUntilIdle()
}

class CaptureModelParseTest {

    @Test fun `a confident local guess shows at once and the LLM's agreeing read replaces it`() = runTest {
        val r = rig()
        val gate = CompletableDeferred<Unit>()
        r.service.parseGate = gate
        r.service.parseResult = CaptureParseResult(CaptureIntent.Grocery("Almond milk", "2"), "anthropic", false)
        r.model.setText("buy almond milk")
        r.model.parse()
        advanceUntilIdle()
        assertEquals(CapturePhase.Preview, r.s.phase)
        assertEquals("on-device", r.s.via)
        assertTrue(r.s.thinking)

        gate.complete(Unit)
        advanceUntilIdle()
        assertEquals("anthropic", r.s.via)
        assertEquals("2", r.s.draft.quantity)
        assertFalse(r.s.thinking)
        assertNull(r.s.serverAlt)
    }

    @Test fun `a disagreeing LLM is offered as the alternative and the toggle swaps both ways`() = runTest {
        val r = rig()
        r.service.parseResult = CaptureParseResult(CaptureIntent.Task("Soccer", null, null, null, ""), "anthropic", false)
        typeAndParse(r, "Soccer Tue 4pm for Wally")
        assertEquals("event", r.s.draft.kind)
        assertEquals("task", r.s.serverAlt?.kind)
        assertEquals("Claude", r.s.altProviderLabel)

        r.model.switchToAlt()
        assertEquals("task", r.s.draft.kind)
        assertEquals("anthropic", r.s.via)
        assertEquals("event", r.s.serverAlt?.kind)
        assertEquals("The on-device guess", r.s.altProviderLabel)
    }

    @Test fun `a weak local guess waits for the server and falls back to it when the server can't help`() = runTest {
        val r = rig()
        r.service.parseResult = CaptureParseResult(null, "heuristic", true)
        r.model.setText("milk")
        r.model.parse()
        assertEquals(CapturePhase.Parsing, r.s.phase)
        advanceUntilIdle()
        assertEquals(CapturePhase.Preview, r.s.phase)
        assertEquals("on-device", r.s.via)
        assertEquals("Milk", r.s.draft.name)
    }

    @Test fun `nothing understood anywhere returns to input with a message`() = runTest {
        val r = rig()
        typeAndParse(r, ",")
        assertEquals(CapturePhase.Input, r.s.phase)
        assertEquals("Couldn’t understand that — try rephrasing.", r.s.error)
    }

    @Test fun `the heuristic's recurrence survives an LLM one-off of the same event`() = runTest {
        val r = rig()
        r.service.parseResult = CaptureParseResult(
            CaptureIntent.Event("Soccer practice", "2026-06-16T22:00:00Z", false, "Wally", null, "", ""), "ollama", false,
        )
        typeAndParse(r, "soccer every Tuesday at 4pm for Wally")
        assertEquals("Soccer practice", r.s.draft.name)
        assertEquals(CaptureRepeatFreq.Weekly, r.s.draft.repeat.freq)
        assertEquals(listOf("TU"), r.s.draft.repeat.byday)
    }

    @Test fun `a server answer for text the user has since changed is dropped`() = runTest {
        val r = rig()
        val gate = CompletableDeferred<Unit>()
        r.service.parseGate = gate
        r.service.parseResult = CaptureParseResult(CaptureIntent.Grocery("Eggs", null), "anthropic", false)
        r.model.setText("milk")
        r.model.parse()
        r.model.setText("milk and bread")
        gate.complete(Unit)
        advanceUntilIdle()
        assertFalse(r.s.thinking)
        // Back to input rather than stuck on a busy "Thinking…" button.
        assertEquals(CapturePhase.Input, r.s.phase)
        assertEquals("", r.s.draft.name)
    }

    @Test fun `an event with no named person defaults to the viewer`() = runTest {
        val r = rig()
        typeAndParse(r, "Dentist tomorrow")
        assertEquals("Kevin", r.s.draft.person)
        assertEquals(LocalDate.of(2026, 6, 12), r.s.draft.eventDate)
        assertTrue(r.s.draft.allDay)
    }

    @Test fun `opening warms the model and loads the pickers`() = runTest {
        val r = rig()
        r.model.onOpen()
        advanceUntilIdle()
        assertTrue(r.service.calls.containsAll(listOf("warm", "lists", "currencies")))
        assertEquals(2, r.s.lists.size)
    }
}

class CaptureModelCommitTest {

    @Test fun `grocery folds the quantity into the label, bumps lists and finishes`() = runTest {
        val r = rig()
        typeAndParse(r, "2 lbs chicken thighs")
        r.model.commit()
        advanceUntilIdle()
        assertEquals("Chicken thighs (2 lbs)", r.service.last("addGroceryItem")["name"])
        assertEquals(1, r.bus.revisionOf(RefreshDomain.Lists))
        assertTrue(r.s.done)
    }

    @Test fun `task resolves the assignee and sends no zero reward`() = runTest {
        val r = rig()
        typeAndParse(r, "remind take out the trash for Wally")
        r.model.commit()
        advanceUntilIdle()
        val b = r.service.last("createChore")
        assertEquals("p-wally", b["personId"])
        assertNull(b["rewardAmount"])
        assertEquals(1, r.bus.revisionOf(RefreshDomain.Chores))
    }

    @Test fun `an unknown named list is created on the fly`() = runTest {
        val r = rig()
        typeAndParse(r, "add sunscreen to the packing list")
        r.model.commit()
        advanceUntilIdle()
        assertEquals("Packing", r.service.last("createList")["name"])
        assertEquals("new", r.service.last("addListItem")["listId"])
    }

    @Test fun `a meal links an exactly-titled recipe on the parsed day`() = runTest {
        val r = rig()
        r.service.parseResult = CaptureParseResult(CaptureIntent.Meal("tacos", "2026-06-12", "lunch", ""), "anthropic", false)
        typeAndParse(r, "tacos for lunch on Friday")
        r.model.commit()
        advanceUntilIdle()
        val b = r.service.last("planMeal")
        assertEquals("r1", b["recipeId"])
        assertNull(b["title"])
        assertEquals("2026-06-12", b["date"])
        assertEquals("lunch", b["mealType"])
    }

    @Test fun `an all-day event commits at local noon with no end`() = runTest {
        val r = rig()
        typeAndParse(r, "Dentist tomorrow")
        r.model.commit()
        advanceUntilIdle()
        val b = r.service.last("createEvent")
        assertEquals("2026-06-12T18:00:00Z", b["startsAt"])
        assertNull(b["endsAt"])
        assertEquals(listOf("p-kevin"), b["personIds"])
    }

    @Test fun `a timed recurring event ends an hour later and carries its rule and end date`() = runTest {
        val r = rig()
        typeAndParse(r, "soccer every Tuesday at 4pm for Wally")
        r.model.updateDraft { it.copy(untilOn = true, until = LocalDate.of(2026, 8, 31)) }
        r.model.commit()
        advanceUntilIdle()
        val b = r.service.last("createEvent")
        assertEquals("2026-06-16T22:00:00Z", b["startsAt"])
        assertEquals("2026-06-16T23:00:00Z", b["endsAt"])
        assertEquals("FREQ=WEEKLY;BYDAY=TU", b["rrule"])
        assertEquals("2026-09-01T05:59:00Z", b["until"])
        assertEquals(listOf("p-wally"), b["personIds"])
    }

    @Test fun `a non-admin cannot add a family member and nothing is sent`() = runTest {
        val r = rig(env(current = wally))
        typeAndParse(r, "add my son Max")
        assertTrue(r.s.personBlocked)
        assertFalse(r.s.canCommit)
        r.model.commit()
        advanceUntilIdle()
        assertFalse("createPerson" in r.service.calls)
        assertEquals("Only an adult can add family members.", r.s.error)
    }

    @Test fun `pantry is suppressed while the module is off`() = runTest {
        val r = rig(env(pantryOn = false))
        typeAndParse(r, "put 2 cans of beans in the pantry")
        assertTrue(r.s.pantryBlocked)
        r.model.commit()
        advanceUntilIdle()
        assertFalse("createPantryItem" in r.service.calls)
        assertEquals("The Pantry module is turned off. Turn it on in Settings → Modules.", r.s.error)
    }

    @Test fun `reward has two gates with their own reasons`() = runTest {
        val off = rig(env(rewardsOn = false))
        typeAndParse(off, "reward: movie night")
        assertEquals("Rewards are turned off.", off.s.rewardBlockedReason)

        val kid = rig(env(current = wally))
        typeAndParse(kid, "reward: movie night")
        assertTrue(kid.s.rewardBlocked)
        assertEquals("Ask a parent to add a reward.", kid.s.rewardBlockedReason)

        val ok = rig()
        typeAndParse(ok, "add a reward: ice cream night for 50 stars")
        ok.model.commit()
        advanceUntilIdle()
        assertEquals(50, ok.service.last("createReward")["cost"])
        assertEquals(1, ok.bus.revisionOf(RefreshDomain.Rewards))
    }

    @Test fun `a measured goal without a number downgrades to a habit`() = runTest {
        val r = rig()
        typeAndParse(r, "set a goal to read 20 books")
        r.model.updateDraft { it.copy(goalTarget = "") }
        r.model.commit()
        advanceUntilIdle()
        val b = r.service.last("createGoal")
        assertEquals("habit", b["goalType"])
        assertNull(b["targetValue"])
        assertNull(b["unit"])
        assertEquals(listOf("p-kevin"), b["participantIds"])
    }

    @Test fun `everyone means every member, but only for a goal manager`() = runTest {
        val r = rig()
        typeAndParse(r, "set a family goal to walk 30 min per day")
        assertTrue(r.s.draft.goalEveryone)
        r.model.commit()
        advanceUntilIdle()
        assertEquals(listOf("p-kevin", "p-wally"), r.service.last("createGoal")["participantIds"])

        val kid = rig(env(current = wally))
        typeAndParse(kid, "set a family goal to walk 30 min per day")
        assertFalse(kid.s.draft.goalEveryone)
        assertFalse(kid.s.environment.can(Capability.GOAL_MANAGE))
    }

    @Test fun `goals off blocks the commit`() = runTest {
        val r = rig(env(goalsOn = false))
        typeAndParse(r, "set a goal to read 20 books")
        assertTrue(r.s.goalBlocked)
        assertFalse(r.s.canCommit)
    }

    @Test fun `a server refusal is relayed and the preview stays up`() = runTest {
        val r = rig()
        typeAndParse(r, "12 days until Disney")
        r.service.failWith = WaffledApiException(400, "Date must be in the future")
        r.model.commit()
        advanceUntilIdle()
        assertEquals("Date must be in the future", r.s.error)
        assertEquals(CapturePhase.Preview, r.s.phase)
        assertFalse(r.s.done)
    }

    @Test fun `countdown commits the parsed day`() = runTest {
        val r = rig()
        typeAndParse(r, "12 days until Disney")
        r.model.commit()
        advanceUntilIdle()
        assertEquals("2026-06-23", r.service.last("createCountdown")["date"])
    }
}

class CaptureModelMutateTest {

    @Test fun `a mutate resolves, auto-picks a lone candidate and commits with its meta`() = runTest {
        val r = rig()
        r.service.resolveResult = CaptureResolveResponse(
            listOf(CaptureCandidate("c1", "Reading", meta = mapOf("occ" to JsonPrimitive("x")))),
        )
        typeAndParse(r, "log 20 min on my reading goal")
        assertEquals("mutate", r.s.draft.kind)
        assertEquals("log", r.service.last("resolve")["verb"])
        assertEquals("c1", r.s.mutateChosenId)
        assertEquals("+20 minutes", r.s.mutateArgsSummary)

        r.model.commit()
        advanceUntilIdle()
        assertEquals(mapOf("occ" to JsonPrimitive("x")), r.service.last("commitMutate")["meta"])
        assertEquals(1, r.bus.revisionOf(RefreshDomain.Goals))
        assertTrue(r.s.done)
    }

    @Test fun `several candidates wait for a pick and commit refuses without one`() = runTest {
        val r = rig()
        r.service.resolveResult = CaptureResolveResponse(listOf(CaptureCandidate("a", "Trash"), CaptureCandidate("b", "Trash (Wed)")))
        typeAndParse(r, "mark the trash chore done")
        assertNull(r.s.mutateChosenId)
        r.model.commit()
        advanceUntilIdle()
        assertFalse("commitMutate" in r.service.calls)
        r.model.chooseCandidate("b")
        r.model.commit()
        advanceUntilIdle()
        assertEquals("b", r.service.last("commitMutate")["targetId"])
    }

    @Test fun `a resolve that fails is the offline degrade`() = runTest {
        val r = rig()
        r.service.resolveResult = null
        typeAndParse(r, "delete the dentist appointment")
        assertTrue(r.s.mutateState!!.offline)
    }

    @Test fun `a failed mutate commit keeps the picker up with the server's reason`() = runTest {
        val r = rig()
        r.service.resolveResult = CaptureResolveResponse(listOf(CaptureCandidate("c1", "Soccer")))
        typeAndParse(r, "move soccer to Thursday 4pm")
        assertEquals("→ Thu, Jun 11 · 4:00 PM", r.s.mutateArgsSummary)
        r.service.failWith = WaffledApiException(409, "That occurrence is already settled.")
        r.model.commit()
        advanceUntilIdle()
        assertEquals("That occurrence is already settled.", r.s.error)
        assertEquals(CapturePhase.Preview, r.s.phase)
    }
}

class CaptureModelCopyTest {

    @Test fun `glance detail per kind`() = runTest {
        val r = rig()
        typeAndParse(r, "Soccer Tue 4pm for Wally")
        assertEquals("Tue, Jun 16 · 4:00 PM", r.s.glanceDetail)

        typeAndParse(r, "soccer every Tuesday at 4pm for Wally")
        assertEquals("Tue, Jun 16 · 4:00 PM · 🔁 Every week on Tue", r.s.glanceDetail)

        typeAndParse(r, "chore walk the dog for Kelly 5 stars")
        assertEquals("Up for grabs · 5 stars", r.s.glanceDetail)

        typeAndParse(r, "set a goal to read 20 books this year")
        assertEquals("Count · 20 books · by Dec 31", r.s.glanceDetail)

        typeAndParse(r, "put 2 cans of beans in the pantry")
        assertEquals("Adds to Pantry", r.s.glanceDetail)
    }

    @Test fun `labels follow the kind and provider`() = runTest {
        val r = rig()
        typeAndParse(r, "Dentist tomorrow")
        assertEquals("Add event", r.s.addLabel)
        assertEquals("Event title", r.s.namePlaceholder)
        assertEquals("on device", r.s.viaLabel)
        r.model.updateDraft { it.copy(kind = "pantry") }
        assertEquals("Add to pantry", r.s.addLabel)
    }

    @Test fun `a list commit needs a target list`() = runTest {
        val r = rig()
        typeAndParse(r, "milk")
        r.model.updateDraft { it.copy(kind = "list", listName = "") }
        assertFalse(r.s.canCommit)
    }

    @Test fun `reset clears the last parse`() = runTest {
        val r = rig()
        typeAndParse(r, "Dentist tomorrow")
        r.model.reset()
        assertEquals("", r.s.text)
        assertEquals(CapturePhase.Input, r.s.phase)
        assertEquals(CaptureDraft(), r.s.draft)
    }
}
