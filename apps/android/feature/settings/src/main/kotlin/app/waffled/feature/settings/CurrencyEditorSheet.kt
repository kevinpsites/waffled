package app.waffled.feature.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledTextField
import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.launch

/** Add or edit a reward currency (admins). The default currency can't be deleted. */
@Composable
internal fun CurrencyEditorSheet(
    api: SettingsApi,
    editing: SettingsApi.Currency?,
    canDelete: Boolean,
    onDone: () -> Unit,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var label by remember { mutableStateOf(editing?.label.orEmpty()) }
    var symbol by remember { mutableStateOf(editing?.symbol ?: "⭐") }
    var colorHex by remember { mutableStateOf(editing?.color ?: WaffledSwatch.all[4]) }
    var isDefault by remember { mutableStateOf(editing?.isDefault ?: false) }
    var spendable by remember { mutableStateOf(editing?.spendable ?: true) }
    var busy by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    SettingsSheet(title = if (editing == null) "New currency" else "Edit currency", onDismiss = onDismiss) {
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
            EmojiBox(symbol) { symbol = CurrencyRules.capSymbol(it) }
            WaffledTextField(label, { label = it }, Modifier.weight(1f), placeholder = "Stars, Family Dollars…")
        }
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            SectionLabel("Color")
            ColorSwatchPicker(colorHex, { colorHex = it })
        }
        LabeledSwitch("Default", "New chores award this", isDefault, { isDefault = it })
        LabeledSwitch("Spendable", "Can buy rewards", spendable, { spendable = it })

        error?.let { FormMessage(it, WF.colors.primary, 13f) }

        WaffledPrimaryCTA(
            label = if (busy) "Saving…" else if (editing == null) "Add currency" else "Save",
            onClick = {
                busy = true
                error = null
                scope.launch {
                    val draft = SettingsApi.CurrencyDraft(label, symbol, colorHex, isDefault, spendable)
                    val ok = runCatching { api.saveCurrency(editing?.key, draft) }.isSuccess
                    busy = false
                    if (ok) { onDone(); onDismiss() } else error = "Couldn’t save. Check your connection."
                }
            },
            isDisabled = label.isBlank(),
            isBusy = busy,
        )

        if (editing != null && canDelete && !editing.isDefault) {
            ConfirmTextButton("Delete currency", "Tap again to delete", confirmDelete, { confirmDelete = true }, {
                busy = true
                error = null
                scope.launch {
                    val failure = runCatching { api.deleteCurrency(editing.key) }.exceptionOrNull()
                    busy = false
                    if (failure == null) { onDone(); onDismiss() }
                    else error = CurrencyRules.deleteError((failure as? WaffledApiException)?.userMessage)
                }
            })
        }
    }
}
