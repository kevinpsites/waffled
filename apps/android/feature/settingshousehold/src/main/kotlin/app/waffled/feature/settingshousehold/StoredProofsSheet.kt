package app.waffled.feature.settingshousehold

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.runtime.collectAsState
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
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledImages
import app.waffled.core.model.WaffledDates
import app.waffled.core.network.MediaUrl
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch
import java.time.ZoneId

/**
 * The admin's stored chore-photo manager, opened from Chores & Rewards settings: a grid
 * of retained proof photos — tap to enlarge, delete one, or clear them all. [onChanged]
 * runs after a confirmed delete so the caller can refresh its count.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StoredProofsSheet(
    api: SettingsHouseholdApi,
    proofs: List<SettingsHouseholdApi.StoredProof>,
    baseUrl: String,
    onChanged: suspend () -> Unit,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val model = remember(api) {
        StoredProofsModel(
            proofs = proofs,
            deleteProof = { api.deleteProof(it) },
            clearProofs = { api.clearProofs() },
            onChanged = onChanged,
        )
    }
    val state by model.state.collectAsState()
    var enlarged by remember { mutableStateOf<ProofCell?>(null) }
    var confirmClear by remember { mutableStateOf(false) }
    // URL + caption per proof, once per list rather than per recomposed cell.
    val cells = remember(state.proofs, baseUrl) { state.proofs.map { ProofCell.of(it, baseUrl) } }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        SheetHeader(
            "Stored photos",
            leading = "Close" to onDismiss,
            trailing = if (state.proofs.isNotEmpty()) "Clear all" to { confirmClear = true } else null,
            trailingEnabled = !state.busy,
        )
        if (cells.isEmpty()) {
            WaffledEmptyState(
                emoji = "🗂️",
                title = "No stored photos",
                message = "Chore proof photos appear here while they’re kept.",
                top = 48.dp,
                modifier = Modifier.padding(bottom = 48.dp),
            )
        } else {
            LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 150.dp),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 16.dp, bottom = WF.spacing.tabBarClearance),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(cells, key = { it.proof.id }) { cell ->
                    ProofTile(cell, busy = state.busy, onOpen = { enlarged = cell }) {
                        scope.launch { model.delete(cell.proof) }
                    }
                }
            }
        }
    }

    enlarged?.let { cell ->
        ModalBottomSheet(
            onDismissRequest = { enlarged = null },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = WF.colors.canvas,
        ) {
            SheetHeader("Photo", leading = "Close" to { enlarged = null }, trailing = null)
            Column(
                Modifier.verticalScroll(rememberScrollState()).padding(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                val shape = RoundedCornerShape(WF.radius.md)
                AsyncImage(
                    model = WaffledImages.request(LocalContext.current, cell.url, cell.cacheKey),
                    contentDescription = cell.title,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxWidth().clip(shape).border(1.dp, WF.colors.hair, shape).background(WF.colors.panel),
                )
                Text(cell.title, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center), color = WF.colors.ink)
                Text(cell.subtitle, style = TextStyle(fontSize = 13.sp), color = WF.colors.ink3)
                Text(
                    "Delete this photo",
                    Modifier.padding(top = 4.dp).clickable(enabled = !state.busy) {
                        scope.launch { if (model.delete(cell.proof)) enlarged = null }
                    },
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.primary,
                )
            }
        }
    }

    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("Delete all ${state.proofs.size} stored photos?") },
            confirmButton = {
                TextButton(onClick = {
                    confirmClear = false
                    scope.launch { model.clearAll() }
                }) { Text("Delete all", color = WF.colors.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("Cancel", color = WF.colors.ink2) } },
            containerColor = WF.colors.card,
        )
    }

    state.errorMessage?.let { message ->
        AlertDialog(
            onDismissRequest = model::dismissError,
            title = { Text("Photos unchanged") },
            text = { Text(message) },
            confirmButton = { TextButton(onClick = model::dismissError) { Text("OK", color = WF.colors.primary) } },
            containerColor = WF.colors.card,
        )
    }
}

private data class ProofCell(
    val proof: SettingsHouseholdApi.StoredProof,
    val url: String?,
    val cacheKey: String?,
    val title: String,
    val subtitle: String,
) {
    companion object {
        fun of(p: SettingsHouseholdApi.StoredProof, baseUrl: String): ProofCell {
            val day = WaffledDates.parseInstant(p.completedAt)?.let {
                WaffledDates.format(it, "MMM d", ZoneId.systemDefault())
            }
            return ProofCell(
                proof = p,
                url = MediaUrl.resolve(p.proofUrl, baseUrl),
                cacheKey = MediaUrl.cacheKey(p.proofUrl),
                title = "${p.emoji ?: "🧹"} ${p.choreTitle}",
                subtitle = listOfNotNull(p.personName, day).joinToString(" · "),
            )
        }
    }
}

@Composable
private fun ProofTile(cell: ProofCell, busy: Boolean, onOpen: () -> Unit, onDelete: () -> Unit) {
    HairlineCard(padding = 0.dp) {
        AsyncImage(
            model = WaffledImages.request(LocalContext.current, cell.url, cell.cacheKey),
            contentDescription = cell.title,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxWidth().height(128.dp).background(WF.colors.panel).clickable(onClick = onOpen),
        )
        Row(Modifier.padding(10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    cell.title,
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(cell.subtitle, style = TextStyle(fontSize = 11.5.sp), color = WF.colors.ink3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Box(
                Modifier.size(30.dp).clip(CircleShape).clickable(enabled = !busy, onClick = onDelete),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Delete, contentDescription = "Delete photo", tint = WF.colors.primary, modifier = Modifier.size(16.dp))
            }
        }
    }
}
