package app.waffled.core.auth

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** A plain string key/value sink — SharedPreferences in the app, a map in tests. */
interface KeyValueStore {
    fun getString(key: String): String?
    fun putString(key: String, value: String)
    fun remove(key: String)
}

/**
 * Encrypt/decrypt seam. The real implementation holds its key in the Android Keystore,
 * where it never enters app memory; tests supply an in-process key.
 */
interface TokenCrypto {
    fun encrypt(plaintext: ByteArray): ByteArray
    fun decrypt(payload: ByteArray): ByteArray
}

/**
 * Tokens encrypted at rest — the Android answer to the iOS Keychain.
 *
 * Both tokens go into ONE envelope so they cannot get out of step, and the envelope is
 * length-prefixed rather than delimiter-separated: JWTs are full of dots and base64
 * padding, so any separator would eventually be ambiguous.
 *
 * Uses `java.util.Base64` rather than `android.util.Base64`: it is available from API
 * 26 (our minSdk) and, unlike the Android one, is real on the JVM — so this class stays
 * unit-testable instead of needing a device.
 *
 * Anything unreadable — tampering, or a Keystore key lost to a device restore — is
 * treated as "signed out" and **cleared**, rather than left on disk to fail forever.
 */
class EncryptedTokenStore(
    private val prefs: KeyValueStore,
    private val crypto: TokenCrypto,
) : TokenStore {

    override fun load(): TokenPair? {
        val encoded = prefs.getString(KEY) ?: return null
        return runCatching {
            val plain = crypto.decrypt(Base64.getDecoder().decode(encoded))
            decode(plain)
        }.getOrElse {
            // Undecryptable: clear it so we don't retry a dead blob on every launch.
            clear()
            null
        }
    }

    override fun save(tokens: TokenPair) {
        val sealed = crypto.encrypt(encode(tokens))
        prefs.putString(KEY, Base64.getEncoder().encodeToString(sealed))
    }

    override fun clear() {
        prefs.remove(KEY)
    }

    // ---- length-prefixed envelope ----

    private fun encode(tokens: TokenPair): ByteArray {
        val a = tokens.accessToken.toByteArray(Charsets.UTF_8)
        val r = tokens.refreshToken.toByteArray(Charsets.UTF_8)
        return intBytes(a.size) + a + intBytes(r.size) + r
    }

    private fun decode(bytes: ByteArray): TokenPair {
        var i = 0
        fun next(): String {
            val len = readInt(bytes, i); i += 4
            val s = String(bytes, i, len, Charsets.UTF_8); i += len
            return s
        }
        return TokenPair(next(), next())
    }

    private fun intBytes(v: Int) = byteArrayOf(
        (v ushr 24).toByte(), (v ushr 16).toByte(), (v ushr 8).toByte(), v.toByte(),
    )

    private fun readInt(b: ByteArray, off: Int): Int =
        ((b[off].toInt() and 0xFF) shl 24) or
            ((b[off + 1].toInt() and 0xFF) shl 16) or
            ((b[off + 2].toInt() and 0xFF) shl 8) or
            (b[off + 3].toInt() and 0xFF)

    private companion object {
        const val KEY = "waffled.auth.sealed"
    }
}

/**
 * AES-GCM with a key generated in, and never leaving, the Android Keystore.
 *
 * `setUserAuthenticationRequired(false)` on purpose: the app must be able to refresh in
 * the background, matching the iOS accessibility choice
 * (`AfterFirstUnlockThisDeviceOnly`) rather than demanding a biometric per request.
 */
class KeystoreTokenCrypto(
    private val alias: String = "waffled.auth.key",
) : TokenCrypto {

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return gen.generateKey()
    }

    override fun encrypt(plaintext: ByteArray): ByteArray {
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(Cipher.ENCRYPT_MODE, key())
        val iv = c.iv
        // GCM picks a fresh IV per encryption — store it alongside the ciphertext.
        return byteArrayOf(iv.size.toByte()) + iv + c.doFinal(plaintext)
    }

    override fun decrypt(payload: ByteArray): ByteArray {
        val ivLen = payload[0].toInt()
        val iv = payload.copyOfRange(1, 1 + ivLen)
        val body = payload.copyOfRange(1 + ivLen, payload.size)
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
        return c.doFinal(body)
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_BITS = 128
    }
}
