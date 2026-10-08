package app.waffled.feature.family

import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// Port of the approvals cases in RestDataStateTests.swift: a failed read can never say
// "All caught up", a disabled module is not fetched and hides retained rows, and a scope
// change never leaks the previous account's queue.
class ApprovalsModelTest {

    private val redemption = FamilyApi.Redemption(
        id = "redemption-1", rewardId = "reward-1", personId = "person-1",
        personName = "Maya", title = "Movie night", emoji = "🎬", cost = 5,
        currency = "stars", status = "pending", createdAt = "2026-09-03T12:00:00Z",
    )
    private val chore = FamilyApi.ChoreInstance(
        id = "chore-1", choreId = "template-1", choreTitle = "Dishes", emoji = "🍽️",
        personId = "person-1", personName = "Maya", status = "awaiting",
        requiresApproval = true,
    )

    @Test fun failedApprovalsKeepTheirEntryPointVisible() = runTest {
        val m = ApprovalsModel(fetchRedemptions = { error("offline") }, fetchChores = { error("offline") })
        m.load(scope = "a")
        val s = m.state.value

        assertTrue(s.isEmpty)
        assertTrue(s.showsEntryPoint)
        assertEquals("Check approvals", s.entryTitle)
    }

    @Test fun approvalFailureCannotRenderAllCaughtUp() = runTest {
        val m = ApprovalsModel(fetchRedemptions = { error("rejected") }, fetchChores = { emptyList() })
        m.load(scope = "a")

        assertTrue(m.state.value.isEmpty)
        assertFalse(m.state.value.isAuthoritative)
        assertFalse(m.state.value.showsAllCaughtUp)
    }

    @Test fun authoritativeEmptyApprovalsCanRenderAllCaughtUp() = runTest {
        val m = ApprovalsModel(fetchRedemptions = { emptyList() }, fetchChores = { emptyList() })
        m.load(scope = "a")

        assertTrue(m.state.value.isEmpty)
        assertTrue(m.state.value.isAuthoritative)
        assertTrue(m.state.value.showsAllCaughtUp)
        assertFalse(m.state.value.showsEntryPoint)
    }

    @Test fun disabledApprovalModulesAreNotFetchedAndHideRetainedRows() = runTest {
        val calls = mutableListOf<String>()
        val m = ApprovalsModel(
            fetchRedemptions = { calls += "rewards"; listOf(redemption) },
            fetchChores = { calls += "chores"; listOf(chore) },
        )
        m.load(scope = "a")
        assertEquals(2, m.state.value.total)
        assertEquals("2 to approve", m.state.value.entryTitle)

        m.load(scope = "a", choresEnabled = false, rewardsEnabled = false)

        assertEquals(1, calls.count { it == "rewards" })
        assertEquals(1, calls.count { it == "chores" })
        assertTrue(m.state.value.redemptions.isEmpty())
        assertTrue(m.state.value.chores.isEmpty())
        assertEquals(0, m.state.value.total)
        assertTrue(m.state.value.isAuthoritative)
    }

    @Test fun disabledApprovalFailureIsExcludedFromTheVisibleState() = runTest {
        val calls = mutableListOf<String>()
        val m = ApprovalsModel(
            fetchRedemptions = { calls += "rewards"; error("rejected") },
            fetchChores = { calls += "chores"; emptyList() },
        )
        m.load(scope = "a", choresEnabled = true, rewardsEnabled = false)

        assertEquals(0, calls.count { it == "rewards" })
        assertEquals(1, calls.count { it == "chores" })
        assertTrue(m.state.value.isAuthoritative)
        assertTrue(m.state.value.isEmpty)
    }

    @Test fun approvalScopeChangeClearsConfirmedValuesBeforeANewScopeFails() = runTest {
        var fail = false
        val m = ApprovalsModel(
            fetchRedemptions = { if (fail) error("rejected") else listOf(redemption) },
            fetchChores = { if (fail) error("rejected") else emptyList() },
        )
        m.load(scope = Any())
        assertEquals(listOf("redemption-1"), m.state.value.redemptions.map { it.id })
        fail = true

        m.load(scope = Any())

        assertTrue(m.state.value.redemptions.isEmpty())
        assertFalse(m.state.value.isAuthoritative)
    }

