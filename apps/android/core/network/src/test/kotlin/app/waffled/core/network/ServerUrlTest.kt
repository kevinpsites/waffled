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

    // ---- IPv6 ----

    @Test
    fun bracketedIpv6HostsAreParsedNotMangled() {
        // Naive `substringBefore(':')` would reduce "[::1]:8080" to "[" and then treat
        // the result as a public host, silently refusing a loopback address.
        assertEquals("[::1]", ServerUrl.hostOf("http://[::1]:8080"))
        assertEquals("[fd00::1]", ServerUrl.hostOf("http://[fd00::1]:8080"))
    }

    @Test
    fun ipv6LoopbackAndUniqueLocalAllowCleartext() {
        assertTrue(ServerUrl.cleartextAllowed("[::1]"))
        // fc00::/7 — the IPv6 equivalent of RFC1918.
        assertTrue(ServerUrl.cleartextAllowed("[fd00::1]"))
        assertTrue(ServerUrl.cleartextAllowed("[fe80::1]")) // link-local
    }

    @Test
    fun publicIpv6StillRequiresHttps() {
        assertFalse(ServerUrl.cleartextAllowed("[2606:4700::1111]"))
        assertTrue(ServerUrl.validate("http://[2606:4700::1111]:8080") is ServerUrlVerdict.InsecurePublic)
    }

    @Test
    fun ipv6RoundTripsThroughNormalize() {
        assertEquals("http://[fd00::1]:8080", ServerUrl.normalize("[fd00::1]:8080"))
    }

    @Test
    fun userinfoCannotDisguiseAPublicHostAsLocal() {
        // The real host is after the `@`; reading it as localhost would allow cleartext.
        assertNull(ServerUrl.normalize("http://localhost:80@evil.com"))
        assertTrue(ServerUrl.validate("http://localhost:80@evil.com") is ServerUrlVerdict.Invalid)
        assertNull(ServerUrl.normalize("https://user:secret@family.example.com"))
    }

    @Test
    fun rejectsPathsQueriesFragmentsAndBadPorts() {
        assertNull(ServerUrl.normalize("https://family.example.com/path"))
        assertNull(ServerUrl.normalize("https://family.example.com?debug=1"))
        assertNull(ServerUrl.normalize("https://family.example.com#x"))
        assertNull(ServerUrl.normalize("https:///missing-host"))
        assertNull(ServerUrl.normalize("http://192.168.1.50:http"))
        assertNull(ServerUrl.normalize("http://192.168.1.50:99999"))
    }

    @Test
    fun lowercasesSchemeAndHost() {
        assertEquals("http://localhost:8080", ServerUrl.normalize("HTTP://LOCALHOST:8080/"))
    }
}
