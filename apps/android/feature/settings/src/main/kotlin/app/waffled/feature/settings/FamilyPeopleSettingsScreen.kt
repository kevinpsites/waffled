package app.waffled.feature.settings

import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledSettingsMenuLabel
import app.waffled.core.design.colorFromHex
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Calendar chip styles; anything but an explicit "tinted" is solid (iOS `EventStyle`). */
private val eventStyles = listOf("solid" to "Solid colors", "tinted" to "Tinted")
private const val DEFAULT_FAMILY_HEX = "#F97316"

private fun resolveEventStyle(raw: String?) = if (raw == "tinted") "tinted" else "solid"

/**
 * Settings → Family & People: members (add / edit / remove), the household basics,
 * calendar display, and the role → capability grid. Admin actions; the owner can't be
 * removed.
 */
@Composable
internal fun FamilyPeopleSettingsScreen(
    api: SettingsApi,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    var settings by remember { mutableStateOf<SettingsApi.HouseholdSettings?>(null) }
    var display by remember { mutableStateOf(SettingsApi.HouseholdModules(emptyMap(), true)) }
    var loading by remember { mutableStateOf(true) }
    var editor by remember { mutableStateOf<PersonEditorTarget?>(null) }
    var reload by remember { mutableStateOf(0) }

    LaunchedEffect(reload) {
        runCatching { api.householdSettings() }.getOrNull()?.let { settings = it }
        runCatching { api.household() }.getOrNull()?.let { display = it.modules() }
        loading = false
    }

    val permissions = remember { PermissionsMatrixModel(api::permissionsMatrix, api::setPermissionsMatrix) }

    SettingsPage("Family & People", onBack, modifier, spacing = 10.dp) {
        SectionLabel("Members", Modifier.padding(top = 4.dp))
        val s = settings
        when {
            s != null -> s.members.forEach { m -> MemberRow(m) { editor = PersonEditorTarget(m) } }
            loading -> WaffledLoading(Modifier.padding(bottom = 30.dp), top = 30.dp)
        }
        DashedAddButton("Add a person") { editor = PersonEditorTarget(null) }

        if (s != null) {
            HouseholdCard(
                household = s.household,
                eventStyle = resolveEventStyle(display.eventStyle),
                familyHex = display.familyColorHex?.takeIf { colorFromHex(it) != null } ?: DEFAULT_FAMILY_HEX,
                onCommit = { field, value ->
                    scope.launch {
                        runCatching { api.updateHousehold(field, value) }
                        reload++
                    }
                },
                onDisplay = { style, hex ->
                    scope.launch {
                        // The server validates the hex; a rejected save just re-reads the stored value.
                        runCatching { api.setHouseholdDisplay(eventStyle = style, familyColorHex = hex) }
                        reload++
                    }
                },
            )
        }

        PermissionsCard(permissions)
    }

    editor?.let { target ->
        PersonEditorSheet(
            api = api,
            editing = target.member,
            onDone = { reload++ },
            onDismiss = { editor = null },
        )
    }
}

private class PersonEditorTarget(val member: SettingsApi.Member?)

@Composable
private fun MemberRow(m: SettingsApi.Member, onEdit: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().settingsBox().clickable(onClick = onEdit).padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AvatarFromHex(m.colorHex, m.avatarEmoji ?: "🙂", size = 44.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(m.name, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
            Text(PeopleRules.roleLine(m), style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink3)
        }
        if (m.hasLogin) Glyph(Icons.Filled.Key, "Can sign in")
        if (m.hasPin) Glyph(Icons.Filled.Lock, "Has a kiosk PIN")
        Icon(Icons.Filled.Edit, contentDescription = "Edit", tint = WF.colors.ink3, modifier = Modifier.size(15.dp))
    }
}

@Composable
private fun Glyph(icon: ImageVector, description: String) {
    Box(Modifier.size(22.dp).background(WF.colors.panel, CircleShape), contentAlignment = Alignment.Center) {
        Icon(icon, contentDescription = description, tint = WF.colors.ink3, modifier = Modifier.size(12.dp))
    }
}

