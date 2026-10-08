package app.waffled.feature.photos

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.wfChip
import app.waffled.core.design.wfShadow1
import kotlinx.coroutines.launch

/**
 * The family photo wall — the phone layout of iOS `PhotosView`.
 *
 * A 2-column grid under a title bar, an album filter, multi-select bulk move/delete, and
 * the add + detail sheets. Photos are not a PowerSync table, so the wall loads over REST
 * on first appear, on pull-to-refresh, and after every mutation.
 *
 * **Scope:** the iPad/kiosk layout and the full-screen slideshow are Phase 4 — see the
 * disabled Play control below.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PhotosScreen(
    model: PhotosModel,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val snapshot by model.state.collectAsStateWithLifecycle()
    val loading by model.loadingState.collectAsStateWithLifecycle()
    val failed by model.errorState.collectAsStateWithLifecycle()

    val rows = snapshot.value.orEmpty()
    val albums = remember(rows) { model.albums }

    var selectedAlbum by remember { mutableStateOf<String?>(null) }
    var detail by remember { mutableStateOf<PhotoRow?>(null) }
    var showAdd by remember { mutableStateOf(false) }

    // Multi-select bulk actions.
    var selecting by remember { mutableStateOf(false) }
    var selection by remember { mutableStateOf(emptySet<String>()) }
    var showMove by remember { mutableStateOf(false) }
    var showNewAlbum by remember { mutableStateOf(false) }
    var showDelete by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }

    // An album that disappeared (its last photo moved or deleted) must not keep
    // filtering. Derived rather than assigned, so this never writes state mid-composition.
    val activeAlbum = selectedAlbum?.takeIf { it in albums }
    val shown = remember(rows, activeAlbum) { model.shown(activeAlbum) }
    val allSelected = shown.isNotEmpty() && selection.size == shown.size

    fun exitSelection() {
        selecting = false
        selection = emptySet()
    }

    androidx.compose.runtime.LaunchedEffect(Unit) {
        if (rows.isEmpty()) model.load()
    }

    Box(
        modifier
            .fillMaxSize()
            .background(WF.colors.canvas),
    ) {
        Column(Modifier.fillMaxSize()) {
            PhotosTopBar(
                selecting = selecting,
                allSelected = allSelected,
                canSelectAll = shown.isNotEmpty(),
                canSelect = rows.isNotEmpty(),
                onCancelSelection = ::exitSelection,
                onToggleSelectAll = {
                    selection = if (allSelected) emptySet() else shown.map { it.id }.toSet()
                },
                onEnterSelection = { selecting = true; selection = emptySet() },
                onAdd = { showAdd = true },
            )

            PullToRefreshBox(
                // Only a REFRESH spins here. The first load already renders
                // `WaffledLoading`, and two spinners at once reads as a stutter.
                isRefreshing = loading && rows.isNotEmpty(),
                onRefresh = { scope.launch { model.load() } },
                modifier = Modifier.fillMaxSize(),
            ) {
                LazyVerticalGrid(
                    columns = GridCells.Fixed(2),
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(
                        start = 16.dp,
                        end = 16.dp,
                        top = 12.dp,
                        // Content scrolls UNDER the tab bar.
                        bottom = WF.spacing.tabBarClearance,
                    ),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (albums.isNotEmpty()) {
                        item(span = { GridItemSpanFull }) {
                            AlbumFilter(
                                albums = albums,
                                selected = activeAlbum,
                                onSelect = { selectedAlbum = it },
                                modifier = Modifier.padding(bottom = 12.dp),
                            )
                        }
                    }

                    when {
                        loading && rows.isEmpty() ->
                            item(span = { GridItemSpanFull }) { WaffledLoading(top = 48.dp) }

                        // Gated on the WHOLE wall, not the filtered slice — matching iOS.
                        // An album filter that matches nothing shows an empty grid, not a
                        // second empty state.
                        rows.isEmpty() -> item(span = { GridItemSpanFull }) {
                            WaffledEmptyState(
                                emoji = if (failed) "😕" else "📷",
                                title = if (failed) "Couldn’t load photos" else "No photos yet",
                                message = if (failed) {
                                    "Pull to refresh to try again."
                                } else {
                                    "Tap Add to upload your family’s moments."
                                },
                                top = 56.dp,
                            )
                        }

                        else -> items(shown, key = { it.id }) { row ->
                            PhotoTile(
                                row = row,
                                selecting = selecting,
                                selected = row.id in selection,
                                modifier = Modifier.clickable {
                                    if (selecting) {
                                        selection = if (row.id in selection) {
                                            selection - row.id
                                        } else {
                                            selection + row.id
                                        }
                                    } else {
                                        detail = row
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }

        if (selecting) {
            SelectionBar(
                count = selection.size,
                busy = busy,
                onMove = { showMove = true },
                onDelete = { showDelete = true },
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        }
    }

    // ---- dialogs ----

    if (showMove) {
        MoveDialog(
            albums = albums,
            count = selection.size,
            onDismiss = { showMove = false },
            onNewAlbum = { showMove = false; showNewAlbum = true },
            onPick = { album ->
                showMove = false
                val ids = selection
                scope.launch {
                    busy = true
                    model.move(ids, album)
                    busy = false
                    exitSelection()
                }
            },
        )
    }

    if (showNewAlbum) {
        NewAlbumDialog(
            count = selection.size,
            onDismiss = { showNewAlbum = false },
            onConfirm = { name ->
                showNewAlbum = false
                val ids = selection
                scope.launch {
                    busy = true
                    model.move(ids, name)
                    busy = false
                    exitSelection()
                }
            },
        )
    }

    if (showDelete) {
        AlertDialog(
            onDismissRequest = { showDelete = false },
            title = { Text("Delete ${PhotosFormat.photoCount(selection.size)}?") },
            text = { Text("This removes them from your family wall.") },
            confirmButton = {
                TextButton(onClick = {
                    showDelete = false
                    val ids = selection
                    scope.launch {
                        busy = true
                        model.delete(ids)
                        busy = false
                        exitSelection()
                    }
                }) { Text("Delete", color = WF.colors.danger) }
            },
            dismissButton = {
                TextButton(onClick = { showDelete = false }) { Text("Cancel") }
            },
            containerColor = WF.colors.card,
            titleContentColor = WF.colors.ink,
            textContentColor = WF.colors.ink2,
        )
    }

    detail?.let { row ->
        PhotoDetailSheet(
            row = row,
            albumCount = row.memory?.let { model.countInAlbum(it) } ?: 0,
            albums = albums,
            api = model.api,
            // The sheets write straight through `model.api`, so the bus bump is ours.
            onChanged = { model.invalidate(); scope.launch { model.load() } },
            onDismiss = { detail = null },
        )
    }

    if (showAdd) {
        PhotoAddSheet(
            albums = albums,
            api = model.api,
            // The sheets write straight through `model.api`, so the bus bump is ours.
            onDone = { model.invalidate(); scope.launch { model.load() } },
            onDismiss = { showAdd = false },
        )
    }
}

/** A full-width row inside the grid — filters, spinners and the empty state span it. */
private val androidx.compose.foundation.lazy.grid.LazyGridItemSpanScope.GridItemSpanFull
    get() = androidx.compose.foundation.lazy.grid.GridItemSpan(maxLineSpan)

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PhotosTopBar(
    selecting: Boolean,
    allSelected: Boolean,
    canSelectAll: Boolean,
    canSelect: Boolean,
    onCancelSelection: () -> Unit,
    onToggleSelectAll: () -> Unit,
    onEnterSelection: () -> Unit,
    onAdd: () -> Unit,
) {
    TopAppBar(
        modifier = Modifier.statusBarsPadding(),
        title = {
            Text(
                text = "Photos",
                style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink,
            )
        },
        navigationIcon = {
            if (selecting) {
                TextButton(onClick = onCancelSelection) {
                    Text("Cancel", style = WF.type.label, color = WF.colors.primary)
                }
            } else {
                // Phase 4: the full-screen slideshow ("Play") needs the screensaver types,
                // which do not exist yet. Shipped visibly disabled rather than omitted so
                // the gap is obvious in the UI.
                TextButton(onClick = {}, enabled = false) {
                    Icon(
                        imageVector = Icons.Filled.PlayArrow,
                        contentDescription = null,
                        tint = WF.colors.ink3,
                        modifier = Modifier.size(18.dp),
                    )
                    Text("Play", style = WF.type.label, color = WF.colors.ink3)
                }
            }
        },
        actions = {
            if (selecting) {
                TextButton(onClick = onToggleSelectAll, enabled = canSelectAll) {
                    Text(
                        text = if (allSelected) "Deselect All" else "Select All",
                        style = WF.type.label,
                        color = if (canSelectAll) WF.colors.primary else WF.colors.ink3,
                    )
                }
            } else {
                TextButton(onClick = onEnterSelection, enabled = canSelect) {
                    Text(
                        text = "Select",
                        style = WF.type.label,
                        color = if (canSelect) WF.colors.primary else WF.colors.ink3,
                    )
                }
                TextButton(onClick = onAdd) {
                    Icon(
                        imageVector = Icons.Filled.Add,
                        contentDescription = null,
                        tint = WF.colors.primary,
                        modifier = Modifier.size(18.dp),
                    )
                    Text("Add", style = WF.type.label, color = WF.colors.primary)
                }
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = WF.colors.canvas),
    )
}

// ---------------------------------------------------------------------------
// Album filter
// ---------------------------------------------------------------------------

/**
 * Album chips — "All photos" plus each album — so the wall can scope to one album.
 * Hidden by the caller until there is more than nothing to choose between.
 */
@Composable
private fun AlbumFilter(
    albums: List<String>,
    selected: String?,
    onSelect: (String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyRow(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item { AlbumChip("All photos", on = selected == null) { onSelect(null) } }
        items(albums) { album ->
            AlbumChip(album, on = selected == album) { onSelect(album) }
        }
    }
}

@Composable
private fun AlbumChip(label: String, on: Boolean, onClick: () -> Unit) {
    Text(
        text = label,
        modifier = Modifier
            .wfChip(selected = on)
            .clickable(onClick = onClick)
            .padding(horizontal = 13.dp, vertical = 7.dp),
        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
        color = if (on) WF.colors.ink else WF.colors.ink2,
    )
}

// ---------------------------------------------------------------------------
// Selection bar
// ---------------------------------------------------------------------------

/**
 * The floating Move / Delete bar shown while selecting.
 *
 * Hand-rolled rather than a Material `BottomAppBar`: it is a floating capsule sitting
 * ABOVE the app's own tab bar, not a docked bar, and Material's bar would fight the tab
 * bar for the same edge. Chrome is all tokens (`card` + hairline + `wfShadow1`).
 */
@Composable
private fun SelectionBar(
    count: Int,
    busy: Boolean,
    onMove: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(WF.radius.pill)
    val enabled = count > 0 && !busy
    Row(
        modifier = modifier
            .padding(horizontal = 16.dp)
            // The tab bar is 64dp PLUS the navigation-bar inset, so iOS's flat 94pt
            // would leave this untappable under 3-button navigation. Use the token that
            // exists for exactly this clearance.
            .padding(bottom = WF.spacing.tabBarClearance)
            .fillMaxWidth()
            .wfShadow1(shape)
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.line, shape)
            .clip(shape)
            .padding(horizontal = 20.dp, vertical = 13.dp),
        horizontalArrangement = Arrangement.spacedBy(18.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SelectionAction(
            icon = Icons.Filled.Folder,
            label = "Move",
            tint = if (enabled) WF.colors.ink else WF.colors.ink3,
            enabled = enabled,
            onClick = onMove,
        )
        SelectionAction(
            icon = Icons.Filled.Delete,
            label = "Delete",
            tint = if (enabled) WF.colors.danger else WF.colors.ink3,
            enabled = enabled,
            onClick = onDelete,
        )
        Spacer(Modifier.weight(1f))
        if (busy) {
            CircularProgressIndicator(
                modifier = Modifier.size(16.dp),
                color = WF.colors.ink3,
                strokeWidth = 2.dp,
            )
        }
        Text(
            text = if (count == 0) "Select photos" else "$count selected",
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink2,
        )
    }
}

@Composable
private fun SelectionAction(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    tint: androidx.compose.ui.graphics.Color,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier.clickable(enabled = enabled, onClick = onClick),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(imageVector = icon, contentDescription = null, tint = tint, modifier = Modifier.size(17.dp))
        Text(text = label, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = tint)
    }
}

// ---------------------------------------------------------------------------
// Move dialogs
// ---------------------------------------------------------------------------

/** The album picker for a bulk move — the port of iOS's move `confirmationDialog`. */
@Composable
private fun MoveDialog(
    albums: List<String>,
    count: Int,
    onDismiss: () -> Unit,
    onNewAlbum: () -> Unit,
    onPick: (String?) -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Move ${PhotosFormat.photoCount(count)}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                albums.forEach { album ->
                    DialogChoice(album) { onPick(album) }
                }
                DialogChoice("New album…", onClick = onNewAlbum)
                DialogChoice("Remove from album") { onPick(null) }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        containerColor = WF.colors.card,
        titleContentColor = WF.colors.ink,
        textContentColor = WF.colors.ink2,
    )
}

@Composable
private fun DialogChoice(label: String, onClick: () -> Unit) {
    Text(
        text = label,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 11.dp),
        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
        color = WF.colors.ink,
    )
}

/** "New album" — name it, then move the selection into it. */
@Composable
private fun NewAlbumDialog(
    count: Int,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New album") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    text = "Move ${PhotosFormat.photoCount(count)} into a new album.",
                    style = WF.type.bodySmall,
                    color = WF.colors.ink2,
                )
                PhotoTextField(
                    value = name,
                    onValueChange = { name = it },
                    placeholder = "Album name",
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(name.trim()) },
                enabled = name.isNotBlank(),
            ) { Text("Move") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        containerColor = WF.colors.card,
        titleContentColor = WF.colors.ink,
        textContentColor = WF.colors.ink2,
    )
}
