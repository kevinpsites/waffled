package app.waffled.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * A household reward currency (`GET /api/currencies`).
 *
 * Lifted into `core:model` because Chores and Rewards independently invented an identical
 * copy, and Goals and Today will need it too — the shape below is their agreed one.
 *
 * Amounts are whole numbers everywhere: stars have no minor units, so there is no
 * fractional arithmetic to get wrong. The hazard is in DERIVED values — see
 * [progressPercent].
 */
@Serializable
data class Currency(
    val key: String,
    val label: String = "",
    val symbol: String = "",
    /** The currency's own `#RRGGBB`; parse with `colorFromHex`, fall back to gold. */
    val color: String? = null,
    @SerialName("isDefault") val isDefault: Boolean = false,
    /** A non-spendable currency tracks effort but cannot price a reward. */
    val spendable: Boolean = true,
    @SerialName("sortOrder") val sortOrder: Int = 0,
) {
    /** What to show when a currency has no symbol configured. */
    val displaySymbol: String get() = symbol.ifBlank { "★" }

    val displayLabel: String get() = label.ifBlank { key }
}

/**
 * Percent complete toward a target, **truncated**.
 *
 * Truncation is deliberate: 999 of 1000 must read 99%, never a rounded-up 100% that
 * tells a child their jar is full when it isn't. Returns 0 for a non-positive target
 * rather than dividing by zero, and never exceeds 100.
 */
fun progressPercent(current: Int, target: Int): Int {
    if (target <= 0) return 0
    if (current <= 0) return 0
    val pct = (current.toLong() * 100L) / target.toLong()
    return pct.coerceAtMost(100L).toInt()
}
