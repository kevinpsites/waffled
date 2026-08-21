package app.waffled.feature.rewards

import app.waffled.core.network.WaffledApiException
import app.waffled.core.network.WaffledHttp
import app.waffled.core.testing.ApiTestHarness
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The rewards API slice, driven against a real MockWebServer through [ApiTestHarness].
 *
 * The load-bearing assertions here are the **explicit nulls**. `WaffledJson` sets
 * `explicitNulls = false`, so a nullable data-class property is *omitted* from the body
 * — which silently turns "clear this" into "leave it alone". Three reward writes depend
 * on a null actually reaching the server (clearing an emoji, clearing a category,
 * un-pinning a saving-toward), so each one asserts on the raw request body.
 */
class RewardsApiTest {

    private val harness = ApiTestHarness()
    private lateinit var client: HttpClient
    private lateinit var api: RewardsApi

    @Before
    fun setUp() {
        harness.start()
        // `ApiTestHarness`'s KDoc shows a one-argument API constructor; the real slices
        // take (client, tokens) so the 401 replay can name the token that failed.
        client = WaffledHttp.client(harness.tokens, harness.serverAddress)
        api = RewardsApi(client, harness.tokens)
    }

    @After
    fun tearDown() {
        client.close()
        harness.stop()
    }

    // ---- catalog ---------------------------------------------------------------

    @Test
    fun `catalog unwraps the rewards envelope`() = runTest {
        harness.enqueueJson(
            """
            {"rewards":[
              {"id":"r1","title":"Movie night","emoji":"🍿","cost":30,"currency":"stars",
               "category":"screen","sortOrder":1,"requiresApproval":true},
              {"id":"r2","title":"Ice cream","emoji":null,"cost":10,"currency":"stars",
               "category":null,"sortOrder":0,"requiresApproval":false}
            ]}
            """.trimIndent(),
        )

        val rewards = api.catalog()

        assertEquals(2, rewards.size)
        assertEquals("Movie night", rewards[0].title)
        assertEquals(30, rewards[0].cost)
        assertEquals("screen", rewards[0].category)
        assertTrue(rewards[0].requiresApproval)
        assertNull(rewards[1].emoji)
        assertNull(rewards[1].category)
        assertEquals("/api/rewards", harness.takeRequest().path)
    }

    @Test
    fun `archived rewards come from their own route`() = runTest {
        harness.enqueueJson("""{"rewards":[{"id":"r9","title":"Old","cost":5,"currency":"stars"}]}""")

        val archived = api.archivedRewards()

        assertEquals("r9", archived.single().id)
        assertEquals("/api/rewards/archived", harness.takeRequest().path)
    }

    @Test
    fun `creating a reward sends an explicit null for a cleared emoji and category`() = runTest {
        harness.enqueueJson("""{"reward":{"id":"r3","title":"Park trip","cost":20,"currency":"stars"}}""")

        val created = api.createReward(
            title = "Park trip",
            emoji = null,
            cost = 20,
            currency = "stars",
            category = null,
            requiresApproval = false,
        )

        assertEquals("r3", created.id)
        val request = harness.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/rewards", request.path)
        val body = request.body.readUtf8()
        // The whole point: these keys must be PRESENT and null, not absent.
        assertContains(body, "\"emoji\":null")
        assertContains(body, "\"category\":null")
        assertContains(body, "\"requiresApproval\":false")
    }

    @Test
    fun `updating a reward patches and can clear the category`() = runTest {
        harness.enqueueJson("""{"reward":{"id":"r1","title":"Movie","cost":30,"currency":"stars"}}""")

        api.updateReward(
            id = "r1",
            title = "Movie",
            emoji = "🍿",
            cost = 30,
            currency = "stars",
            category = null,
            requiresApproval = true,
        )

        val request = harness.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("/api/rewards/r1", request.path)
        val body = request.body.readUtf8()
        assertContains(body, "\"emoji\":\"🍿\"")
        assertContains(body, "\"category\":null")
    }

    @Test
    fun `archiving is a DELETE with no body to decode`() = runTest {
        harness.enqueueJson("", status = 204)

        api.archiveReward("r1")

        val request = harness.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/api/rewards/r1", request.path)
    }

    @Test
    fun `restoring an archived reward posts to its restore route`() = runTest {
        harness.enqueueJson("""{"reward":{"id":"r9","title":"Old","cost":5,"currency":"stars"}}""")

        assertEquals("r9", api.restoreReward("r9").id)
        assertEquals("/api/rewards/r9/restore", harness.takeRequest().path)
    }

    // ---- balances --------------------------------------------------------------

