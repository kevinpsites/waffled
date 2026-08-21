package app.waffled.feature.meals

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Book
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledTextField

/**
 * The stateless leaf views shared by [PlanWeekSheet] and [PlanMonthSheet].
 *
 * No parent state lives here: every mutable thing (locked / dirty / redrafting /
 * suggestions) stays in the sheet's model and is threaded in as plain values and lambdas.
 */

/** A small pill button (icon + label) used in a review card's action row. */
@Composable
fun PlanActionChip(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .clip(CircleShape)
            .background(WF.colors.panel)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = WF.colors.ink2, modifier = Modifier.size(14.dp))
        Text(
            label,
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.ink2,
            maxLines = 1,
        )
    }
}

/** A tiny metadata tag chip (e.g. "🕐 30m", "📖 Library"). */
@Composable
fun PlanTag(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier = modifier
            .clip(CircleShape)
            .background(WF.colors.panel)
            .padding(horizontal = 7.dp, vertical = 2.dp),
        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold),
        color = WF.colors.ink2,
        maxLines = 1,
    )
}

/**
 * The "Use up first" card — a chip flow of ingredients to prioritise, plus an inline add
 * field. The parent owns [items] and [input].
 */
@Composable
fun UseUpCard(
    items: List<String>,
    input: String,
    onInputChange: (String) -> Unit,
    onAdd: () -> Unit,
    onRemove: (String) -> Unit,
    modifier: Modifier = Modifier,
    title: String = "Use up first",
    placeholder: String = "Add an ingredient",
) {
    WaffledCard(modifier = modifier, padding = 14.dp) {
        Text(title, style = WF.type.fieldTitle, color = WF.colors.ink)
        Spacer(Modifier.size(10.dp))
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items.forEach { item ->
                Row(
                    Modifier
                        .clip(CircleShape)
                        .background(WF.colors.panel)
                        .padding(start = 12.dp, end = 6.dp, top = 7.dp, bottom = 7.dp),
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(item, style = WF.type.body, color = WF.colors.ink)
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = "Remove $item",
                        tint = WF.colors.ink3,
                        modifier = Modifier
                            .size(18.dp)
                            .clip(CircleShape)
                            .clickable { onRemove(item) },
                    )
                }
            }
        }
        Spacer(Modifier.size(8.dp))
        WaffledTextField(
            value = input,
            onValueChange = onInputChange,
            placeholder = placeholder,
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                imeAction = androidx.compose.ui.text.input.ImeAction.Done,
            ),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { onAdd() }),
        )
    }
}

/** The full-screen loading state shown while the AI drafts a plan. */
@Composable
fun PlanLoadingView(title: String, subtitle: String, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // The app provides no MaterialTheme, so M3's own colour scheme would tint this
        // baseline purple — the AI colour has to be passed explicitly.
        CircularProgressIndicator(color = WF.colors.ai)
        Spacer(Modifier.size(16.dp))
        Text(title, style = WF.type.cardTitle, color = WF.colors.ink)
        Spacer(Modifier.size(6.dp))
        Text(
            subtitle,
            style = WF.type.bodySmall,
            color = WF.colors.ink3,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 40.dp),
        )
    }
}

/** The full-screen empty/error message. Pass [onRetry] to show a "Try again" button. */
@Composable
fun PlanMessageView(
    emoji: String,
    title: String,
    subtitle: String,
    modifier: Modifier = Modifier,
    onRetry: (() -> Unit)? = null,
) {
    Column(
        modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(emoji, style = TextStyle(fontSize = 44.sp))
        Spacer(Modifier.size(12.dp))
        Text(title, style = WF.type.sectionTitle, color = WF.colors.ink, textAlign = TextAlign.Center)
        Spacer(Modifier.size(8.dp))
        Text(
            subtitle,
            style = WF.type.body,
            color = WF.colors.ink3,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 40.dp),
        )
        if (onRetry != null) {
            Spacer(Modifier.size(10.dp))
            Text(
                "Try again",
                style = WF.type.label,
                color = WF.colors.ai,
                modifier = Modifier
                    .clip(CircleShape)
                    .clickable(onClick = onRetry)
                    .padding(horizontal = 12.dp, vertical = 6.dp),
            )
        }
    }
}

