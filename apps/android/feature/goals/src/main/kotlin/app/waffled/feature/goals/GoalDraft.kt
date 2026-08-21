package app.waffled.feature.goals

import androidx.compose.runtime.Immutable
import java.time.LocalDate
import kotlin.math.roundToInt
import kotlin.math.roundToLong
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Everything the goal editor holds, plus every rule that decides what it sends.
 *
 * Lifted out of the composable on purpose: the counting model, the auto-derived milestone
 * ladder and the request body are where the bugs live, and none of them need a device to
 * test. The composable stays a thin renderer over this. Mirrors the iOS `GoalCreateSheet`
 * and the web goal modal.
 */
@Immutable
data class GoalDraft(
    val title: String = "",
    val goalListId: String? = null,
    /** shared_total | each_tracks */
    val trackingMode: String = "each_tracks",
    /** count_once | split */
    val participantMode: String = "count_once",
    /** family | per_person */
    val targetBasis: String = "per_person",
    /** total | count | habit | checklist */
    val goalType: String = "total",
    val target: String = "1000",
    val unit: String = "hours",
    val habitPeriod: String = "week",
    val habitPer: String = "5",
    val category: String = "physical",
    val hasDeadline: Boolean = false,
    val deadline: LocalDate = LocalDate.now(),
    val isFeatured: Boolean = false,
    val isSpotlight: Boolean = false,
    val hasRewards: Boolean = false,
    /**
     * Most goals benefit from matching calendar events adding progress, and it is one tap
     * to turn off — so this defaults ON, matching the web and iOS product decision.
     */
    val autoFromCalendar: Boolean = true,
    val milestones: List<MilestoneDraft> = emptyList(),
    /**
     * The signature of the last auto-derived ladder. While [milestones] still matches it,
     * changing the target or type re-derives; once someone hand-edits a row the signature
     * diverges and auto-derivation stops for good.
     */
    val lastDerivedSignature: String = "",
    val steps: List<StepDraft> = List(3) { StepDraft() },
    /** True when this draft is editing an existing goal rather than creating one. */
    val isEditing: Boolean = false,
) {

    @Immutable
    data class MilestoneDraft(
        val emoji: String = "🎯",
        val threshold: String = "0",
        val reward: String = "",
    )

    /** A checklist step. [existingId] is the server id when editing, so steps are updated in place. */
    @Immutable
    data class StepDraft(
        val existingId: String? = null,
        val label: String = "",
    )

    /** How prominent the goal is: one spotlight per list, then a pinned band, then the rest. */
    enum class Tier { Spotlight, Pinned, Normal }

    // ---- derived state ---------------------------------------------------------

    val isHabit: Boolean get() = goalType == "habit"
    val isChecklist: Boolean get() = goalType == "checklist"

    val filledSteps: List<StepDraft> get() = steps.filter { it.label.isNotBlank() }

    val tier: Tier
        get() = when {
            isSpotlight -> Tier.Spotlight
            isFeatured -> Tier.Pinned
            else -> Tier.Normal
        }

    /**
     * Shared-vs-each, derived from the three backend fields rather than stored separately
     * — one source of truth beats two that can disagree.
     *
     * "Each tracks their own" is the PER-PERSON BASIS for an amount goal, and plain
     * `each_tracks` for a habit or checklist, which have no per-person target.
     */
    val shared: Boolean
        get() = if (goalType == "total" || goalType == "count") {
            !(trackingMode == "each_tracks" && targetBasis == "per_person")
        } else {
            trackingMode != "each_tracks"
        }

    /** The measure-aware sub-choice: a total is full|split, a count is each|once. */
    val countChoice: String
        get() = if (goalType == "total") {
            if (trackingMode == "each_tracks") "full" else "split"
        } else {
            if (trackingMode == "each_tracks") "each" else "once"
        }

    /** The three backend fields the counting model actually writes, for assertions. */
    fun countingTriple(): Triple<String, String, String> = Triple(trackingMode, targetBasis, participantMode)

    /** Mirrors the web's per-type validation: a name, plus a valid measure. */
    val canSave: Boolean
        get() {
            if (title.isBlank()) return false
            return when (goalType) {
                "checklist" -> filledSteps.isNotEmpty()
                "habit" -> (habitPer.trim().toIntOrNull() ?: 0) > 0
                else -> (target.trim().toDoubleOrNull() ?: 0.0) > 0 && unit.isNotBlank()
            }
        }

    // ---- transitions -----------------------------------------------------------

    fun setSharedMode(): GoalDraft =
        if (goalType == "total" || goalType == "count") {
            copy(trackingMode = "each_tracks", targetBasis = "family", participantMode = "count_once")
        } else {
            copy(trackingMode = "shared_total", targetBasis = "family", participantMode = "count_once")
        }

    fun setEachMode(): GoalDraft = copy(
        trackingMode = "each_tracks",
        targetBasis = if (goalType == "total" || goalType == "count") "per_person" else "family",
        participantMode = "count_once",
    )

    fun setCountChoice(choice: String): GoalDraft = when {
        goalType == "total" && choice == "full" ->
            copy(trackingMode = "each_tracks", targetBasis = "family", participantMode = "count_once")

        goalType == "count" && choice == "each" ->
            copy(trackingMode = "each_tracks", targetBasis = "family", participantMode = "count_once")

        goalType == "total" && choice == "split" ->
            copy(trackingMode = "shared_total", targetBasis = "family", participantMode = "split")

        // count "once" — everyone listed is just who came along.
        else -> copy(trackingMode = "shared_total", targetBasis = "family", participantMode = "count_once")
    }

    /**
     * Switch measure, fitting the unit (a Count must not inherit the Total default of
     * "hours") and re-normalising the counting fields for the new measure.
     */
    fun selectMeasure(key: String): GoalDraft {
        val wasShared = shared
        val fittedUnit = when {
            key == "count" && (unit == "hours" || unit.isBlank()) -> ""
            key == "total" && unit.isBlank() -> "hours"
            else -> unit
        }
        val moved = copy(goalType = key, unit = fittedUnit)
        return if (wasShared) moved.setSharedMode() else moved.setEachMode()
    }

    fun withTier(next: Tier): GoalDraft =
        copy(isSpotlight = next == Tier.Spotlight, isFeatured = next == Tier.Pinned)

    /**
     * Re-derive the starter ladder from the current target and type — but only while
     * nobody has hand-edited it, and never on an edit (an existing goal keeps its own).
     */
    fun reDeriveIfUntouched(): GoalDraft {
        if (isEditing) return this
        if (signature(milestones) != lastDerivedSignature) return this
        val derived = derivedMilestones(goalType, target.trim().toIntOrNull() ?: 0)
        return copy(milestones = derived, lastDerivedSignature = signature(derived))
    }

    // ---- the request body ------------------------------------------------------

    /**
     * The create/update body.
     *
     * Two classes of field live here and they pull in OPPOSITE directions — keep them
     * apart, or someone will "fix" the inconsistency and break one of them:
     *
     *  - **Clearable** (`goalListId`, `unit`, `deadline`) must be sent as an explicit
     *    `JsonNull`. `WaffledJson` sets `explicitNulls = false`, so an omitted key reads
     *    as "leave it alone" and a removed deadline would quietly survive.
     *  - **Preserve-only** (`healthMetric`, `healthDailyTarget`) must NOT be sent at all.
     *    Android has no health source, so it has no opinion about the Apple Health link;
     *    iOS sends an explicit null when its toggle is off, and copying that would wipe
     *    the link off any goal the moment someone edited it from their phone.
     */
    fun body(participantIds: List<String>): JsonObject = buildJsonObject {
        put("title", title.trim())
        put("goalType", goalType)
        put("category", category)
        put("trackingMode", trackingMode)
        put("participantMode", participantMode)
        put("targetBasis", targetBasis)
        put("logMethod", "quick_log")
        put("isFeatured", isFeatured)
        put("isSpotlight", isSpotlight)
        put("hasRewards", hasRewards)
        // Checklist progress comes from ticking steps, never from a matching event.
        put("autoFromCalendar", if (isChecklist) false else autoFromCalendar)

        // -- clearable: an explicit null is the only way to remove one of these --
        put("goalListId", goalListId?.let(::JsonPrimitive) ?: JsonNull)
        put(
            "unit",
            if (isHabit || isChecklist || unit.isBlank()) JsonNull else JsonPrimitive(unit.trim()),
        )
        put("deadline", if (hasDeadline) JsonPrimitive(deadline.toString()) else JsonNull)

        // -- the measure --
        when {
            isHabit -> {
                val n = habitPer.trim().toIntOrNull() ?: 0
                put("targetValue", n)
                put("habitPeriod", habitPeriod)
                put("habitTargetPerPeriod", n)
            }

            isChecklist -> {
                put("targetValue", JsonNull)
                put(
                    "steps",
                    buildJsonArray {
                        filledSteps.forEach { step ->
                            add(
                                buildJsonObject {
                                    put("label", step.label.trim())
                                    step.existingId?.let { put("id", it) }
                                },
                            )
                        }
                    },
                )
            }

            else -> put("targetValue", target.trim().toDoubleOrNull()?.let(::JsonPrimitive) ?: JsonNull)
        }

        put("participantIds", buildJsonArray { participantIds.forEach { add(JsonPrimitive(it)) } })
        put(
            "milestones",
            buildJsonArray {
                if (hasRewards) {
                    milestones.forEach { m ->
                        add(
                            buildJsonObject {
                                put("threshold", m.threshold.trim().toIntOrNull() ?: 0)
                                put("emoji", m.emoji)
                                put("label", m.threshold)
                                put("rewardText", m.reward)
                            },
                        )
                    }
                }
            },
        )
        // healthMetric / healthDailyTarget are DELIBERATELY absent — see the KDoc.
    }

    companion object {

        val CATEGORIES = listOf("physical", "intellectual", "spiritual", "creative", "social")

        val CATEGORY_LABELS = mapOf(
            "physical" to "Physical",
            "intellectual" to "Intellectual",
            "spiritual" to "Spiritual",
            "creative" to "Creative",
            "social" to "Social",
        )

        /** A brand-new goal: the defaults the mock opens on, with its starter ladder. */
        fun new(defaultListId: String?): GoalDraft {
            val derived = derivedMilestones("total", 1000)
            return GoalDraft(
                goalListId = defaultListId,
                milestones = derived,
                lastDerivedSignature = signature(derived),
            )
        }

        /** Prefill from an existing goal, for the edit flow. */
        fun from(detail: GoalsApi.GoalDetail): GoalDraft {
            val deadlineDay = detail.deadline?.let { runCatching { GoalDateKey.parse(it) }.getOrNull() }
            return GoalDraft(
                title = detail.title,
                goalListId = detail.goalListId,
                trackingMode = detail.trackingMode,
                participantMode = detail.participantMode ?: "count_once",
                targetBasis = detail.targetBasis ?: "family",
                goalType = detail.goalType,
                target = detail.target?.let(::goalFmt) ?: "",
                unit = detail.unit.orEmpty(),
                habitPeriod = detail.habitPeriod ?: "week",
                habitPer = detail.habitTargetPerPeriod?.toString() ?: "5",
                category = detail.category ?: "physical",
                hasDeadline = deadlineDay != null,
                deadline = deadlineDay ?: LocalDate.now(),
                isFeatured = detail.isFeatured,
                isSpotlight = detail.isSpotlight == true,
                hasRewards = detail.hasRewards,
                autoFromCalendar = detail.autoFromCalendar,
                milestones = detail.milestones
                    .map { MilestoneDraft(it.emoji ?: "🎯", goalFmt(it.threshold), it.rewardText.orEmpty()) }
                    .ifEmpty { derivedMilestones(detail.goalType, detail.target?.roundToInt() ?: 0) },
                steps = detail.steps
                    .map { StepDraft(existingId = it.id, label = it.label) }
                    .ifEmpty { List(3) { StepDraft() } },
                isEditing = true,
            )
        }

        /**
         * Auto-derived starter milestones. Per the product note: split the goal's NUMBER
         * into sensible checkpoints and leave the reward text BLANK — goals stay about
         * growth, so a family fills in a reward only if they want one.
         */
        fun derivedMilestones(type: String, target: Int): List<MilestoneDraft> = when (type) {
            // threshold = 🔥 streak days
            "habit" -> listOf("🌱" to 7, "🔥" to 30, "🏆" to 100)
                .map { (emoji, t) -> MilestoneDraft(emoji, t.toString(), "") }

            // threshold = % complete
            "checklist" -> listOf("🌱" to 50, "🏆" to 100)
                .map { (emoji, t) -> MilestoneDraft(emoji, t.toString(), "") }

            // total | count — three nice thirds of the target
            else -> {
                val values = niceThirds(target)
                val emojis = when {
                    values.size >= 3 -> listOf("🌱", "⛺", "🏆")
                    values.size == 2 -> listOf("🌱", "🏆")
                    else -> listOf("🏆")
                }
                emojis.zip(values).map { (emoji, t) -> MilestoneDraft(emoji, t.toString(), "") }
            }
        }

        /**
         * Three ascending checkpoints for a numeric target: two nice-rounded thirds plus
         * the target itself. 300 → 100/200/300, 750 → 250/500/750, 1000 → 250/500/1000.
         */
        fun niceThirds(target: Int): List<Int> {
            if (target <= 1) return listOf(maxOf(target, 1))
            val out = mutableListOf<Int>()
            for (candidate in listOf(niceRound(target / 3.0), niceRound(target * 2 / 3.0), target)) {
                val x = minOf(candidate, target)
                val last = out.lastOrNull()
                if (last != null) {
                    if (x > last) out.add(x)
                } else if (x > 0) {
                    out.add(x)
                }
            }
            if (out.lastOrNull() != target) out.add(target)
            return out
        }

        /**
         * Round to a "nice" number — the leading digit snapped to 1 / 2 / 2.5 / 5 / 10.
         * Hand-rolled base extraction so this doesn't lean on `pow`/`log10` rounding.
         */
        fun niceRound(v: Double): Int {
            if (v <= 0) return 0
            var n = v
            var base = 1.0
            while (n >= 10) { n /= 10; base *= 10 }
            while (n < 1) { n *= 10; base /= 10 }
            val nice = when {
                n < 1.5 -> 1.0
                n < 2.25 -> 2.0
                n < 3.5 -> 2.5
                n < 7.5 -> 5.0
                else -> 10.0
            }
            return (nice * base).roundToLong().toInt()
        }

        /** A stable fingerprint of a ladder, for telling auto-derived from hand-edited. */
        fun signature(ms: List<MilestoneDraft>): String =
            ms.joinToString(";") { "${it.emoji}|${it.threshold}|${it.reward}" }
    }
}
