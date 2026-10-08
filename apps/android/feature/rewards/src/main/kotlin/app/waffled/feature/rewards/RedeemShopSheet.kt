package app.waffled.feature.rewards

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledPrimaryCTA

/**
 * The redeem-confirm sheet — the gradient well and emoji, the price, a "balance → left"
 * line, an approval note when the reward needs one, and Not yet / Redeem it!
 *
 * The arithmetic is [RewardsMath], not inline subtraction, so the number a child reads
 * before confirming is produced by the same integer rules the tile used to decide the
 * reward was affordable in the first place.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RedeemShopSheet(
    reward: RewardsApi.Reward,
    currency: RewardsApi.Currency?,
    balance: Int,
    busy: Boolean,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    val category = ShopCategory.of(reward.category)
    val symbol = currency?.symbol?.takeIf { it.isNotBlank() } ?: "⭐"
    val left = RewardsMath.balanceAfter(balance, reward.cost)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(13.dp),
        ) {
            RewardWell(emoji = reward.emoji, gradient = category)

            Text(
                text = "Redeem ${reward.title}?",
                style = WF.type.serif(24.sp, FontWeight.Bold),
                color = WF.colors.ink,
                textAlign = TextAlign.Center,
            )

            PanelPill {
                Text(text = symbol, style = WF.type.bodySmall)
                Text(
                    text = "${reward.cost} ${currency?.label?.lowercase() ?: "stars"}",
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink2,
                )
            }

            Text(
                text = "$balance $symbol → $left $symbol left",
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
            )

            if (reward.requiresApproval) {
                PanelPill {
                    Icon(
                        imageVector = Icons.Filled.CheckCircle,
                        contentDescription = null,
                        tint = WF.colors.ink2,
                        modifier = Modifier.size(14.dp),
                    )
                    Text(
                        text = "A parent will get a ping to approve",
                        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink2,
                    )
                }
            }

            Row(
                Modifier.fillMaxWidth().padding(top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                SecondaryButton(label = "Not yet", onClick = onDismiss, modifier = Modifier.weight(1f))
                WaffledPrimaryCTA(
                    label = if (busy) "Redeeming…" else "Redeem it!",
                    onClick = onConfirm,
                    modifier = Modifier.weight(1f),
                    isBusy = busy,
                )
            }
        }
    }
}

/**
 * The post-redeem celebration — a confetti burst over the reward, the balance line, an
 * approval-aware pill, and Back to shop.
 *
 * [balanceBefore] is captured before the write so the "13 → 3" line is honest even
 * though the reload has already landed by the time this shows.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShopCelebrationView(
    reward: RewardsApi.Reward,
    currency: RewardsApi.Currency?,
    balanceBefore: Int,
    pending: Boolean,
    onClose: () -> Unit,
) {
    val category = ShopCategory.of(reward.category)
    val symbol = currency?.symbol?.takeIf { it.isNotBlank() } ?: "⭐"
    val left = RewardsMath.balanceAfter(balanceBefore, reward.cost)

    ModalBottomSheet(
        onDismissRequest = onClose,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Box(Modifier.fillMaxWidth()) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp)
                    .padding(bottom = 28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(13.dp),
            ) {
                RewardWell(emoji = reward.emoji, gradient = category)

                Text(
                    text = "${reward.title} unlocked! 🎉",
                    style = WF.type.serif(24.sp, FontWeight.Bold),
                    color = WF.colors.ink,
                    textAlign = TextAlign.Center,
                )
                Text(
                    text = "$balanceBefore $symbol → $left $symbol left",
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
                Row(
                    modifier = Modifier
                        .background(
                            WF.colors.primary.copy(alpha = 0.12f),
                            RoundedCornerShape(WF.radius.pill),
                        )
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Filled.CheckCircle,
                        contentDescription = null,
                        tint = WF.colors.primary,
                        modifier = Modifier.size(14.dp),
                    )
                    Text(
                        text = if (pending) "We told a parent — enjoy!" else "Enjoy!",
                        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.primary,
                    )
                }
                WaffledPrimaryCTA(
                    label = "Back to shop",
                    onClick = onClose,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
            // Decoration only: it must never eat the taps meant for "Back to shop".
            ConfettiView(
                Modifier
                    .matchParentSize()
                    .clip(RoundedCornerShape(0.dp)),
            )
        }
    }
}

/** The gradient well both sheets open with — a big emoji on its category colour. */
@Composable
private fun RewardWell(emoji: String?, gradient: ShopCategory) {
    Box(
        modifier = Modifier
            .padding(top = 12.dp)
            .size(92.dp)
            .clip(RoundedCornerShape(22.dp))
            .background(gradient.gradient),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = emoji ?: "🎁", style = TextStyle(fontSize = 44.sp))
    }
}

/** A neutral capsule for a supporting line of copy. */
@Composable
private fun PanelPill(content: @Composable () -> Unit) {
    Row(
        modifier = Modifier
            .background(WF.colors.panel, RoundedCornerShape(WF.radius.pill))
            .padding(horizontal = 14.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        content()
    }
}

/**
 * The quiet half of a two-button row.
 *
 * `WaffledPrimaryCTA` covers the loud half but has no neutral variant, so this mirrors
 * its metrics (full width, 14dp vertical, `radius.md`) on a `panel` fill — see the report
 * note about a shared secondary CTA.
 */
@Composable
internal fun SecondaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    fill: Color = WF.colors.panel,
    textColor: Color = WF.colors.ink2,
) {
    val shape = RoundedCornerShape(WF.radius.md)
    Box(
        modifier = modifier
            .fillMaxWidth()
            .background(fill, shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(vertical = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold),
            color = textColor,
        )
    }
}