@Composable
private fun HouseholdCard(
    household: SettingsApi.Household,
    eventStyle: String,
    familyHex: String,
    onCommit: (field: String, value: String) -> Unit,
    onDisplay: (style: String?, hex: String?) -> Unit,
) {
    var name by remember(household.name) { mutableStateOf(household.name) }
    var location by remember(household.location) { mutableStateOf(household.location.orEmpty()) }
    var pendingHex by remember(familyHex) { mutableStateOf(familyHex) }
    var familySave by remember { mutableStateOf<Job?>(null) }
    val scope = rememberCoroutineScope()

    SectionLabel("Household", Modifier.padding(top = 12.dp, bottom = 0.dp))
    Column(Modifier.fillMaxWidth().settingsBox().padding(horizontal = 14.dp)) {
        FieldRow("🏡", "Name") {
            InlineField(name, { name = it }, "Household", bold = true) { onCommit("name", name.trim()) }
        }
        HairDivider()
        FieldRow("🗓️", "Week starts") {
            MenuValue(household.weekStart.capitalized(), listOf("sunday" to "Sunday", "monday" to "Monday")) {
                onCommit("weekStart", it)
            }
        }
        HairDivider()
        FieldRow("🌐", "Time zone") {
            MenuValue(TimeZoneChoices.label(household.timezone), TimeZoneChoices.options(household.timezone)) {
                onCommit("timezone", it)
            }
        }
        HairDivider()
        FieldRow("📍", "Location") {
            InlineField(location, { location = it }, "City, State", bold = false) { onCommit("location", location.trim()) }
        }
        HairDivider()
        FieldRow("🎨", "Event style") {
            MenuValue(eventStyles.first { it.first == eventStyle }.second, eventStyles) { onDisplay(it, null) }
        }
        HairDivider()
        Column(Modifier.padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("👨‍👩‍👧‍👦", style = TextStyle(fontSize = 16.sp))
                Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text("Family color", style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
                    Text("Events with the whole family use this color", style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
                }
            }
            // Debounced: rapid taps across swatches would otherwise fire one PATCH each.
            ColorSwatchPicker(pendingHex, size = 26.dp, onPick = { hex ->
                pendingHex = hex
                familySave?.cancel()
                familySave = scope.launch {
                    delay(300)
                    onDisplay(null, hex)
                }
            })
        }
    }
}

@Composable
private fun FieldRow(emoji: String, label: String, control: @Composable () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(emoji, style = TextStyle(fontSize = 16.sp))
        Text(label, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
        Spacer(Modifier.width(12.dp).weight(1f))
        control()
    }
}

/**
 * A borderless, trailing-aligned text field committed on Done — iOS's inline
 * `TextField` in a settings row. `WaffledTextField` draws a boxed field, which is wrong
 * inside a row that is already a box.
 */
@Composable
private fun InlineField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    bold: Boolean,
    onCommit: () -> Unit,
) {
    val style = TextStyle(
        fontSize = 15.sp,
        fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal,
        color = WF.colors.ink,
        textAlign = TextAlign.End,
    )
    BasicTextField(
        value = value,
        onValueChange = onChange,
        singleLine = true,
        textStyle = style,
        cursorBrush = SolidColor(WF.colors.primary),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { onCommit() }),
        modifier = Modifier.width(180.dp),
        decorationBox = { inner ->
            Box(contentAlignment = Alignment.CenterEnd) {
                if (value.isEmpty()) Text(placeholder, style = style.copy(color = WF.colors.ink3))
                inner()
            }
        },
    )
}

/** A Settings dropdown: the shared menu label opening a Material dropdown of choices. */
@Composable
internal fun MenuValue(current: String, options: List<Pair<String, String>>, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        WaffledSettingsMenuLabel(current, Modifier.clickable { open = true })
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = WF.colors.card) {
            options.forEach { (value, label) ->
                DropdownMenuItem(
                    text = { Text(label, color = WF.colors.ink) },
                    onClick = {
                        open = false
                        onPick(value)
                    },
                )
            }
        }
    }
}

/**
 * Role → capability grid (admin-only). A non-admin's 403 on load removes the card, so it
 * needs no separate admin check. Admins always hold everything, so they aren't listed.
 */
@Composable
private fun PermissionsCard(model: PermissionsMatrixModel) {
    val state by model.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    LaunchedEffect(model) { model.load() }
    if (state.hidden) return

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionLabel("Permissions", Modifier.padding(top = 14.dp))
        BodyNote(
            "Choose what each role can do. Admins can always do everything, and everyone can always finish their own chores and redeem their own rewards.",
            12.5f, WF.colors.ink3,
        )
        val matrix = state.matrix
        if (matrix == null) {
            WaffledLoading(Modifier.padding(bottom = 12.dp), top = 12.dp)
        } else {
            PermissionsGrid.roles.forEach { role ->
                val row = matrix[role].orEmpty()
                Column(Modifier.fillMaxWidth().settingsBox().padding(horizontal = 14.dp).padding(bottom = 6.dp)) {
                    Text(
                        PermissionsGrid.roleLabel(role),
                        modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
                        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.ink,
                    )
                    PermissionsGrid.capabilities.forEachIndexed { i, cap ->
                        if (i > 0) HairDivider()
                        Box(Modifier.padding(vertical = 9.dp)) {
                            LabeledSwitch(
                                title = PermissionsGrid.capabilityLabel(cap),
                                subtitle = PermissionsGrid.capabilitySubtitle(cap),
                                checked = row[cap] ?: false,
                                onCheckedChange = { scope.launch { model.toggle(role, cap) } },
                                enabled = !state.saving,
                                titleSize = 14f,
                            )
                        }
                    }
                }
            }
        }
    }
}
