package app.waffled.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.SegmentedRow
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledTextField
import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

private val birthdayFormat: DateTimeFormatter = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)

/**
 * Add or edit a member (admins). Editing splits into General (profile) and Sign-in
 * (login + kiosk PIN); a new person sees only General, since login and PIN need an id.
 */
@Composable
internal fun PersonEditorSheet(
    api: SettingsApi,
    editing: SettingsApi.Member?,
    onDone: () -> Unit,
    onDismiss: () -> Unit,
) {
    var tab by remember { mutableStateOf(0) }
    SettingsSheet(title = if (editing == null) "New person" else "Edit ${editing.name}", onDismiss = onDismiss) {
        if (editing != null) SegmentedRow(listOf("General", "Sign-in"), tab, { tab = it })
        if (editing == null || tab == 0) GeneralForm(api, editing, onDone, onDismiss)
        else SignInForm(api, editing, onDone)
    }
}

@Composable
private fun GeneralForm(
    api: SettingsApi,
    editing: SettingsApi.Member?,
    onDone: () -> Unit,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf(editing?.name.orEmpty()) }
    var emoji by remember { mutableStateOf(editing?.avatarEmoji ?: "🙂") }
    var memberType by remember { mutableStateOf(editing?.memberType ?: "kid") }
    var colorHex by remember { mutableStateOf(editing?.colorHex ?: WaffledSwatch.all[0]) }
    var birthday by remember { mutableStateOf(PeopleRules.birthday(editing?.birthday)) }
    var pickingBirthday by remember { mutableStateOf(false) }
    var isAdmin by remember { mutableStateOf(editing?.isAdmin ?: false) }
    var showOnKiosk by remember { mutableStateOf(editing?.showOnKiosk ?: true) }
    var busy by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
        EmojiBox(emoji) { emoji = PeopleRules.capEmoji(it) }
        WaffledTextField(name, { name = it }, Modifier.weight(1f), placeholder = "Name")
    }

    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        SectionLabel("Type")
        val types = PeopleRules.memberTypes
        SegmentedRow(types.map { it.capitalized() }, types.indexOf(memberType).coerceAtLeast(0), { memberType = types[it] })
    }

    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        SectionLabel("Color")
        ColorSwatchPicker(colorHex, { colorHex = it })
    }

    LabeledSwitch("Birthday", null, birthday != null, { on -> birthday = if (on) (birthday ?: LocalDate.now()) else null })
    birthday?.let { day ->
        Text(
            day.format(birthdayFormat),
            modifier = Modifier
                .background(WF.colors.panel, RoundedCornerShape(WF.radius.sm))
                .clickable { pickingBirthday = true }
                .padding(horizontal = 12.dp, vertical = 8.dp),
            style = TextStyle(fontSize = 15.sp),
            color = WF.colors.ink,
        )
    }

    LabeledSwitch("Admin", "Can add people & change settings", isAdmin, { isAdmin = it })
    LabeledSwitch("Show on kiosk", "Appears on the family display", showOnKiosk, { showOnKiosk = it })

    error?.let { FormMessage(it, WF.colors.primary, 13f) }

    WaffledPrimaryCTA(
        label = if (busy) "Saving…" else if (editing == null) "Add person" else "Save",
        onClick = {
            busy = true
            error = null
            scope.launch {
                val draft = SettingsApi.PersonDraft(
                    name = name.trim(),
                    memberType = memberType,
                    colorHex = colorHex,
                    isAdmin = isAdmin,
                    showOnKiosk = showOnKiosk,
                    avatarEmoji = emoji.ifEmpty { null },
                    birthday = birthday?.toString(),
                )
                val ok = runCatching { api.savePerson(editing?.id, draft) }.isSuccess
                busy = false
                if (ok) { onDone(); onDismiss() } else error = "Couldn’t save. Admins only."
            }
        },
        isDisabled = name.isBlank(),
        isBusy = busy,
    )

    when {
        editing != null && !editing.isOwner -> ConfirmTextButton(
            "Remove person", "Tap again to remove", confirmDelete, { confirmDelete = true }, {
                busy = true
                error = null
                scope.launch {
                    val ok = runCatching { api.deletePerson(editing.id) }.isSuccess
                    busy = false
                    if (ok) { onDone(); onDismiss() } else error = "Couldn’t remove this person."
                }
            },
        )
        editing?.isOwner == true -> Text(
            "The household owner can’t be removed.",
            modifier = Modifier.fillMaxWidth(),
            style = TextStyle(fontSize = 12.sp, textAlign = TextAlign.Center),
            color = WF.colors.ink3,
        )
    }

    if (pickingBirthday) {
        BirthdayPicker(birthday ?: LocalDate.now(), onDismiss = { pickingBirthday = false }) {
            birthday = it
            pickingBirthday = false
        }
    }
}

