package app.waffled.feature.photos

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.toMutableStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.Pill
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledFieldCard
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.network.MediaImageEncoder
import app.waffled.core.network.WaffledApiException
import coil3.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** How many photos the system picker will hand back at once. Matches iOS. */
private const val MAX_PICK = 10

/** One staged upload — the port of iOS `PhotoAddSheet.Row`. */
private class StagedPhoto(val uri: Uri) {
    var storageKey by mutableStateOf<String?>(null)
    var caption by mutableStateOf("")
    var album by mutableStateOf("")
    var isFavorite by mutableStateOf(false)
    var failure by mutableStateOf<String?>(null)
    val uploading: Boolean get() = storageKey == null && failure == null
    val ready: Boolean get() = storageKey != null
}

/**
 * The upload sheet — the port of iOS `PhotoAddSheet`.
 *
 * Pick up to [MAX_PICK] photos with the system photo picker (which, like iOS's PHPicker,
 * needs no runtime permission), each uploading to the blob store as it is picked. Give
 * each a caption / favourite / album, then "Add to wall" creates them. A shared
 * "album for all" seeds every row that has none.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PhotoAddSheet(
    albums: List<String>,
    api: PhotosApi,
    onDone: () -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    val rows: SnapshotStateList<StagedPhoto> = remember { mutableListOf<StagedPhoto>().toMutableStateList() }
    var sharedAlbum by remember { mutableStateOf("") }
    var creating by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }

    val picker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickMultipleVisualMedia(MAX_PICK),
    ) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        // Ingest straight off the picker callback rather than through a keyed
        // LaunchedEffect: clearing the key to mark a batch consumed would cancel the
        // very coroutine doing the uploading.
        scope.launch {
            for (uri in uris) {
                val staged = StagedPhoto(uri)
                rows.add(staged)
                val uploaded = withContext(Dispatchers.IO) {
                    runCatching {
                        val encoded = MediaImageEncoder.encode(context, uri)
                        api.uploadMedia(encoded.base64, encoded.contentType)
                    }
                }
                uploaded
                    .onSuccess {
                        staged.storageKey = it.key
                        if (sharedAlbum.isNotEmpty() && staged.album.isEmpty()) staged.album = sharedAlbum
                    }
                    .onFailure { staged.failure = it.uploadFailureText() }
            }
        }
    }

    val canAdd = rows.any { it.ready } && !creating

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
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onDismiss) {
                    Text("Cancel", style = WF.type.label, color = WF.colors.primary)
                }
                Spacer(Modifier.weight(1f))
                Text(
                    text = "Add photos",
                    style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink,
                )
                Spacer(Modifier.weight(1f))
                // Balances the Cancel button so the title stays centred.
                Spacer(Modifier.size(64.dp))
            }

            PickButton(
                label = if (rows.isEmpty()) "Choose photos" else "Add more",
                onClick = {
                    picker.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                    )
                },
            )

            if (rows.isNotEmpty()) {
                WaffledFieldCard(title = "Album for all (optional)") {
                    PhotoTextField(
                        value = sharedAlbum,
                        onValueChange = { next ->
                            sharedAlbum = next
                            // Seed only the rows that have no album of their own.
                            rows.forEach { if (it.album.isEmpty()) it.album = next }
                        },
                        placeholder = "e.g. Summer trip",
                        capitalization = KeyboardCapitalization.Words,
                    )
                    if (albums.isNotEmpty()) {
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            items(albums) { album ->
                                Pill(
                                    text = album,
                                    modifier = Modifier.clickable {
                                        sharedAlbum = album
                                        rows.forEach { if (it.album.isEmpty()) it.album = album }
                                    },
                                )
                            }
                        }
                    }
                }
            }

            rows.forEach { staged -> StagedRow(staged) }

            errorText?.let { message ->
                DismissibleErrorBanner(message = message, onDismiss = { errorText = null })
            }

            if (rows.isNotEmpty()) {
                WaffledPrimaryCTA(
                    label = if (creating) "Adding…" else "Add to wall",
                    onClick = {
                        scope.launch {
                            creating = true
                            val failures = createAll(api, rows)
                            creating = false
                            if (failures > 0) {
                                errorText =
                                    "${PhotosFormat.photoCount(failures)} couldn’t be added. Try again."
                                onDone() // still refresh — some may have landed
                            } else {
                                onDone()
                                onDismiss()
                            }
                        }
                    },
                    isBusy = creating,
                    isDisabled = !canAdd,
                )
            }
        }
    }
}

/** Create every ready row. Returns how many failed. */
private suspend fun createAll(api: PhotosApi, rows: List<StagedPhoto>): Int {
    var failures = 0
    for (staged in rows) {
        val key = staged.storageKey ?: continue
        val album = staged.album.trim()
        val body = buildJsonObject {
            put("storageKey", JsonPrimitive(key))
            put("caption", JsonPrimitive(staged.caption.trim()))
            put("isFavorite", JsonPrimitive(staged.isFavorite))
            // Explicit null, not an omitted key — see PhotosApi.update.
            put("memory", if (album.isEmpty()) JsonNull else JsonPrimitive(album))
        }
        if (runCatching { api.create(body) }.isFailure) failures++
    }
    return failures
}

