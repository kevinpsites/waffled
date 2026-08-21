package app.waffled.feature.chores

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.CheckCircleOutline
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.PanTool
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.ApprovalActionPair
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.DisclosureChevron
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledStatusBadge
import app.waffled.core.model.Person
import app.waffled.core.network.MediaImageEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The chores board — the phone layout of iOS `ChoresView`.
 *
 * A day stepper over a stack of per-person column cards, plus an "Up for grabs" column
 * anyone can claim from. Tick to complete; tap an up-for-grabs chore to say who did it;
 * a parent approves or rejects the ones awaiting an OK. Chores are **online-only**, so
 * the board loads over REST on appear, on pull-to-refresh, on every day step, and after
 * every write.
 *
 * **Scope:** phone only. The iPad/kiosk Kanban board is a later phase.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChoresScreen(
    model: ChoresModel,
    /** The household, in display order — the columns follow it. */
    members: List<Person>,
    /** The signed-in person; null on a shared device nobody has claimed. */
    viewer: Person?,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    val snapshot by model.state.collectAsStateWithLifecycle()
    val loading by model.loadingState.collectAsStateWithLifecycle()
    val failed by model.errorState.collectAsStateWithLifecycle()
    val date by model.date.collectAsStateWithLifecycle()
    val awaiting by model.awaiting.collectAsStateWithLifecycle()
    val currencies by model.currencies.collectAsStateWithLifecycle()
    val proofError by model.proofError.collectAsStateWithLifecycle()

    val rows = snapshot.value.orEmpty()
    val permissions = remember(viewer) { ChorePermissions.of(viewer) }
    val columns = remember(rows, members) { ChoreColumns.build(rows, members) }
    // Recomputed only when the day changes, never per row.
    val meta = remember(date) { model.meta() }

    var collapsed by remember { mutableStateOf(emptySet<String>()) }
    var claiming by remember { mutableStateOf<String?>(null) }
    var editor by remember { mutableStateOf<ChoreEditorTarget?>(null) }
    var reviewing by remember { mutableStateOf<ChoreRow?>(null) }
    var moving by remember { mutableStateOf<ChoreRow?>(null) }

    // Photo-proof capture, in three steps: choose a source, capture, confirm.
    var proofTarget by remember { mutableStateOf<ProofTarget?>(null) }
    var proofPreview by remember { mutableStateOf<ProofPreview?>(null) }
    var uploadingProof by remember { mutableStateOf(false) }
    var cameraUri by remember { mutableStateOf<Uri?>(null) }

    val libraryPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
        // Handled straight off the callback: routing it through a keyed LaunchedEffect
        // would need the key cleared to mark it consumed, cancelling the very coroutine
        // doing the work.
        val target = proofTarget
        proofTarget = null
        if (uri != null && target != null) proofPreview = ProofPreview(uri, target)
    }

    val cameraLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture(),
    ) { saved ->
        val target = proofTarget
        val uri = cameraUri
        proofTarget = null
        cameraUri = null
        if (saved && uri != null && target != null) proofPreview = ProofPreview(uri, target)
    }

    fun startProof(row: ChoreRow, claimFor: String? = null) {
        model.dismissProofError()
        proofTarget = ProofTarget(row, claimFor)
    }

    LaunchedEffect(Unit) {
        if (rows.isEmpty()) model.load()
        model.loadCurrencies()
        model.loadAwaiting()
    }

    Box(
        modifier
            .fillMaxSize()
            .background(WF.colors.canvas),
    ) {
        Column(Modifier.fillMaxSize()) {
            TopAppBar(
                modifier = Modifier.statusBarsPadding(),
                title = {
                    Text(
                        text = "Chores",
                        style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.ink,
                    )
                },
                actions = {
                    // Always available: a new chore defaults to "Up for grabs", which is
                    // the self-serve carve-out anyone may add to. The editor's Who chips
                    // are what `chore.manage` gates.
                    TextButton(onClick = { editor = ChoreEditorTarget.New(personId = null) }) {
                        Icon(
                            imageVector = Icons.Filled.Add,
                            contentDescription = null,
                            tint = WF.colors.primary,
                            modifier = Modifier.size(18.dp),
                        )
                        Text("New chore", style = WF.type.label, color = WF.colors.primary)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = WF.colors.canvas),
            )

            PullToRefreshBox(
                // Only a REFRESH spins here; the first load already draws WaffledLoading,
                // and two spinners at once reads as a stutter.
                isRefreshing = loading && rows.isNotEmpty(),
                onRefresh = {
                    scope.launch {
                        model.load()
                        model.loadAwaiting()
                    }
                },
                modifier = Modifier.fillMaxSize(),
            ) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(
                        start = 16.dp,
                        end = 16.dp,
                        top = 8.dp,
                        // Content scrolls UNDER the tab bar.
                        bottom = WF.spacing.tabBarClearance,
                    ),
                    verticalArrangement = Arrangement.spacedBy(WF.spacing.xxl),
                ) {
                    proofError?.let { message ->
                        item(key = "proof-error") {
                            DismissibleErrorBanner(
                                message = message,
                                onDismiss = { model.dismissProofError() },
                            )
                        }
                    }

                    if (permissions.canApprove && awaiting.isNotEmpty()) {
                        item(key = "approvals") {
                            ApprovalsCard(
                                rows = awaiting,
                                members = members,
                                coinFor = { row -> coinLabel(row, model) },
                                onOpenProof = { reviewing = it },
                                onApprove = { row -> scope.launch { model.approve(row.id) } },
                                onReject = { row -> scope.launch { model.reject(row.id) } },
                            )
                        }
                    }

                    item(key = "date-nav") {
                        DateNav(
                            meta = meta,
                            onPrevious = { scope.launch { model.shift(-1) } },
                            onNext = { scope.launch { model.shift(1) } },
                            onToday = { scope.launch { model.goToday() } },
                        )
                    }

                    if (rows.isEmpty()) {
                        item(key = "empty") {
                            if (loading && !model.loaded) {
                                WaffledLoading(top = 32.dp)
                            } else {
                                WaffledEmptyState(
                                    emoji = if (failed) "😕" else "✅",
                                    title = if (failed) {
                                        "Couldn’t load chores"
                                    } else {
                                        "Nothing scheduled ${if (meta.isToday) "today" else "this day"}"
                                    },
                                    message = if (failed) "Pull to refresh to try again." else null,
                                    top = 32.dp,
                                )
                            }
                        }
                    }

                    items(columns, key = { it.id }) { column ->
                        ChoreColumnCard(
                            column = column,
                            permissions = permissions,
                            members = members,
                            isCollapsed = column.id in collapsed,
                            claimingId = claiming,
                            isToday = meta.isToday,
                            coinFor = { row -> coinLabel(row, model) },
                            onToggleCollapsed = {
                                collapsed = if (column.id in collapsed) {
                                    collapsed - column.id
                                } else {
                                    collapsed + column.id
                                }
                            },
                            onTick = { row ->
                                when {
                                    column.isGrabs ->
                                        claiming = if (claiming == row.id) null else row.id
                                    // A photo-required chore must capture one before it can
                                    // finish — open the picker instead of ticking.
                                    row.needsPhotoToFinish -> startProof(row)
                                    else -> scope.launch { model.toggle(row) }
                                }
                            },
                            onClaim = { row, personId ->
                                claiming = null
                                if (row.requiresPhoto) {
                                    startProof(row, claimFor = personId)
                                } else {
                                    scope.launch { model.claimComplete(row.id, personId) }
                                }
                            },
                            onCancelClaim = { claiming = null },
                            onOpenRow = { row ->
                                if (permissions.canEditChores) editor = ChoreEditorTarget.Edit(row)
                            },
                            onMoveRow = { row ->
                                if (permissions.canReassign(row.status)) moving = row
                            },
                            onOpenProof = { reviewing = it },
                            onApprove = { row -> scope.launch { model.approve(row.id) } },
                            onReject = { row -> scope.launch { model.reject(row.id) } },
                            onAdd = {
                                editor = ChoreEditorTarget.New(
                                    personId = if (column.isGrabs) null else column.id,
                                )
                            },
                        )
                    }
                }
            }
        }
    }

    // ---- sheets ----

    editor?.let { target ->
        ChoreEditSheet(
            target = target,
            // Managers can assign to anyone; everyone else only to themselves, which is
            // how the web behaves. Snapshotted here rather than read inside the sheet.
            assignableMembers = if (permissions.canManage) {
                members
            } else {
                members.filter { it.id == viewer?.id }
            },
            currencies = currencies,
            initialDate = date,
            onSave = { choreId, body -> model.save(choreId, body) },
            onDelete = { choreId -> scope.launch { model.delete(choreId) } },
            onDismiss = { editor = null },
        )
    }

    reviewing?.let { row ->
        ChoreProofReview(
            row = row,
            memberColorHex = members.firstOrNull { it.id == row.personId }?.colorHex,
            coin = coinLabel(row, model),
            canDecide = permissions.canDecide(row.status),
            onApprove = {
                reviewing = null
                scope.launch { model.approve(row.id) }
            },
            onReject = {
                reviewing = null
                scope.launch { model.reject(row.id) }
            },
            onDismiss = { reviewing = null },
        )
    }

    moving?.let { row ->
        MoveChoreSheet(
            row = row,
            members = members,
            onPick = { personId ->
                moving = null
                scope.launch {
                    if (personId == null) model.unassign(row.id) else model.assign(row.id, personId)
                }
            },
            onDismiss = { moving = null },
        )
    }

    // The source choice only shows while nothing has been captured yet.
    if (proofTarget != null && proofPreview == null) {
        ChoreProofChoiceSheet(
            onTakePhoto = {
                val uri = ChoreProofCapture.newImageUri(context)
                cameraUri = uri
                cameraLauncher.launch(uri)
            },
            onChooseFromLibrary = {
                libraryPicker.launch(
                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                )
            },
            onDismiss = { proofTarget = null },
        )
    }

    proofPreview?.let { preview ->
        ChoreProofConfirm(
            imageUri = preview.uri,
            row = preview.target.row,
            coin = coinLabel(preview.target.row, model),
            isBusy = uploadingProof,
            onUse = {
                scope.launch {
                    uploadingProof = true
                    // Encoding decodes a full-size bitmap, so it belongs off the main
                    // thread. `MediaImageEncoder` already downscales under the server cap.
                    val encoded = withContext(Dispatchers.IO) {
                        runCatching { MediaImageEncoder.encode(context, preview.uri) }
                    }
                    encoded.onSuccess {
                        model.completeWithProof(
                            id = preview.target.row.id,
                            base64 = it.base64,
                            contentType = it.contentType,
                            claimFor = preview.target.claimFor,
                        )
                    }
                    uploadingProof = false
                    proofPreview = null
                }
            },
            onRetake = {
                // Drop the shot and reopen the source choice for the same chore.
                proofTarget = preview.target
                proofPreview = null
            },
            onDismiss = { proofPreview = null },
        )
    }
}

