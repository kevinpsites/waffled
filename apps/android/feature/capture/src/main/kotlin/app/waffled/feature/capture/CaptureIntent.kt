package app.waffled.feature.capture

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The parsed "Add anything" intent — from `POST /api/capture` or the on-device
 * [CaptureHeuristic]. Mirrors the iOS `CaptureIntent` and the web `ParsedIntent` union.
 */
sealed interface CaptureIntent {
    /** The wire `kind` discriminator. */
    val kind: String

    data class Event(
        val title: String,
        /** ISO-8601 instant. */
        val startsAt: String,
        val allDay: Boolean,
        val personName: String?,
        val rrule: String?,
        val scheduleLabel: String,
        val whenLabel: String,
    ) : CaptureIntent { override val kind get() = "event" }

    data class Grocery(val name: String, val quantity: String?) : CaptureIntent {
        override val kind get() = "grocery"
    }

    data class Task(
        val title: String,
        val personName: String?,
        val stars: Int?,
        val rrule: String?,
        val scheduleLabel: String,
    ) : CaptureIntent { override val kind get() = "task" }

    data class Meal(
        val title: String,
        /** `YYYY-MM-DD`, or null for "today". */
        val date: String?,
        val mealType: String,
        val whenLabel: String,
    ) : CaptureIntent { override val kind get() = "meal" }

    data class ListItem(val itemName: String, val listName: String?, val quantity: String?) : CaptureIntent {
        override val kind get() = "list"
    }

    data class Countdown(val title: String, val date: String, val emoji: String?, val whenLabel: String) : CaptureIntent {
        override val kind get() = "countdown"
    }

    data class Person(
        val name: String,
        val memberType: String,
        val avatarEmoji: String?,
        val birthday: String?,
        val isAdmin: Boolean,
    ) : CaptureIntent { override val kind get() = "person" }

    data class Goal(
        val title: String,
        val goalType: String,
        val targetValue: Double?,
        val unit: String?,
        val deadline: String?,
        val trackingMode: String,
        val audience: String?,
    ) : CaptureIntent { override val kind get() = "goal" }

    data class Pantry(
        val name: String,
        val amount: String?,
        val unit: String?,
        val location: String,
        val expiresOn: String?,
        val lowAt: Double?,
    ) : CaptureIntent { override val kind get() = "pantry" }

    data class Reward(
        val title: String,
        val emoji: String?,
        val cost: Int?,
        val currency: String?,
        val category: String?,
        val requiresApproval: Boolean?,
    ) : CaptureIntent { override val kind get() = "reward" }

    /**
     * Tier 2 — a verb acting on an EXISTING row. Never committed directly: verb +
     * targetKind + description drive `/api/capture/resolve`, the user picks a candidate,
     * then `/api/capture/commit`. [args] is best-effort and refined server-side.
     */
    data class Mutate(
        val verb: String,
        val targetKind: String?,
        val description: String,
        val args: Map<String, JsonElement>,
    ) : CaptureIntent { override val kind get() = "mutate" }

