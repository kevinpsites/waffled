package app.waffled.feature.goals

import app.waffled.core.model.Capability
import app.waffled.core.model.Person

/**
 * Who may shape the household's goals.
 *
 * `goal.manage` gates CREATING and EDITING a goal — the ＋ button, the editor, delete, the
 * pin toggle and the new-group affordance. It does NOT gate logging progress: anyone in a
 * goal can record what they did, which is the entire point of a family goal.
 *
 * `isAdmin` implies the capability (see `Person.can`). The SERVER enforces this
 * independently; everything here is UX, and hiding an action someone is genuinely allowed
 * to take reads to them as a broken app rather than a permission error.
 */
object GoalsAccess {

    /** May create, edit, delete, re-tier or re-group goals. */
    fun canManage(me: Person?): Boolean = me?.can(Capability.GOAL_MANAGE) == true

    /**
     * May log progress. Deliberately open: a goal exists to be logged against, and the
     * server decides whose progress it credits.
     */
    fun canLog(@Suppress("UNUSED_PARAMETER") me: Person?): Boolean = true
}
