package app.waffled.feature.photos

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.Pill
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledFieldCard
import app.waffled.core.design.WaffledImages
import app.waffled.core.design.colorFromHex
import app.waffled.core.design.wfField
import app.waffled.core.model.WaffledDates
import app.waffled.core.network.WaffledApiException
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * A photo's detail sheet — the port of iOS `PhotoDetailView`.
 *
 * The large image (or emoji tile), caption, album, "added by", date, a favourite toggle
 * (PATCH `isFavorite`) and Delete behind a confirm. An inline Edit mode PATCHes caption,
 * album and date.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PhotoDetailSheet(
    row: PhotoRow,
    albumCount: Int,
    albums: List<String>,
    api: PhotosApi,
    onChanged: () -> Unit,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val zone = remember { ZoneId.systemDefault() }

    var isFavorite by remember(row.id) { mutableStateOf(row.isFavorite) }
    var caption by remember(row.id) { mutableStateOf(row.caption) }
    var album by remember(row.id) { mutableStateOf(row.memory.orEmpty()) }
    var day by remember(row.id) {
        mutableStateOf(PhotosFormat.editableDay(row.photo.takenAt, row.photo.createdAt, zone))
    }
    var editing by remember(row.id) { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    var showDatePicker by remember { mutableStateOf(false) }

    fun resetEdits() {
        caption = row.caption
        album = row.memory.orEmpty()
        day = PhotosFormat.editableDay(row.photo.takenAt, row.photo.createdAt, zone)
        errorText = null
    }

    suspend fun save() {
        if (saving) return
        saving = true
        try {
            val trimmedAlbum = album.trim()
            val body = buildJsonObject {
                put("caption", JsonPrimitive(caption.trim()))
                // An empty album CLEARS it — null, not "". They aren't the same thing.
                put("memory", if (trimmedAlbum.isEmpty()) JsonNull else JsonPrimitive(trimmedAlbum))
                put("isFavorite", JsonPrimitive(isFavorite))
                // Noon in the device zone so the day never shifts when it round-trips
                // through the display formatter.
                day?.let { d -> WaffledDates.noonIso(d, zone)?.let { put("takenAt", JsonPrimitive(it)) } }
            }
            runCatching { api.update(row.id, body) }
                .onSuccess {
                    onChanged()
                    // Back to read mode rather than dismissing, so the saved caption /
                    // album / date is visible right here — otherwise it looks lost.
                    editing = false
                    errorText = null
                }
                .onFailure { errorText = it.userFacing() }
        } finally {
            saving = false
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(16.dp)
                .padding(bottom = 40.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            SheetHeader(
                title = "Photo",
                onClose = onDismiss,
                trailing = {
                    if (editing) {
                        TextButton(onClick = { scope.launch { save() } }, enabled = !saving) {
                            Text(if (saving) "Saving…" else "Save", style = WF.type.label, color = WF.colors.primary)
                        }
                    } else {
                        DetailMenu(
                            onEdit = { resetEdits(); editing = true },
                            onDelete = { confirmDelete = true },
                        )
                    }
                },
            )

            // Read mode reads the LOCAL edit state, not the row we opened with — the row
            // in `PhotosScreen` is captured on open and never updates, so a just-saved
            // date would otherwise still show the old day.
            val dayLabel = day?.let { d ->
                PhotosFormat.dateLabel("${d}T12:00:00Z", null, ZoneOffset.UTC)
            } ?: row.dateLabel ?: "—"

            // In edit mode the fields lead and the photo shrinks to a preview, so it's
            // obvious what you're editing without scrolling past a full image.
            if (editing) {
                EditCard(
                    caption = caption,
                    onCaption = { caption = it },
                    album = album,
                    onAlbum = { album = it },
                    albums = albums,
                    dayLabel = dayLabel,
                    onPickDate = { showDatePicker = true },
                    saving = saving,
                    onCancel = { resetEdits(); editing = false },
                    onSave = { scope.launch { save() } },
                )
                Stage(row = row, modifier = Modifier.heightIn(max = 220.dp))
            } else {
                Stage(row = row)
                DetailsCard(
                    caption = caption,
                    album = album.trim(),
                    albumCount = albumCount,
                    dateLabel = dayLabel,
                    uploadedBy = row.photo.uploadedBy,
                    isFavorite = isFavorite,
                    busy = busy,
                    onToggleFavorite = {
                        scope.launch {
                            busy = true
                            val next = !isFavorite
                            runCatching {
                                api.update(row.id, buildJsonObject { put("isFavorite", JsonPrimitive(next)) })
                            }
                                .onSuccess { isFavorite = next; onChanged() }
                                .onFailure { errorText = "Couldn’t update favorite." }
                            busy = false
                        }
                    },
                )
            }

            errorText?.let { message ->
                DismissibleErrorBanner(message = message, onDismiss = { errorText = null })
            }
        }
    }

    if (showDatePicker) {
        val initial = day?.let { java.time.LocalDate.parse(it) }
            ?.atStartOfDay(ZoneOffset.UTC)?.toInstant()?.toEpochMilli()
        val pickerState = rememberDatePickerState(initialSelectedDateMillis = initial)
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    pickerState.selectedDateMillis?.let { millis ->
                        // The picker works in UTC-midnight millis; read it back as a plain
                        // calendar day so no timezone shift can move it.
                        day = Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate().toString()
                    }
                    showDatePicker = false
                }) { Text("OK") }
            },
            dismissButton = { TextButton(onClick = { showDatePicker = false }) { Text("Cancel") } },
        ) {
            DatePicker(state = pickerState)
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete photo?") },
            text = { Text("This can’t be undone.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    scope.launch {
                        runCatching { api.delete(row.id) }
                            .onSuccess { onChanged(); onDismiss() }
                            .onFailure { errorText = "Couldn’t delete photo." }
                    }
                }) { Text("Delete", color = WF.colors.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
            containerColor = WF.colors.card,
            titleContentColor = WF.colors.ink,
            textContentColor = WF.colors.ink2,
        )
    }
}

