package app.waffled.feature.goals

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.FamilyColor
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledSecondaryCTA
import app.waffled.core.design.WaffledTextField
import app.waffled.core.model.Person
import app.waffled.core.network.ApiErrorText
import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.launch

/**
 * New goal list (membership group) — name, optional emoji, member multi-select and a
 * private toggle. The port of the iOS `GoalListCreateSheet`, mirroring the web ListModal.
 *
 * Creates the list server-side and hands the new id back so the caller can select it
 * immediately, rather than waiting for the next lists fetch to notice it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun GoalListCreateSheet(
    api: GoalsApi,
    members: List<Person>,
    onDismiss: () -> Unit,
    onCreated: (String) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var emoji by remember { mutableStateOf("") }
    var memberIds by remember { mutableStateOf(emptySet<String>()) }
    var isPrivate by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Column(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.canvas)
            .verticalScroll(rememberScrollState())
            .padding(WF.spacing.xxxl),
        verticalArrangement = Arrangement.spacedBy(WF.spacing.xxxl),
    ) {
        Text("New goal list", style = WF.type.title, color = WF.colors.ink)

        error?.let { DismissibleErrorBanner(message = it, onDismiss = { error = null }) }

        Row(horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg)) {
            WaffledTextField(
                value = name,
                onValueChange = { name = it },
                label = "List name",
                placeholder = "Mom & Dad",
                modifier = Modifier.weight(1f),
            )
            WaffledTextField(
                value = emoji,
                // Two characters is enough for any emoji, including a joined pair; more
                // is a paste accident, not a choice.
                onValueChange = { emoji = it.take(2) },
                label = "Emoji",
                placeholder = "💑",
                modifier = Modifier.width(84.dp),
            )
        }

        GoalSection("Who's on this list?") {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
                verticalArrangement = Arrangement.spacedBy(WF.spacing.sm),
            ) {
                members.forEach { m ->
                    GoalPersonChip(
                        name = m.name,
                        colorHex = m.colorHex,
                        emoji = m.displayEmoji,
                        selected = m.id in memberIds,
                        onClick = {
                            memberIds = if (m.id in memberIds) memberIds - m.id else memberIds + m.id
                        },
                    )
                }
            }
        }

        Row(
            Modifier
                .fillMaxWidth()
                .background(WF.colors.card, RoundedCornerShape(WF.radius.md))
                .border(1.dp, WF.colors.hair, RoundedCornerShape(WF.radius.md))
                .padding(WF.spacing.lg),
            horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("Private", style = WF.type.label, color = WF.colors.ink)
                Text("Only these members see it", style = WF.type.caption, color = WF.colors.ink3)
            }
            Switch(
                checked = isPrivate,
                onCheckedChange = { isPrivate = it },
                colors = SwitchDefaults.colors(
                    checkedThumbColor = Color.White,
                    checkedTrackColor = FamilyColor.Person3.solid,
                    uncheckedThumbColor = WF.colors.card,
                    uncheckedTrackColor = WF.colors.panel,
                    uncheckedBorderColor = WF.colors.hair,
                ),
            )
        }

        WaffledPrimaryCTA(
            label = "Create list",
            isBusy = saving,
            isDisabled = name.isBlank(),
            onClick = {
                if (saving) return@WaffledPrimaryCTA
                saving = true
                scope.launch {
                    val created = runCatching {
                        api.addGoalList(
                            name = name.trim(),
                            emoji = emoji.trim().ifBlank { null },
                            memberIds = memberIds.toList(),
                            isPrivate = isPrivate,
                        )
                    }
                    saving = false
                    created.fold(
                        onSuccess = { id ->
                            onCreated(id)
                            onDismiss()
                        },
                        // Relay what the server said — it knows why, and we don't.
                        onFailure = { failure ->
                            error = (failure as? WaffledApiException)?.userMessage
                                ?: ApiErrorText.from(null, 0)
                        },
                    )
                }
            },
        )
        WaffledSecondaryCTA(label = "Cancel", onClick = onDismiss)
    }
}
