package app.waffled.android.session

import app.waffled.core.auth.KeyValueStore
import kotlinx.coroutines.test.runTest
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The local mirror — and its queued `ps_crud` writes — belongs to one principal. Sign-out
 * wipes both (the account no longer has authority here), and a sign-in as someone ELSE
 * wipes whatever a failed sign-out wipe left behind.
 */
class MirrorBoundaryTest {

    private class Prefs : KeyValueStore {
        val map = mutableMapOf<String, String>()
        override fun getString(key: String): String? = map[key]
        override fun putString(key: String, value: String) { map[key] = value }
        override fun remove(key: String) { map.remove(key) }
    }

    private class Rig(var clearSucceeds: Boolean = true) {
        val prefs = Prefs()
        val calls = mutableListOf<String>()
        val boundary = MirrorBoundary(
            store = prefs,
            stopAndClear = { calls += "stopAndClear"; clearSucceeds },
            rescope = { clear, adopt ->
                calls += "rescope:$clear"
                if (clear && !clearSucceeds) false else { adopt(); true }
            },
        )
        suspend fun signIn(principal: String?) = boundary.adopt(principal) { calls += "install" }
    }

    private fun jwt(payload: String): String {
        val enc = Base64.getUrlEncoder().withoutPadding()
        return "${enc.encodeToString("{\"alg\":\"HS256\"}".toByteArray())}." +
            "${enc.encodeToString(payload.toByteArray())}.sig"
    }

    @Test
    fun theSameAccountSigningBackInKeepsTheMirror() = runTest {
        val rig = Rig()
        rig.boundary.record("srv|alice|h1")

        assertEquals(SignInAdoption.Adopted, rig.signIn("srv|alice|h1"))
        assertEquals(listOf("install"), rig.calls)
    }

    @Test
    fun aDifferentAccountClearsTheMirrorBeforeItsTokensAreInstalled() = runTest {
        val rig = Rig()
        rig.boundary.record("srv|alice|h1")

        assertEquals(SignInAdoption.Adopted, rig.signIn("srv|bob|h1"))
        assertEquals(listOf("rescope:true", "install"), rig.calls)
        assertEquals("srv|bob|h1", rig.boundary.owner())
    }

    @Test
    fun signOutWipesTheMirrorAndForgetsItsOwner() = runTest {
        val rig = Rig()
        rig.boundary.record("srv|alice|h1")

        assertTrue(rig.boundary.signOut())
        assertEquals(listOf("stopAndClear"), rig.calls)
        assertNull(rig.boundary.owner())
    }

    @Test
    fun aFailedSignOutWipeKeepsTheOwnerSoTheNextAccountStillClears() = runTest {
        val rig = Rig(clearSucceeds = false)
        rig.boundary.record("srv|alice|h1")

        assertFalse(rig.boundary.signOut())
        assertEquals("srv|alice|h1", rig.boundary.owner())
    }

    @Test
    fun aFailedWipeIsRefusedAndKeepsTheOldOwner() = runTest {
        val rig = Rig(clearSucceeds = false)
        rig.boundary.record("srv|alice|h1")

        assertEquals(SignInAdoption.TeardownFailed, rig.signIn("srv|bob|h1"))
        assertFalse("install" in rig.calls)
        assertEquals("srv|alice|h1", rig.boundary.owner())
    }

    @Test
    fun anUnknownOwnerWithAnEmptyQueueClearsToBeSafe() = runTest {
        val rig = Rig()
        assertEquals(SignInAdoption.Adopted, rig.signIn("srv|bob|h1"))
        assertEquals(listOf("rescope:true", "install"), rig.calls)
    }

    @Test
    fun principalIsServerSubjectAndHouseholdClaim() {
        val a = MirrorBoundary.principalOf(
            "http://h:8080",
            jwt("""{"sub":"acct-1","https://waffled.app/household_id":"h1"}"""),
        )
        val sameOtherHousehold = MirrorBoundary.principalOf(
            "http://h:8080",
            jwt("""{"sub":"acct-1","https://waffled.app/household_id":"h2"}"""),
        )
        val otherServer = MirrorBoundary.principalOf(
            "http://other:8080",
            jwt("""{"sub":"acct-1","https://waffled.app/household_id":"h1"}"""),
        )
        assertEquals("http://h:8080|acct-1|h1", a)
        assertNotEquals(a, sameOtherHousehold)
        assertNotEquals(a, otherServer)
        assertNull(MirrorBoundary.principalOf("http://h:8080", "not-a-jwt"))
    }
}
