package app.waffled.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledImages
import app.waffled.core.model.WaffledDates
import app.waffled.core.network.MediaUrl
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val proofDate: DateTimeFormatter = DateTimeFormatter.ofPattern("MMM d")

/** "Avery · Jul 25" — precomputed per proof, never in the grid's render path. */
private fun caption(p: SettingsApi.StoredProof): String {
    val day = p.completedAt?.let { WaffledDates.parseInstant(it) }?.atZone(ZoneId.systemDefault())?.format(proofDate)
    return listOfNotNull(p.personName, day).joinToString(" · ")
}

/**
 * The admin's stored chore-photo manager: a grid of retained proofs — tap to view one
 * big, delete one, or clear them all. Failed deletes leave the rows in place.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun StoredProofsSheet(
    api: SettingsApi,
    proofs: List<SettingsApi.StoredProof>,
    baseUrl: String,
    onChanged: suspend () -> Unit,
    onDismiss: () -> Unit,
) {
    val model = remember { StoredProofsModel(proofs, api::deleteProof, api::clearProofs, onChanged) }
    val state by model.state.collectAsStateWithLifecycle()
    val captions = remember(state.proofs) { state.proofs.associate { it.instanceId to caption(it) } }
    val scope = rememberCoroutineScope()
    var enlarged by remember { mutableStateOf<SettingsApi.StoredProof?>(null) }
    var confirmClear by remember { mutableStateOf(false) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Box(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp), contentAlignment = Alignment.Center) {
            Text("Close", Modifier.align(Alignment.CenterStart).clickable(onClick = onDismiss), style = TextStyle(fontSize = 16.sp), color = WF.colors.primary)
            Text("Stored photos", style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
            if (state.proofs.isNotEmpty()) {
                Text(
                    "Clear all",
                    Modifier.align(Alignment.CenterEnd).clickable(enabled = !state.busy) { confirmClear = true },
                    style = TextStyle(fontSize = 16.sp),
                    color = WF.colors.primary,
                )
            }
        }
        if (state.proofs.isEmpty()) {
            WaffledEmptyState("🗂️", "No stored photos", message = "Chore proof photos appear here while they’re kept.", top = 48.dp)
            Box(Modifier.height(WF.spacing.tabBarClearance))
        } else {
            LazyVerticalGrid(
                columns = GridCells.Adaptive(150.dp),
                modifier = Modifier.heightIn(max = 2000.dp),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp, 16.dp, 16.dp, WF.spacing.tabBarClearance),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(state.proofs, key = { it.instanceId }) { p ->
                    ProofCell(p, captions[p.instanceId].orEmpty(), baseUrl, busy = state.busy, onOpen = { enlarged = p }) {
                        scope.launch { model.delete(p) }
                    }
                }
            }
        }
    }

    enlarged?.let { p ->
        AlertDialog(
            onDismissRequest = { enlarged = null },
            containerColor = WF.colors.canvas,
            title = { Text("${p.emoji ?: "🧹"} ${p.choreTitle}", color = WF.colors.ink, textAlign = TextAlign.Center) },
            text = {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    ProofImage(p, baseUrl, ContentScale.Fit, Modifier.fillMaxWidth().clip(RoundedCornerShape(WF.radius.md)))
                    Text(captions[p.instanceId].orEmpty(), style = TextStyle(fontSize = 13.sp), color = WF.colors.ink3)
                }
            },
            confirmButton = {
                TextButton(enabled = !state.busy, onClick = {
                    scope.launch { if (model.delete(p)) enlarged = null }
                }) { Text("Delete this photo", color = WF.colors.primary, fontWeight = FontWeight.Bold) }
            },
            dismissButton = { TextButton(onClick = { enlarged = null }) { Text("Close", color = WF.colors.ink2) } },
        )
    }

    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            containerColor = WF.colors.card,
            title = { Text("Delete all ${state.proofs.size} stored photos?", color = WF.colors.ink) },
            confirmButton = {
                TextButton(onClick = {
                    confirmClear = false
                    scope.launch { model.clearAll() }
                }) { Text("Delete all", color = WF.colors.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("Cancel", color = WF.colors.ink2) } },
        )
    }

    state.errorMessage?.let { msg ->
        AlertDialog(
            onDismissRequest = model::dismissError,
            containerColor = WF.colors.card,
            title = { Text("Photos unchanged", color = WF.colors.ink) },
            text = { Text(msg, color = WF.colors.ink2) },
            confirmButton = { TextButton(onClick = model::dismissError) { Text("OK", color = WF.colors.primary) } },
        )
    }
}

@Composable
private fun ProofCell(
    p: SettingsApi.StoredProof,
    caption: String,
    baseUrl: String,
    busy: Boolean,
    onOpen: () -> Unit,
    onDelete: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().settingsBox()) {
        ProofImage(p, baseUrl, ContentScale.Crop, Modifier.fillMaxWidth().height(128.dp).clickable(onClick = onOpen))
        Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    "${p.emoji ?: "🧹"} ${p.choreTitle}",
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink,
                )
                Text(caption, maxLines = 1, overflow = TextOverflow.Ellipsis, style = TextStyle(fontSize = 11.5.sp), color = WF.colors.ink3)
            }
            Box(Modifier.size(30.dp).clickable(enabled = !busy, onClick = onDelete), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.Delete, contentDescription = "Delete photo", tint = WF.colors.primary, modifier = Modifier.size(16.dp))
            }
        }
    }
}

/** Coil with the shared loader, cached on the storage path rather than a signed URL. */
@Composable
private fun ProofImage(p: SettingsApi.StoredProof, baseUrl: String, scale: ContentScale, modifier: Modifier) {
    val context = LocalContext.current
    Box(modifier.background(WF.colors.panel)) {
        AsyncImage(
            model = WaffledImages.request(context, MediaUrl.resolve(p.proofUrl, baseUrl), MediaUrl.cacheKey(p.proofUrl)),
            contentDescription = p.choreTitle,
            contentScale = scale,
            modifier = Modifier.fillMaxWidth().then(if (scale == ContentScale.Crop) Modifier.height(128.dp) else Modifier),
        )
    }
}
