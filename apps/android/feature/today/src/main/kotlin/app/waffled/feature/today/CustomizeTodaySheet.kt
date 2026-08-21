package app.waffled.feature.today

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledPrimaryCTA
import kotlinx.coroutines.launch

/**
 * Reorder + show/hide the Today cards. Saves to the caller's own override ("Just me") or,
 * for admins, the shared family default ("Everyone").
 *
 * The list is deliberately the FULL order, not the rendered rows: a card hidden by the user
 * still has to be findable here to be un-hidden, and a card whose module is off still
 * belongs in the saved order for when that module comes back.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CustomizeTodaySheet(
    order: List<String>,
    hidden: Set<String>,
    canEditFamily: Boolean,
    onDismiss: () -> Unit,
    onSave: suspend (scope: String, order: List<String>, hidden: Set<String>) -> Boolean,
    onReset: suspend (scope: String) -> Boolean,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()

    var draftOrder by remember(order) { mutableStateOf(order) }
    var draftHidden by remember(hidden) { mutableStateOf(hidden) }
    var tier by remember { mutableStateOf("user") }
    var busy by remember { mutableStateOf(false) }

    fun commit(op: suspend () -> Boolean) {
        busy = true
        scope.launch {
            op()
            busy = false
            onDismiss()
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = WF.colors.canvas,
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "Customize Today",
                style = WF.type.title,
                color = WF.colors.ink,
            )

            if (canEditFamily) {
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    listOf("user" to "Just me", "family" to "Everyone")
                        .forEachIndexed { index, (value, label) ->
                            SegmentedButton(
                                selected = tier == value,
                                onClick = { tier = value },
                                shape = SegmentedButtonDefaults.itemShape(index, 2),
                            ) { Text(label) }
                        }
                }
                Text(
                    text = if (tier == "family") {
                        "Sets the default Today layout for everyone in the household."
                    } else {
                        "Your own arrangement, just on this account."
                    },
                    style = TextStyle(fontSize = 12.5.sp),
                    color = WF.colors.ink3,
                )
            }

            SectionLabel("Reorder · toggle to show or hide")

            LazyColumn(
                modifier = Modifier.fillMaxWidth().weight(1f, fill = false),
                contentPadding = PaddingValues(vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                itemsIndexed(draftOrder, key = { _, key -> key }) { index, key ->
                    CardToggleRow(
                        label = TodayCards.label(key),
                        isShown = key !in draftHidden,
                        canMoveUp = index > 0,
                        canMoveDown = index < draftOrder.lastIndex,
                        onToggle = { on ->
                            draftHidden = if (on) draftHidden - key else draftHidden + key
                        },
                        onMove = { delta -> draftOrder = TodayCards.moved(draftOrder, index, delta) },
                    )
                }
            }

            WaffledPrimaryCTA(
                label = "Save",
                onClick = { commit { onSave(tier, draftOrder, draftHidden) } },
                isBusy = busy,
            )

            Row(
                modifier = Modifier.fillMaxWidth().padding(bottom = WF.spacing.xxl),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                TextButton(onClick = onDismiss, enabled = !busy) {
                    Text("Cancel", color = WF.colors.ink2)
                }
                TextButton(
                    onClick = { commit { onReset(tier) } },
                    enabled = !busy,
                ) {
                    Text(
                        text = if (tier == "family") "Reset everyone" else "Reset to default",
                        color = WF.colors.danger,
                    )
                }
            }
        }
    }
}

/**
 * One card row: its name, up/down move controls, and a show/hide switch.
 *
 * **Up/down buttons rather than drag-to-reorder.** SwiftUI gets `.onMove` from `List` for
 * free; Compose Foundation has no reorderable-list API, and the community libraries that
 * provide one are not in the (frozen) version catalog. Two buttons are also the more
 * accessible control — a drag handle needs custom TalkBack actions to be usable at all.
 */
@Composable
private fun CardToggleRow(
    label: String,
    isShown: Boolean,
    canMoveUp: Boolean,
    canMoveDown: Boolean,
    onToggle: (Boolean) -> Unit,
    onMove: (Int) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            modifier = Modifier.weight(1f),
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink,
        )
        IconButton(onClick = { onMove(-1) }, enabled = canMoveUp) {
            Icon(
                imageVector = Icons.Filled.KeyboardArrowUp,
                contentDescription = "Move $label up",
                tint = if (canMoveUp) WF.colors.ink2 else WF.colors.hair,
                modifier = Modifier.size(20.dp),
            )
        }
        IconButton(onClick = { onMove(1) }, enabled = canMoveDown) {
            Icon(
                imageVector = Icons.Filled.KeyboardArrowDown,
                contentDescription = "Move $label down",
                tint = if (canMoveDown) WF.colors.ink2 else WF.colors.hair,
                modifier = Modifier.size(20.dp),
            )
        }
        Switch(
            checked = isShown,
            onCheckedChange = onToggle,
            colors = SwitchDefaults.colors(
                // White on the saturated coral fill is correct; `onInk` is for `ink` fills.
                checkedThumbColor = Color.White,
                checkedTrackColor = WF.colors.primary,
                uncheckedTrackColor = WF.colors.panel,
                uncheckedBorderColor = WF.colors.hair,
            ),
        )
    }
}
