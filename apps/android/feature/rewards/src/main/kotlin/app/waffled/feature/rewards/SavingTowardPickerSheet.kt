package app.waffled.feature.rewards

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmojiTile
import app.waffled.core.design.WaffledEmptyState

/**
 * Pick what a person is saving toward — or clear the pin.
 *
 * The rows come from `/api/persons/:id/overview`'s `rewardShop`, which is the catalog
 * already annotated with **this person's** `have` and `toGo` against each reward. That
 * is deliberately the server's arithmetic rather than ours: it is the same single ledger
 * every other number on this screen reads, so the picker can never disagree with the
 * hero it sets.
 *
 * Scope note: iOS's richer `SavingTowardPicker` lives in the Family module
 * (`PersonView.swift`). This is the shop's own minimal version, so the saving-toward
 * hero's Change button is never a dead control.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SavingTowardPickerSheet(
    options: List<RewardsApi.PersonRewardOverview.ShopReward>,
    currentId: String?,
    symbolFor: (String) -> String,
    onPick: (String?) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "Save toward",
                    modifier = Modifier.weight(1f),
                    style = WF.type.serif(22.sp, FontWeight.Bold),
                    color = WF.colors.ink,
                )
                if (currentId != null) {
                    TextButton(onClick = { onPick(null) }) {
                        Text("Clear", style = WF.type.label, color = WF.colors.primary)
                    }
                }
            }

            if (options.isEmpty()) {
                WaffledEmptyState(
                    emoji = "🎁",
                    title = "Nothing to save toward yet",
                    message = "A parent can add rewards to the shop.",
                    top = 24.dp,
                )
            } else {
                LazyColumn(
                    modifier = Modifier.heightIn(max = 420.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(options, key = { it.id }) { option ->
                        SavingOptionRow(
                            option = option,
                            selected = option.id == currentId,
                            symbol = symbolFor(option.currency),
                            onClick = { onPick(option.id) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SavingOptionRow(
    option: RewardsApi.PersonRewardOverview.ShopReward,
    selected: Boolean,
    symbol: String,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(WF.radius.md)
    val pct = RewardsMath.progressPercent(have = option.have, cost = option.cost)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WaffledEmojiTile(emoji = option.emoji ?: "🎁")
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(
                text = option.title,
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink,
                maxLines = 1,
            )
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(6.dp)
                    .clip(RoundedCornerShape(WF.radius.pill))
                    .background(WF.colors.panel),
            ) {
                Box(
                    Modifier
                        .fillMaxWidth(pct / 100f)
                        .height(6.dp)
                        .background(WF.colors.primary),
                )
            }
            Text(
                text = if (option.toGo <= 0) {
                    "Ready! ${option.cost} $symbol"
                } else {
                    "${option.have} of ${option.cost} $symbol · ${option.toGo} to go"
                },
                style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
            )
        }
        if (selected) {
            Text(
                text = "✓",
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.primary,
            )
        }
    }
}
