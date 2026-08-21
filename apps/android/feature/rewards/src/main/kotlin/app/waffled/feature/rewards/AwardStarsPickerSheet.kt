package app.waffled.feature.rewards

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledPrimaryCTA
import kotlinx.coroutines.launch

/**
 * Hand out ad-hoc "spot" stars — pick a family member, an amount and currency, and an
 * optional reason.
 *
 * Gated by `reward.grant` at the call site (see [RewardsAccess.canGrant] for why that
 * key is spelled out). This writes a positive `spot_award` entry in the same single
 * ledger chores credit, which is what makes it advance the recipient's saving-toward jar
 * for free — there is no second balance to keep in step.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AwardStarsPickerSheet(
    people: List<RewardsApi.PersonBalance>,
    currencies: List<RewardsApi.Currency>,
    model: RewardsModel,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()

    var selectedPersonId by remember { mutableStateOf(people.firstOrNull()?.personId.orEmpty()) }
    var amount by remember { mutableStateOf(5) }
    var currencyKey by remember {
        mutableStateOf(
            currencies.firstOrNull { it.isDefault }?.key ?: currencies.firstOrNull()?.key ?: "stars",
        )
    }
    var note by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }

    val currency = currencies.firstOrNull { it.key == currencyKey }
    val symbol = currency?.symbol?.takeIf { it.isNotBlank() } ?: "⭐"
    // Whole units only, and never zero — an award of nothing is a no-op the server would
    // still write a ledger row for.
    val canAward = amount > 0 && selectedPersonId.isNotEmpty() && !busy

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
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onDismiss) {
                    Text("Cancel", style = WF.type.label, color = WF.colors.primary)
                }
                Spacer(Modifier.weight(1f))
                Text(
                    text = "Award stars",
                    style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink,
                )
                Spacer(Modifier.weight(1f))
                Spacer(Modifier.size(64.dp))
            }

            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = "Hand out ad-hoc stars",
                    style = WF.type.serif(22.sp, FontWeight.Bold),
                    color = WF.colors.ink,
                )
                Text(
                    text = "For something great that wasn’t a chore.",
                    style = WF.type.bodySmall,
                    color = WF.colors.ink3,
                )
            }

            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel(text = "To")
                // A row of avatar chips rather than a dropdown: households are small, and
                // a face is faster to hit than a menu on a phone.
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    people.forEach { p ->
                        PersonChip(
                            person = p,
                            selected = p.personId == selectedPersonId,
                            onClick = { selectedPersonId = p.personId },
                        )
                    }
                }
            }

            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                SectionLabel(text = "How many")
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    AmountStep(plus = false) { amount = (amount - 1).coerceAtLeast(1) }
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(text = symbol, style = TextStyle(fontSize = 18.sp))
                        Text(
                            text = "$amount",
                            modifier = Modifier.widthIn(min = 30.dp),
                            style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Bold),
                            color = WF.colors.ink,
                        )
                    }
                    AmountStep(plus = true) { amount = (amount + 1).coerceAtMost(1_000) }
                }
                if (currencies.size > 1) {
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
                SectionLabel(text = "Note (optional)")
                RewardTextField(
                    value = note,
                    onValueChange = { note = it },
                    placeholder = "e.g. so helpful today",
                    fontSize = 15.sp,
                )
            }

            failure?.let {
                DismissibleErrorBanner(message = it, onDismiss = { failure = null })
            }

            WaffledPrimaryCTA(
                label = if (busy) "Awarding…" else "Award $amount $symbol",
                onClick = {
                    scope.launch {
                        busy = true
                        val ok = model.awardSpot(
                            personId = selectedPersonId,
                            amount = amount,
                            currency = currencyKey,
                            note = note,
                        )
                        busy = false
                        if (ok) onDismiss() else failure = "Couldn’t award those stars. Try again."
                    }
                },
                isBusy = busy,
                isDisabled = !canAward,
            )
        }
    }
}

/** An avatar + name chip, selectable. */
@Composable
internal fun PersonChip(
    person: RewardsApi.PersonBalance,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Row(
        modifier = modifier
            .background(if (selected) WF.colors.ink else WF.colors.card, shape)
            .then(
                if (selected) {
                    Modifier
                } else {
                    Modifier.border(1.dp, WF.colors.hair, shape)
                },
            )
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(start = 6.dp, end = 13.dp, top = 6.dp, bottom = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AvatarFromHex(
            colorHex = person.colorHex,
            emoji = person.avatarEmoji ?: "🙂",
            size = 26.dp,
        )
        Text(
            text = person.name ?: "—",
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
            // `onInk`, never white: `ink` flips to a warm off-white in dark, so white
            // text on it disappears.
            color = if (selected) WF.colors.onInk else WF.colors.ink,
        )
    }
}

@Composable
private fun AmountStep(plus: Boolean, onClick: () -> Unit) {
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
            contentDescription = if (plus) "One more" else "One fewer",
            tint = WF.colors.ink,
            modifier = Modifier.size(16.dp),
        )
    }
}