    @Test
    fun `the balances summary carries the currency catalog and every person's ledger`() = runTest {
        harness.enqueueJson(
            """
            {"currencies":[
               {"key":"stars","label":"Stars","symbol":"⭐","color":"#F3A93B",
                "isDefault":true,"spendable":true,"sortOrder":0},
               {"key":"sticks","label":"Sticks","symbol":"🥢","color":null,
                "isDefault":false,"spendable":false,"sortOrder":1}
             ],
             "people":[
               {"personId":"p1","name":"Kid","avatarEmoji":"🙂","colorHex":"#2F7FED","stars":12,
                "balances":[{"currency":"stars","balance":12},{"currency":"sticks","balance":3}],
                "recent":[{"amount":5,"reason":"spot_award","currency":"stars",
                           "createdAt":"2026-08-20T10:00:00Z"}]}
             ]}
            """.trimIndent(),
        )

        val summary = api.balances()

        assertEquals(2, summary.currencies.size)
        assertTrue(summary.currencies[0].isDefault)
        assertFalse(summary.currencies[1].spendable)
        val kid = summary.people.single()
        assertEquals(12, RewardsMath.balanceOf(kid, "stars"))
        assertEquals(3, RewardsMath.balanceOf(kid, "sticks"))
        assertEquals("spot_award", kid.recent.single().reason)
        assertEquals("/api/balances", harness.takeRequest().path)
    }

    // ---- redemptions -----------------------------------------------------------

    @Test
    fun `pending redemptions filter by status on the query string`() = runTest {
        harness.enqueueJson(
            """
            {"redemptions":[
              {"id":"x1","rewardId":"r1","personId":"p1","personName":"Kid","personAvatar":"🙂",
               "personColor":"#2F7FED","title":"Movie night","emoji":"🍿","cost":30,
               "currency":"stars","status":"pending","decidedAt":null,
               "createdAt":"2026-08-20T10:00:00Z"}
            ]}
            """.trimIndent(),
        )

        val pending = api.redemptions(status = "pending")

        assertEquals("Kid", pending.single().personName)
        assertEquals("pending", pending.single().status)
        assertEquals("/api/redemptions?status=pending", harness.takeRequest().path)
    }

    @Test
    fun `redemptions with no filter skip the query string entirely`() = runTest {
        harness.enqueueJson("""{"redemptions":[]}""")

        assertTrue(api.redemptions().isEmpty())
        assertEquals("/api/redemptions", harness.takeRequest().path)
    }

    @Test
    fun `redeeming posts the person against the reward`() = runTest {
        harness.enqueueJson(
            """{"redemption":{"id":"x2","rewardId":"r1","personId":"p1","title":"Movie night",
                "cost":30,"currency":"stars","status":"pending","createdAt":"2026-08-20T10:00:00Z"}}""",
        )

        val redemption = api.redeem(rewardId = "r1", personId = "p1")

        assertEquals("pending", redemption.status)
        val request = harness.takeRequest()
        assertEquals("/api/rewards/r1/redeem", request.path)
        assertContains(request.body.readUtf8(), "\"personId\":\"p1\"")
    }

    @Test
    fun `approve and deny hit their own routes`() = runTest {
        val body = """{"redemption":{"id":"x1","rewardId":"r1","personId":"p1","title":"Movie",
            "cost":30,"currency":"stars","status":"approved","createdAt":"2026-08-20T10:00:00Z"}}"""
        harness.enqueueJson(body)
        assertEquals("approved", api.approveRedemption("x1").status)
        assertEquals("/api/redemptions/x1/approve", harness.takeRequest().path)

        harness.enqueueJson(body.replace("approved", "denied"))
        assertEquals("denied", api.denyRedemption("x1").status)
        assertEquals("/api/redemptions/x1/deny", harness.takeRequest().path)
    }

    // ---- spot awards + saving toward -------------------------------------------

    @Test
    fun `a spot award posts amount, currency and note`() = runTest {
        harness.enqueueJson("{}")

        api.awardSpot(personId = "p1", amount = 5, currency = "stars", note = "so helpful")

        val request = harness.takeRequest()
        assertEquals("/api/persons/p1/award", request.path)
        val body = request.body.readUtf8()
        assertContains(body, "\"amount\":5")
        assertContains(body, "\"currency\":\"stars\"")
        assertContains(body, "\"note\":\"so helpful\"")
    }

    @Test
    fun `a spot award omits a blank note rather than sending an empty string`() = runTest {
        harness.enqueueJson("{}")

        api.awardSpot(personId = "p1", amount = 5, currency = null, note = "   ")

        val body = harness.takeRequest().body.readUtf8()
        assertContains(body, "\"amount\":5")
        assertFalse(body.contains("note"), "a blank note must not be sent at all: $body")
        assertFalse(body.contains("currency"), "a null currency lets the server pick the default: $body")
    }

    @Test
    fun `clearing the saving-toward pin sends an explicit null rewardId`() = runTest {
        harness.enqueueJson("{}")

        api.setSavingToward(personId = "p1", rewardId = null)

        val request = harness.takeRequest()
        assertEquals("/api/persons/p1/saving-toward", request.path)
        // Omitting the key would leave the old pin in place — the exact failure the
        // `explicitNulls = false` trap produces.
        assertContains(request.body.readUtf8(), "\"rewardId\":null")
    }