/** A chore awaiting a photo, plus the person to claim it for first (up-for-grabs). */
private data class ProofTarget(val row: ChoreRow, val claimFor: String?)

/** A captured photo held for the confirm step, before it uploads. */
private data class ProofPreview(val uri: Uri, val target: ProofTarget)

/** "3⭐", or null when the chore carries no reward — a zero must not read as "⭐ 0". */
private fun coinLabel(row: ChoreRow, model: ChoresModel): String? =
    if (row.rewardAmount > 0) "${row.rewardAmount}${model.currencySymbol(row.rewardCurrency)}" else null

// ---------------------------------------------------------------------------
// Date stepper
// ---------------------------------------------------------------------------

@Composable
private fun DateNav(
    meta: ChoreDates.DayMeta,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    onToday: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(WF.spacing.sm),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            NavArrow(Icons.AutoMirrored.Filled.KeyboardArrowLeft, "Previous day", onPrevious)
            Column(
                Modifier.weight(1f),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(meta.full, style = WF.type.cardTitle, color = WF.colors.ink)
                Text(meta.relative, style = WF.type.micro, color = WF.colors.ink3)
            }
            NavArrow(Icons.AutoMirrored.Filled.KeyboardArrowRight, "Next day", onNext)
        }
        if (!meta.isToday) {
            Text(
                text = "Jump to today",
                modifier = Modifier
                    .background(
                        WF.colors.primary.copy(alpha = 0.10f),
                        RoundedCornerShape(WF.radius.pill),
                    )
                    .clip(RoundedCornerShape(WF.radius.pill))
                    .clickable(onClick = onToday)
                    .padding(horizontal = 12.dp, vertical = 5.dp),
                style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.primary,
            )
        }
    }
}

