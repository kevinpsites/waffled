package app.waffled.feature.meals

/**
 * Pure move/swap math for the week planner, so the view can update its entries
 * *optimistically* (before the server round-trip) and the rule is unit-tested.
 *
 * Android deliberately drives this from an explicit **Move** affordance rather than a
 * drag: iOS relies on a custom UTI so text fields can't intercept the drop, and Compose's
 * drag-and-drop modifiers are both experimental and have no equivalent payload-typing
 * trick. The math below is identical either way — only the gesture that calls it differs.
 */
object MealPlanSwap {

    /**
     * The post-move entries when the meal at ([srcDate], [srcSlot]) lands on
     * ([dstDate], [dstSlot]): the source entry moves to the target slot, and whatever
     * occupied the target moves back to the source slot (a swap). Every other entry is
     * untouched.
     *
     * Returns null for a no-op — nothing at the source, or a move onto the slot it came
     * from — so the caller can ignore it.
     */
    fun apply(
        entries: List<WeekEntryDTO>,
        srcDate: String,
        srcSlot: String,
        dstDate: String,
        dstSlot: String,
    ): List<WeekEntryDTO>? {
        if (srcDate == dstDate && srcSlot == dstSlot) return null
        val src = entries.firstOrNull { it.date == srcDate && it.mealType == srcSlot } ?: return null
        val dst = entries.firstOrNull { it.date == dstDate && it.mealType == dstSlot }
        val out = entries.filterNot {
            (it.date == srcDate && it.mealType == srcSlot) || (it.date == dstDate && it.mealType == dstSlot)
        }.toMutableList()
        out.add(src.movedTo(dstDate, dstSlot))
        if (dst != null) out.add(dst.movedTo(srcDate, srcSlot))
        return out
    }

    /**
     * One server write: upsert [entry] into the slot, or clear it when [entry] is null.
     */
    data class Op(val date: String, val mealType: String, val entry: WeekEntryDTO?)

    /** The write plan for a move: [ordered] runs in order, [compensation] undoes it. */
    data class WritePlan(val ordered: List<Op>, val compensation: Op)

    /**
     * The ordered, loss-safe server writes for a move, plus the compensating write for a
     * failure between them.
     *
     * Order matters. `ordered[0]` upserts the **moved** meal into the target slot — its
     * own row is untouched, so if this write fails the server never changed and a local
     * snapshot rollback is a true rollback. Only `ordered[1]` rewrites the source slot
     * (displaced meal back, or a clear on a move-to-empty). If *that* write fails, the
     * moved meal exists in **both** slots — a recoverable duplicate, never a loss
     * (writing the source slot first could leave it in zero slots). [WritePlan.compensation]
     * then restores the target slot to its pre-move content, returning the server to its
     * exact prior state; if even that fails, the duplicate stays visible and fixable.
     *
     * Returns null for the same no-op moves as [apply].
     */
    fun writes(
        entries: List<WeekEntryDTO>,
        srcDate: String,
        srcSlot: String,
        dstDate: String,
        dstSlot: String,
    ): WritePlan? {
        if (srcDate == dstDate && srcSlot == dstSlot) return null
        val src = entries.firstOrNull { it.date == srcDate && it.mealType == srcSlot } ?: return null
        val dst = entries.firstOrNull { it.date == dstDate && it.mealType == dstSlot }
        return WritePlan(
            ordered = listOf(
                Op(dstDate, dstSlot, src),
                Op(srcDate, srcSlot, dst),
            ),
            compensation = Op(dstDate, dstSlot, dst),
        )
    }

    /**
     * Serializes the planner's optimistic moves against its reload triggers, so every
     * path that could refetch (refresh-bus bumps, week paging, pull-to-refresh) obeys ONE
     * discipline: while any move's writes/rollback are unfinished, reloads are deferred —
     * a half-committed week can never be fetched over the optimistic or rolled-back
     * entries — and the last move to settle replays exactly one reload.
     *
     * A finishing move may write the entries itself (its snapshot rollback) only via
     * [mayApplyResult]: it must be the *sole* in-flight move with nothing deferred behind
     * it. Overlapping moves, or any move whose first write already landed (bumping the
     * meals revision), leave the entries to the settle reload — server truth wins over
     * guessing.
     *
     * A plain class, not a data class: every method here mutates.
     */
    class Gate {
        var inFlight: Int = 0
            private set
        private var pendingReload = false

        /** A move's optimistic state was applied; its writes are starting. */
        fun begin() {
            inFlight += 1
        }

        /**
         * A reload trigger fired. true → load now; false → deferred, replayed by the move
         * that settles last.
         */
        fun shouldReloadNow(): Boolean {
            if (inFlight <= 0) return true
            pendingReload = true
            return false
        }

        /** Whether the finishing move may write the entries itself (see the class docs). */
        val mayApplyResult: Boolean get() = inFlight == 1 && !pendingReload

        /** A move couldn't apply its own result — queue the settle reload that will. */
        fun requestSettleReload() {
            pendingReload = true
        }

        /**
         * The move fully settled (writes + reconcile/rollback done). true → run the
         * deferred reload now; only the last move out replays it.
         */
        fun finish(): Boolean {
            inFlight = maxOf(0, inFlight - 1)
            if (inFlight != 0 || !pendingReload) return false
            pendingReload = false
            return true
        }
    }
}
