package app.waffled.feature.rewards

import app.waffled.core.model.Capability
import app.waffled.core.model.Person
import app.waffled.core.model.WaffledModule
import app.waffled.core.sync.ModuleGate
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The pure ledger arithmetic and the gates, translated from the iOS Rewards spec.
 *
 * Two things are being pinned here, and both have burned this product before:
 *
 *  1. **The arithmetic is integer, end to end.** Currency amounts are money-shaped, so
 *     every intermediate — progress percent included — is computed in whole units and
 *     only becomes a `Float` at the final draw call. A `Double` percent that rounds up
 *     to 100 on 999/1000 tells a child a reward is ready when it isn't.
 *  2. **The capability gates are independent**, and `isAdmin` implies all of them.
 */
class RewardsMathTest {

    // ---- progress -------------------------------------------------------------

    @Test
    fun `progress is a whole percent of the way there`() {
        assertEquals(50, RewardsMath.progressPercent(have = 5, cost = 10))
        assertEquals(33, RewardsMath.progressPercent(have = 1, cost = 3))
    }

    @Test
    fun `progress never rounds up to a false 100`() {
        // 999/1000 is 99.9% — a Double percent formatted as an Int would show 100 and
        // the tile would claim "ready". Integer division truncates, which is the honest
        // direction to be wrong in.
        assertEquals(99, RewardsMath.progressPercent(have = 999, cost = 1000))
    }

    @Test
    fun `progress clamps at both ends`() {
        assertEquals(0, RewardsMath.progressPercent(have = 0, cost = 10))
        assertEquals(0, RewardsMath.progressPercent(have = -5, cost = 10))
        assertEquals(100, RewardsMath.progressPercent(have = 40, cost = 10))
    }

    @Test
    fun `a free reward is complete, not a divide by zero`() {
        assertEquals(100, RewardsMath.progressPercent(have = 0, cost = 0))
        assertEquals(100, RewardsMath.progressPercent(have = 3, cost = -1))
    }

    // ---- to go / affordability ------------------------------------------------

    @Test
    fun `to go is the shortfall and never negative`() {
        assertEquals(4, RewardsMath.toGo(have = 6, cost = 10))
        assertEquals(0, RewardsMath.toGo(have = 10, cost = 10))
        assertEquals(0, RewardsMath.toGo(have = 25, cost = 10))
    }

    @Test
    fun `affordable at exactly the cost`() {
        assertTrue(RewardsMath.canAfford(have = 10, cost = 10))
        assertFalse(RewardsMath.canAfford(have = 9, cost = 10))
        assertTrue(RewardsMath.canAfford(have = 0, cost = 0))
    }

    @Test
    fun `the balance after a redemption is the plain debit`() {
        assertEquals(3, RewardsMath.balanceAfter(balance = 13, cost = 10))
        // A redemption that outruns the balance still shows the true (negative) result
        // rather than clamping — the caller gates on canAfford, and hiding an overdraft
        // would make a server-side rejection look like a client bug.
        assertEquals(-2, RewardsMath.balanceAfter(balance = 8, cost = 10))
    }

    // ---- balances lookup ------------------------------------------------------

    private fun personBalance(vararg pairs: Pair<String, Int>) = RewardsApi.PersonBalance(
        personId = "p1",
        name = "Kid",
        balances = pairs.map { RewardsApi.PersonBalance.CurrencyBalance(it.first, it.second) },
    )

    @Test
    fun `balance reads the named currency from the one ledger`() {
        val p = personBalance("stars" to 12, "sticks" to 3)
        assertEquals(12, RewardsMath.balanceOf(p, "stars"))
        assertEquals(3, RewardsMath.balanceOf(p, "sticks"))
    }

    @Test
    fun `an unheld currency is zero, not missing`() {
        assertEquals(0, RewardsMath.balanceOf(personBalance("stars" to 12), "gems"))
        assertEquals(0, RewardsMath.balanceOf(null, "stars"))
    }

    // ---- trades ---------------------------------------------------------------

