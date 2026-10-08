package app.waffled.feature.kiosktoday

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledTextField

/**
 * Quick-add for the grocery card — iOS `AddGroceryItemSheet`. A sheet rather than an
 * inline field so the system lifts the field above the keyboard; it stays open for
 * several adds in a row.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AddGrocerySheet(onAdd: (String) -> Unit, onDismiss: () -> Unit) {
    var draft by remember { mutableStateOf("") }
    var added by remember { mutableIntStateOf(0) }
    val focus = remember { FocusRequester() }
    val canAdd = draft.isNotBlank()
    val add = {
        val name = draft.trim()
        if (name.isNotEmpty()) {
            draft = ""
            added += 1
            onAdd(name)
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier.fillMaxWidth().imePadding().padding(start = 20.dp, end = 20.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onDismiss) { Text("Done", color = WF.colors.primary) }
                Spacer(Modifier.weight(1f))
                Text("Add to grocery", style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
                Spacer(Modifier.weight(1f))
                TextButton(onClick = add, enabled = canAdd) {
                    Text(
                        "Add",
                        fontWeight = FontWeight.SemiBold,
                        color = if (canAdd) WF.colors.primary else WF.colors.ink3,
                    )
                }
            }
            WaffledTextField(
                value = draft,
                onValueChange = { draft = it },
                modifier = Modifier.fillMaxWidth().focusRequester(focus),
                placeholder = "e.g. Milk",
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { add() }),
            )
            if (added > 0) {
                Text(
                    "Added $added item${if (added == 1) "" else "s"} — keep typing, or swipe down when done.",
                    style = TextStyle(fontSize = 12.sp),
                    color = WF.colors.ink3,
                )
            }
        }
    }
    LaunchedEffect(Unit) { focus.requestFocus() }
}
