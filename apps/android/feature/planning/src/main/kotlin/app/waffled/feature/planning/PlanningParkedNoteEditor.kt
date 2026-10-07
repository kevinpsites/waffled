package app.waffled.feature.planning

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.wfField
import app.waffled.feature.planning.api.ParkedTagChange
import kotlinx.coroutines.launch

/** The server's own cap (`parkItem`'s MAX_NOTE). */
internal const val PARKED_NOTE_MAX = 500

/**
 * Fixing a note that is already parked — its words and its tag, so Drop never has to stand
 * in for backspace. One editor for every surface that shows a note. Port of iOS
 * `PlanningParkedNoteEditor`.
 *
 * [onSave] gets ONLY WHAT MOVED: a null note leaves the words alone, and the tag is a
 * [ParkedTagChange] so "No tag" can be told from "only the words". It returns whether the
 * server took it; a refusal leaves the editor open on what was typed.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PlanningParkedNoteEditor(
    note: String,
    stepKey: String?,
    /** The tags this surface offers. The note's current tag is always added as a chip. */
    tags: List<PlanningParkedTag>,
    onCancel: () -> Unit,
    onSave: suspend (note: String?, tag: ParkedTagChange) -> Boolean,
    busy: Boolean = false,
    errorMessage: String? = null,
) {
    var text by rememberSaveable { mutableStateOf(note) }
    var tag by rememberSaveable { mutableStateOf(stepKey) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    val trimmed = text.trim()
    val disabled = busy || saving
    val chips = if (stepKey != null && tags.none { it.stepKey == stepKey }) {
        tags + PlanningParkedTag(stepKey, stepKey)
    } else {
        tags
    }

    fun save() {
        if (disabled || trimmed.isEmpty()) return
        val wordsSame = trimmed == note.trim()
        if (wordsSame && tag == stepKey) {
            onCancel()
            return
        }
        val nextNote = if (wordsSame) null else trimmed
        val nextTag = if (tag == stepKey) ParkedTagChange.Unchanged else ParkedTagChange.To(tag)
        saving = true
        scope.launch {
            val took = onSave(nextNote, nextTag)
            saving = false
            if (took) onCancel()
        }
    }

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        PlanningNoteField(
            value = text,
            onValueChange = { text = it.take(PARKED_NOTE_MAX) },
            placeholder = "The note",
            enabled = !disabled,
            fontSize = 14,
            modifier = Modifier
                .focusRequester(focus)
                .semantics { contentDescription = "Edit this note" },
        )
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            chips.forEach { t -> PlanningTagChip(t.label, tag == t.stepKey, { tag = t.stepKey }, disabled) }
            PlanningTagChip("No tag", tag == null, { tag = null }, disabled)
        }
        if (!errorMessage.isNullOrEmpty()) {
            Text(errorMessage, style = TextStyle(fontSize = 12.sp), color = WF.colors.danger)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PlanningPillButton(
                label = "Save",
                onClick = ::save,
                filled = true,
                disabled = disabled || trimmed.isEmpty(),
                working = saving,
            )
            PlanningPillButton(label = "Cancel", onClick = onCancel, tint = WF.colors.ink2, disabled = saving)
        }
    }
}

/**
 * A multi-line boxed field for a note (1–4 lines), on `wfField` chrome. `WaffledTextField`
 * is single-height with a 15sp body; a note wants the bolder 14–15sp semibold of iOS.
 */
@Composable
internal fun PlanningNoteField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    fontSize: Int = 15,
) {
    val style = TextStyle(fontSize = fontSize.sp, fontWeight = FontWeight.SemiBold, color = WF.colors.ink)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        textStyle = style,
        minLines = 1,
        maxLines = 4,
        cursorBrush = SolidColor(WF.colors.primary),
        modifier = modifier.fillMaxWidth(),
        decorationBox = { inner ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .wfField()
                    .padding(horizontal = 12.dp, vertical = 10.dp),
            ) {
                if (value.isEmpty()) Text(placeholder, style = style.copy(color = WF.colors.ink3))
                inner()
            }
        },
    )
}
