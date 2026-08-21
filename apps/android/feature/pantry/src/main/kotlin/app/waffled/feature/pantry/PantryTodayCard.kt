package app.waffled.feature.pantry

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard

/**
 * The Pantry card on Today (phone).
 *
 * Surfaces only what needs attention — expiring within three days (or already past) and
 * running low — soonest first, under an "N on hand · M soon" header. Tapping opens the
 * Pantry.
 *
 * Reuses [PantryModel] so "soon"/"low" and the precomputed expiry days match the list
 * exactly; there is no second definition of either, and no date math per render.
 *
 * Gate on the **pantry** module at the call site (`ModuleGate.isOn`) — Pantry is optional
 * and default OFF.
 */
@Composable
fun PantryTodayCard(
    model: PantryModel,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
    cap: Int = 5,
) {
    val snapshot by model.state.collectAsStateWithLifecycle()

    LaunchedEffect(Unit) { model.load() }

    // The household turned this card off in Settings → Pantry. `showOnToday` defaults
    // true, so nothing flashes off before the config lands.
    if (snapshot.loaded && !model.showOnToday) return

    val rows = snapshot.value.orEmpty()
    val onHand = remember(rows) { model.onHand }
    val attention = remember(rows) { model.needsAttention() }
    val soonCount = remember(rows) { onHand.count { it.isSoon } }

    WaffledCard(modifier.clickable(onClick = onOpen), padding = 15.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "🥫 Pantry",
                    style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink2,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    if (soonCount > 0) {
                        "${onHand.size} on hand · $soonCount soon"
                    } else {
                        "${onHand.size} on hand"
                    },
                    style = WF.type.caption,
                    color = WF.colors.ink3,
                )
                Icon(
                    Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    tint = WF.colors.ink3,
                    modifier = Modifier.size(14.dp),
                )
            }

            when {
                !snapshot.loaded -> EmptyLine("Loading…")
                onHand.isEmpty() -> EmptyLine("Nothing logged yet — add what's on hand ›")
                attention.isEmpty() -> EmptyLine("All fresh — nothing to use up soon.")
                else -> {
                    attention.take(cap).forEach { AttentionRow(it) }
                    if (attention.size > cap) {
                        Text(
                            "+${attention.size - cap} more",
                            style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
                            color = WF.colors.ink3,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun EmptyLine(text: String) {
    Text(
        text,
        Modifier.fillMaxWidth(),
        style = WF.type.bodySmall,
        color = WF.colors.ink3,
    )
}

@Composable
private fun AttentionRow(row: PantryRow) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(32.dp)
                .background(WF.colors.panel, RoundedCornerShape(9.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Text(row.emoji, style = TextStyle(fontSize = 17.sp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
                row.name,
                style = WF.type.label,
                color = WF.colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            row.amountLabel?.let {
                Text(it, style = TextStyle(fontSize = 11.sp), color = WF.colors.ink3)
            }
        }
        // An expiry pill when it needs using; otherwise the reason it is here is "low".
        if (row.isSoon && row.expiryLabel != null) {
            AgePillLike(row.expiryLabel, WF.colors.warn, WF.colors.warnT)
        } else {
            AgePillLike("Low", WF.colors.primaryD, WF.colors.primaryD.copy(alpha = 0.12f))
        }
    }
}

/**
 * The status pill on a Today row.
 *
 * Not [app.waffled.core.design.WaffledStatusBadge]: that derives its fill from the text
 * colour at a fixed 12% opacity, and the expiry pill uses the `warnT` **token** — which
 * in dark mode is a wash of a different lightness than `warn` at 12%. Passing the fill
 * explicitly keeps both variants on their intended surface.
 */
@Composable
private fun AgePillLike(
    text: String,
    tint: androidx.compose.ui.graphics.Color,
    fill: androidx.compose.ui.graphics.Color,
) {
    Text(
        text,
        Modifier
            .background(fill, RoundedCornerShape(WF.radius.pill))
            .padding(horizontal = 8.dp, vertical = 3.dp),
        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
        color = tint,
    )
}