    @Test
    fun `pinning a saving-toward sends the reward id`() = runTest {
        harness.enqueueJson("{}")

        api.setSavingToward(personId = "p1", rewardId = "r1")

        assertContains(harness.takeRequest().body.readUtf8(), "\"rewardId\":\"r1\"")
    }

    // ---- person overview -------------------------------------------------------

    @Test
    fun `the person overview decodes only the reward slice it needs`() = runTest {
        // The real route returns goals, insights, streaks and more. Decoding a subset is
        // safe because WaffledJson ignores unknown keys — and it keeps the Family
        // module's ownership of the rest of that payload intact.
        harness.enqueueJson(
            """
            {"person":{"id":"p1","name":"Kid"},"stars":12,"topStreak":4,
             "goals":[{"id":"g1","title":"Read"}],
             "currencies":[{"key":"stars","label":"Stars","symbol":"⭐","isDefault":true,"sortOrder":0}],
             "balances":[{"currency":"stars","balance":12}],
             "savingToward":{"id":"r1","title":"Movie night","emoji":"🍿","cost":30,
                             "have":12,"toGo":18,"pct":40,"currency":"stars"},
             "rewardShop":[{"id":"r1","title":"Movie night","emoji":"🍿","cost":30,
                            "have":12,"toGo":18,"currency":"stars"}]}
            """.trimIndent(),
        )

        val overview = api.personOverview("p1")

        assertEquals("Movie night", overview.savingToward?.title)
        assertEquals(18, overview.savingToward?.toGo)
        assertEquals(40, overview.savingToward?.pct)
        assertEquals(1, overview.rewardShop.size)
        assertEquals(12, overview.balances.single().balance)
        assertEquals("/api/persons/p1/overview", harness.takeRequest().path)
    }

    @Test
    fun `an unpinned person has no saving-toward`() = runTest {
        harness.enqueueJson("""{"currencies":[],"balances":[],"rewardShop":[]}""")

        assertNull(api.personOverview("p1").savingToward)
    }

    // ---- currencies, settings, conversions -------------------------------------

    @Test
    fun `the currency catalog has its own route`() = runTest {
        harness.enqueueJson(
            """{"currencies":[{"key":"stars","label":"Stars","symbol":"⭐","isDefault":true,
                "spendable":true,"sortOrder":0}]}""",
        )

        assertEquals("stars", api.currencies().single().key)
        assertEquals("/api/currencies", harness.takeRequest().path)
    }

    @Test
    fun `the household approval default drives a new reward's toggle`() = runTest {
        harness.enqueueJson("""{"requireApproval":false}""")

        assertFalse(api.rewardSettings().requireApproval)
        assertEquals("/api/rewards/settings", harness.takeRequest().path)
    }

    @Test
    fun `conversions carry both sides of the trade rate`() = runTest {
        harness.enqueueJson(
            """
            {"conversions":[
              {"id":"c1","fromCurrency":"stars","toCurrency":"sticks","fromAmount":10,"toAmount":1,
               "from":{"key":"stars","label":"Stars","symbol":"⭐","color":"#F3A93B"},
               "to":{"key":"sticks","label":"Sticks","symbol":"🥢","color":null}}
            ]}
            """.trimIndent(),
        )

        val conversion = api.conversions().single()

        assertEquals(10, conversion.fromAmount)
        assertEquals(1, conversion.toAmount)
        assertEquals("⭐", conversion.from.symbol)
        assertEquals("/api/conversions", harness.takeRequest().path)
    }

    @Test
    fun `an unaffordable trade comes back as ok false, not an HTTP error`() = runTest {
        harness.enqueueJson("""{"ok":false,"error":"Not enough stars"}""")

        val result = api.applyConversion(id = "c1", personId = "p1", times = 3)

        assertFalse(result.ok)
        assertEquals("Not enough stars", result.error)
        val request = harness.takeRequest()
        assertEquals("/api/conversions/c1/apply", request.path)
        assertContains(request.body.readUtf8(), "\"times\":3")
    }

    // ---- auth + errors ---------------------------------------------------------

    @Test
    fun `every request carries the bearer token`() = runTest {
        harness.enqueueJson("""{"rewards":[]}""")

        api.catalog()

        assertEquals("Bearer test-access-token", harness.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun `a 401 refreshes once and replays the request`() = runTest {
        harness.enqueueUnauthorized()
        harness.enqueueJson("""{"rewards":[{"id":"r1","title":"Movie","cost":30,"currency":"stars"}]}""")

        assertEquals("r1", api.catalog().single().id)

        assertEquals(1, harness.refreshCount.get())
        harness.takeRequest()
        assertEquals("Bearer refreshed-access-token", harness.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun `a rejected write relays the server's own message`() = runTest {
        // A kid tapping Redeem on a reward they can't afford must read the server's
        // reason, not a guess we made up on the client.
        harness.enqueueJson("""{"error":"Forbidden","message":"Not enough stars"}""", status = 403)

        val failure = assertFailsWith<WaffledApiException> { api.redeem("r1", "p1") }

        assertEquals(403, failure.status)
        assertEquals("Not enough stars", failure.userMessage)
    }
}