private fun Throwable.uploadFailureText(): String = when (this) {
    is MediaImageEncoder.TooLargeException -> message ?: "That image is too large to upload."
    is WaffledApiException -> userMessage
    else -> "Couldn’t upload this photo."
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * The "Choose photos" tile. Hand-rolled rather than `WaffledPrimaryCTA`: this is a
 * secondary tinted action (primary-on-12%-primary, as on iOS), while the CTA is the
 * saturated single call-to-action already used by "Add to wall" at the bottom.
 */
@Composable
private fun PickButton(label: String, onClick: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(WF.colors.primary.copy(alpha = 0.12f), shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(vertical = 13.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Spacer(Modifier.weight(1f))
        Icon(
            imageVector = Icons.Filled.PhotoLibrary,
            contentDescription = null,
            tint = WF.colors.primary,
            modifier = Modifier.size(18.dp),
        )
        Text(
            text = label,
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.primary,
        )
        Spacer(Modifier.weight(1f))
    }
}

@Composable
private fun StagedRow(staged: StagedPhoto) {
    WaffledCard {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(
                modifier = Modifier
                    .size(72.dp)
                    .background(WF.colors.panel, RoundedCornerShape(12.dp))
                    .clip(RoundedCornerShape(12.dp)),
                contentAlignment = Alignment.Center,
            ) {
                AsyncImage(
                    model = staged.uri,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
                when {
                    staged.uploading -> CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        // The spinner sits over the thumbnail, so it belongs to the
                        // media pair, not the ink scale.
                        color = WF.colors.onMedia,
                        strokeWidth = 2.dp,
                    )
                    staged.failure != null -> Icon(
                        imageVector = Icons.Filled.Warning,
                        contentDescription = null,
                        tint = WF.colors.onMedia,
                        modifier = Modifier
                            .background(WF.colors.scrim, RoundedCornerShape(WF.radius.pill))
                            .size(22.dp),
                    )
                }
            }

            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                PhotoTextField(
                    value = staged.caption,
                    onValueChange = { staged.caption = it },
                    placeholder = "Caption",
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    PhotoTextField(
                        value = staged.album,
                        onValueChange = { staged.album = it },
                        placeholder = "Album",
                        modifier = Modifier.weight(1f),
                        capitalization = KeyboardCapitalization.Words,
                    )
                    Box(
                        modifier = Modifier
                            .size(44.dp)
                            .background(WF.colors.panel, RoundedCornerShape(12.dp))
                            .clip(RoundedCornerShape(12.dp))
                            .clickable { staged.isFavorite = !staged.isFavorite },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = if (staged.isFavorite) "❤️" else "🤍",
                            style = TextStyle(fontSize = 20.sp),
                        )
                    }
                }
                staged.failure?.let { message ->
                    Text(text = message, style = WF.type.caption, color = WF.colors.primaryD)
                }
            }
        }
    }
}
