package app.waffled.android.shell

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.ListAlt
import androidx.compose.material.icons.filled.Restaurant
import androidx.compose.material.icons.filled.Today
import androidx.compose.ui.graphics.vector.ImageVector
import app.waffled.core.model.WaffledModule
import app.waffled.core.sync.ModuleGate

/**
 * Which module fills the phone bar's single flex tab.
 *
 * Meals when it's on; otherwise backfill Goals → Chores → Lists → Pantry. The bar always
 * renders four tabs whatever the answer, because the capture FAB is centred between
 * slots 2 and 3 — dropping a tab would visibly shift it.
 */
object FlexSlot {

    /** Meals first, then the backfill order. */
    private val PRIORITY = listOf(
        WaffledModule.Meals,
        WaffledModule.Goals,
        WaffledModule.Chores,
        WaffledModule.Lists,
        WaffledModule.Pantry,
    )

    fun resolve(gate: ModuleGate): WaffledModule? = PRIORITY.firstOrNull { gate.isOn(it) }

    /** The four fixed tabs, with the flex slot resolved (or a placeholder). */
    fun tabs(gate: ModuleGate): List<TabSlot> {
        val flex = resolve(gate)
        return listOf(
            TabSlot("today", "Today", Icons.Filled.Today),
            TabSlot("calendar", "Calendar", Icons.Filled.CalendarMonth),
            flex?.let { TabSlot(it.key, it.tabLabel, it.tabIcon) }
                ?: TabSlot("flex", "More", Icons.Filled.ListAlt),
            TabSlot("family", "Family", Icons.Filled.Group),
        )
    }
}

private val WaffledModule.tabLabel: String
    get() = when (this) {
        WaffledModule.Meals -> "Meals"
        WaffledModule.Goals -> "Goals"
        WaffledModule.Chores -> "Tasks"
        WaffledModule.Lists -> "Lists"
        WaffledModule.Pantry -> "Pantry"
        else -> name
    }

private val WaffledModule.tabIcon: ImageVector
    get() = when (this) {
        WaffledModule.Meals -> Icons.Filled.Restaurant
        WaffledModule.Goals -> Icons.Filled.Flag
        WaffledModule.Chores -> Icons.Filled.CheckCircle
        WaffledModule.Lists -> Icons.Filled.ListAlt
        WaffledModule.Pantry -> Icons.Filled.Inventory2
        else -> Icons.Filled.ListAlt
    }
