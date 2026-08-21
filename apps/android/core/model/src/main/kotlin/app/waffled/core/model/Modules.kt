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
    Quotes("quotes", defaultOn = false, isAvailable = false);

    companion object {
        fun fromKey(key: String): WaffledModule? = entries.firstOrNull { it.key == key }
    }
}

/**
 * The four capabilities a non-admin person can be granted. They gate independently —
 * a chores-only grant shows the approvals queue with only its actionable buttons.
 */
object Capability {
    const val CHORE_MANAGE = "chore.manage"
    const val CHORE_APPROVE = "chore.approve"
    const val REWARD_MANAGE = "reward.manage"
    const val REWARD_APPROVE = "reward.approve"

    val all = listOf(CHORE_MANAGE, CHORE_APPROVE, REWARD_MANAGE, REWARD_APPROVE)
}
