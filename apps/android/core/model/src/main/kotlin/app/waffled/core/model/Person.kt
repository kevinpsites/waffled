package app.waffled.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Cross-feature domain types. These live in `core:model` precisely so eighteen parallel
 * feature agents don't each invent their own `Person`.
 *
 * ⚠️ FROZEN after Phase 0 — if a feature needs a field that isn't here, stop and report
 * rather than adding a parallel type in a feature module.
 */

@Serializable
data class Person(
    val id: String,
    @SerialName("household_id") val householdId: String? = null,
    val name: String,
    @SerialName("color_hex") val colorHex: String? = null,
    @SerialName("avatar_emoji") val avatarEmoji: String? = null,
    @SerialName("member_type") val memberType: String? = null,
    @SerialName("sort_order") val sortOrder: Int? = null,
    @SerialName("is_admin") val isAdmin: Boolean = false,
    val capabilities: List<String> = emptyList(),
) {
    /** `isAdmin || capabilities.contains(c)` — the iOS `can(_:)` rule, per person. */
    fun can(capability: String): Boolean = isAdmin || capabilities.contains(capability)

    /** Emoji to render in an [app.waffled.core.design.Avatar]; falls back to an initial. */
    val displayEmoji: String
        get() = avatarEmoji?.takeIf { it.isNotBlank() }
            ?: name.trim().take(1).uppercase().ifEmpty { "?" }
}

@Serializable
data class Household(
    val id: String,
    val name: String,
    val timezone: String? = null,
    /**
     * The household's first day of week. The SERVER owns this boundary — clients must
     * never compute their own week start (a client-computed one caused the PlanMonth
     * grocery-rebuild bug).
     */
    @SerialName("week_start") val weekStart: String? = null,
)
