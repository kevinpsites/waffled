package app.waffled.feature.family

import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The Family slice of the API, against a real MockWebServer — every envelope it reads. */
class FamilyApiTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: FamilyApi

    @Before
    fun setUp() {
        harness.start()
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = FamilyApi(client, harness.tokens)
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    // ---- hub tile feeds ----

    @Test fun `chores today unwraps the people envelope`() = runTest {
        harness.enqueueJson("""{"people":[{"id":"p1","name":"Maya","avatarEmoji":"🦊","colorHex":"#2F7FED","total":3,"done":1,"stars":7}]}""")
        val people = api.choresToday()
        assertEquals(2, people.single().total - people.single().done)
        assertEquals("/api/chores/today", harness.takeRequest().path)
    }

    @Test fun `goals unwraps and defaults the featured flag`() = runTest {
        harness.enqueueJson("""{"goals":[{"id":"g1","isFeatured":true},{"id":"g2"}]}""")
        assertEquals(listOf(true, false), api.goals().map { it.isFeatured })
        assertEquals("/api/goals", harness.takeRequest().path)
    }

    @Test fun `family stars read the family overview`() = runTest {
        harness.enqueueJson("""{"people":[{"name":"Maya","stars":9},{"name":null,"stars":0}]}""")
        assertEquals(listOf(9, 0), api.familyStars().map { it.stars })
        assertEquals("/api/family/overview", harness.takeRequest().path)
    }

    @Test fun `lists and photos unwrap their envelopes`() = runTest {
        harness.enqueueJson("""{"lists":[{"id":"l1","name":"Grocery"}]}""")
        harness.enqueueJson("""{"photos":[{"id":"ph1","imageUrl":"/m/1.jpg","memory":"Beach"}]}""")
        assertEquals(listOf("l1"), api.lists().map { it.id })
        assertEquals("Beach", api.photos().single().memory)
        assertEquals("/api/lists", harness.takeRequest().path)
        assertEquals("/api/photos", harness.takeRequest().path)
    }

    // ---- approvals ----

    @Test fun `pending redemptions filter by status`() = runTest {
        harness.enqueueJson("""{"redemptions":[{"id":"r1","rewardId":"rw","personId":"p1","personName":"Maya","title":"Movie","cost":5,"currency":"stars","status":"pending","createdAt":"x"}]}""")
        assertEquals("Movie", api.pendingRedemptions().single().title)
        assertEquals("/api/redemptions?status=pending", harness.takeRequest().path)
    }

    @Test fun `awaiting chores read every date`() = runTest {
        harness.enqueueJson("""{"instances":[{"id":"c1","choreId":"t1","choreTitle":"Dishes","status":"awaiting","rewardAmount":2,"rewardCurrency":"stars","proofUrl":"/media/p.jpg","hadProof":true}]}""")
        val c = api.awaitingChores().single()
        assertEquals("Dishes", c.choreTitle)
        assertTrue(c.hadProof)
        assertEquals("/api/chore-instances/awaiting", harness.takeRequest().path)
    }

    @Test fun `approval writes post to their routes`() = runTest {
        repeat(4) { harness.enqueueJson("{}") }
        api.approveRedemption("r1")
        api.denyRedemption("r2")
        api.approveChore("c1")
        api.rejectChore("c2")
        assertEquals("/api/redemptions/r1/approve", harness.takeRequest().path)
        assertEquals("/api/redemptions/r2/deny", harness.takeRequest().path)
        val approve = harness.takeRequest()
        assertEquals("/api/chore-instances/c1/approve", approve.path)
        assertEquals("POST", approve.method)
        assertEquals("/api/chore-instances/c2/reject", harness.takeRequest().path)
    }

    @Test fun `a refused approval relays the server message`() = runTest {
        harness.enqueueError(403, "Forbidden", "You can't approve chores")
        val e = assertFailsWith<WaffledApiException> { api.approveChore("c1") }
        assertEquals("You can't approve chores", e.userMessage)
    }

    // ---- the person spotlight ----

    @Test fun `chore instances for a day and the check-off writes`() = runTest {
        harness.enqueueJson("""{"instances":[]}""")
        harness.enqueueJson("{}")
        harness.enqueueJson("{}")
        api.choreInstances("2026-10-07")
        api.completeChore("c1")
        api.uncompleteChore("c1")
        assertEquals("/api/chore-instances/today?date=2026-10-07", harness.takeRequest().path)
        assertEquals("/api/chore-instances/c1/complete", harness.takeRequest().path)
        assertEquals("/api/chore-instances/c1/uncomplete", harness.takeRequest().path)
    }

    @Test fun `person overview decodes the spotlight and keeps the raw payload`() = runTest {
        harness.enqueueJson(OVERVIEW_JSON)
        val o = api.personOverview("p1")

        assertEquals("/api/persons/p1/overview", harness.takeRequest().path)
        assertEquals("Maya Lopez", o.person.name)
        assertEquals(9, o.person.age)
        assertEquals(4, o.topStreak)
        assertEquals(listOf("sticks", "stars"), o.currencies.map { it.key })
        assertEquals(12, o.balances.first { it.currency == "stars" }.balance)
        assertEquals("Read 20 books", o.goals.single().title)
        assertNull(o.goals.single().pct)
        assertEquals(2, o.categoryBalance.size)
        assertEquals("Leaning on health.", o.insight?.text)
        assertEquals("spot award — so helpful", o.recentLedger[1].label)
        assertEquals("approved", o.redemptions.single().status)
        // The raw object is what the rewards slot decodes its own wire type from.
        assertNotNull(o.raw?.get("savingToward"))
        assertNotNull(o.raw?.get("rewardShop"))
    }

    @Test fun `planning focus decodes when present`() = runTest {
        harness.enqueueJson(OVERVIEW_JSON.replace(
            "\"planningFocus\":null",
            "\"planningFocus\":{\"emoji\":\"📚\",\"label\":\"Read 20 minutes a day\",\"detail\":\"3 of 20 books\",\"weekStart\":\"2026-09-06\"}",
        ))
        val focus = api.personOverview("p1").planningFocus
        assertEquals("Read 20 minutes a day", focus?.label)
        assertEquals("3 of 20 books", focus?.detail)
        assertEquals("2026-09-06", focus?.weekStart)
    }

    @Test fun `planning focus is null when null or absent`() = runTest {
        harness.enqueueJson(OVERVIEW_JSON)
        harness.enqueueJson(OVERVIEW_JSON.replace(",\"planningFocus\":null", ""))
        assertNull(api.personOverview("p1").planningFocus)
        assertNull(api.personOverview("p1").planningFocus)
    }

    @Test fun `a malformed planning focus never fails the whole spotlight`() = runTest {
        harness.enqueueJson(OVERVIEW_JSON.replace("\"planningFocus\":null", "\"planningFocus\":\"soon\""))
        val o = api.personOverview("p1")
        assertEquals("Maya Lopez", o.person.name)
        assertNull(o.planningFocus)
    }

    @Test fun `a minimal overview from an older server still decodes`() = runTest {
        harness.enqueueJson("""{"person":{"id":"p1","name":"Leo"}}""")
        val o = api.personOverview("p1")
        assertEquals("Leo", o.person.name)
        assertTrue(o.goals.isEmpty())
        assertNull(o.insight)
    }

    private companion object {
        val OVERVIEW_JSON = """
            {"person":{"id":"p1","name":"Maya Lopez","avatarEmoji":"🦊","colorHex":"#2F7FED","age":9,"memberType":"kid"},
             "activeGoals":1,"topStreak":4,"stars":12,
             "currencies":[
               {"key":"sticks","label":"Sticks","symbol":"🥢","color":null,"isDefault":false,"sortOrder":1},
               {"key":"stars","label":"Stars","symbol":"⭐","color":"#F3A93B","isDefault":true,"sortOrder":0}],
             "balances":[{"currency":"stars","balance":12},{"currency":"sticks","balance":3}],
             "goals":[{"id":"g1","title":"Read 20 books","emoji":"📚","category":"mind","unit":"books",
               "goalType":"total","progress":3,"target":null,"pct":null,"streakDays":2}],
             "categoryBalance":[
               {"category":"health","emoji":"💪","label":"Health","goalCount":1,"avgPct":40},
               {"category":"mind","emoji":"🧠","label":"Mind","goalCount":0,"avgPct":0}],
             "insight":{"lean":["health"],"light":["mind"],"suggestions":[],"text":"Leaning on health."},
             "recentLedger":[
               {"amount":2,"reason":"chore_completed","currency":"stars","detail":"Dishes","note":null,"createdAt":"a"},
               {"amount":5,"reason":"spot_award","currency":"stars","detail":null,"note":" so helpful ","createdAt":"b"}],
             "redemptions":[{"id":"rd1","title":"Movie","emoji":"🎬","cost":5,"currency":"stars","status":"approved","createdAt":"c"}],
             "rewardShop":[{"id":"rw1","title":"Movie","emoji":"🎬","cost":30,"have":12,"toGo":18,"currency":"stars"}],
             "savingToward":{"id":"rw1","title":"Movie","emoji":"🎬","cost":30,"have":12,"toGo":18,"pct":40,"currency":"stars"},
             "streak":{"current":2},
             "planningFocus":null}
        """.trimIndent().replace("\n", "")
    }
}
