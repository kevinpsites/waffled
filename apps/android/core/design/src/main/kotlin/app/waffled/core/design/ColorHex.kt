package app.waffled.core.design

import androidx.compose.ui.graphics.Color

/**
 * Parse a `persons.color_hex` value into a [Color], or `null` if it isn't one.
 *
 * This is deliberately forgiving — the value is user-entered and arrives over the wire,
 * so a bad string must degrade to "no colour" (the caller falls back to a token) rather
 * than throw. Accepts `#RGB`, `#RRGGBB`, `#RRGGBBAA`, with or without the leading `#`,
 * any case, and surrounding whitespace.
 */
fun colorFromHex(value: String?): Color? {
    val raw = value?.trim()?.removePrefix("#") ?: return null
    if (raw.isEmpty()) return null
    if (!raw.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }) return null

    val rgba: Long = when (raw.length) {
        3 -> {
            // #F0A -> #FF00AA
            val r = raw[0].digitToInt(16).let { it * 16 + it }
            val g = raw[1].digitToInt(16).let { it * 16 + it }
            val b = raw[2].digitToInt(16).let { it * 16 + it }
            (0xFFL shl 24) or (r.toLong() shl 16) or (g.toLong() shl 8) or b.toLong()
        }
        6 -> 0xFF000000L or raw.toLong(16)
        8 -> {
            // Wire format is RRGGBBAA; Compose wants AARRGGBB.
            val v = raw.toLong(16)
            val a = v and 0xFF
            (a shl 24) or (v ushr 8)
        }
        else -> return null
    }
    return Color(rgba)
}
