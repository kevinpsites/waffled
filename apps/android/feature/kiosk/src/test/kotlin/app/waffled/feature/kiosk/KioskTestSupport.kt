package app.waffled.feature.kiosk

import app.waffled.core.auth.KeyValueStore
import app.waffled.core.auth.TokenCrypto

/** A map-backed prefs sink, so the device store runs on the JVM. */
class MapKeyValueStore : KeyValueStore {
    val values = mutableMapOf<String, String>()
    override fun getString(key: String): String? = values[key]
    override fun putString(key: String, value: String) { values[key] = value }
    override fun remove(key: String) { values.remove(key) }
}

/** Reversible but not identity — enough to prove the secret never lands in plain text. */
class XorCrypto(private val key: Byte = 0x5A) : TokenCrypto {
    var failDecrypt = false
    override fun encrypt(plaintext: ByteArray): ByteArray = ByteArray(plaintext.size) { (plaintext[it].toInt() xor key.toInt()).toByte() }
    override fun decrypt(payload: ByteArray): ByteArray {
        if (failDecrypt) error("key lost")
        return encrypt(payload)
    }
}