@Composable
private fun NavArrow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    description: String,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(38.dp)
            .background(WF.colors.panel, CircleShape)
            .clip(CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = description, tint = WF.colors.ink2, modifier = Modifier.size(20.dp))
    }
}

// ---------------------------------------------------------------------------
// "Needs your OK"
// ---------------------------------------------------------------------------

/**
 * Chore check-offs waiting on a parent, surfaced inline at the top so they can be decided
 * in place. Pulls **every** awaiting instance, across all dates, so it is independent of
 * the day being viewed — an approval queue that hid yesterday's submissions would quietly
 * strand them.
 *
 * The caller gates this on `chore.approve`.
 */
@Composable
private fun ApprovalsCard(
    rows: List<ChoreRow>,
    members: List<Person>,
    coinFor: (ChoreRow) -> String?,
    onOpenProof: (ChoreRow) -> Unit,
    onApprove: (ChoreRow) -> Unit,
    onReject: (ChoreRow) -> Unit,
) {
    WaffledCard(padding = 14.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.lg)) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(WF.spacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Needs your OK", style = WF.type.cardTitle, color = WF.colors.ink)
                WaffledStatusBadge(
                    text = "${rows.size}",
                    color = WF.colors.primary,
                    size = 12.sp,
                    weight = FontWeight.Black,
                )
            }
            rows.forEachIndexed { index, row ->
                if (index > 0) HairlineDivider()
                Column(verticalArrangement = Arrangement.spacedBy(WF.spacing.md)) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(WF.spacing.md),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        AvatarFromHex(
                            colorHex = members.firstOrNull { it.id == row.personId }?.colorHex,
                            emoji = row.emoji ?: "🙂",
                            size = 36.dp,
                        )
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                text = "${row.personName ?: "Someone"} finished",
                                style = WF.type.caption,
                                color = WF.colors.ink3,
                            )
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(WF.spacing.xs),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    text = "${row.emoji ?: "🧹"} ${row.title}",
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    style = WF.type.label,
                                    color = WF.colors.ink,
                                )
                                coinFor(row)?.let {
                                    WaffledStatusBadge(it, WF.colors.gold, size = 12.5.sp, weight = FontWeight.Black)
                                }
                            }
                        }
                        ChoreProofThumb(row = row, onTap = { onOpenProof(row) })
                    }
                    ApprovalActionPair(
                        denyLabel = "Not yet",
                        isKiosk = false,
                        onDeny = { onReject(row) },
                        onApprove = { onApprove(row) },
                    )
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// A column of chores
// ---------------------------------------------------------------------------

