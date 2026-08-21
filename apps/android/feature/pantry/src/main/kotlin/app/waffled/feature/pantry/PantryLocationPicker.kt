package app.waffled.feature.pantry

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.wfChip
import kotlinx.coroutines.launch

/**
 * The "Where" chip row, shared by the add-by-hand editor and the scan confirm sheet.
 *
 * The household's configured sections plus a "＋ New" chip that creates one right here.
 * You're standing at the freezer holding a bag that belongs somewhere that doesn't exist
 * yet — that shouldn't mean abandoning the add and going to Settings.
 *
 * A section created here is appended to the household's pantry config (so it shows in the
 * filter chips too) and kept in local state, because the parent's model won't have
 * reloaded by the time this row re-renders.
 */
@Composable
fun PantryLocationPicker(
    selection: String,
    onSelect: (String) -> Unit,
    locations: List<String>,
    api: PantryApi,
    modifier: Modifier = Modifier,
    /** Called after a section is created, so the parent can refresh its config. */
    onLocationsChanged: suspend () -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    var created by remember { mutableStateOf(emptyList<String>()) }
    var adding by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }

    val choices = remember(locations, created, selection) {
        val out = (locations.ifEmpty { PantrySections.DEFAULTS }).toMutableList()
        for (name in created) {
            if (out.none { it.equals(name, ignoreCase = true) }) out += name
        }
        if (selection.isNotEmpty() && out.none { it.equals(selection, ignoreCase = true) }) {
            out += selection
        }
        out.toList()
    }

    fun create() {
        val name = draft.trim()
        if (name.isEmpty() || saving) return
        saving = true
        failed = false
        scope.launch {
            runCatching { api.addLocation(name) }
                .onSuccess { next ->
                    // The server matches case-insensitively, but the item list buckets on
                    // an EXACT string — so adopt the household's own spelling or the item
                    // files under a section nothing recognises and lands in "Other".
                    val canonical = PantrySections.canonical(name, next)
                    created = created + canonical
                    onSelect(canonical)
                    adding = false
                    draft = ""
                    onLocationsChanged()
                }
                .onFailure { failed = true }
            saving = false
        }
    }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(9.dp)) {
        SectionLabel("Where")

        if (adding) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                WaffledTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    modifier = Modifier.weight(1f),
                    placeholder = "New section name",
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { create() }),
                )
                Text(
                    text = if (saving) "…" else "Add",
                    modifier = Modifier
                        .background(WF.colors.ink, RoundedCornerShape(WF.radius.pill))
                        .clip(RoundedCornerShape(WF.radius.pill))
                        .clickable(enabled = !saving && draft.isNotBlank(), onClick = { create() })
                        .padding(horizontal = 14.dp, vertical = 9.dp),
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
                    // `onInk`, never white: `ink` flips to a warm off-white in dark.
                    color = WF.colors.onInk,
                )
                Box(
                    Modifier
                        .size(32.dp)
                        .background(WF.colors.panel, CircleShape)
                        .clip(CircleShape)
                        .clickable(enabled = !saving) {
                            adding = false
                            draft = ""
                            failed = false
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = "Cancel",
                        tint = WF.colors.ink3,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
        } else {
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                choices.forEach { location ->
                    val on = location.equals(selection, ignoreCase = true)
                    Text(
                        text = location,
                        modifier = Modifier
                            .wfChip(selected = on)
                            .clickable { onSelect(location) }
                            .padding(horizontal = 12.dp, vertical = 7.dp),
                        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                        color = if (on) WF.colors.ink else WF.colors.ink2,
                    )
                }
                Row(
                    modifier = Modifier
                        .wfChip(selected = false)
                        .clickable {
                            failed = false
                            adding = true
                        }
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Filled.Add,
                        contentDescription = null,
                        tint = WF.colors.primary,
                        modifier = Modifier.size(13.dp),
                    )
                    Text(
                        "New",
                        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.primary,
                    )
                }
                Box(Modifier.width(4.dp))
            }
        }

        if (failed) {
            Text(
                "Couldn't add that section — try again.",
                style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.danger,
            )
        }
    }
}