@Composable
private fun SignInForm(api: SettingsApi, editing: SettingsApi.Member, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf(editing.loginEmail.orEmpty()) }
    var password by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    var hasLogin by remember { mutableStateOf(editing.hasLogin) }
    var hasPassword by remember { mutableStateOf(editing.hasPassword) }
    var hasPin by remember { mutableStateOf(editing.hasPin) }
    var loginBusy by remember { mutableStateOf(false) }
    var loginError by remember { mutableStateOf<String?>(null) }
    var loginNote by remember { mutableStateOf<String?>(null) }
    var confirmRemoveLogin by remember { mutableStateOf(false) }
    var pinBusy by remember { mutableStateOf(false) }
    var pinError by remember { mutableStateOf<String?>(null) }
    var pinNote by remember { mutableStateOf<String?>(null) }
    var confirmRemovePin by remember { mutableStateOf(false) }

    WaffledCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionLabel("🔑  Login")
            BodyNote(PeopleRules.loginStatus(hasLogin, hasPassword), 12.5f, WF.colors.ink3)
            WaffledTextField(
                email, { email = it }, placeholder = "Email",
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false),
            )
            WaffledTextField(
                password, { password = it },
                placeholder = if (hasPassword) "New password (leave blank to keep)" else "Password (optional — blank invites SSO)",
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                visualTransformation = PasswordVisualTransformation(),
            )
            loginError?.let { FormMessage(it, WF.colors.primary) } ?: loginNote?.let { FormMessage(it, WF.colors.success) }
            WaffledPrimaryCTA(
                label = if (loginBusy) "Saving…" else if (hasLogin) "Update login" else "Give a login",
                onClick = {
                    loginBusy = true; loginError = null; loginNote = null
                    scope.launch {
                        try {
                            api.setPersonLogin(editing.id, email.trim(), password.ifEmpty { null })
                            hasLogin = true
                            if (password.isNotEmpty()) hasPassword = true
                            password = ""
                            loginNote = "Saved."
                            onDone()
                        } catch (e: WaffledApiException) {
                            loginError = PeopleRules.saveLoginError(e.status)
                        } catch (e: kotlinx.coroutines.CancellationException) {
                            throw e
                        } catch (_: Exception) {
                            loginError = "Couldn’t reach the server."
                        }
                        loginBusy = false
                    }
                },
                isDisabled = !PeopleRules.canSaveLogin(email),
                isBusy = loginBusy,
            )
            if (hasLogin && !editing.isOwner) {
                ConfirmTextButton("Remove login", "Tap again to remove login", confirmRemoveLogin, { confirmRemoveLogin = true }, {
                    loginBusy = true; loginError = null; loginNote = null
                    scope.launch {
                        try {
                            api.removePersonLogin(editing.id)
                            hasLogin = false; hasPassword = false; email = ""; confirmRemoveLogin = false
                            loginNote = "Login removed."
                            onDone()
                        } catch (e: WaffledApiException) {
                            loginError = PeopleRules.removeLoginError(e.status)
                        } catch (e: kotlinx.coroutines.CancellationException) {
                            throw e
                        } catch (_: Exception) {
                            loginError = "Couldn’t reach the server."
                        }
                        loginBusy = false
                    }
                }, size = 13.5f)
            }
        }
    }

    WaffledCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionLabel("🔒  Kiosk PIN")
            BodyNote(
                if (hasPin) "Set — required to open this profile on the kiosk."
                else "Optional — set one to protect this profile on a shared kiosk.",
                12.5f, WF.colors.ink3,
            )
            WaffledTextField(
                pin, { pin = PeopleRules.sanitizePin(it) }, placeholder = "4–8 digits",
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                visualTransformation = PasswordVisualTransformation(),
            )
            pinError?.let { FormMessage(it, WF.colors.primary) } ?: pinNote?.let { FormMessage(it, WF.colors.success) }
            WaffledPrimaryCTA(
                label = if (pinBusy) "Saving…" else if (hasPin) "Update PIN" else "Set PIN",
                onClick = {
                    pinBusy = true; pinError = null; pinNote = null
                    scope.launch {
                        try {
                            api.setPersonPin(editing.id, pin)
                            hasPin = true; pin = ""; confirmRemovePin = false
                            pinNote = "PIN saved."
                            onDone()
                        } catch (e: WaffledApiException) {
                            pinError = PeopleRules.savePinError(e.status)
                        } catch (e: kotlinx.coroutines.CancellationException) {
                            throw e
                        } catch (_: Exception) {
                            pinError = "Couldn’t reach the server."
                        }
                        pinBusy = false
                    }
                },
                isDisabled = !PeopleRules.isValidPin(pin),
                isBusy = pinBusy,
            )
            if (hasPin) {
                ConfirmTextButton("Remove PIN", "Tap again to remove PIN", confirmRemovePin, { confirmRemovePin = true }, {
                    pinBusy = true; pinError = null; pinNote = null
                    scope.launch {
                        runCatching { api.clearPersonPin(editing.id) }
                            .onSuccess {
                                hasPin = false; pin = ""; confirmRemovePin = false
                                pinNote = "PIN removed."
                                onDone()
                            }
                            .onFailure { pinError = "Couldn’t remove the PIN." }
                        pinBusy = false
                    }
                }, size = 13.5f)
            }
        }
    }
}

/** The 64pt emoji well beside the name field (iOS caps it at three characters). */
@Composable
internal fun EmojiBox(value: String, onChange: (String) -> Unit) {
    Box(
        Modifier.size(64.dp).background(WF.colors.panel, RoundedCornerShape(16.dp)),
        contentAlignment = Alignment.Center,
    ) {
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            textStyle = TextStyle(fontSize = 30.sp, textAlign = TextAlign.Center, color = WF.colors.ink),
            cursorBrush = SolidColor(WF.colors.primary),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/**
 * Material3's date dialog, converting through UTC so the chosen day never shifts by one
 * west of Greenwich. Same wrapper as Calendar's and Pantry's — features can't share it
 * and `core:design` is frozen, so it's a `core:design` candidate.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BirthdayPicker(initial: LocalDate, onDismiss: () -> Unit, onPick: (LocalDate) -> Unit) {
    val state = rememberDatePickerState(initialSelectedDateMillis = initial.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = {
                state.selectedDateMillis?.let { onPick(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) } ?: onDismiss()
            }) { Text("OK") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    ) {
        DatePicker(state = state)
    }
}
