package app.waffled.feature.settingshousehold

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.LockNote
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledMenuPill
import app.waffled.core.design.WaffledTextField
import app.waffled.core.model.Person
import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Add or edit a subscribed ICS feed: the link, an optional name, who it belongs to, and
 * whether only that person sees it. The sheet says the events are read-only, because
 * that's the part people are surprised by. [feed] null = subscribing to a new feed.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun IcsFeedEditorSheet(
    api: SettingsHouseholdApi,
    feed: SettingsHouseholdApi.Feed?,
    members: List<Person>,
    onSaved: () -> Unit,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf(feed?.url.orEmpty()) }
    var name by remember { mutableStateOf(feed?.name.orEmpty()) }
    var personId by remember { mutableStateOf(feed?.personId) }
    var personal by remember { mutableStateOf(feed?.visibility == "personal") }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var personMenu by remember { mutableStateOf(false) }
    val isNew = feed == null
    val canSave = url.isNotBlank() && !saving

    fun save() = scope.launch {
        saving = true; error = null
        try {
            if (feed != null) {
                api.updateIcsFeed(feed.id, IcsFeedForm.updateBody(url, name, personId, personal))
            } else {
                // Private is hidden while the feed belongs to nobody, so a stale tick can't ride along.
                api.createIcsFeed(
                    url = url.trim(),
                    name = name.trim().ifEmpty { null },
                    personId = personId,
                    visibility = if (IcsFeedForm.isPrivate(personal, personId)) "personal" else "family",
                )
            }
            onSaved()
            onDismiss()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The server validates the URL — relay it. The hint is only for when it said nothing.
            error = (e as? WaffledApiException)?.userMessage
                ?: "Couldn’t save that feed. Check the link is a full http(s) address to an .ics file."
        } finally {
            saving = false
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        SheetHeader(
            title = if (isNew) "Add calendar feed" else "Edit feed",
            leading = "Cancel" to onDismiss,
            trailing = (if (isNew) "Subscribe" else "Save") to { save() },
            trailingEnabled = canSave,
        )
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            WaffledTextField(
                value = url,
                onValueChange = { url = it },
                label = "Calendar link (ICS)",
                placeholder = "https://…/basic.ics",
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Uri,
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                ),
            )
            Caption("Paste the “secret address in iCal format” / “subscribe” link from the calendar you want to follow.")
            WaffledTextField(value = name, onValueChange = { name = it }, label = "Name (optional)", placeholder = "US Holidays")

            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Belongs to", style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink2)
                Box {
                    WaffledMenuPill(
                        members.firstOrNull { it.id == personId }?.name ?: "Nobody in particular",
                        Modifier.clip(RoundedCornerShape(WF.radius.pill)).clickable { personMenu = true },
                    )
                    OptionsMenu(
                        personMenu, { personMenu = false },
                        listOf("Nobody in particular" to { personId = null }) + members.map { m -> m.name to { personId = m.id } },
                    )
                }
            }

            if (IcsFeedForm.offersPrivate(personId)) {
                CheckToggle("Private (only the person it belongs to sees it)", personal, { personal = !personal })
            }

            LockNote("Events from a feed are read-only — Waffled can show them but can't change them.")

            error?.let {
                Text(it, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.danger)
            }
        }
    }
}

/** Cancel / title / confirm — the iOS sheet toolbar, drawn inline at the top of a sheet. */
@Composable
internal fun SheetHeader(
    title: String,
    leading: Pair<String, () -> Unit>?,
    trailing: Pair<String, () -> Unit>?,
    trailingEnabled: Boolean = true,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f)) {
            leading?.let { (label, action) ->
                Text(label, Modifier.clickable(onClick = action), style = TextStyle(fontSize = 16.sp), color = WF.colors.ink2)
            }
        }
        Text(
            title,
            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center),
            color = WF.colors.ink,
        )
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
            trailing?.let { (label, action) ->
                Text(
                    label,
                    Modifier.clickable(enabled = trailingEnabled, onClick = action),
                    style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold),
                    color = if (trailingEnabled) WF.colors.primary else WF.colors.ink3,
                )
            }
        }
    }
}