/**
 * A compact one-line summary of a plan card.
 *
 * On iOS this is the floating preview under a dragged card. There is no drag here — the
 * planner uses an explicit move affordance (see [MoveTargets]) — so the same chip
 * identifies the card being moved in the move sheet's header instead.
 */
@Composable
fun PlanCardChip(emoji: String?, title: String, modifier: Modifier = Modifier) {
    Row(
        modifier
            .clip(CircleShape)
            .background(WF.colors.card)
            .border(1.dp, WF.colors.hair, CircleShape)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(emoji ?: "🍽️", style = TextStyle(fontSize = 14.sp))
        Text(
            title,
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * The ✨ Reshuffle / Reshuffling… capsule in a review header. [isBusy] drives the inline
 * spinner; the parent owns the disabled rule.
 */
@Composable
fun PlanReshuffleButton(
    isBusy: Boolean,
    isDisabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .clip(CircleShape)
            .background(WF.colors.aiT)
            .clickable(enabled = !isDisabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (isBusy) {
            CircularProgressIndicator(color = WF.colors.ai, strokeWidth = 2.dp, modifier = Modifier.size(14.dp))
        } else {
            Text("✨", style = TextStyle(fontSize = 13.sp))
        }
        Text(
            if (isBusy) "Reshuffling…" else "Reshuffle",
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.ai,
        )
    }
}

/**
 * A single review-night card, shared by both plan sheets. Stateless — the few
 * wording/behaviour differences between week and month are parameters:
 *
 * - [metaTags] is built by the parent (week vs month wording).
 * - [belowTitleNote] is the week's note line; month folds its note into [metaTags].
 * - [onSkip] shows the trailing ✕ (month only).
 * - [onOpen] makes the title block tappable (week only — month wires no preview).
 * - [onMove] opens the move sheet, replacing the iOS drag onto another night.
 */
@Composable
fun MealPlanReviewCard(
    card: PlanCardDTO,
    dayLabel: String,
    isLocked: Boolean,
    isBusy: Boolean,
    metaTags: List<String>,
    belowTitleNote: String?,
    actionsDisabled: Boolean,
    onSwap: () -> Unit,
    onPick: () -> Unit,
    onMove: () -> Unit,
    onToggleLock: () -> Unit,
    modifier: Modifier = Modifier,
    onSkip: (() -> Unit)? = null,
    onOpen: (() -> Unit)? = null,
) {
    val shape = RoundedCornerShape(WF.radius.md)
    Box(modifier.fillMaxWidth()) {
        Column(
            Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(WF.colors.card)
                .border(
                    width = if (isLocked) 1.dp else 1.dp,
                    color = if (isLocked) WF.colors.primary else WF.colors.hair,
                    shape = shape,
                )
                .padding(13.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .let { if (onOpen != null) it.clickable(onClick = onOpen) else it },
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(
                    Modifier
                        .size(46.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(WF.colors.panel),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(card.emoji ?: "🍽️", style = TextStyle(fontSize = 26.sp))
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(dayLabel, style = WF.type.sectionLabel, color = WF.colors.ink3)
                    Text(
                        card.title,
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (metaTags.isNotEmpty()) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            metaTags.forEach { PlanTag(it) }
                        }
                    }
                    if (!belowTitleNote.isNullOrEmpty()) {
                        Text(
                            belowTitleNote,
                            style = WF.type.caption,
                            color = WF.colors.ink3,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                if (onSkip != null) {
                    Box(
                        Modifier
                            .size(28.dp)
                            .clip(CircleShape)
                            .background(WF.colors.panel)
                            .clickable(onClick = onSkip),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.Filled.Close,
                            contentDescription = "Skip ${card.title}",
                            tint = WF.colors.ink3,
                            modifier = Modifier.size(14.dp),
                        )
                    }
                }
            }
            HorizontalDivider(color = WF.colors.hair)
            FlowRow(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                PlanActionChip(Icons.Filled.SwapHoriz, "Swap", !actionsDisabled, onSwap)
                PlanActionChip(Icons.Filled.Book, "Pick", !actionsDisabled, onPick)
                // Replaces the iOS drag-onto-another-night: same outcome, discoverable,
                // and it works one-handed.
                PlanActionChip(Icons.Filled.SwapHoriz, "Move", !actionsDisabled, onMove)
                Spacer(Modifier.weight(1f))
                Row(
                    Modifier
                        .clip(CircleShape)
                        .background(if (isLocked) WF.colors.primary else WF.colors.panel)
                        .clickable(onClick = onToggleLock)
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        if (isLocked) Icons.Filled.Lock else Icons.Filled.LockOpen,
                        contentDescription = null,
                        // On the solid primary fill white is correct (a saturated colour);
                        // on the neutral panel it is ink2.
                        tint = if (isLocked) androidx.compose.ui.graphics.Color.White else WF.colors.ink2,
                        modifier = Modifier.size(14.dp),
                    )
                    Text(
                        if (isLocked) "Locked" else "Lock",
                        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
                        color = if (isLocked) androidx.compose.ui.graphics.Color.White else WF.colors.ink2,
                        maxLines = 1,
                    )
                }
            }
        }
        if (isBusy) {
            Box(
                Modifier
                    .matchParentSize()
                    .clip(shape)
                    .background(WF.colors.card.copy(alpha = 0.7f)),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator(color = WF.colors.ai, modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
            }
        }
    }
}

/**
 * The bottom divider + full-width primary action shared by both plan sheets.
 *
 * [isInactive] drives the grey vs AI tint; [isDisabled] is the broader gate. They differ
 * on purpose: a busy bar with suggestions still shows the AI tint while disabled.
 */
@Composable
fun PlanApplyBar(
    isBusy: Boolean,
    isInactive: Boolean,
    isDisabled: Boolean,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth().background(WF.colors.canvas)) {
        HorizontalDivider(color = WF.colors.hair)
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp)
                .clip(RoundedCornerShape(WF.radius.md))
                .background(if (isInactive) WF.colors.ink3 else WF.colors.ai)
                .clickable(enabled = !isDisabled, onClick = onClick)
                .padding(vertical = 14.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (isBusy) {
                // White on a saturated AI fill is correct here — `onInk` is only for the
                // neutral `ink` fill, which flips to warm off-white in dark.
                CircularProgressIndicator(
                    color = androidx.compose.ui.graphics.Color.White,
                    strokeWidth = 2.dp,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.width(8.dp))
            }
            Text(
                label,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold),
                color = androidx.compose.ui.graphics.Color.White,
            )
        }
    }
}

/** A left-aligned informational note (the "no fresh options" line). */
@Composable
fun PlanNotice(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(WF.radius.sm))
            .background(WF.colors.primaryT)
            .padding(horizontal = 12.dp, vertical = 9.dp),
        style = WF.type.caption,
        color = WF.colors.primary,
    )
}

/** A labelled config row with a trailing control, used across both sheets' config. */
@Composable
fun PlanConfigRow(
    label: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    trailing: @Composable () -> Unit,
) {
    Row(
        modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = WF.type.label, color = WF.colors.ink)
            if (subtitle != null) {
                Text(subtitle, style = WF.type.caption, color = WF.colors.ink3)
            }
        }
        trailing()
    }
}

/** A card wrapper for a config block, so both sheets look identical. */
@Composable
fun PlanConfigCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    WaffledCard(modifier = modifier, padding = 14.dp, content = content)
}
