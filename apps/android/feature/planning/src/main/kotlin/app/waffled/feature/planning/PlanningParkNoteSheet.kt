package app.waffled.feature.planning

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import kotlinx.coroutines.launch

/** What the park sheet's footnote says, by where the note will surface. */
internal object PlanningParkCopy {
    fun says(betweenSessions: Boolean, tags: List<PlanningParkedTag>, tag: String?): String {
        if (betweenSessions) return "It waits in the recap and at the next session’s Loose ends."
        val label = tags.firstOrNull { it.stepKey == tag }?.label
            ?: return "No step will raise it. It waits in the recap and at next week’s Loose ends."
        return "Comes back at $label, later in this session."
    }
}

/**
 * Park a note from any step — opened from the session footer's pin, or from a summary
 * screen ([betweenSessions]: no step is ahead, so no tags). A failed park leaves the sheet
 * open on what was typed. Port of iOS `PlanningParkNoteSheet`.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun PlanningParkNoteSheet(
    tags: List<PlanningParkedTag>,
    onPark: suspend (note: String, stepKey: String?) -> Boolean,
    onClose: () -> Unit,
    betweenSessions: Boolean = false,
    errorMessage: String? = null,
) {
    var text by remember { mutableStateOf("") }
    var tag by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val focus = remember { FocusRequester() }
    val trimmed = text.trim()

    fun park() {
        if (saving || trimmed.isEmpty()) return
        saving = true
        scope.launch {
            val took = onPark(trimmed, tag)
            saving = false
            if (took) onClose()
        }
    }

    ModalBottomSheet(
        onDismissRequest = { if (!saving) onClose() },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = false),
        containerColor = WF.colors.canvas,
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 4.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "Cancel",
                modifier = Modifier
                    .align(Alignment.CenterStart)
                    .clickable(enabled = !saving, onClick = onClose),
                style = TextStyle(fontSize = 16.sp),
                color = WF.colors.primary,
            )
            Text("Park a note", style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
        }
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(16.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            PlanningNoteField(
                value = text,
                onValueChange = { text = it.take(PARKED_NOTE_MAX) },
                placeholder = "We’re going camping, we need to pack",
                enabled = !saving,
                modifier = Modifier
                    .focusRequester(focus)
                    .semantics { contentDescription = "The note" },
            )
            if (!betweenSessions) {
                FlowRow(
                    modifier = Modifier.semantics { contentDescription = "Which step should look at this?" },
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    tags.forEach { t -> PlanningTagChip(t.label, tag == t.stepKey, { tag = t.stepKey }, saving) }
                    PlanningTagChip("No tag", tag == null, { tag = null }, saving)
                }
            }
            Text(
                PlanningParkCopy.says(betweenSessions, tags, tag),
                style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink2,
            )
            if (!errorMessage.isNullOrEmpty()) {
                Text(errorMessage, style = TextStyle(fontSize = 12.sp), color = WF.colors.danger)
            }
            PlanningPillButton(
                label = "Park it",
                onClick = ::park,
                filled = true,
                disabled = saving || trimmed.isEmpty(),
                working = saving,
            )
        }
    }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
}
