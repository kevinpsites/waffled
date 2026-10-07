package app.waffled.feature.rewards

import app.waffled.core.model.Capability
import app.waffled.core.model.Person
import app.waffled.core.sync.ModuleGate

/**
 * The reward ledger arithmetic, kept pure so it is testable on the JVM and out of the
 * render hot path.
 *
 * **Everything here is integer.** Currency amounts are money-shaped — whole stars,
 * sticks, marbles — and the server sends every one as an `Int`. Percentages are computed
 * in whole units too, and only become a `Float` at the final draw call, because a
 * floating percent that rounds 999/1000 up to 100 tells a child a reward is ready when
 * it is one star short.
 */
object RewardsMath {

    /**
     * How far along a saving-toward is, 0–100, truncating rather than rounding.
     *
     * A cost of zero (or a nonsense negative one) is "already there" rather than a
     * divide-by-zero — a free reward is always affordable.
     */
    fun progressPercent(have: Int, cost: Int): Int {
        if (cost <= 0) return 100
        if (have <= 0) return 0
        return ((have.toLong() * 100L) / cost).coerceAtMost(100L).toInt()
    }

    /** The same progress as a 0f–1f fraction, for a progress bar's width. */
    fun progressFraction(have: Int, cost: Int): Float = progressPercent(have, cost) / 100f

    /** The shortfall — what's still owed. Never negative. */
    fun toGo(have: Int, cost: Int): Int = (cost - have).coerceAtLeast(0)

    /** Affordable at exactly the cost, matching the server's `>=` rule. */
    fun canAfford(have: Int, cost: Int): Boolean = have >= cost

    /**
     * The balance a redemption would leave behind.
     *
     * Deliberately not clamped at zero: callers gate on [canAfford] first, and hiding an
     * overdraft would make a legitimate server-side rejection look like a client bug.
     */
    fun balanceAfter(balance: Int, cost: Int): Int = balance - cost

    /** A person's balance in one currency. An unheld currency is zero, not missing. */
    fun balanceOf(person: RewardsApi.PersonBalance?, currency: String): Int =
        person?.balances?.firstOrNull { it.currency == currency }?.balance ?: 0

    /**
     * How many whole trades a balance affords at a given rate.
     *
     * Integer division on purpose: 25 ⭐ at "10 ⭐ → 1 🥢" buys two trades, not 2.5. A
     * zero or negative rate trades nothing rather than dividing by zero.
     */
    fun maxTrades(balance: Int, fromAmount: Int): Int {
        if (fromAmount <= 0 || balance <= 0) return 0
        return balance / fromAmount
    }
}

/**
 * Who may do what with rewards.
 *
 * The two gates are **independent** — a person granted only `reward.approve` sees the
 * approvals queue but no Add button, and vice versa — and `isAdmin` implies all of them
 * (that rule lives in `Person.can`). The module gate is separate again: Rewards is a
 * SUB-FLAG of chores, not a module of its own.
 */
object RewardsAccess {

    /** Creating, editing and archiving rewards. */
    fun canManage(person: Person?): Boolean = person?.can(Capability.REWARD_MANAGE) == true

    /**
     * Whether [viewer] may redeem from [walletOwnerId]'s balance: their own, or anyone's
     * with `reward.manage` — the server's `assertSelfOrCapability`. Gating the button on
     * this keeps the shop from offering a redeem that would come back 403.
     */
    fun maySpend(viewer: Person?, walletOwnerId: String): Boolean =
        viewer != null && (viewer.id == walletOwnerId || canManage(viewer))

    /** Approving or denying a pending redemption. */
    fun canApprove(person: Person?): Boolean = person?.can(Capability.REWARD_APPROVE) == true

    /**
     * Handing out ad-hoc "spot" stars.
     *
     * ⚠️ The key is spelled out here because `core:model`'s `Capability` object is
     * missing it. The server's catalog (`apps/api/src/platform/permissions.ts`) declares
     * SIX capabilities — `chore.manage`, `chore.approve`, `reward.manage`,
     * `reward.approve`, **`reward.grant`**, `goal.manage` — while `Capability` declares
     * four and its KDoc asserts there are only four. The core modules are frozen, so
     * this is reported rather than patched locally; when `Capability.REWARD_GRANT` lands, swap
     * this literal for it and delete this note. Granting is genuinely its own gate: a
     * catalog manager is not automatically allowed to mint currency.
     */
    fun canGrant(person: Person?): Boolean = person?.can("reward.grant") == true

    /**
     * Whether the Rewards experience should appear at all: the chores module ON **and**
     * the `chores.rewards` sub-flag enabled. [subEnabled] comes from the household
     * settings, not from the module flags.
     */
    fun isVisible(gate: ModuleGate, subEnabled: Boolean): Boolean = gate.rewardsOn(subEnabled)
}
