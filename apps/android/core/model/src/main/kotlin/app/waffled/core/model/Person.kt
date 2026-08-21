package app.waffled.core.model

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNames

/**
 * Cross-feature domain types. These live in `core:model` precisely so eighteen parallel
 * feature agents don't each invent their own `Person`.
 *
 * ⚠️ FROZEN after Phase 0 — if a feature needs a field that isn't here, stop and report
 * rather than adding a parallel type in a feature module.
 */

/**
 * ⚠️ A person arrives in TWO shapes and must decode both:
 *  - PowerSync rows carry the database's snake_case columns (`color_hex`),
 *  - the REST API emits camelCase (`colorHex`) — `persons.ts:23` maps between them.
 *
 * Hence [JsonNames] on every multi-word field. Supporting only one shape fails
 * SILENTLY: the field decodes to null, every avatar goes grey, and nothing anywhere
 * reports a problem. Locked by `PersonWireFormatTest`.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class Person(
    val id: String,
    @SerialName("household_id") @JsonNames("householdId") val householdId: String? = null,
    val name: String,
    @SerialName("color_hex") @JsonNames("colorHex") val colorHex: String? = null,
    @SerialName("avatar_emoji") @JsonNames("avatarEmoji") val avatarEmoji: String? = null,
    @SerialName("member_type") @JsonNames("memberType") val memberType: String? = null,
    @SerialName("sort_order") @JsonNames("sortOrder") val sortOrder: Int? = null,
    @SerialName("is_admin") @JsonNames("isAdmin") val isAdmin: Boolean = false,
    val capabilities: List<String> = emptyList(),
) {
    /** `isAdmin || capabilities.contains(c)` — the iOS `can(_:)` rule, per person. */
    fun can(capability: String): Boolean = isAdmin || capabilities.contains(capability)

    /** Emoji to render in an [app.waffled.core.design.Avatar]; falls back to an initial. */
    val displayEmoji: String
        get() = avatarEmoji?.takeIf { it.isNotBlank() }
            ?: name.trim().take(1).uppercase().ifEmpty { "?" }
}

@OptIn(ExperimentalSerializationApi::class)
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
    @SerialName("week_start") @JsonNames("weekStart") val weekStart: String? = null,
)