/**
 * `WaffledApiException.userMessage` is already the server's own explanation (built by
 * `ApiErrorText`), so relay it. iOS digs the JSON out again at the call site; the shared
 * network layer already did that here.
 */
private fun Throwable.userFacing(): String = when (this) {
    is WaffledApiException -> "Couldn’t save (error $status). $userMessage"
    else -> "Couldn’t reach the server — check your connection and try again."
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * The sheet's title row.
 *
 * Hand-rolled rather than a `TopAppBar`: inside a `ModalBottomSheet` an app bar brings
 * its own window insets and elevation overlay, which fight the sheet's drag handle. This
 * is the iOS "Close / title / action" navigation bar in three tokens.
 */
@Composable
private fun SheetHeader(
    title: String,
    onClose: () -> Unit,
    trailing: @Composable () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onClose) {
            Text("Close", style = WF.type.label, color = WF.colors.primary)
        }
        Spacer(Modifier.weight(1f))
        Text(
            text = title,
            style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.ink,
        )
        Spacer(Modifier.weight(1f))
        trailing()
    }
}

@Composable
private fun DetailMenu(onEdit: () -> Unit, onDelete: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { open = true }) {
            Text("•••", style = WF.type.label, color = WF.colors.primary)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text("Edit", color = WF.colors.ink) },
                leadingIcon = { Icon(Icons.Filled.Edit, contentDescription = null, tint = WF.colors.ink2) },
                onClick = { open = false; onEdit() },
            )
            DropdownMenuItem(
                text = { Text("Delete", color = WF.colors.danger) },
                leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null, tint = WF.colors.danger) },
                onClick = { open = false; onDelete() },
            )
        }
    }
}

/** The big photo, or the emoji-on-gradient stage when there is no stored image. */
@Composable
private fun Stage(row: PhotoRow, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(WF.radius.lg)
    // Real per-photo `color_hex` — one of the two documented literal-colour exceptions.
    val tint = colorFromHex(row.colorHex) ?: WF.colors.panel
    Box(
        modifier = modifier
            .fillMaxWidth()
            .background(tint, shape)
            .clip(shape),
        contentAlignment = Alignment.Center,
    ) {
        if (row.resolvedImageUrl != null) {
            AsyncImage(
                model = WaffledImages.request(LocalContext.current, row.resolvedImageUrl, row.imageCacheKey),
                contentDescription = row.caption.ifEmpty { "Photo" },
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxWidth(),
            )
        } else {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(280.dp)
                    .background(Brush.linearGradient(listOf(tint, tint.copy(alpha = 0.7f)))),
                contentAlignment = Alignment.Center,
            ) {
                Text(text = row.emoji ?: "🏖️", style = TextStyle(fontSize = 92.sp))
            }
        }
    }
}

