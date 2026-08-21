package app.waffled.core.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * ⚠️ KEEP IN SYNC with `apps/api/src/platform/permissions.ts`.
 *
 * The server is the authority; this is a UX gate. Missing a capability here doesn't grant
 * anything — it *hides* an action the user is actually allowed to take, which reads as a
 * broken app rather than a permission error.
 *
 * Transcribed from `permissions.ts:10-11`, which declares **six**.
 */
class CapabilityTest {

    @Test
    fun theCapabilityListMatchesTheServer() {
        assertEquals(
            listOf(
                "chore.manage",
                "chore.approve",
                "reward.manage",
                "reward.approve",
                "reward.grant",
                "goal.manage",
            ),
            Capability.all,
        )
    }

    @Test
    fun adminImpliesEverything() {
        val admin = Person(id = "p1", name = "Sam", isAdmin = true)
        Capability.all.forEach { assertTrue(admin.can(it), "admin should have $it") }
    }

    @Test
    fun capabilitiesGateIndependently() {
        // A reward.grant-only person can award stars but cannot approve a redemption.
        val p = Person(id = "p1", name = "Sam", capabilities = listOf(Capability.REWARD_GRANT))
        assertTrue(p.can(Capability.REWARD_GRANT))
        assertFalse(p.can(Capability.REWARD_APPROVE))
        assertFalse(p.can(Capability.REWARD_MANAGE))
    }

    @Test
    fun defaultRolePermissionsMatchTheServersConservativeDefaults() {
        // permissions.ts:18-20 — adults get everything, teens and kids get nothing until
        // an admin grants it.
        Capability.all.forEach { assertTrue(MemberRole.Adult.grantsByDefault(it)) }
        Capability.all.forEach { assertFalse(MemberRole.Teen.grantsByDefault(it)) }
        Capability.all.forEach { assertFalse(MemberRole.Kid.grantsByDefault(it)) }
    }

    @Test
    fun rolesParseFromTheServersStrings() {
        assertEquals(MemberRole.Adult, MemberRole.fromKey("adult"))
        assertEquals(MemberRole.Teen, MemberRole.fromKey("teen"))
        assertEquals(MemberRole.Kid, MemberRole.fromKey("kid"))
        assertEquals(null, MemberRole.fromKey("wizard"))
    }
}
