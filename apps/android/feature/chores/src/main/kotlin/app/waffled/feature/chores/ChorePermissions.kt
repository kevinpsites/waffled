package app.waffled.feature.chores

import androidx.compose.runtime.Immutable
import app.waffled.core.model.Capability
import app.waffled.core.model.Person

/**
 * What the signed-in person may do on the chores board.
 *
 * These are a **security-shaped** rule, not cosmetics — they mirror the server's
 * capability grid, and the server enforces them again on every write. Two things about
 * them are easy to get wrong and are therefore spelled out here:
 *
 *  - **They gate independently.** `chore.approve` alone means the approvals queue and its
 *    Approve / Not-yet buttons, and *nothing* editable. `chore.manage` alone means the
 *    editor and drag-to-reassign, and *no* approval buttons. Bundling them behind one
 *    "is a parent" boolean silently widens both.
 *  - **`isAdmin` implies everything** — that is [Person.can]'s rule, applied here.
 *
 * The one carve-out: anyone may add a chore to **Up for grabs**. Offering to do work is
 * not the same act as assigning work to someone else, and the web board works the same
 * way.
 */
@Immutable
data class ChorePermissions(
    val canManage: Boolean,
    val canApprove: Boolean,
) {

    /** Creating, editing and deleting a chore definition. */
    val canEditChores: Boolean get() = canManage

    /** Adding a chore to a column. Up-for-grabs is the self-serve carve-out. */
    fun canAddTo(isGrabs: Boolean): Boolean = isGrabs || canManage

    /** Approving or rejecting — only meaningful while a chore is actually awaiting. */
    fun canDecide(status: String): Boolean =
        canApprove && status == ChoresApi.STATUS_AWAITING

    /**
     * Dragging a chore into another column. Manage-only, and only while it is still
     * pending — a done or awaiting chore keeps its awarded stars where they are.
     */
    fun canReassign(status: String): Boolean =
        canManage && status == ChoresApi.STATUS_PENDING

    companion object {
        /** Nothing granted — the state a shared device shows before anyone claims it. */
        val NONE = ChorePermissions(canManage = false, canApprove = false)

        fun of(viewer: Person?): ChorePermissions = ChorePermissions(
            canManage = viewer?.can(Capability.CHORE_MANAGE) == true,
            canApprove = viewer?.can(Capability.CHORE_APPROVE) == true,
        )
    }
}
