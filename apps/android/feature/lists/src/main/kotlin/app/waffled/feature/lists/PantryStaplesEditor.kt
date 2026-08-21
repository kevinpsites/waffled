package app.waffled.feature.lists

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.wfChip
import kotlinx.coroutines.launch

/**
 * Manage the pantry staples master list — the items assumed in-house, which the grocery
 * list therefore leaves off.
 *
 * Mirrors the web's "Pantry staples" modal: add via a field, remove via an ✕ on each chip.
 * The same list is also managed from the Meals settings tab, so [onChange] tells the board
 * behind this sheet to re-read it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PantryStaplesEditor(
    initial: List<GroceryBoardDTO.Staple>,
    api: ListsApi,
    onDismiss: () -> Unit,
    onChange: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    var staples by remember { mutableStateOf(initial) }
    var draft by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    val trimmed = draft.trim()
    val canAdd = trimmed.isNotEmpty() && staples.none { it.name.equals(trimmed, ignoreCase = true) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
        modifier = modifier,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Pantry staples", style = WF.type.title, color = WF.colors.ink)
            Text(
                "Assumed in the house — the grocery list leaves these off.",
                style = WF.type.bodySmall,
                color = WF.colors.ink2,
            )

            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                ListTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    placeholder = "Add a staple… (e.g. Soy sauce)",
                    capitalization = KeyboardCapitalization.Words,
                    modifier = Modifier.weight(1f),
                    onSubmit = {
                        if (canAdd && !busy) {
                            scope.launch {
                                busy = true
                                runCatching { api.addPantryStaple(trimmed) }
                                    .onSuccess {
                                        staples = staples + it
                                        draft = ""
                                        onChange()
                                    }
                                busy = false
                            }
                        }
                    },
                )
                Text(
                    text = "Add",
                    modifier = Modifier
                        .wfChip(selected = canAdd && !busy)
                        .clickable(enabled = canAdd && !busy) {
                            scope.launch {
                                busy = true
                                runCatching { api.addPantryStaple(trimmed) }
                                    .onSuccess {
                                        staples = staples + it
                                        draft = ""
                                        onChange()
                                    }
                                busy = false
                            }
                        }
                        .padding(horizontal = 18.dp, vertical = 12.dp),
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                    color = if (canAdd && !busy) WF.colors.ink else WF.colors.ink3,
                )
            }

            if (staples.isEmpty()) {
                Text("No staples yet.", style = WF.type.body, color = WF.colors.ink3)
            } else {
                ChipFlow {
                    for (staple in staples) {
                        Row(
                            Modifier
                                .wfChip(selected = false)
                                .padding(start = 12.dp, end = 9.dp, top = 8.dp, bottom = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(7.dp),
                        ) {
                            Text(
                                staple.name,
                                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                                color = WF.colors.ink2,
                            )
                            Box(
                                Modifier
                                    .size(16.dp)
                                    .clickable {
                                        // Optimistic: put it back if the delete didn't take.
                                        val snapshot = staples
                                        staples = staples.filterNot { it.id == staple.id }
                                        scope.launch {
                                            runCatching { api.removePantryStaple(staple.id) }
                                                .onSuccess { onChange() }
                                                .onFailure { staples = snapshot }
                                        }
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    Icons.Filled.Close,
                                    contentDescription = "Remove ${staple.name}",
                                    tint = WF.colors.ink3,
                                    modifier = Modifier.size(12.dp),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