@Composable
private fun ChoreColumnCard(
    column: ChoreColumn,
    permissions: ChorePermissions,
    members: List<Person>,
    isCollapsed: Boolean,
    claimingId: String?,
    isToday: Boolean,
    coinFor: (ChoreRow) -> String?,
    onToggleCollapsed: () -> Unit,
    onTick: (ChoreRow) -> Unit,
    onClaim: (ChoreRow, String) -> Unit,
    onCancelClaim: () -> Unit,
    onOpenRow: (ChoreRow) -> Unit,
    onMoveRow: (ChoreRow) -> Unit,
    onOpenProof: (ChoreRow) -> Unit,
    onApprove: (ChoreRow) -> Unit,
    onReject: (ChoreRow) -> Unit,
    onAdd: () -> Unit,
) {
    val shape = RoundedCornerShape(WF.radius.md)
    Column(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .border(
                width = 1.dp,
                // Up for grabs is marked out in gold so it reads as the shared pile.
                color = if (column.isGrabs) WF.colors.gold.copy(alpha = 0.4f) else WF.colors.hair,
                shape = shape,
            )
            .clip(shape)
            .padding(14.dp),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onToggleCollapsed),
            horizontalArrangement = Arrangement.spacedBy(9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (column.isGrabs) {
                Box(
                    Modifier
                        .size(30.dp)
                        .background(WF.colors.gold.copy(alpha = 0.15f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("🙌", style = TextStyle(fontSize = 16.sp))
                }
            } else {
                AvatarFromHex(colorHex = column.colorHex, emoji = column.emoji ?: "🙂", size = 30.dp)
            }
            Text(
                text = column.name,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = WF.type.cardTitle,
                color = WF.colors.ink,
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = if (column.allDone) Icons.Filled.CheckCircle else Icons.Filled.CheckCircleOutline,
                    contentDescription = null,
                    // `success` is the finished-work colour across the app.
                    tint = if (column.allDone) WF.colors.success else WF.colors.ink3,
                    modifier = Modifier.size(14.dp),
                )
                Text(
                    text = "${column.done}/${column.items.size}",
                    style = WF.type.micro,
                    color = WF.colors.ink2,
                )
            }
            DisclosureChevron(isOpen = !isCollapsed)
        }

        if (isCollapsed) return@Column

        if (column.isGrabs && column.items.isNotEmpty()) {
            Text(
                text = "Tap the hand to say who did it.",
                modifier = Modifier.padding(top = WF.spacing.xxs, bottom = 2.dp),
                style = WF.type.micro,
                color = WF.colors.ink3,
            )
        }

        column.items.forEachIndexed { index, row ->
            if (index > 0) HairlineDivider()
            ChoreRowItem(
                row = row,
                isGrabs = column.isGrabs,
                permissions = permissions,
                members = members,
                coin = coinFor(row),
                isClaiming = claimingId == row.id,
                onTick = { onTick(row) },
                onClaim = { personId -> onClaim(row, personId) },
                onCancelClaim = onCancelClaim,
                onOpen = { onOpenRow(row) },
                onMove = { onMoveRow(row) },
                onOpenProof = { onOpenProof(row) },
                onApprove = { onApprove(row) },
                onReject = { onReject(row) },
            )
        }

        if (column.items.isEmpty()) {
            Text(
                text = if (column.isGrabs) {
                    "Nothing up for grabs — add one anyone can claim."
                } else {
                    "Nothing for ${column.name} ${if (isToday) "today" else "this day"}."
                },
                modifier = Modifier.padding(vertical = WF.spacing.xs),
                style = WF.type.caption,
                color = WF.colors.ink3,
            )
        }

        // Assigning work to someone else is manage-only; anyone may add to Up for grabs.
        if (permissions.canAddTo(column.isGrabs)) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onAdd)
                    .padding(top = WF.spacing.sm),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Filled.Add,
                    contentDescription = null,
                    tint = WF.colors.ink3,
                    modifier = Modifier.size(14.dp),
                )
                Text("Add chore", style = WF.type.bodySmall, color = WF.colors.ink3)
            }
        }
    }
}

