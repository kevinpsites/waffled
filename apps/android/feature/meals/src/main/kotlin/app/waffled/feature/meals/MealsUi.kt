package app.waffled.feature.meals

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF

/**
 * Small pieces the two planners share.
 *
 * `MealRowMenu` deliberately mirrors `feature:lists`' `ListRowMenu`. Feature modules can't
 * depend on each other, so the pattern is re-stated rather than reused — it belongs in
 * `core:design` and is called out in the hand-off notes.
 */

data class MenuAction(
    val label: String,
    val icon: ImageVector,
    val onClick: () -> Unit,
    val destructive: Boolean = false,
)

/**
 * A row's overflow menu.
 *
 * Material3's `DropdownMenu` is the native contextual-action control and carries the
 * actions iOS puts behind a context menu. Only the colours are ours — the app installs no
 * `MaterialTheme`, so an unstyled M3 surface would render from the baseline scheme.
 */
@Composable
fun MealRowMenu(expanded: Boolean, onDismiss: () -> Unit, items: List<MenuAction>) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss, containerColor = WF.colors.card) {
        for (action in items) {
            val tint = if (action.destructive) WF.colors.danger else WF.colors.ink
            DropdownMenuItem(
                text = { Text(action.label, style = WF.type.body, color = tint) },
                leadingIcon = {
                    Icon(action.icon, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
                },
                onClick = {
                    onDismiss()
                    action.onClick()
                },
            )
        }
    }
}

/** A circular chevron used by both planners' period steppers. */
@Composable
fun PeriodChevron(forward: Boolean, contentDescription: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(WF.colors.card)
            .border(1.dp, WF.colors.hair, CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            if (forward) Icons.Filled.ChevronRight else Icons.Filled.ChevronLeft,
            contentDescription = contentDescription,
            tint = WF.colors.ink2,
            modifier = Modifier.size(20.dp),
        )
    }
}

/** The chevron · title · chevron header both planners use, with an optional "jump" link. */
@Composable
fun PeriodHeader(
    title: String,
    jumpLabel: String?,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    onJump: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier.fillMaxWidth().padding(top = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PeriodChevron(forward = false, contentDescription = "Previous", onClick = onPrevious)
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(title, style = WF.type.cardTitle, color = WF.colors.ink)
            if (jumpLabel != null) {
                Text(
                    jumpLabel,
                    style = WF.type.caption,
                    color = WF.colors.primary,
                    modifier = Modifier
                        .clip(CircleShape)
                        .clickable(onClick = onJump)
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                )
            }
        }
        PeriodChevron(forward = true, contentDescription = "Next", onClick = onNext)
    }
}

/** The full-width ✨ CTA that opens a plan sheet. */
@Composable
fun PlanCta(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(WF.radius.md))
            .background(WF.colors.ai)
            .clickable(onClick = onClick)
            .padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("✨", style = TextStyle(fontSize = 15.sp))
        Spacer(Modifier.size(7.dp))
        // White on the saturated AI fill — `onInk` is only for the neutral `ink` fill.
        Text(label, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = Color.White)
    }
}

/** The dashed "Plan Dinner" placeholder for an empty slot. */
@Composable
fun PlanSlotButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(WF.colors.card2)
            .border(1.dp, WF.colors.hair, shape)
            .clickable(onClick = onClick)
            .padding(vertical = 11.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Add, contentDescription = null, tint = WF.colors.ink2, modifier = Modifier.size(16.dp))
        Spacer(Modifier.size(7.dp))
        Text(label, style = WF.type.label, color = WF.colors.ink2)
    }
}

/**
 * Choose where a planned meal moves to.
 *
 * This replaces the iOS drag. iOS keeps the drop safe with a custom non-text UTI so a
 * TextField can't swallow the payload; Compose has no equivalent payload typing and its
 * drag-and-drop modifiers are still experimental, so a drag here would be fragile and
 * hard to use one-handed on a scrolling list. An explicit list is also strictly more
 * informative: it says up front which targets are a SWAP.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MoveMealSheet(
    movingTitle: String,
    movingEmoji: String?,
    targets: List<MoveTargets.Target>,
    dayLabel: (String) -> String,
    onPick: (MoveTargets.Target) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp)) {
            Text("Move to…", style = WF.type.sectionTitle, color = WF.colors.ink)
            Spacer(Modifier.size(8.dp))
            PlanCardChip(movingEmoji, movingTitle)
            Spacer(Modifier.size(14.dp))
            LazyColumn(Modifier.fillMaxWidth()) {
                items(targets, key = { it.key }) { target ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(WF.radius.sm))
                            .clickable { onPick(target) }
                            .padding(horizontal = 12.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                "${dayLabel(target.date)} · ${MealsFormat.slotLabel(target.mealType)}",
                                style = WF.type.label,
                                color = WF.colors.ink,
                            )
                            Text(
                                // Naming the occupant up front is the whole reason this is
                                // a list: the user knows it is a swap before committing.
                                target.occupantTitle?.let { "Swaps with $it" } ?: "Empty",
                                style = WF.type.caption,
                                color = WF.colors.ink3,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        if (target.isSwap) {
                            Text("Swap", style = WF.type.micro, color = WF.colors.ai)
                        }
                    }
                }
            }
            Spacer(Modifier.size(WF.spacing.tabBarClearance))
        }
    }
}