    @Test fun lateApprovalResultFromThePreviousScopeIsDiscarded() = runTest {
        val deferred = CompletableDeferred<List<FamilyApi.Redemption>>()
        val started = CompletableDeferred<Unit>()
        var redemptionCalls = 0
        var choreCalls = 0
        val m = ApprovalsModel(
            fetchRedemptions = {
                redemptionCalls += 1
                if (redemptionCalls == 1) { started.complete(Unit); deferred.await() } else error("rejected")
            },
            fetchChores = {
                choreCalls += 1
                if (choreCalls == 1) emptyList() else error("rejected")
            },
        )

        val oldLoad = async { m.load(scope = Any()) }
        started.await()
        m.load(scope = Any())
        deferred.complete(listOf(redemption))
        oldLoad.await()

        assertTrue(m.state.value.redemptions.isEmpty())
        assertFalse(m.state.value.isAuthoritative)
    }

    @Test fun oneItemReadsSingular() = runTest {
        val m = ApprovalsModel(fetchRedemptions = { listOf(redemption) }, fetchChores = { emptyList() })
        m.load(scope = "a")
        assertEquals("1 to approve", m.state.value.entryTitle)
    }

    // ---- decisions: optimistic drop, reload on failure, broadcast only on success ----

    @Test fun anApprovedRedemptionLeavesTheQueueAndBroadcastsRewards() = runTest {
        val bus = RefreshBus()
        val m = ApprovalsModel(
            fetchRedemptions = { listOf(redemption) },
            fetchChores = { listOf(chore) },
            actions = FakeActions(),
            refreshBus = bus,
        )
        m.load(scope = "a")

        assertTrue(m.decideRedemption("redemption-1", approve = true))

        assertEquals(emptyList(), m.state.value.redemptions)
        assertEquals(1, bus.revisionOf(RefreshDomain.Rewards))
        assertEquals(0, bus.revisionOf(RefreshDomain.Chores))
    }

    @Test fun aRejectedChoreLeavesTheQueueAndBroadcastsChores() = runTest {
        val bus = RefreshBus()
        val actions = FakeActions()
        val m = ApprovalsModel(
            fetchRedemptions = { emptyList() },
            fetchChores = { listOf(chore) },
            actions = actions,
            refreshBus = bus,
        )
        m.load(scope = "a")

        assertTrue(m.decideChore("chore-1", approve = false))

        assertEquals(listOf("reject:chore-1"), actions.log)
        assertEquals(emptyList(), m.state.value.chores)
        assertEquals(1, bus.revisionOf(RefreshDomain.Chores))
    }

    @Test fun aFailedDecisionRestoresTheTrueQueueAndBroadcastsNothing() = runTest {
        val bus = RefreshBus()
        var fetches = 0
        val m = ApprovalsModel(
            fetchRedemptions = { fetches += 1; listOf(redemption) },
            fetchChores = { emptyList() },
            actions = FakeActions(fail = true),
            refreshBus = bus,
        )
        m.load(scope = "a")

        assertFalse(m.decideRedemption("redemption-1", approve = false))

        assertEquals(2, fetches)
        assertEquals(listOf("redemption-1"), m.state.value.redemptions.map { it.id })
        assertEquals(0, bus.revisionOf(RefreshDomain.Rewards))
    }

    private class FakeActions(private val fail: Boolean = false) : ApprovalActions {
        val log = mutableListOf<String>()
        private fun run(entry: String) {
            log += entry
            if (fail) error("refused")
        }
        override suspend fun approveRedemption(id: String) = run("approveRedemption:$id")
        override suspend fun denyRedemption(id: String) = run("denyRedemption:$id")
        override suspend fun approveChore(id: String) = run("approve:$id")
        override suspend fun rejectChore(id: String) = run("reject:$id")
    }
}
