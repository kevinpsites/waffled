package app.waffled.feature.chores

import app.waffled.core.model.Capability
import app.waffled.core.model.Person
import org.junit.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The capability gates on the chores board.
 *
 * These are a **security-shaped** rule, not cosmetics: they must match the server's
 * `chore.manage` / `chore.approve` grid exactly, and — the part that is easy to get
 * wrong — they gate INDEPENDENTLY. Someone granted only `chore.approve` still sees the
 * approvals queue with its Approve/Not-yet buttons, and still sees no editing affordance
 * anywhere.
 */
class ChorePermissionsTest {

    private fun person(
        isAdmin: Boolean = false,
        vararg capabilities: String,
    ) = Person(
        id = "p1",
        name = "Elaine",
        isAdmin = isAdmin,
        capabilities = capabilities.toList(),
    )

    @Test
    fun `a person with neither capability can do neither`() {
        val gates = ChorePermissions.of(person())
        assertFalse(gates.canManage)
        assertFalse(gates.canApprove)
    }

    @Test
    fun `chore manage alone does not grant approving`() {
        val gates = ChorePermissions.of(person(capabilities = arrayOf(Capability.CHORE_MANAGE)))
        assertTrue(gates.canManage)
        assertFalse(gates.canApprove)
    }

    @Test
    fun `chore approve alone does not grant managing`() {
        val gates = ChorePermissions.of(person(capabilities = arrayOf(Capability.CHORE_APPROVE)))
        assertFalse(gates.canManage)
        assertTrue(gates.canApprove)
    }

    @Test
    fun `an admin implies every chore capability`() {
        val gates = ChorePermissions.of(person(isAdmin = true))
        assertTrue(gates.canManage)
        assertTrue(gates.canApprove)
    }

    @Test
    fun `an unknown viewer gets nothing`() {
        // A shared device with nobody claimed must not expose parent-only actions.
        val gates = ChorePermissions.of(null)
        assertFalse(gates.canManage)
        assertFalse(gates.canApprove)
    }

    // ---- what the gates actually gate --------------------------------------------

    @Test
    fun `only chore manage may edit a chore definition`() {
        assertTrue(ChorePermissions(canManage = true, canApprove = false).canEditChores)
        assertFalse(ChorePermissions(canManage = false, canApprove = true).canEditChores)
    }

    @Test
    fun `anyone may add to up-for-grabs but only manage may add to a person`() {
        val none = ChorePermissions(canManage = false, canApprove = false)
        // The self-serve carve-out, matching the web: adding a chore anyone can claim
        // is not an act of assigning work to someone else.
        assertTrue(none.canAddTo(isGrabs = true))
        assertFalse(none.canAddTo(isGrabs = false))
        assertTrue(ChorePermissions(canManage = true, canApprove = false).canAddTo(isGrabs = false))
    }

    @Test
    fun `only chore approve may decide an awaiting chore`() {
        val approver = ChorePermissions(canManage = false, canApprove = true)
        assertTrue(approver.canDecide(status = "awaiting"))
        // Nothing to decide on a chore that isn't waiting.
        assertFalse(approver.canDecide(status = "pending"))
        assertFalse(approver.canDecide(status = "done"))
        assertFalse(ChorePermissions(canManage = true, canApprove = false).canDecide("awaiting"))
    }

    @Test
    fun `reassigning by drag needs manage and a still-pending chore`() {
        val manager = ChorePermissions(canManage = true, canApprove = false)
        assertTrue(manager.canReassign(status = "pending"))
        // A done or awaiting chore keeps its awarded stars where they are.
        assertFalse(manager.canReassign(status = "done"))
        assertFalse(manager.canReassign(status = "awaiting"))
        assertFalse(ChorePermissions(canManage = false, canApprove = true).canReassign("pending"))
    }
}