@Composable
private fun DetailsCard(
    caption: String,
    album: String,
    albumCount: Int,
    dateLabel: String,
    uploadedBy: PhotosApi.PhotoPerson?,
    isFavorite: Boolean,
    busy: Boolean,
    onToggleFavorite: () -> Unit,
) {
    WaffledCard {
        Column {
            // Read mode reflects the locally-saved values, so a just-saved edit shows
            // immediately rather than the stale row we opened with.
            if (caption.isNotEmpty()) {
                Text(
                    text = caption,
                    modifier = Modifier.padding(bottom = 12.dp),
                    style = WF.type.serif(22.sp, FontWeight.SemiBold),
                    color = WF.colors.ink,
                )
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(enabled = !busy, onClick = onToggleFavorite)
                    .padding(vertical = 11.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Favorite", style = WF.type.body.copy(fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
                Spacer(Modifier.weight(1f))
                if (busy) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(14.dp),
                        color = WF.colors.ink3,
                        strokeWidth = 2.dp,
                    )
                    Spacer(Modifier.size(8.dp))
                }
                Text(text = if (isFavorite) "❤️" else "🤍", style = TextStyle(fontSize = 20.sp))
            }

            Hairline()
            InfoRow("Album", album.ifEmpty { "—" })
            Hairline()
            AddedByRow(uploadedBy)
            Hairline()
            InfoRow("Date", dateLabel)

            if (album.isNotEmpty() && albumCount > 1) {
                Hairline()
                Text(
                    text = PhotosFormat.albumLine(album, albumCount),
                    modifier = Modifier.padding(top = 11.dp),
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
            }
        }
    }
}

@Composable
private fun Hairline() {
    HorizontalDivider(thickness = 1.dp, color = WF.colors.hair)
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = WF.type.body.copy(fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
        Spacer(Modifier.weight(1f))
        Text(
            text = value,
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink2,
            textAlign = TextAlign.End,
        )
    }
}

@Composable
private fun AddedByRow(person: PhotosApi.PhotoPerson?) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Added by", style = WF.type.body.copy(fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
        Spacer(Modifier.weight(1f))
        if (person != null) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AvatarFromHex(
                    colorHex = person.colorHex,
                    emoji = person.avatarEmoji ?: "🙂",
                    size = 26.dp,
                )
                Text(
                    text = person.name ?: "—",
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink2,
                )
            }
        } else {
            Text("—", style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink2)
        }
    }
}

@Composable
private fun EditCard(
    caption: String,
    onCaption: (String) -> Unit,
    album: String,
    onAlbum: (String) -> Unit,
    albums: List<String>,
    dayLabel: String,
    onPickDate: () -> Unit,
    saving: Boolean,
    onCancel: () -> Unit,
    onSave: () -> Unit,
) {
    WaffledFieldCard(title = "Edit photo") {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            FieldGroup("CAPTION") {
                PhotoTextField(value = caption, onValueChange = onCaption, placeholder = "Add a caption")
            }
            FieldGroup("ALBUM") {
                PhotoTextField(
                    value = album,
                    onValueChange = onAlbum,
                    placeholder = "Album (optional)",
                    capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Words,
                )
                if (albums.isNotEmpty()) {
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(albums) { a ->
                            Pill(text = a, modifier = Modifier.clickable { onAlbum(a) })
                        }
                    }
                }
            }
            FieldGroup("DATE") {
                Text(
                    text = dayLabel,
                    modifier = Modifier
                        .fillMaxWidth()
                        .wfField(fill = WF.colors.panel)
                        .clickable(onClick = onPickDate)
                        .padding(horizontal = 13.dp, vertical = 12.dp),
                    style = WF.type.body,
                    color = WF.colors.ink,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SheetButton(
                    label = "Cancel",
                    fill = WF.colors.panel,
                    content = WF.colors.ink2,
                    enabled = !saving,
                    onClick = onCancel,
                    modifier = Modifier.weight(1f),
                )
                SheetButton(
                    label = if (saving) "Saving…" else "Save changes",
                    fill = WF.colors.primary,
                    // A saturated coloured fill — the one case a literal white is right.
                    content = androidx.compose.ui.graphics.Color.White,
                    enabled = !saving,
                    onClick = onSave,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/**
 * A small-caps label sitting directly above its field, so each label reads as belonging
 * to the field beneath it rather than floating between two.
 */
@Composable
private fun FieldGroup(label: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Text(
            text = label,
            style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Black, letterSpacing = 0.5.sp),
            color = WF.colors.ink3,
        )
        content()
    }
}

/**
 * A capsule button pair inside a card. Not `WaffledPrimaryCTA`: that is the full-width
 * single call-to-action, and this is a side-by-side Cancel/Save pair at card width.
 */
@Composable
private fun SheetButton(
    label: String,
    fill: androidx.compose.ui.graphics.Color,
    content: androidx.compose.ui.graphics.Color,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Box(
        modifier = modifier
            .background(fill, shape)
            .clip(shape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 11.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = label, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold), color = content)
    }
}
