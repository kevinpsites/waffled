package app.waffled.feature.lists

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.model.Person

/**
 * The fuller "Details" editor — name, quantity, priority, assignee, section and (for
 * grocery) store. The 90% case stays on the inline row editor; this is for the rest.
 *
 * The editor's contract is "what you see is what the row becomes", so an emptied field
 * CLEARS rather than being skipped — which is why [ListsApi.updateItemDetails] always
 * sends every key, nulls included.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ItemDetailEditor(
    sections: List<String>,
    stores: List<String>,
    showStore: Boolean,
    onDismiss: () -> Unit,
    onSave: (
        name: String,
        quantity: String,
        assignee: ListItemDTO.Assignee?,
        section: String,
        store: String,
        priority: Int,
    ) -> Unit,
    modifier: Modifier = Modifier,
    item: ListItemDTO? = null,
    /** Add mode: a blank sheet, optionally seeded with whatever was typed in the add bar. */
    newItemName: String? = null,
    /**
     * The household, for the assignee picker.
     *
     * Passed in rather than read from `SyncManager` here because `SyncManager.members` is
     * declared but never populated from the synced `persons` table (flagged in the port
     * report). An empty list simply hides the picker.
     */
    members: List<Person> = emptyList(),
) {
    var name by remember { mutableStateOf(item?.name ?: newItemName.orEmpty()) }
    var quantity by remember { mutableStateOf(item?.editableQuantity.orEmpty()) }
    var section by remember { mutableStateOf(item?.section.orEmpty()) }
    var store by remember { mutableStateOf(item?.store.orEmpty()) }
    var priority by remember { mutableIntStateOf(item?.priority ?: ListItemPriority.NORMAL) }
    // Preselect by ID, not by name: two members can share a name, and the server sends the
    // id (iOS drops it and has to match on the name).
    var assigneeId by remember { mutableStateOf(item?.assignee?.personId) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
        modifier = modifier,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Text(
                if (item == null) "Add item" else "Item details",
                style = WF.type.title,
                color = WF.colors.ink,
            )

            Field("Name") {
                ListTextField(
                    value = name,
                    onValueChange = { name = it },
                    placeholder = "Item",
                    capitalization = KeyboardCapitalization.Sentences,
                )
            }

            Field("Quantity") {
                ListTextField(
                    value = quantity,
                    onValueChange = { quantity = it },
                    placeholder = "e.g. 2 lb",
                )
            }

            Field("Priority") {
                ChipFlow {
                    for (option in ListItemPriority.all) {
                        ListChip(
                            label = option.label,
                            leading = option.icon.takeIf { it.isNotEmpty() },
                            selected = priority == option.value,
                            onClick = { priority = option.value },
                        )
                    }
                }
            }

            if (members.isNotEmpty()) {
                Field("Assigned to") {
                    ChipFlow {
                        AssigneeChip(
                            label = "Anyone",
                            person = null,
                            selected = assigneeId == null,
                            onClick = { assigneeId = null },
                        )
                        for (person in members) {
                            AssigneeChip(
                                label = person.name,
                                person = person,
                                selected = assigneeId == person.id,
                                onClick = { assigneeId = person.id },
                            )
                        }
                    }
                }
            }

            Field("Section") {
                ChipFlow {
                    ListChip("Auto", leading = "✨", selected = section.isBlank(), onClick = { section = "" })
                    for (s in sections) {
                        ListChip(s, selected = section.equals(s, ignoreCase = true), onClick = { section = s })
                    }
                }
                ListTextField(
                    value = section,
                    onValueChange = { section = it },
                    placeholder = "e.g. Produce",
                    capitalization = KeyboardCapitalization.Words,
                )
                Text(
                    if (section.isBlank()) "Auto — filed by item name."
                    else "Filed under “${section.trim()}”.",
                    style = WF.type.caption,
                    color = WF.colors.ink3,
                )
            }

            if (showStore) {
                Field("Store") {
                    ChipFlow {
                        ListChip("No store", selected = store.isBlank(), onClick = { store = "" })
                        for (s in stores) {
                            ListChip(s, selected = store.equals(s, ignoreCase = true), onClick = { store = s })
                        }
                    }
                    ListTextField(
                        value = store,
                        onValueChange = { store = it },
                        placeholder = "e.g. Costco",
                        capitalization = KeyboardCapitalization.Words,
                    )
                    Text(
                        if (store.isBlank()) "No store — shows in the list as usual."
                        else "Shop at “${store.trim()}”.",
                        style = WF.type.caption,
                        color = WF.colors.ink3,
                    )
                }
            }

            WaffledPrimaryCTA(
                label = if (item == null) "Add item" else "Save",
                onClick = {
                    val picked = members.firstOrNull { it.id == assigneeId }
                    onSave(
                        name.trim(),
                        quantity.trim(),
                        picked?.let {
                            ListItemDTO.Assignee(
                                personId = it.id,
                                name = it.name,
                                avatarEmoji = it.avatarEmoji,
                                colorHex = it.colorHex,
                            )
                        },
                        section.trim(),
                        store.trim(),
                        priority,
                    )
                },
                isDisabled = name.isBlank(),
            )
        }
    }
}

@Composable
private fun Field(label: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        SectionLabel(label)
        content()
    }
}

@Composable
private fun AssigneeChip(label: String, person: Person?, selected: Boolean, onClick: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (person != null) {
            AvatarFromHex(colorHex = person.colorHex, emoji = person.displayEmoji, size = 22.dp)
        }
        ListChip(label = label, selected = selected, onClick = onClick)
    }
}
