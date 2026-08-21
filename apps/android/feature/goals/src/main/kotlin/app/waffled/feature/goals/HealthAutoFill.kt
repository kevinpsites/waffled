package app.waffled.feature.goals

/**
 * The availability gate for filling a goal from health data.
 *
 * iOS offers two health affordances — a "use today's total" pre-fill card on the log
 * sheet, and an "auto-fill from Apple Health" section in the editor — and guards both on
 * `HKHealthStore.isHealthDataAvailable()`.
 *
 * **Health Connect is deliberately out of scope for this port**, so [isAvailable] is a
 * constant `false` and neither affordance renders. The gate exists rather than the code
 * simply being absent so that wiring a real source later is one implementation away, and
 * so the surrounding UI already reads as "hidden because unavailable" rather than
 * "never built".
 *
 * The manual logging path is complete and unaffected — nothing here gates it.
 *
 * ⚠️ Android must never WRITE the health fields. A goal can be linked to an Apple Health
 * metric on iOS, and this client has no opinion about that link: `healthMetric` and
 * `healthDailyTarget` are read for display and deliberately omitted from every request
 * body (see `GoalDraft.body`). Sending an explicit null the way iOS does would wipe the
 * link off any goal the moment someone edited it from their phone.
 */
object HealthAutoFill {

    /** Whether a health source can be read on this device. Always false for now. */
    val isAvailable: Boolean get() = false

    /**
     * A short badge for a goal that fills itself from health data elsewhere, so someone
     * on Android can see WHY progress appears without them logging it.
     *
     * Deliberately does not name the metric: the metric catalog is a HealthKit concern
     * and porting 26 metric keys to render one word would be dead weight.
     */
    fun linkedBadge(healthMetric: String?): String? =
        healthMetric?.takeIf { it.isNotBlank() }?.let { "⌚ Auto-filled from Health" }
}
