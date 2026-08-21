package app.waffled.core.auth

import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Tokens must be encrypted at rest. iOS keeps them in the Keychain
 * (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`); Android's equivalent is a
 * Keystore-held AES-GCM key that never leaves the secure hardware, wrapping values
 * written to ordinary preferences.
 *
 * The Keystore itself needs a device, so [TokenCrypto] is a seam: these tests drive it
 * with a plain in-process AES-GCM key, and the app supplies the Keystore-backed one. The
 * STORE logic — envelope format, tamper handling, clearing — is what's under test here.
 */
class EncryptedTokenStoreTest {

    /** Real AES-GCM, but with an in-process key so this runs on the JVM. */
    private class TestCrypto : TokenCrypto {
        private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

        override fun encrypt(plaintext: ByteArray): ByteArray {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, key)
            val iv = c.iv
            return byteArrayOf(iv.size.toByte()) + iv + c.doFinal(plaintext)
        }

        override fun decrypt(payload: ByteArray): ByteArray {
            val ivLen = payload[0].toInt()
            val iv = payload.copyOfRange(1, 1 + ivLen)
            val body = payload.copyOfRange(1 + ivLen, payload.size)
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
            return c.doFinal(body)
        }
    }

    private class FakePrefs : KeyValueStore {
        val map = mutableMapOf<String, String>()
        override fun getString(key: String): String? = map[key]
        override fun putString(key: String, value: String) { map[key] = value }
        override fun remove(key: String) { map.remove(key) }
    }

    @Test
    fun roundTripsAPair() {
        val store = EncryptedTokenStore(FakePrefs(), TestCrypto())
        store.save(TokenPair("access-abc", "refresh-xyz"))
        assertEquals(TokenPair("access-abc", "refresh-xyz"), store.load())
    }

    @Test
    fun theStoredBytesAreNotThePlainToken() {
        val prefs = FakePrefs()
        val store = EncryptedTokenStore(prefs, TestCrypto())
        store.save(TokenPair("access-abc", "refresh-xyz"))

        val onDisk = prefs.map.values.joinToString("")
        assertFalse(onDisk.contains("access-abc"), "the access token is sitting in the clear")
        assertFalse(onDisk.contains("refresh-xyz"), "the refresh token is sitting in the clear")
        assertTrue(onDisk.isNotEmpty())
    }

    @Test
    fun anEmptyStoreLoadsAsNull() {
        assertNull(EncryptedTokenStore(FakePrefs(), TestCrypto()).load())
    }

    @Test
    fun clearRemovesTheCiphertext() {
        val prefs = FakePrefs()
        val store = EncryptedTokenStore(prefs, TestCrypto())
        store.save(TokenPair("a", "r"))

        store.clear()

        assertNull(store.load())
        assertTrue(prefs.map.isEmpty(), "clearing must not leave ciphertext behind")
    }

    @Test
    fun tamperedCiphertextLoadsAsNullRatherThanCrashing() {
        // GCM authenticates, so a flipped byte fails the tag. The user should be treated
        // as signed out, not shown a crash — and the junk must not be left to fail again.
        val prefs = FakePrefs()
        val store = EncryptedTokenStore(prefs, TestCrypto())
        store.save(TokenPair("a", "r"))

        val key = prefs.map.keys.first()
        prefs.map[key] = "!!!not-base64!!!"

        assertNull(store.load())
        assertTrue(prefs.map.isEmpty(), "unreadable state should be cleared, not retried forever")
    }

    @Test
    fun aKeyRotationInvalidatesOldCiphertextSafely() {
        // If the Keystore key is lost (device restore, biometric reset), the old blob is
        // undecryptable. That is a sign-out, not a crash loop.
        val prefs = FakePrefs()
        EncryptedTokenStore(prefs, TestCrypto()).save(TokenPair("a", "r"))

        val afterRotation = EncryptedTokenStore(prefs, TestCrypto()) // a different key
        assertNull(afterRotation.load())
    }

    @Test
    fun tokensContainingSeparatorsSurviveTheRoundTrip() {
        // JWTs are dot-separated and base64; the envelope must not be delimiter-fragile.
        val jwt = "eyJhbGci.eyJzdWIiOiIxIn0.sig-with-dots.and\nnewline"
        val store = EncryptedTokenStore(FakePrefs(), TestCrypto())
        store.save(TokenPair(jwt, "refresh/with+slashes=="))
        assertEquals(TokenPair(jwt, "refresh/with+slashes=="), store.load())
    }
}