@Composable
private fun ChoreRowItem(
    row: ChoreRow,
    isGrabs: Boolean,
    permissions: ChorePermissions,
    members: List<Person>,
    coin: String?,
    isClaiming: Boolean,
    onTick: () -> Unit,
    onClaim: (String) -> Unit,
    onCancelClaim: () -> Unit,
    onOpen: () -> Unit,
    onMove: () -> Unit,
    onOpenProof: () -> Unit,
    onApprove: () -> Unit,
    onReject: () -> Unit,
) {
    val canDecide = permissions.canDecide(row.status)
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                // Tapping the row edits the chore — a manage-only act, so without the
                // capability the tap is a no-op rather than a dead end.
                .clickable(onClick = onOpen)
                .padding(top = 9.dp, bottom = if (canDecide) 4.dp else 9.dp),
            horizontalArrangement = Arrangement.spacedBy(11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ChoreTick(row = row, isGrabs = isGrabs, onClick = onTick)

            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(WF.spacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = row.emoji?.let { "$it ${row.title}" } ?: row.title,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = TextStyle(
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold,
                            textDecoration = if (row.isDone) TextDecoration.LineThrough else null,
                        ),
                        color = if (row.isDone) WF.colors.ink3 else WF.colors.ink,
                    )
                    if (row.streak >= 2) {
                        Text("🔥 ${row.streak}", style = WF.type.micro, color = WF.colors.ink2)
                    }
                    if (!row.isDone && !row.isAwaiting) {
                        // A carried-forward one-off gets a loud pill; a not-yet-due one
                        // gets a calm hint. Both are precomputed on the row.
                        row.overdueLabel?.let {
                            WaffledStatusBadge(
                                text = "overdue · $it",
                                color = WF.colors.primaryD,
                                size = 10.5.sp,
                                weight = FontWeight.Black,
                            )
                        } ?: row.upcomingLabel?.let {
                            WaffledStatusBadge(
                                text = it,
                                color = WF.colors.ink3,
                                size = 10.5.sp,
                                weight = FontWeight.Black,
                            )
                        }
                    }
                }
                Row(
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    coin?.let { Text(it, style = WF.type.micro, color = WF.colors.ink3) }
                    row.dueTimeLabel?.let {
                        Text("🕒 $it", style = WF.type.micro, color = WF.colors.ink3)
                    }
                    if (row.isAwaiting) {
                        WaffledStatusBadge(
                            text = "Needs OK",
                            color = WF.colors.primary,
                            size = 10.sp,
                            weight = FontWeight.Black,
                        )
                    }
                }
            }

            // The submitted photo, on awaiting AND done chores, so the child can see the
            // proof is attached even when the chore needed no separate approval.
            if (row.isAwaiting || row.isDone) {
                ChoreProofThumb(row = row, onTap = onOpenProof)
            }

            if (permissions.canReassign(row.status)) {
                // Reassignment is a MENU, not a drag. iOS drags a row between side-by-side
                // columns; on a phone the columns are stacked and collapsible, so a drag
                // would mean auto-scrolling the list under the finger. A picker does the
                // same job with one tap, and Compose's drag-and-drop APIs are still
                // experimental.
                Icon(
                    imageVector = Icons.Filled.PanTool,
                    contentDescription = "Move to someone else",
                    tint = WF.colors.ink3,
                    modifier = Modifier
                        .size(18.dp)
                        .clickable(onClick = onMove),
                )
            }
        }

        // Approve / Not yet sit on their own line beneath the row, so the row above stays
        // tick · title · photo instead of cramming until the labels wrap.
        if (canDecide) {
            ApprovalActionPair(
                denyLabel = "Not yet",
                isKiosk = false,
                onDeny = onReject,
                onApprove = onApprove,
                modifier = Modifier.padding(bottom = 9.dp),
            )
        }

        if (isGrabs && isClaiming) {
            ClaimPicker(members = members, onPick = onClaim, onCancel = onCancelClaim)
        }
    }
}

