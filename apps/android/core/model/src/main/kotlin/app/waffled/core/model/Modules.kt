package app.waffled.core.model

/**
 * The optional-module catalog — mirrors `apps/api/src/platform/modules.ts` and the iOS
 * `WaffledModule`. The server enforces these independently; the client gate is UX only.
 *
 * ⚠️ KEEP IN SYNC with the API and the web `can()`/module helpers.
 */
enum class WaffledModule(
    val key: String,
    val defaultOn: Boolean,
    /** `quotes` is declared but permanently unavailable — always gates off. */
    val isAvailable: Boolean = true,
) {
    Chores("chores", defaultOn = true),
    Goals("goals", defaultOn = true),
    Meals("meals", defaultOn = true),
    Lists("lists", defaultOn = true),
    Pantry("pantry", defaultOn = false),
    FamilyNight("familyNight", defaultOn = false),
    WaffledBites("waffledBites", defaultOn = false),
    Rhythms("rhythms", defaultOn = false),
    WeeklyPlanning("weeklyPlanning", defaultOn = false),
    Quotes("quotes", defaultOn = false, isAvailable = false);

    companion object {
        fun fromKey(key: String): WaffledModule? = entries.firstOrNull { it.key == key }
    }
}

/**
 * The capabilities a non-admin person can be granted.
 *
 * ⚠️ KEEP IN SYNC with `apps/api/src/platform/permissions.ts` (`CAPABILITIES`).
 * The server is the authority and enforces independently; this is a UX gate. Omitting one
 * grants nothing — it *hides* an action the user is genuinely allowed to take, which
 * reads to them as a broken app rather than a permission error. Locked by
 * `CapabilityTest`.
 *
 * They gate independently: a chores-only grant shows the approvals queue with only its
 * actionable buttons. `isAdmin` implies all of them.
 */
object Capability {
    const val CHORE_MANAGE = "chore.manage"
    const val CHORE_APPROVE = "chore.approve"
    const val REWARD_MANAGE = "reward.manage"
    const val REWARD_APPROVE = "reward.approve"

    /** Award stars directly (distinct from approving a redemption). */
    const val REWARD_GRANT = "reward.grant"

    /** Create and edit household goals. */
    const val GOAL_MANAGE = "goal.manage"

    /**
     * Household-wide weekly-planning choices (which lists the session asks about). It
     * does NOT gate running a session — anyone in the household can.
     */
    const val PLANNING_MANAGE = "planning.manage"

    val all = listOf(
        CHORE_MANAGE,
        CHORE_APPROVE,
        REWARD_MANAGE,
        REWARD_APPROVE,
        REWARD_GRANT,
        GOAL_MANAGE,
        PLANNING_MANAGE,
    )
}

/**
 * A household member's role, which supplies the DEFAULT capability matrix before an admin
 * customises it (`permissions.ts:17-21`).
 *
 * The defaults are deliberately conservative: adults get everything, teens and kids get
 * nothing until granted. The stored matrix is merged over these per cell, so the client
 * should read the household's `settings.permissions` when present and fall back to these.
 */
enum class MemberRole(val key: String, private val defaultGrant: Boolean) {
    Adult("adult", defaultGrant = true),
    Teen("teen", defaultGrant = false),
    Kid("kid", defaultGrant = false);

    fun grantsByDefault(@Suppress("UNUSED_PARAMETER") capability: String): Boolean = defaultGrant

    companion object {
        fun fromKey(key: String?): MemberRole? = entries.firstOrNull { it.key == key }
    }
}