    companion object {
        /**
         * Decode the server's intent object. Lenient like the iOS decoder: optional
         * fields fall back to defaults; an unknown `kind` or a missing required field
         * yields null rather than throwing.
         */
        fun fromJson(element: JsonElement?): CaptureIntent? {
            val o = (element as? JsonObject) ?: return null
            fun s(k: String): String? = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
            fun d(k: String): Double? = (o[k] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
            fun i(k: String): Int? = (o[k] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
            fun b(k: String): Boolean? = (o[k] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
            return when (s("kind")) {
                "event" -> Event(
                    title = s("title") ?: return null,
                    startsAt = s("startsAt") ?: return null,
                    allDay = b("allDay") ?: false,
                    personName = s("personName"),
                    rrule = s("rrule"),
                    scheduleLabel = s("scheduleLabel") ?: "",
                    whenLabel = s("whenLabel") ?: "",
                )
                "grocery" -> Grocery(s("name") ?: return null, s("quantity"))
                "task" -> Task(s("title") ?: return null, s("personName"), i("stars"), s("rrule"), s("scheduleLabel") ?: "")
                "meal" -> Meal(s("title") ?: return null, s("date"), s("mealType") ?: "dinner", s("whenLabel") ?: "")
                "list" -> ListItem(s("itemName") ?: return null, s("listName"), s("quantity"))
                "countdown" -> Countdown(s("title") ?: return null, s("date") ?: return null, s("emoji"), s("whenLabel") ?: "")
                "person" -> Person(s("name") ?: return null, s("memberType") ?: "adult", s("avatarEmoji"), s("birthday"), b("isAdmin") ?: false)
                "goal" -> Goal(
                    title = s("title") ?: return null,
                    goalType = s("goalType") ?: "habit",
                    targetValue = d("targetValue"),
                    unit = s("unit"),
                    deadline = s("deadline"),
                    trackingMode = s("trackingMode") ?: "shared_total",
                    audience = s("audience"),
                )
                "pantry" -> Pantry(s("name") ?: return null, s("amount"), s("unit"), s("location") ?: "Pantry", s("expiresOn"), d("lowAt"))
                "reward" -> Reward(s("title") ?: return null, s("emoji"), i("cost"), s("currency"), s("category"), b("requiresApproval"))
                "mutate" -> {
                    // `args` is current; `mutateArgs` is the legacy alias an older server emits.
                    val args = (o["args"] as? JsonObject) ?: (o["mutateArgs"] as? JsonObject) ?: JsonObject(emptyMap())
                    val description = runCatching { o["target"]?.jsonObject?.get("description")?.jsonPrimitive?.content }
                        .getOrNull() ?: return null
                    Mutate(s("verb") ?: return null, s("targetKind"), description, args.filterValues { it !is JsonNull })
                }
                else -> null
            }
        }
    }
}

/** A glanceable preview of an intent — the twin of the iOS `CaptureSummary` / web `intentSummary`. */
data class CaptureSummary(val icon: String, val kind: String, val primary: String, val detail: String) {
    companion object {
        fun of(intent: CaptureIntent): CaptureSummary = when (intent) {
            is CaptureIntent.Event -> CaptureSummary(
                "📅", "Event", intent.title,
                listOf(intent.whenLabel, intent.scheduleLabel, intent.personName.orEmpty()).filter { it.isNotEmpty() }.joinToString(" · "),
            )
            is CaptureIntent.Grocery -> CaptureSummary(
                "🛒", "Grocery", listOfNotNull(intent.quantity, intent.name).joinToString(" "), "Adds to the grocery list",
            )
            is CaptureIntent.Task -> CaptureSummary(
                "✅", "Task", intent.title,
                listOf(intent.personName ?: "Up for grabs", intent.scheduleLabel, intent.stars?.let { "$it★" }.orEmpty())
                    .filter { it.isNotEmpty() }.joinToString(" · "),
            )
            is CaptureIntent.Meal -> CaptureSummary("🍽️", "Meal", intent.title, "${intent.whenLabel} · meal plan")
            is CaptureIntent.ListItem -> CaptureSummary(
                "📝", "List", listOfNotNull(intent.quantity, intent.itemName).joinToString(" "),
                intent.listName?.let { "Adds to $it" } ?: "Adds to a list",
            )
            is CaptureIntent.Countdown -> CaptureSummary("⏳", "Countdown", intent.title, intent.whenLabel)
            is CaptureIntent.Person -> CaptureSummary(
                intent.avatarEmoji ?: "👤", "Family member", intent.name, memberTypeLabel(intent.memberType),
            )
            is CaptureIntent.Goal -> CaptureSummary(
                "🎯", "Goal", intent.title,
                listOfNotNull(
                    goalTypeLabel(intent.goalType),
                    intent.targetValue?.let { tv -> trimNumber(tv).let { n -> intent.unit?.let { "$n $it" } ?: n } },
                    intent.deadline?.let { "by $it" },
                ).filter { it.isNotEmpty() }.joinToString(" · "),
            )
            is CaptureIntent.Pantry -> CaptureSummary(
                "🥫", "Pantry",
                listOfNotNull(intent.amount, intent.unit, intent.name).filter { it.isNotEmpty() }.joinToString(" "),
                listOfNotNull("Adds to ${intent.location}", intent.expiresOn?.let { "expires $it" })
                    .filter { it.isNotEmpty() }.joinToString(" · "),
            )
            is CaptureIntent.Reward -> CaptureSummary(
                intent.emoji ?: "🎁", "Reward", intent.title,
                listOfNotNull(
                    "Adds to the reward shop",
                    intent.cost?.let { "$it★" },
                    if (intent.requiresApproval == true) "needs approval" else null,
                ).joinToString(" · "),
            )
            is CaptureIntent.Mutate -> CaptureSummary(
                MutateLabels.icon(intent.verb), MutateLabels.verbLabel(intent.verb),
                intent.description, MutateLabels.targetLabel(intent.targetKind),
            )
        }

        fun memberTypeLabel(memberType: String): String = when (memberType) {
            "kid" -> "Kid"
            "teen" -> "Teen"
            else -> "Adult"
        }

        fun goalTypeLabel(goalType: String): String = when (goalType) {
            "count" -> "Count"
            "total" -> "Total"
            "checklist" -> "Checklist"
            else -> "Habit"
        }
    }
}

/** `20.0` → `"20"`, `2.5` → `"2.5"` — how a goal target / log amount reads. */
fun trimNumber(n: Double): String = if (n == Math.rint(n) && !n.isInfinite()) n.toLong().toString() else n.toString()

/** Display copy for a Tier 2 mutate. Mirrors the web `mutateIcon` / `mutateVerbLabel` / `mutateTargetLabel`. */
object MutateLabels {
    fun icon(verb: String): String = when (verb) {
        "complete" -> "✅"
        "log" -> "📈"
        "reschedule" -> "📅"
        "reassign" -> "🔄"
        "redeem" -> "⭐"
        "delete" -> "🗑️"
        else -> "✨"
    }

    fun verbLabel(verb: String): String = when (verb) {
        "complete" -> "Mark done"
        "log" -> "Log progress"
        "reschedule" -> "Reschedule"
        "reassign" -> "Reassign"
        "redeem" -> "Redeem"
        "delete" -> "Delete"
        else -> "Update"
    }

    fun targetLabel(targetKind: String?): String = when (targetKind) {
        "chore" -> "chore"
        "goal" -> "goal"
        "listItem" -> "list item"
        "event" -> "event"
        "reward" -> "reward"
        else -> "match"
    }

    /** The confirm-button label per verb (the web `CONFIRM_LABEL`). */
    fun confirmLabel(verb: String): String = when (verb) {
        "complete" -> "Mark done"
        "log" -> "Log it"
        "reschedule" -> "Reschedule"
        "reassign" -> "Reassign"
        "redeem" -> "Redeem"
        "delete" -> "Delete it"
        else -> "Do it"
    }

    /**
     * Copy for an empty resolve. `unsupported` means the ACTION can't run — never say
     * "Couldn't find…", which would wrongly claim the item doesn't exist.
     */
    fun emptyHint(unsupported: Boolean, disabledReason: String?, targetKind: String?): String {
        if (unsupported) return disabledReason ?: "Quick-add can't do that yet."
        return "Couldn't find a ${targetLabel(targetKind)} like that" + (disabledReason?.let { " — $it" } ?: "")
    }
}