/** The tick: a check, an hourglass, a camera, or the hand that opens the claim picker. */
@Composable
private fun ChoreTick(row: ChoreRow, isGrabs: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(30.dp)
            .clip(CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        when {
            row.isAwaiting -> Text("⏳", style = TextStyle(fontSize = 16.sp))
            row.isDone -> Icon(
                imageVector = Icons.Filled.CheckCircle,
                contentDescription = "Done",
                tint = WF.colors.success,
                modifier = Modifier.size(22.dp),
            )
            // The camera affordance, matching web: a photo-required chore says so on its
            // tick, so it is clear a snapshot is what finishes it.
            row.needsPhotoToFinish && !isGrabs -> Icon(
                imageVector = Icons.Filled.PhotoCamera,
                contentDescription = "Needs a photo",
                tint = WF.colors.primary,
                modifier = Modifier.size(22.dp),
            )
            isGrabs -> Icon(
                imageVector = Icons.Filled.PanTool,
                contentDescription = "Claim this chore",
                tint = WF.colors.gold,
                modifier = Modifier.size(20.dp),
            )
            else -> Icon(
                imageVector = Icons.Filled.CheckCircleOutline,
                contentDescription = "Mark done",
                tint = WF.colors.ink3,
                modifier = Modifier.size(22.dp),
            )
        }
    }
}

