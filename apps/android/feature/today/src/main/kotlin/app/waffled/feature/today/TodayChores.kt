package app.waffled.feature.today

import androidx.compose.runtime.Immutable

/*
 * COPIED from the chores feature (`ChoreSort`, `ChoresModel.toggle`, `ChoreRow.needsPhotoToFinish`)
 * because Today does not depend on that module and its types are its own. Keep the two in
 * step until both move into a shared core module — a follow-up to extract is owed.
 */

/** One person the Today chores card can show. */
@Immutable
data class ChorePerson(
    val id: String,
    val name: String,
    val emoji: String?,
    val colorHex: String?,
)

internal object TodayChoreRules {

    /** Pending first; then a set due time (ascending) before none; then title A–Z. */
    fun sort(rows: List<TodayApi.ChoreInstance>): List<TodayApi.ChoreInstance> =
        rows.sortedWith { a, b ->
            when {
                sortsBefore(a, b) -> -1
                sortsBefore(b, a) -> 1
                else -> 0
            }
        }

    private fun sortsBefore(a: TodayApi.ChoreInstance, b: TodayApi.ChoreInstance): Boolean {
        if (a.isPending != b.isPending) return a.isPending
        if (a.dueTime != b.dueTime) {
            val at = a.dueTime ?: return false
            val bt = b.dueTime ?: return true
            return at < bt
        }
        return a.choreTitle.compareTo(b.choreTitle, ignoreCase = true) < 0
    }

    /** Done or awaiting un-ticks; a pending chore needing approval waits for an OK. */
    fun toggledStatus(row: TodayApi.ChoreInstance): String = when {
        row.isDone || row.isAwaiting -> TodayApi.STATUS_PENDING
        row.requiresApproval -> TodayApi.STATUS_AWAITING
        else -> TodayApi.STATUS_DONE
    }

    /** Only an open photo chore needs the Tasks board, which owns the camera. */
    fun needsPhotoToFinish(row: TodayApi.ChoreInstance): Boolean =
        row.requiresPhoto && !row.isDone && !row.isAwaiting
}
