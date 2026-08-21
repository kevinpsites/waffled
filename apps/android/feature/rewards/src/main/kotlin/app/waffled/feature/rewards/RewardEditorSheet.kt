package app.waffled.feature.rewards

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.wfChip
import kotlinx.coroutines.launch

/**
 * Add or edit a reward — emoji, title, cost, a currency picker when the household has
 * more than one spendable currency, a shop category, the per-reward approval gate, and
 * Archive when editing.
 *
 * Gated by `reward.manage` at the call site. Everyone can still *see* the catalog (so
 * they know what to save toward) and redeem from it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RewardEditorSheet(
    editing: RewardsApi.Reward?,
    currencies: List<RewardsApi.Currency>,
    model: RewardsModel,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()

    var emoji by remember { mutableStateOf(editing?.emoji ?: "🎁") }
    var title by remember { mutableStateOf(editing?.title ?: "") }
    var costText by remember { mutableStateOf((editing?.cost ?: 10).toString()) }
    var currencyKey by remember {
        mutableStateOf(
            editing?.currency
                ?: currencies.firstOrNull { it.isDefault }?.key
                ?: currencies.firstOrNull()?.key
                ?: "stars",
        )
    }
    var category by remember { mutableStateOf(editing?.category) }
    var requiresApproval by remember { mutableStateOf(editing?.requiresApproval ?: true) }
    var busy by remember { mutableStateOf(false) }
    var confirmArchive by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }

    // A NEW reward inherits the household's approval default (Settings → Chores &
    // rewards); an edit keeps whatever it was saved with.
    LaunchedEffect(editing?.id) {
        if (editing == null) {
            runCatching { model.api.rewardSettings() }
                .onSuccess { requiresApproval = it.requireApproval }
        }
    }

    // Cost is money-shaped, so it is parsed once here as an Int and never held as text
    // arithmetic. A blank field reads as zero rather than blocking the stepper.
    val cost = costText.filter { it.isDigit() }.toIntOrNull() ?: 0
    val trimmedTitle = title.trim()
    val canSave = trimmedTitle.isNotEmpty() && !busy
    val selectedCurrency = currencies.firstOrNull { it.key == currencyKey }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(20.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onDismiss) {
                    Text("Cancel", style = WF.type.label, color = WF.colors.primary)
                }
                Spacer(Modifier.weight(1f))
                Text(
                    text = if (editing == null) "New reward" else "Edit reward",
                    style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink,
                )
                Spacer(Modifier.weight(1f))
                Spacer(Modifier.size(64.dp))
            }

            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                RewardTextField(
                    // Two code points is enough for a flag or a ZWJ-free emoji; more is
                    // almost always a paste that would overflow the tile.
                    value = emoji,
                    onValueChange = { emoji = it.take(2) },
                    placeholder = "🎁",
                    modifier = Modifier.size(70.dp),
                    fontSize = 30.sp,
                    textAlign = TextAlign.Center,
                )
                RewardTextField(
                    value = title,
                    onValueChange = { title = it },
                    placeholder = "Movie night, 30 min screen time…",
                    modifier = Modifier.weight(1f),
                    fontSize = 16.sp,
                )
            }

            if (currencies.size > 1) {
                Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                    SectionLabel(text = "Currency")
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        currencies.forEach { c ->
                            PickerChip(
                                label = "${c.symbol} ${c.label}",
                                selected = c.key == currencyKey,
                                tint = currencyTint(c.color),
                                onClick = { currencyKey = c.key },
                            )
                        }
                    }
                }
            }

            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel(text = "Category (for the shop)")
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    PickerChip(
                        label = "🚫 None",
                        selected = category == null,
                        onClick = { category = null },
                    )
                    ShopCategory.selectable.forEach { c ->
                        PickerChip(
                            label = "${c.emoji} ${c.label}",
                            selected = category == c.key,
                            onClick = { category = c.key },
                        )
                    }
                }
            }

            WaffledCard(padding = 14.dp) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = "Cost",
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink,
                    )
                    Spacer(Modifier.weight(1f))
                    Text(
                        text = selectedCurrency?.symbol?.takeIf { it.isNotBlank() } ?: "⭐",
                        style = TextStyle(fontSize = 16.sp),
                    )
                    Spacer(Modifier.size(8.dp))
                    RewardTextField(
                        value = costText,
                        onValueChange = { costText = it.filter(Char::isDigit).take(6) },
                        placeholder = "0",
                        modifier = Modifier.size(width = 82.dp, height = 46.dp),
                        fontSize = 17.sp,
                        textAlign = TextAlign.End,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    )
                    Spacer(Modifier.size(8.dp))
                    StepGlyph(plus = false) { costText = (cost - 1).coerceAtLeast(0).toString() }
                    Spacer(Modifier.size(6.dp))
                    StepGlyph(plus = true) { costText = (cost + 1).coerceAtMost(100_000).toString() }
                }
            }

            WaffledCard(padding = 14.dp) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = "Needs a parent’s OK",
                            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                            color = WF.colors.ink,
                        )
                        Spacer(Modifier.weight(1f))
                        Switch(
                            checked = requiresApproval,
                            onCheckedChange = { requiresApproval = it },
                            colors = SwitchDefaults.colors(
                                checkedTrackColor = WF.colors.primary,
                                checkedThumbColor = WF.colors.onMedia,
                            ),
                        )
                    }
                    Text(
                        text = if (requiresApproval) {
                            "Redeeming waits for a parent to approve."
                        } else {
                            "Redeems instantly if they can afford it."
                        },
                        style = WF.type.caption,
                        color = WF.colors.ink3,
                    )
                }
            }

            failure?.let {
                app.waffled.core.design.DismissibleErrorBanner(message = it, onDismiss = { failure = null })
            }

            WaffledPrimaryCTA(
                label = when {
                    busy -> "Saving…"
                    editing == null -> "Add reward"
                    else -> "Save"
                },
                onClick = {
                    scope.launch {
                        busy = true
                        val ok = model.saveReward(
                            id = editing?.id,
                            title = trimmedTitle,
                            emoji = emoji.trim().takeIf { it.isNotEmpty() },
                            cost = cost,
                            currency = currencyKey,
                            category = category,
                            requiresApproval = requiresApproval,
                        )
                        busy = false
                        if (ok) onDismiss() else failure = "Couldn’t save that reward. Try again."
                    }
                },
                isBusy = busy,
                isDisabled = !canSave,
            )

            if (editing != null) {
                // Two-tap archive rather than a dialog, matching iOS: the action is
                // reversible (archived rewards restore), so a modal would overstate it.
                Text(
                    text = if (confirmArchive) "Tap again to archive" else "Archive reward",
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable {
                            if (!confirmArchive) {
                                confirmArchive = true
                            } else {
                                scope.launch {
                                    busy = true
                                    val ok = model.archiveReward(editing.id)
                                    busy = false
                                    if (ok) onDismiss() else failure = "Couldn’t archive that reward."
                                }
                            }
                        }
                        .padding(vertical = 6.dp),
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                    color = if (confirmArchive) WF.colors.primary else WF.colors.ink3,
                    textAlign = TextAlign.Center,
                )
                Text(
                    text = "Archived rewards keep their redemption history and can be restored.",
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 30.dp),
                    style = TextStyle(fontSize = 11.sp),
                    color = WF.colors.ink3,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

/**
 * A selectable chip.
 *
 * The fill/border treatment comes from the shared `wfChip` modifier; only the label and
 * padding are local, which is exactly the split that modifier documents.
 */
@Composable
internal fun PickerChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = WF.colors.primary,
) {
    Text(
        text = label,
        modifier = modifier
            .wfChip(selected = selected, tint = tint)
            .clickable(onClick = onClick)
            .padding(horizontal = 13.dp, vertical = 8.dp),
        style = TextStyle(
            fontSize = 14.sp,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
        ),
        color = if (selected) WF.colors.ink else WF.colors.ink2,
    )
}

/** A round −/+ stepper button. */
@Composable
private fun StepGlyph(plus: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(RoundedCornerShape(WF.radius.pill))
            .background(WF.colors.panel)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = if (plus) Icons.Filled.Add else Icons.Filled.Remove,
            contentDescription = if (plus) "Increase" else "Decrease",
            tint = WF.colors.ink,
            modifier = Modifier.size(16.dp),
        )
    }
}

/** A hairline divider on the shared token, for lists inside cards. */
@Composable
internal fun RewardsDivider(modifier: Modifier = Modifier) {
    Box(
        modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(WF.colors.hair),
    )
}
