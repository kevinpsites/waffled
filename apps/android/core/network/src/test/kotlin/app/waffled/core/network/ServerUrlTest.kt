package app.waffled.core.network

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Waffled is self-hosted, so the server address is typed by the user at runtime.
 *
 * Android's network-security-config cannot express "private ranges" (no CIDR support,
 * and there is nothing to enumerate ahead of time), so the cleartext policy from
 * docs/product/android-port-plan.md §7.5 is enforced HERE:
 *   plain http:// is fine on a home network, and must be HTTPS for anything public.
 */
class ServerUrlTest {

    // ---- normalisation ----

    @Test
    fun addsSchemeWhenMissing() {
        assertEquals("http://192.168.1.50:8080", ServerUrl.normalize("192.168.1.50:8080"))
    }

    @Test
    fun trimsWhitespaceAndTrailingSlash() {
        assertEquals("http://10.0.2.2:8080", ServerUrl.normalize("  http://10.0.2.2:8080/  "))
    }

    @Test
    fun preservesHttpsAndPath() {
        assertEquals("https://waffled.example.com", ServerUrl.normalize("https://waffled.example.com/"))
    }

    @Test
    fun rejectsJunk() {
        assertNull(ServerUrl.normalize(""))
        assertNull(ServerUrl.normalize("   "))
        assertNull(ServerUrl.normalize("ftp://nope.example.com"))
    }

    // ---- cleartext policy ----

    @Test
    fun cleartextAllowedOnLoopbackAndEmulatorHost() {
        assertTrue(ServerUrl.cleartextAllowed("localhost"))
        assertTrue(ServerUrl.cleartextAllowed("127.0.0.1"))
        // The emulator's alias for the host machine — without this, dev is impossible.
        assertTrue(ServerUrl.cleartextAllowed("10.0.2.2"))
    }

    @Test
    fun cleartextAllowedOnRfc1918Ranges() {
        assertTrue(ServerUrl.cleartextAllowed("192.168.1.50"))
        assertTrue(ServerUrl.cleartextAllowed("10.1.2.3"))
        assertTrue(ServerUrl.cleartextAllowed("172.16.0.9"))
        assertTrue(ServerUrl.cleartextAllowed("172.31.255.254"))
    }

    @Test
    fun cleartextAllowedOnMdnsNames() {
        assertTrue(ServerUrl.cleartextAllowed("waffled.local"))
        assertTrue(ServerUrl.cleartextAllowed("nas.local"))
    }

    @Test
    fun cleartextRefusedOnPublicHosts() {
        assertFalse(ServerUrl.cleartextAllowed("demo.waffled.app"))
        assertFalse(ServerUrl.cleartextAllowed("8.8.8.8"))
        // 172.32 is OUTSIDE the private 172.16/12 block — a classic off-by-one.
        assertFalse(ServerUrl.cleartextAllowed("172.32.0.1"))
        assertFalse(ServerUrl.cleartextAllowed("11.0.0.1"))
    }

    // ---- the combined check the settings screen uses ----

    @Test
    fun insecurePublicUrlIsRejectedWithAReason() {
        val v = ServerUrl.validate("http://demo.waffled.app")
        assertTrue(v is ServerUrlVerdict.InsecurePublic)
    }

    @Test
    fun plainHttpOnHomeNetworkIsAccepted() {
        assertEquals(
            ServerUrlVerdict.Ok("http://192.168.1.50:8080"),
            ServerUrl.validate("192.168.1.50:8080"),
        )
    }

    @Test
    fun httpsPublicIsAccepted() {
        assertEquals(
            ServerUrlVerdict.Ok("https://demo.waffled.app"),
            ServerUrl.validate("https://demo.waffled.app"),
        )
    }

    @Test
    fun unparseableInputIsRejected() {
        assertTrue(ServerUrl.validate("¯\\_(ツ)_/¯") is ServerUrlVerdict.Invalid)
    }
}
