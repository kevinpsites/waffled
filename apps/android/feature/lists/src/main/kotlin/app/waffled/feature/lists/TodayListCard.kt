package app.waffled.feature.lists

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import kotlinx.coroutines.launch

/**
 * The Today "Lists" card — pins ONE of the household's custom lists so the hardware run or
 * packing list sits on Today next to everything else.
 *
 * Mirrors the web's `ListCard` and the iOS `TodayListCard`. Which list is pinned is a
 * per-device choice; see [TodayListModel].
 */
@Composable
fun TodayListCard(
    model: TodayListModel,
    onOpen: (ListSummary) -> Unit,
    modifier: Modifier = Modifier,
    /**
     * Reloads the card whenever it changes. The host passes its pull-to-refresh counter
     * and the Lists refresh revision: keyed on nothing, the card would sit on the data
     * it read when it first appeared (iOS `TodayListCard`'s `.task(id: refreshRev)`).
     */
    refreshKey: Any? = null,
) {
    val scope = rememberCoroutineScope()
    val loaded by model.loadedState.collectAsStateWithLifecycle()
    val failed by model.failedState.collectAsStateWithLifecycle()

    // `open` is derived from three flows; reading them here is what makes the card
    // recompose when any of them moves.
    model.listsState.collectAsStateWithLifecycle()
    model.itemsState.collectAsStateWithLifecycle()
    model.doneState.collectAsStateWithLifecycle()
    model.pickState.collectAsStateWithLifecycle()

    var switcherOpen by remember { mutableStateOf(false) }

    LaunchedEffect(refreshKey) { model.load() }

    val active = model.active
    val pickable = model.pickable
    val open = model.open

    WaffledCard(modifier = modifier) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(
                    Modifier
                        .weight(1f)
                        .clickable(enabled = active != null) { active?.let(onOpen) },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = active?.let { "${it.emoji ?: "📝"} ${it.name}" } ?: "Lists",
                        style = WF.type.sectionTitle,
                        color = WF.colors.ink,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (active != null) {
                        Icon(
                            Icons.AutoMirrored.Filled.KeyboardArrowRight,
                            contentDescription = null,
                            tint = WF.colors.ink3,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
                // Only worth a switcher when there is something to switch to.
                if (pickable.size > 1) {
                    Box {
                        Icon(
                            Icons.Filled.SwapHoriz,
                            contentDescription = "Which list",
                            tint = WF.colors.ink2,
                            modifier = Modifier.size(20.dp).clickable { switcherOpen = true },
                        )
                        ListRowMenu(
                            expanded = switcherOpen,
                            onDismiss = { switcherOpen = false },
                            items = pickable.map { l ->
                                MenuAction(
                                    label = "${l.emoji ?: "📝"} ${l.name}",
                                    icon = Icons.Filled.Checklist,
                                    onClick = { scope.launch { model.pick(l.id) } },
                                )
                            },
                        )
                    }
                }
            }

            when {
                pickable.isEmpty() -> Text(
                    text = when {
                        !loaded -> "Loading…"
                        failed -> "Couldn’t load your lists — pull to refresh or sign in again."
                        else -> "No lists yet — make one in Lists and it’ll show up here."
                    },
                    style = WF.type.bodySmall,
                    color = WF.colors.ink3,
                )

                open.isEmpty() -> Text(
                    text = if (loaded) "All done here. 🎉" else "Loading…",
                    style = WF.type.bodySmall,
                    color = WF.colors.ink3,
                )

                else -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (item in open) {
                        Row(
                            Modifier.clickable { scope.launch { model.check(item) } },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                Icons.Filled.RadioButtonUnchecked,
                                contentDescription = "Mark ${item.name} as done",
                                tint = WF.colors.ink3,
                                modifier = Modifier.size(18.dp),
                            )
                            Spacer(Modifier.width(10.dp))
                            Text(
                                text = item.quantity?.takeIf { it.isNotEmpty() }
                                    ?.let { "${item.name} ($it)" } ?: item.name,
                                style = WF.type.label,
                                color = WF.colors.ink,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }
    }
}
