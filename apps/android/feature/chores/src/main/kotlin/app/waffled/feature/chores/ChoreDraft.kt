package app.waffled.feature.chores

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** How often a chore repeats. The wire form is an rrule — see [ChoreRrule]. */
enum class ChoreRepeat { Once, Daily, Weekly }

/** A parsed repeat rule: the frequency plus, for a weekly rule, its BYDAY codes. */
data class ParsedRepeat(val frequency: ChoreRepeat, val days: List<String>)

/**
 * The chore editor's repeat rule, both directions — the twin of iOS
 * `ChoreEditSheet.buildRrule` / `parseRrule`.
 */
object ChoreRrule {

    /** Weekday codes in display order, Monday first. */
    val WEEKDAYS: List<Pair<String, String>> = listOf(
        "MO" to "Mon", "TU" to "Tue", "WE" to "Wed", "TH" to "Thu",
        "FR" to "Fri", "SA" to "Sat", "SU" to "Sun",
    )

    /**
     * Read a stored rule.
     *
     * **A blank or absent rule is a one-off, not a daily chore.** Reading it as daily
     * would silently convert a one-off into a recurring chore the moment someone opened
     * the editor and saved.
     */
    fun parse(rrule: String?): ParsedRepeat {
        val raw = rrule?.trim().orEmpty()
        if (raw.isEmpty()) return ParsedRepeat(ChoreRepeat.Once, emptyList())

        val upper = raw.uppercase()
        if (!upper.contains("FREQ=WEEKLY")) return ParsedRepeat(ChoreRepeat.Daily, emptyList())

        val marker = upper.indexOf("BYDAY=")
        if (marker < 0) return ParsedRepeat(ChoreRepeat.Weekly, emptyList())

        // Take letters and commas only, so the scan stops at the next rule part
        // (";INTERVAL=2") instead of swallowing it.
        val days = upper.substring(marker + "BYDAY=".length)
            .takeWhile { it.isLetter() || it == ',' }
            .split(',')
            .filter { it.isNotBlank() }
        return ParsedRepeat(ChoreRepeat.Weekly, days)
    }

    /**
     * Build the rule to send. Null means a one-off — the server treats an absent rule as
     * "just once".
     *
     * A weekly rule with no days chosen also degrades to null: a BYDAY-less weekly rule
     * would repeat on whatever day the server inferred.
     */
    fun build(repeat: ChoreRepeat, days: Set<String>): String? = when (repeat) {
        ChoreRepeat.Once -> null
        ChoreRepeat.Daily -> "FREQ=DAILY"
        ChoreRepeat.Weekly -> {
            val ordered = WEEKDAYS.map { it.first }.filter { it in days }
            if (ordered.isEmpty()) null else "FREQ=WEEKLY;BYDAY=${ordered.joinToString(",")}"
        }
    }
}

/**
 * Everything the chore editor collects, and the request body it becomes.
 *
 * Kept as a plain data class outside the composable so the body construction — the part
 * with the traps in it — is unit-testable without a device.
 *
 * The body is built as a [JsonObject], never a `@Serializable` data class, because
 * `WaffledJson` sets `explicitNulls = false`: a nullable property would be **omitted**,
 * and the server reads an omitted key as "leave it alone". Clearing an emoji, sending a
 * chore back to up-for-grabs and turning a recurring chore into a one-off all depend on
 * the null actually reaching the wire.
 */
@Immutable
data class ChoreDraft(
    val title: String = "",
    val emoji: String = "",
    val personId: String? = null,
    val rewardAmount: Int = 1,
    /** The chosen currency key; null means the household default. */
    val currencyKey: String? = null,
    val repeat: ChoreRepeat = ChoreRepeat.Once,
    val days: Set<String> = emptySet(),
    /** The "On" day for a one-off, `yyyy-MM-dd`. */
    val dueOn: String? = null,
    /** Optional time of day, `HH:mm`. Null clears it. */
    val dueTime: String? = null,
    val requiresApproval: Boolean = false,
    val requiresPhoto: Boolean = false,
    /** Whether the current assignee is an adult — see [toBody]. */
    val assigneeIsAdult: Boolean = false,
) {

    /** Save is blocked on an empty title, and on a weekly rule with no day picked. */
    val canSave: Boolean
        get() = title.isNotBlank() && (repeat != ChoreRepeat.Weekly || days.isNotEmpty())

    /**
     * [currencyCount] is a REQUIRED argument rather than a field on the draft: the
     * household's currency count is not something the editor collects, and as a
     * defaultable field it was silently left at 1 — which dropped `rewardCurrency` from
     * every save the user hadn't explicitly re-picked a currency in, quietly moving an
     * edited chore onto the household default.
     */
    fun toBody(currencyCount: Int): JsonObject = buildJsonObject {
        put("title", JsonPrimitive(title.trim()))
        put("emoji", emoji.trim().takeIf { it.isNotEmpty() }?.let(::JsonPrimitive) ?: JsonNull)
        put("personId", personId?.let(::JsonPrimitive) ?: JsonNull)
        put("rewardAmount", JsonPrimitive(rewardAmount))
        put("rrule", ChoreRrule.build(repeat, days)?.let(::JsonPrimitive) ?: JsonNull)
        put("dueTime", dueTime?.let(::JsonPrimitive) ?: JsonNull)
        // A parent doesn't need another parent's OK, so approval is meaningless for an
        // adult assignee — never persist it there, even if the toggle was on before the
        // chore was reassigned.
        put("requiresApproval", JsonPrimitive(if (assigneeIsAdult) false else requiresApproval))
        put("requiresPhoto", JsonPrimitive(requiresPhoto))

        // Only send a currency when the household actually has more than one; otherwise
        // the backend's default is the better answer.
        if (currencyCount > 1 && currencyKey != null) {
            put("rewardCurrency", JsonPrimitive(currencyKey))
        }

        // The "On" day applies to a one-off only (create sets the instance's day, edit
        // moves it). The server ignores it for a recurring chore, so sending one there is
        // noise that reads like an instruction.
        if (repeat == ChoreRepeat.Once && dueOn != null) {
            put("dueOn", JsonPrimitive(dueOn))
        }
    }

    companion object {
        /** Seed the editor from an existing instance. */
        fun from(instance: ChoresApi.ChoreInstance): ChoreDraft {
            val parsed = ChoreRrule.parse(instance.rrule)
            return ChoreDraft(
                title = instance.choreTitle,
                emoji = instance.emoji.orEmpty(),
                personId = instance.personId,
                rewardAmount = instance.rewardAmount,
                currencyKey = instance.rewardCurrency,
                repeat = parsed.frequency,
                days = parsed.days.toSet(),
                dueOn = instance.dueOn,
                dueTime = instance.dueTime,
                requiresApproval = instance.requiresApproval,
                requiresPhoto = instance.requiresPhoto,
            )
        }
    }
}