/** "Who did it?" — the inline avatar row under an up-for-grabs chore. */
@Composable
private fun ClaimPicker(
    members: List<Person>,
    onPick: (String) -> Unit,
    onCancel: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = WF.spacing.sm, horizontal = WF.spacing.xxs),
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Who did it?", style = WF.type.micro, color = WF.colors.ink2)
        members.forEach { member ->
            Box(Modifier.clickable { onPick(member.id) }) {
                AvatarFromHex(
                    colorHex = member.colorHex,
                    emoji = member.displayEmoji,
                    size = 30.dp,
                )
            }
        }
        Spacer(Modifier.weight(1f))
        Icon(
            imageVector = Icons.Filled.Close,
            contentDescription = "Cancel",
            tint = WF.colors.ink3,
            modifier = Modifier
                .size(18.dp)
                .clickable(onClick = onCancel),
        )
    }
}

// ---------------------------------------------------------------------------
// Reassigning
// ---------------------------------------------------------------------------

/**
 * "Move this chore" — the phone's answer to iOS's drag between columns. Manage-gated by
 * the caller; picking "Up for grabs" unassigns.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MoveChoreSheet(
    row: ChoreRow,
    members: List<Person>,
    onPick: (String?) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 40.dp),
            verticalArrangement = Arrangement.spacedBy(WF.spacing.lg),
        ) {
            Text("Move “${row.title}”", style = WF.type.cardTitle, color = WF.colors.ink)
            MoveTargetRow(
                emoji = "🙌",
                label = "Up for grabs",
                selected = row.personId == null,
                onClick = { onPick(null) },
            )
            members.forEach { member ->
                MoveTargetRow(
                    emoji = member.displayEmoji,
                    label = member.name,
                    colorHex = member.colorHex,
                    selected = row.personId == member.id,
                    onClick = { onPick(member.id) },
                )
            }
        }
    }
}

@Composable
private fun MoveTargetRow(
    emoji: String,
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    colorHex: String? = null,
) {
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AvatarFromHex(colorHex = colorHex, emoji = emoji, size = 32.dp)
        Text(label, modifier = Modifier.weight(1f), style = WF.type.label, color = WF.colors.ink)
        if (selected) {
            Icon(
                imageVector = Icons.Filled.CheckCircle,
                contentDescription = "Where it is now",
                tint = WF.colors.success,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

/** The hairline between rows — Material3's divider, tinted with the shared hairline. */
@Composable
private fun HairlineDivider() {
    HorizontalDivider(thickness = 1.dp, color = WF.colors.hair)
}