    @Test
    fun `max trades is integer division, so a part trade is not offered`() {
        // 25 ⭐ at 10 ⭐ → 1 🥢 buys two trades, not 2.5.
        assertEquals(2, RewardsMath.maxTrades(balance = 25, fromAmount = 10))
        assertEquals(0, RewardsMath.maxTrades(balance = 9, fromAmount = 10))
    }

    @Test
    fun `a nonsense rate trades nothing rather than dividing by zero`() {
        assertEquals(0, RewardsMath.maxTrades(balance = 25, fromAmount = 0))
        assertEquals(0, RewardsMath.maxTrades(balance = -5, fromAmount = 10))
    }

    // ---- capability gates -----------------------------------------------------

    private fun person(vararg caps: String, admin: Boolean = false) =
        Person(id = "p1", name = "Parent", isAdmin = admin, capabilities = caps.toList())

    @Test
    fun `reward manage and approve gate independently`() {
        val manager = person(Capability.REWARD_MANAGE)
        assertTrue(RewardsAccess.canManage(manager))
        assertFalse(RewardsAccess.canApprove(manager))

        val approver = person(Capability.REWARD_APPROVE)
        assertFalse(RewardsAccess.canManage(approver))
        assertTrue(RewardsAccess.canApprove(approver))
    }

    @Test
    fun `an admin holds every reward capability without being granted one`() {
        val admin = person(admin = true)
        assertTrue(RewardsAccess.canManage(admin))
        assertTrue(RewardsAccess.canApprove(admin))
        assertTrue(RewardsAccess.canGrant(admin))
    }

    @Test
    fun `a kid holds none of them`() {
        val kid = person()
        assertFalse(RewardsAccess.canManage(kid))
        assertFalse(RewardsAccess.canApprove(kid))
        assertFalse(RewardsAccess.canGrant(kid))
    }

    @Test
    fun `granting stars is its own capability, separate from managing the catalog`() {
        // `reward.grant` is a SIXTH capability the server knows about — see
        // apps/api/src/platform/permissions.ts. A catalog manager who was never granted
        // it must not get the Award-stars button.
        assertFalse(RewardsAccess.canGrant(person(Capability.REWARD_MANAGE)))
        assertTrue(RewardsAccess.canGrant(person("reward.grant")))
    }

    @Test
    fun `your own wallet is yours to spend without reward manage`() {
        // The server's assertSelfOrCapability: self, or reward.manage.
        val kid = Person(id = "kid", name = "Kid")
        assertTrue(RewardsAccess.maySpend(kid, walletOwnerId = "kid"))
        assertFalse(RewardsAccess.maySpend(kid, walletOwnerId = "sib"))
    }

    @Test
    fun `a reward manager may spend anyone's wallet`() {
        assertTrue(RewardsAccess.maySpend(person(Capability.REWARD_MANAGE), walletOwnerId = "kid"))
        assertTrue(RewardsAccess.maySpend(person(admin = true), walletOwnerId = "kid"))
        // Approving redemptions is not the same as spending for someone.
        assertFalse(RewardsAccess.maySpend(person(Capability.REWARD_APPROVE), walletOwnerId = "kid"))
        assertFalse(RewardsAccess.maySpend(null, walletOwnerId = "kid"))
    }

    @Test
    fun `nobody is nobody`() {
        assertFalse(RewardsAccess.canManage(null))
        assertFalse(RewardsAccess.canApprove(null))
        assertFalse(RewardsAccess.canGrant(null))
    }

    // ---- module gate ----------------------------------------------------------

    private fun gate(choresOn: Boolean) =
        ModuleGate(flags = mapOf(WaffledModule.Chores to choresOn), loaded = true)

    @Test
    fun `rewards needs the chores module AND the sub-flag`() {
        assertTrue(RewardsAccess.isVisible(gate(choresOn = true), subEnabled = true))
        assertFalse(RewardsAccess.isVisible(gate(choresOn = true), subEnabled = false))
        assertFalse(RewardsAccess.isVisible(gate(choresOn = false), subEnabled = true))
        assertFalse(RewardsAccess.isVisible(gate(choresOn = false), subEnabled = false))
    }
}
