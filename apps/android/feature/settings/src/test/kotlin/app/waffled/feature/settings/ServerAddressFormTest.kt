package app.waffled.feature.settings

import app.waffled.core.network.ServerUrlVerdict
import org.junit.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * The About → Server card. Plan §7.5: warn as soon as a public host is typed over plain
 * http, rather than failing opaquely on save.
 */
class ServerAddressFormTest {

    @Test
    fun `no warning for home-network http or any https`() {
        assertNull(ServerAddressForm.liveWarning("http://192.168.1.50:8080"))
        assertNull(ServerAddressForm.liveWarning("http://10.0.2.2:8080"))
        assertNull(ServerAddressForm.liveWarning("http://waffled.local"))
        assertNull(ServerAddressForm.liveWarning("https://family.example.com"))
    }

    @Test
    fun `public host over http is warned while typing`() {
        val warning = ServerAddressForm.liveWarning("http://family.example.com")
        assertNotNull(warning)
        assertContains(warning, "family.example.com")
        assertContains(warning, "https://")
    }

    @Test
    fun `blank or half-typed input is not nagged`() {
        assertNull(ServerAddressForm.liveWarning(""))
        assertNull(ServerAddressForm.liveWarning("   "))
        assertNull(ServerAddressForm.liveWarning("ftp://x"))
    }

    @Test
    fun `save outcomes map to the iOS copy`() {
        assertEquals(
            SaveMessage(note = "Saved. The app is now using this server."),
            ServerAddressForm.message(ServerChange.Updated("http://10.0.2.2:8080")),
        )
        assertEquals(
            "Enter a full server address beginning with http:// or https://.",
            ServerAddressForm.message(ServerChange.Rejected(ServerUrlVerdict.Invalid("bad"))).error,
        )
        assertEquals(
            "Wait for 1 pending change to sync before changing servers.",
            ServerAddressForm.message(ServerChange.PendingUploads(1)).error,
        )
        assertEquals(
            "Wait for 3 pending changes to sync before changing servers.",
            ServerAddressForm.message(ServerChange.PendingUploads(3)).error,
        )
        assertEquals(
            "A connection change is already in progress.",
            ServerAddressForm.message(ServerChange.TransitionInProgress).error,
        )
        assertEquals(
            "Couldn’t safely clear the previous connection. Try again before changing servers.",
            ServerAddressForm.message(ServerChange.TeardownFailed).error,
        )
    }

    @Test
    fun `a refused public http save explains why`() {
        val msg = ServerAddressForm.message(ServerChange.Rejected(ServerUrlVerdict.InsecurePublic("family.example.com")))
        assertNotNull(msg.error)
        assertContains(msg.error, "family.example.com")
        assertNull(msg.note)
    }

    // ---- translated from iOS AppConfigURLTests: only a bare origin is a server address ----

    @Test
    fun `a bare origin passes the shape check`() {
        assertNull(ServerAddressForm.shapeError("  https://family.example.com/  "))
        assertNull(ServerAddressForm.shapeError("http://192.168.1.50:8080"))
        assertNull(ServerAddressForm.shapeError("HTTP://LOCALHOST:8080/"))
        assertNull(ServerAddressForm.shapeError("http://[::1]:8080"))
        // Android deliberately assumes http:// for a bare host:port (self-hosters type that).
        assertNull(ServerAddressForm.shapeError("192.168.1.50:8080"))
    }

    @Test
    fun `credentials, paths and queries are rejected`() {
        assertEquals(ServerAddressForm.INVALID_ADDRESS, ServerAddressForm.shapeError("https://user:secret@family.example.com"))
        assertEquals(ServerAddressForm.INVALID_ADDRESS, ServerAddressForm.shapeError("https://family.example.com/path"))
        assertEquals(ServerAddressForm.INVALID_ADDRESS, ServerAddressForm.shapeError("https://family.example.com?debug=1"))
        assertEquals(ServerAddressForm.INVALID_ADDRESS, ServerAddressForm.shapeError("https://family.example.com#x"))
        assertEquals(ServerAddressForm.INVALID_ADDRESS, ServerAddressForm.shapeError("ftp://family.example.com"))
        assertEquals(ServerAddressForm.INVALID_ADDRESS, ServerAddressForm.shapeError("https:///missing-host"))
    }

    @Test
    fun `a userinfo trick cannot smuggle plain http to a public host`() {
        // hostOf would read "localhost" here; the real host is evil.com.
        val sneaky = "http://localhost:80@evil.com"
        assertEquals(ServerAddressForm.INVALID_ADDRESS, ServerAddressForm.shapeError(sneaky))
        assertNotNull(ServerAddressForm.liveWarning(sneaky))
        assertNull(ServerAddressForm.probeUrl(sneaky))
    }

    @Test
    fun `probe url is the normalised origin`() {
        assertEquals("http://10.0.2.2:8080", ServerAddressForm.probeUrl("http://10.0.2.2:8080/"))
        assertNull(ServerAddressForm.probeUrl("http://family.example.com"))
    }
}
