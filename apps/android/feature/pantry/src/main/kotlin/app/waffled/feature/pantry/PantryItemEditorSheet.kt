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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledSecondaryCTA
import app.waffled.core.design.WaffledTextField
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.time.LocalDate

/** What the editor is doing: adding a new item, or editing an existing one. */
sealed interface PantryEditorMode {
    data object Add : PantryEditorMode
    data class Edit(val row: PantryRow) : PantryEditorMode
}

/**
 * Add-by-hand / edit sheet: name, amount + unit, section, an optional best-by date, when
 * it came in, a note, a low-water mark and the "it's a meal" flag.
 *
 * Builds the request body and hands it back — the caller does the API call, so the same
 * sheet serves both add and edit.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PantryItemEditorSheet(
    mode: PantryEditorMode,
    locations: List<String>,
    api: PantryApi,
    onDismiss: () -> Unit,
    onSave: suspend (JsonObject) -> Unit,
    today: LocalDate = LocalDate.now(),
    onLocationsChanged: suspend () -> Unit = {},
    /** Edit mode only. Null hides the delete affordance entirely. */
    onDelete: (suspend () -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    val existing = (mode as? PantryEditorMode.Edit)?.row

    var name by remember { mutableStateOf(existing?.name.orEmpty()) }
    var amount by remember { mutableStateOf(existing?.item?.amount ?: "1") }
    var unit by remember { mutableStateOf(existing?.item?.unit.orEmpty()) }
    var location by remember {
        mutableStateOf(existing?.item?.location ?: locations.firstOrNull() ?: "Pantry")
    }
    var expiry by remember { mutableStateOf(PantryExpiry.date(existing?.item?.expiresOn)) }
    var addedOn by remember {
        mutableStateOf(PantryExpiry.date(existing?.item?.addedOn) ?: today)
    }
    var note by remember { mutableStateOf(existing?.item?.note.orEmpty()) }
    var lowAt by remember {
        mutableStateOf(existing?.item?.lowAt?.let { PantryAmount.format(it) }.orEmpty())
    }
    var isMeal by remember { mutableStateOf(existing?.isMeal == true) }
    var saving by remember { mutableStateOf(false) }
    var pickingExpiry by remember { mutableStateOf(false) }
    var pickingAdded by remember { mutableStateOf(false) }
    var confirmingDelete by remember { mutableStateOf(false) }

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
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Text(
                text = if (existing == null) "Add to pantry" else "Edit item",
                style = WF.type.title,
                color = WF.colors.ink,
            )

            WaffledTextField(
                value = name,
                onValueChange = { name = it },
                label = "Name",
                placeholder = "e.g. Greek yogurt",
            )

            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                WaffledTextField(
                    value = amount,
                    onValueChange = { amount = it },
                    modifier = Modifier.weight(1f),
                    label = "Amount",
                    placeholder = "1",
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                )
                WaffledTextField(
                    value = unit,
                    onValueChange = { unit = it },
                    modifier = Modifier.weight(1f),
                    label = "Unit",
                    placeholder = "bags, lb…",
                )
            }

            PantryLocationPicker(
                selection = location,
                onSelect = { location = it },
                locations = locations,
                api = api,
                onLocationsChanged = onLocationsChanged,
            )

            // Best by — a switch, because "no best-by date" is the common case and a
            // picker that always shows a date invites one being set by accident.
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    SectionLabel("Best by", Modifier.weight(1f))
                    Switch(
                        checked = expiry != null,
                        onCheckedChange = { on -> expiry = if (on) (expiry ?: today) else null },
                        colors = SwitchDefaults.colors(checkedTrackColor = WF.colors.primary),
                    )
                }
                expiry?.let { date ->
                    DateField(
                        label = PantryExpiry.shortLabelFull(date),
                        onClick = { pickingExpiry = true },
                    )
                }
            }

            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                SectionLabel("Added / bought")
                Text(
                    "how long it's been on hand",
                    style = TextStyle(fontSize = 11.sp),
                    color = WF.colors.ink3,
                )
                DateField(
                    label = PantryExpiry.shortLabelFull(addedOn),
                    onClick = { pickingAdded = true },
                )
            }

            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                WaffledTextField(
                    value = note,
                    onValueChange = { note = it },
                    modifier = Modifier.weight(1f),
                    label = "Note",
                    placeholder = "leftovers from Tuesday",
                )
                WaffledTextField(
                    value = lowAt,
                    onValueChange = { lowAt = it },
                    modifier = Modifier.weight(1f),
                    label = "Warn below",
                    placeholder = "default",
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                )
            }

            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable { isMeal = !isMeal },
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Icon(
                    imageVector = if (isMeal) Icons.Filled.CheckBox else Icons.Filled.CheckBoxOutlineBlank,
                    contentDescription = null,
                    tint = if (isMeal) WF.colors.primary else WF.colors.ink3,
                    modifier = Modifier.size(20.dp),
                )
                Text(
                    "It's a meal — ready to eat (leftovers, pre-made, or a protein to use " +
                        "up). Shows in \"Cook from your pantry\".",
                    style = WF.type.bodySmall,
                    color = WF.colors.ink2,
                )
            }

            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                WaffledSecondaryCTA("Cancel", onDismiss, Modifier.weight(1f), isDisabled = saving)
                WaffledPrimaryCTA(
                    label = "Save",
                    onClick = {
                        saving = true
                        scope.launch {
                            onSave(
                                PantryApi.itemBody(
                                    name = name.trim(),
                                    amount = PantryAmount.canonical(amount),
                                    unit = unit.trim(),
                                    location = location,
                                    note = note.trim(),
                                    expiresOn = expiry?.let(PantryExpiry::string),
                                    addedOn = PantryExpiry.string(addedOn),
                                    lowAt = PantryAmount.parse(lowAt),
                                    isMeal = isMeal,
                                ),
                            )
                            saving = false
                            onDismiss()
                        }
                    },
                    modifier = Modifier.weight(1f),
                    isBusy = saving,
                    isDisabled = name.isBlank(),
                )
            }

            if (onDelete != null) {
                HorizontalDivider(color = WF.colors.hair)
                Row(
                    Modifier
                        .fillMaxWidth()
                        .border(
                            1.dp,
                            WF.colors.danger.copy(alpha = 0.4f),
                            RoundedCornerShape(WF.radius.md),
                        )
                        .clickable(enabled = !saving) { confirmingDelete = true }
                        .padding(vertical = 13.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Filled.Delete,
                        contentDescription = null,
                        tint = WF.colors.danger,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(7.dp))
                    Text(
                        "Delete item",
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.danger,
                    )
                }
            }
        }
    }

    if (pickingExpiry) {
        PantryDatePickerDialog(
            initial = expiry ?: today,
            onDismiss = { pickingExpiry = false },
            onPick = {
                expiry = it
                pickingExpiry = false
            },
        )
    }

    if (pickingAdded) {
        PantryDatePickerDialog(
            initial = addedOn,
            onDismiss = { pickingAdded = false },
            onPick = {
                addedOn = it
                pickingAdded = false
            },
            // Something can't have come into the pantry tomorrow.
            maxDate = today,
        )
    }

    if (confirmingDelete && onDelete != null) {
        AlertDialog(
            onDismissRequest = { confirmingDelete = false },
            title = { Text("Delete this item?") },
            text = { Text("This removes it from your pantry.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmingDelete = false
                    saving = true
                    scope.launch {
                        onDelete()
                        saving = false
                        onDismiss()
                    }
                }) { Text("Delete", color = WF.colors.danger) }
            },
            dismissButton = {
                TextButton(onClick = { confirmingDelete = false }) { Text("Cancel") }
            },
            containerColor = WF.colors.card,
        )
    }
}

/** A read-only boxed field that opens a date picker — the tap target for a chosen day. */
@Composable
private fun DateField(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .background(WF.colors.card, RoundedCornerShape(WF.radius.md))
            .border(1.dp, WF.colors.hair, RoundedCornerShape(WF.radius.md))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 13.dp),
    ) {
        Text(
            text = label,
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink,
        )
    }
}
