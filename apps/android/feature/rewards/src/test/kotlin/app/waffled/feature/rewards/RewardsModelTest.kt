package app.waffled.feature.rewards

import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The rewards state holder, driven through the real API against MockWebServer.
 *
 * [RewardsModel.load] fans its three fetches out in parallel, so responses can't be
 * queued in order — this drives the server with a **path-keyed dispatcher** instead,
 * which is both deterministic and closer to what a real server does.
 */
class RewardsModelTest {

    private val harness = ApiTestHarness()
    private val refreshBus = RefreshBus()
    private lateinit var client: HttpClient
    private lateinit var model: RewardsModel

    /** Path prefix → response body. A path with no entry answers 404. */
    private val routes = linkedMapOf<String, MockResponse>()

    private fun route(prefix: String, body: String, status: Int = 200) {
        routes[prefix] = MockResponse()
            .setResponseCode(status)
            .setHeader("Content-Type", "application/json")
            .setBody(body)
    }

    @Before
    fun setUp() {
        harness.start()
        harness.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                // LONGEST prefix wins: `/api/rewards/r1/redeem` also starts with
                // `/api/rewards`, and matching in insertion order would answer a redeem
                // with the catalog.
                val hit = routes.entries
                    .filter { path.startsWith(it.key) }
                    .maxByOrNull { it.key.length }
                return hit?.value ?: MockResponse().setResponseCode(404).setBody("""{"error":"nope"}""")
            }
        }
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        model = RewardsModel(RewardsApi(client, harness.tokens), refreshBus = refreshBus)

        route("/api/balances", BALANCES)
        route("/api/rewards/archived", """{"rewards":[]}""")
        route("/api/rewards", CATALOG)
        route("/api/redemptions", PENDING)
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    // ---- loading ---------------------------------------------------------------

    @Test
    fun `load assembles the whole economy in one snapshot`() = runTest {
        model.load()

        val economy = model.economy
        assertEquals(2, economy.currencies.size)
        assertEquals(2, economy.people.size)
        assertEquals(2, economy.rewards.size)
        assertEquals(1, economy.pending.size)
        assertTrue(model.loaded)
        assertFalse(model.error)
        assertFalse(model.loading)
    }

    @Test
    fun `the catalog comes back in sort order regardless of what the server sent`() = runTest {
        model.load()

        // The fixture lists sortOrder 2 before 1 on purpose.
        assertEquals(listOf("Ice cream", "Movie night"), model.economy.rewards.map { it.title })
    }

    @Test
    fun `only spendable currencies can be priced in`() = runTest {
        model.load()

        assertEquals(listOf("stars"), model.spendableCurrencies.map { it.key })
    }

    @Test
    fun `currency and balance lookups read the one ledger`() = runTest {
        model.load()

        assertEquals("⭐", model.currency("stars")?.symbol)
        assertNull(model.currency("doubloons"))
        assertEquals(12, model.balance("p1", "stars"))
        assertEquals(3, model.balance("p1", "sticks"))
        // A person with no row for that currency, and an unknown person, are both zero.
        assertEquals(0, model.balance("p2", "sticks"))
        assertEquals(0, model.balance("nobody", "stars"))
    }

    @Test
    fun `the default currency falls back sensibly`() = runTest {
        model.load()

        assertEquals("stars", model.defaultCurrencyKey)
    }

    // ---- failure semantics -----------------------------------------------------

    @Test
    fun `a failed fetch keeps the last good economy on screen`() = runTest {
        model.load()
        assertEquals(2, model.economy.rewards.size)

        // The catalog route dies; RestDomain's contract says apply(null) keeps the prior
        // value so a flaky network never blanks the page.
        route("/api/rewards", """{"error":"boom"}""", status = 500)
        model.load()

        assertTrue(model.error)
        assertTrue(model.loaded)
        assertEquals(2, model.economy.rewards.size)
        assertFalse(model.loading)
    }

    @Test
    fun `a first load that fails outright is loaded, empty and flagged`() = runTest {
        route("/api/balances", """{"error":"boom"}""", status = 500)

        model.load()

        assertTrue(model.error)
        assertTrue(model.loaded)
        assertTrue(model.economy.people.isEmpty())
    }

    @Test
    fun `an admin-only archived list that 403s does not flag the page as broken`() = runTest {
        // /api/rewards/archived is manage-gated. A kid opening Rewards gets a 403 there
        // and must still see a perfectly healthy shop.
        route("/api/rewards/archived", """{"error":"Forbidden"}""", status = 403)

        model.load()

        assertFalse(model.error)
        assertTrue(model.economy.archived.isEmpty())
        assertEquals(2, model.economy.rewards.size)
    }

    // ---- writes ----------------------------------------------------------------

    @Test
    fun `approving a redemption tells the rest of the app rewards moved`() = runTest {
        model.load()
        val before = refreshBus.revisionOf(RefreshDomain.Rewards)
        route("/api/redemptions/x1/approve", """{"redemption":$REDEMPTION}""")

        assertTrue(model.approve("x1"))

        // Rewards aren't synced, so nothing else would ever hear about this.
        assertEquals(before + 1, refreshBus.revisionOf(RefreshDomain.Rewards))
    }

    @Test
    fun `a rejected write reports false and still refreshes`() = runTest {
        model.load()
        val before = refreshBus.revisionOf(RefreshDomain.Rewards)
        route("/api/redemptions/x1/deny", """{"error":"Forbidden"}""", status = 403)

        assertFalse(model.deny("x1"))

        // Still bumped: the server may have moved anyway, and re-reading is cheap next
        // to showing a stale approval queue.
        assertEquals(before + 1, refreshBus.revisionOf(RefreshDomain.Rewards))
    }

    @Test
    fun `redeeming debits the shown balance once the reload lands`() = runTest {
        model.load()
        assertEquals(12, model.balance("p1", "stars"))
        route("/api/rewards/r1/redeem", """{"redemption":$REDEMPTION}""")
        route("/api/balances", BALANCES.replace("\"balance\":12", "\"balance\":2"))

        assertTrue(model.redeem(rewardId = "r1", personId = "p1"))

        assertEquals(2, model.balance("p1", "stars"))
    }

    @Test
    fun `the revision advances once per write, and never on a plain reload`() = runTest {
        model.load()
        val start = model.revision.value

        // Reloading is not a change: the shop's saving-toward effect is keyed on this,
        // and a bump here would refetch the per-person overview on every pull-to-refresh.
        model.load()
        assertEquals(start, model.revision.value)

        route("/api/redemptions/x1/approve", """{"redemption":$REDEMPTION}""")
        model.approve("x1")
        assertEquals(start + 1, model.revision.value)

        // Once per write even when the write FAILED — a failed write leaves the economy
        // structurally identical, so this counter is the only signal the overview gets.
        route("/api/redemptions/x1/deny", """{"error":"nope"}""", status = 403)
        model.deny("x1")
        assertEquals(start + 2, model.revision.value)
    }

    @Test
    fun `awarding spot stars bumps and reloads`() = runTest {
        model.load()
        val before = refreshBus.revisionOf(RefreshDomain.Rewards)
        route("/api/persons/p1/award", "{}")

        assertTrue(model.awardSpot(personId = "p1", amount = 5, currency = "stars", note = "great job"))

        assertEquals(before + 1, refreshBus.revisionOf(RefreshDomain.Rewards))
    }

    @Test
    fun `catalog writes go through the same bump-and-reload path`() = runTest {
        model.load()
        route("/api/rewards", """{"reward":{"id":"r3","title":"New","cost":5,"currency":"stars"}}""")
        val before = refreshBus.revisionOf(RefreshDomain.Rewards)

        assertTrue(
            model.saveReward(
                id = null,
                title = "New",
                emoji = "🎁",
                cost = 5,
                currency = "stars",
                category = null,
                requiresApproval = true,
            ),
        )

        assertEquals(before + 1, refreshBus.revisionOf(RefreshDomain.Rewards))
    }

    // ---- fixtures --------------------------------------------------------------

    private companion object {
        const val BALANCES = """
            {"currencies":[
               {"key":"stars","label":"Stars","symbol":"⭐","color":"#F3A93B",
                "isDefault":true,"spendable":true,"sortOrder":0},
               {"key":"sticks","label":"Sticks","symbol":"🥢","color":null,
                "isDefault":false,"spendable":false,"sortOrder":1}
             ],
             "people":[
               {"personId":"p1","name":"Kid","avatarEmoji":"🙂","colorHex":"#2F7FED","stars":12,
                "balances":[{"currency":"stars","balance":12},{"currency":"sticks","balance":3}],
                "recent":[]},
               {"personId":"p2","name":"Sib","avatarEmoji":"😀","colorHex":"#E0548B","stars":4,
                "balances":[{"currency":"stars","balance":4}],"recent":[]}
             ]}
        """

        const val CATALOG = """
            {"rewards":[
              {"id":"r1","title":"Movie night","emoji":"🍿","cost":30,"currency":"stars",
               "category":"screen","sortOrder":2,"requiresApproval":true},
              {"id":"r2","title":"Ice cream","emoji":"🍦","cost":10,"currency":"stars",
               "category":"treats","sortOrder":1,"requiresApproval":false}
            ]}
        """

        const val REDEMPTION = """
            {"id":"x1","rewardId":"r1","personId":"p1","personName":"Kid","title":"Movie night",
             "emoji":"🍿","cost":30,"currency":"stars","status":"pending",
             "createdAt":"2026-08-20T10:00:00Z"}
        """

        const val PENDING = """{"redemptions":[$REDEMPTION]}"""
    }
}
