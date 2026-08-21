package app.waffled.feature.pantry

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import kotlinx.coroutines.launch

/**
 * "Used from your pantry" — shown after a recipe is marked cooked, when the server finds
 * on-hand items it likely used.
 *
 * Each row offers three choices and defaults to the server's suggestion (staples →
 * "Didn't use", a countable amount above one → "Used some", otherwise "Used it up").
 * Only `used_up` and `decrement` reach the consume route; "Didn't use" is dropped.
 * Matching and suggesting are entirely server-side — this sheet only confirms.
 *
 * Exported for the **Recipes** module to present after a cook: the matches come from
 * [PantryApi.forRecipe], which is a pantry route, so the pair lives here rather than
 * being reimplemented over there.
 *
 * Because it writes without going through [PantryModel], pass the app's [RefreshBus] —
 * consuming changes the pantry, and an open Pantry screen or Today card has no reactive
 * query to notice. Omitting it is a silent stale-data bug, not a missing nicety.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CookConfirmSheet(
    recipeTitle: String,
    matches: List<PantryApi.RecipeMatch>,
    api: PantryApi,
    onDismiss: () -> Unit,
    refreshBus: RefreshBus? = null,
    onApplied: (Int) -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    var choice by remember(matches) {
        mutableStateOf(matches.associate { it.id to it.suggested })
    }
    var busy by remember { mutableStateOf(false) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = WF.spacing.tabBarClearance),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("Used from your pantry", style = WF.type.title, color = WF.colors.ink)
            Text(
                "Update your pantry after cooking $recipeTitle.",
                style = WF.type.body,
                color = WF.colors.ink3,
            )

            matches.forEach { match ->
                MatchRow(
                    match = match,
                    selected = choice[match.id] ?: match.suggested,
                    onSelect = { mode -> choice = choice + (match.id to mode) },
                )
            }

            WaffledPrimaryCTA(
                label = "Update pantry",
                onClick = {
                    busy = true
                    scope.launch {
                        val picked = matches.map { it.id to (choice[it.id] ?: it.suggested) }
                        // `consume` drops the skips itself, so the count has to be taken
                        // here — reporting "3 updated" when one was a skip is a lie the
                        // caller would then show to the user.
                        val applied = picked.count { it.second != PantryApi.MODE_SKIP }
                        if (applied > 0) {
                            runCatching { api.consume(picked) }
                                .onSuccess { refreshBus?.bump(RefreshDomain.Pantry) }
                        }
                        busy = false
                        onApplied(applied)
                        onDismiss()
                    }
                },
                isBusy = busy,
            )
        }
    }
}

/** The three consume choices, in the order the web and iOS present them. */
private val MODES = listOf(
    PantryApi.MODE_DECREMENT to "Used some",
    PantryApi.MODE_USED_UP to "Used it up",
    PantryApi.MODE_SKIP to "Didn't use",
)

@Composable
private fun MatchRow(
    match: PantryApi.RecipeMatch,
    selected: String,
    onSelect: (String) -> Unit,
) {
    val shape = RoundedCornerShape(WF.radius.md)
    Column(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clip(shape)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                match.name,
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(amountLabel(match), style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink3)
            if (match.isStaple) {
                Text(
                    "· staple",
                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
            }
            Spacer(Modifier.weight(1f))
        }

        // A three-way segmented control. Material3's SegmentedButton exists but paints
        // from a colour scheme this app doesn't populate, so it would fight the palette;
        // the shape is three equal-weight cells, which is trivial in a Row.
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            MODES.forEach { (mode, label) ->
                val on = selected == mode
                Box(
                    Modifier
                        .weight(1f)
                        .background(
                            if (on) WF.colors.primary else WF.colors.panel,
                            RoundedCornerShape(9.dp),
                        )
                        .clip(RoundedCornerShape(9.dp))
                        .clickable { onSelect(mode) }
                        .padding(vertical = 8.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        label,
                        style = TextStyle(
                            fontSize = 13.sp,
                            fontWeight = if (on) FontWeight.Bold else FontWeight.SemiBold,
                        ),
                        // White on the saturated coral fill; `ink2` on the panel one.
                        color = if (on) Color.White else WF.colors.ink2,
                        textAlign = TextAlign.Center,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

private fun amountLabel(match: PantryApi.RecipeMatch): String {
    val parts = listOf(match.amount.trim(), match.unit.trim()).filter { it.isNotEmpty() }
    return if (parts.isEmpty()) "on hand" else parts.joinToString(" ")
}
