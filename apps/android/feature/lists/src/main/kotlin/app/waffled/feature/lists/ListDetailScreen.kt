package app.waffled.feature.lists

import androidx.compose.animation.AnimatedVisibility
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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Restore
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.DisclosureChevron
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.wfField
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * One list's items — the phone layout of iOS `ListDetailView`.
 *
 * Works for any list. Grocery additionally gets the board: a week switcher, the
 * aisle / store / meal grouping toggle, per-row meal dots, the pantry-staples panel and
 * the pantry badges.
 *
 * **Scope:** the tablet/kiosk two-column layout (`kioskBody` on iOS) is Phase 4 and is
 * deliberately absent, as are the iOS test-rig deep links.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ListDetailScreen(
    model: ListDetailModel,
    /** Null where the screen is a page root (the tablet's Lists pane): no arrow is drawn. */
    onBack: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
    /** Hands the shared text to the system share sheet; the host owns the Intent. */
    onShare: (subject: String, text: String) -> Unit = { _, _ -> },
    /** Copies the Markdown checklist to the clipboard. */
    onCopy: (text: String) -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    val list by model.listState.collectAsStateWithLifecycle()
    val items by model.itemsState.collectAsStateWithLifecycle()
    val settling by model.settlingState.collectAsStateWithLifecycle()
    val loading by model.loadingState.collectAsStateWithLifecycle()
    val failed by model.errorState.collectAsStateWithLifecycle()
    val board by model.boardState.collectAsStateWithLifecycle()
    val query by model.searchState.collectAsStateWithLifecycle()
    val shareText by model.shareTextState.collectAsStateWithLifecycle()
    val shareMarkdown by model.shareMarkdownState.collectAsStateWithLifecycle()

    var mode by remember { mutableStateOf(GroceryViewMode.Aisle) }
    var collapsed by remember { mutableStateOf(setOf<String>()) }
    var showCompleted by remember { mutableStateOf(false) }
    var editingId by remember { mutableStateOf<String?>(null) }
    var detailItem by remember { mutableStateOf<ListItemDTO?>(null) }
    var addingWithDetails by remember { mutableStateOf<String?>(null) }
    var editingStaples by remember { mutableStateOf(false) }
    var editingList by remember { mutableStateOf(false) }
    var confirmingDelete by remember { mutableStateOf(false) }
    var newSectionPrompt by remember { mutableStateOf(false) }
    var draftName by remember { mutableStateOf("") }
    var draftQty by remember { mutableStateOf("") }
    var draftSection by remember { mutableStateOf<String?>(null) }
    var toast by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(list.id) { model.load() }

    // The cross-device liveness poll: another family member's tick shows up without a
    // manual pull-to-refresh. Silent (no spinner), and skipped while a row is being
    // edited so it can't clobber an in-progress change.
    LaunchedEffect(list.id, editingId) {
        while (editingId == null) {
            delay(POLL_INTERVAL_MS)
            model.load(silent = true)
        }
    }

    // A checked row lingers in place, then drops into Completed.
    LaunchedEffect(settling) {
        val pending = settling.toList()
        if (pending.isEmpty()) return@LaunchedEffect
        delay(SETTLE_DELAY_MS)
        pending.forEach(model::settle)
    }

    toast?.let { message ->
        LaunchedEffect(message) {
            delay(TOAST_MS)
            toast = null
        }
    }

    val searchActive = query.isNotBlank()
    val showSearch = items.size > SEARCH_THRESHOLD

    Column(modifier.fillMaxSize()) {
        ListDetailAppBar(
            list = list,
            shareText = shareText,
            shareMarkdown = shareMarkdown,
            onBack = onBack,
            onShare = onShare,
            onCopy = onCopy,
            onEditList = { editingList = true },
            onDelete = { confirmingDelete = true },
            onConvert = {
                scope.launch {
                    if (model.convertToTemplate()) toast = "Turned “${list.name}” into a template"
                }
            },
            onUseTemplate = {
                scope.launch {
                    model.useTemplate()?.let { toast = "Made “${it.name}” from this template" }
                }
            },
            onMoveToLists = {
                scope.launch {
                    if (model.moveToLists()) toast = "Moved “${list.name}” back to Lists"
                }
            },
        )

        if (list.isTemplate) TemplateBanner()

        // Pinned controls: search (long lists only), then the grocery week + grouping.
        if (showSearch) {
            ListTextField(
                value = query,
                onValueChange = model::setSearch,
                placeholder = "Search this list",
                fill = WF.colors.panel,
                fontSize = 15.sp,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
            )
        }
        if (model.isGrocery && !searchActive) {
            GroceryWeekSwitcher(
                label = groceryWeekLabel(model.weekOffset, board.weekStart),
                showReset = model.weekOffset != 0,
                onStep = { scope.launch { model.stepWeek(it) } },
                onThisWeek = { scope.launch { model.thisWeek() } },
            )
        }
        if (model.isGrocery) {
            GroceryModeToggle(mode = mode, onMode = { mode = it })
        }

        Box(Modifier.weight(1f)) {
            PullToRefreshBox(
                isRefreshing = loading && items.isNotEmpty(),
                onRefresh = { scope.launch { model.load() } },
                modifier = Modifier.fillMaxSize(),
            ) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = 12.dp),
                ) {
                    if (items.isEmpty() && !loading) {
                        item {
                            WaffledEmptyState(
                                emoji = if (failed) "😕" else "🗒️",
                                title = if (failed) "Couldn’t load this list." else "Nothing here yet.",
                                message = if (failed) "Pull to refresh to try again." else "Add something below.",
                            )
                        }
                    } else if (items.isEmpty() && loading) {
                        item { WaffledLoading() }
                    }

                    // The meals recap sits above the rows on a phone (iOS puts it in a side
                    // panel on tablet, which is Phase 4). Hidden while searching so the
                    // matching rows stand out.
                    if (model.isGrocery && !searchActive &&
                        (board.meals.isNotEmpty() || board.unscheduled.isNotEmpty() || board.unscheduledMeals.isNotEmpty())
                    ) {
                        item {
                            MealsRecapPanel(
                                board = board,
                                onRebuild = { scope.launch { model.rebuild() } },
                                onStartOver = { scope.launch { model.startOver() } },
                                onRemoveRecipe = { scope.launch { model.removeRecipe(it) } },
                                onRemoveMeal = { scope.launch { model.removeMeal(it) } },
                            )
                        }
                    }

                    val groups: List<Pair<ListSectionGroup?, MealGroup?>> = when {
                        model.isGrocery && mode == GroceryViewMode.Store ->
                            model.storeSections.map { it to null }
                        model.isGrocery && mode == GroceryViewMode.Meal ->
                            model.mealSections.map { null to it }
                        else -> model.activeSections.map { it to null }
                    }

                    for ((section, mealGroup) in groups) {
                        val id = section?.id ?: mealGroup!!.id
                        val open = id !in collapsed
                        item(key = "h:$id") {
                            if (section != null) {
                                SectionHeaderRow(
                                    title = section.title,
                                    count = section.items.size,
                                    isOpen = open,
                                    onToggle = { collapsed = if (open) collapsed + id else collapsed - id },
                                )
                            } else {
                                MealHeaderRow(
                                    group = mealGroup!!,
                                    isOpen = open,
                                    onToggle = { collapsed = if (open) collapsed + id else collapsed - id },
                                )
                            }
                        }
                        if (!open) continue
                        val rows = section?.items ?: mealGroup!!.items
                        items(rows, key = { "i:${it.id}" }) { item ->
                            ListItemRow(
                                item = item,
                                isTemplate = list.isTemplate,
                                showStoreTag = mode != GroceryViewMode.Store,
                                dots = if (model.isGrocery) model.dotColors(item) else emptyList(),
                                editing = editingId == item.id,
                                sections = model.sectionSuggestions,
                                onStartEdit = { editingId = item.id },
                                onCommitEdit = { name, qty ->
                                    editingId = null
                                    scope.launch { model.edit(item.id, name, qty) }
                                },
                                onToggle = { scope.launch { model.toggle(item.id) } },
                                onDetails = { detailItem = item },
                                onDelete = { scope.launch { model.remove(item.id) } },
                                onMoveToSection = { scope.launch { model.moveToSection(item.id, it) } },
                            )
                        }
                        if (mealGroup?.isFullyCovered == true) {
                            item(key = "covered:$id") {
                                Text(
                                    "Everything this plate needs is already on the list above.",
                                    style = WF.type.caption,
                                    color = WF.colors.ink3,
                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                                )
                            }
                        }
                    }

                    val done = model.completed
                    if (done.isNotEmpty()) {
                        item(key = "completed-header") {
                            CompletedHeaderRow(
                                count = done.size,
                                isOpen = showCompleted,
                                onToggle = { showCompleted = !showCompleted },
                                // On grocery, `checked` means "in cart" and clear-completed
                                // is a server-side no-op, so offering it there would wipe
                                // rows optimistically that come straight back.
                                onClear = if (list.isGrocery || list.isTemplate) null
                                else ({ scope.launch { model.clearCompleted() } }),
                            )
                        }
                        if (showCompleted) {
                            items(done, key = { "c:${it.id}" }) { item ->
                                ListItemRow(
                                    item = item,
                                    isTemplate = list.isTemplate,
                                    showStoreTag = mode != GroceryViewMode.Store,
                                    dots = emptyList(),
                                    editing = false,
                                    sections = model.sectionSuggestions,
                                    onStartEdit = {},
                                    onCommitEdit = { _, _ -> },
                                    onToggle = { scope.launch { model.toggle(item.id) } },
                                    onDetails = { detailItem = item },
                                    onDelete = { scope.launch { model.remove(item.id) } },
                                    onMoveToSection = { scope.launch { model.moveToSection(item.id, it) } },
                                )
                            }
                        }
                    }

                    if (model.isGrocery && !searchActive && board.staples.isNotEmpty()) {
                        item(key = "staples") {
                            PantryStaplesPanel(
                                staples = board.staples,
                                onEdit = { editingStaples = true },
                                onAdd = { name ->
                                    scope.launch {
                                        val aisle = model.addStaple(name)
                                        toast = "Added $name" + (aisle?.let { " to $it" } ?: "")
                                    }
                                },
                            )
                        }
                    }
                }
            }

            toast?.let { ToastBanner(it, Modifier.align(Alignment.BottomCenter)) }
        }

        AddItemBar(
            name = draftName,
            onName = { draftName = it },
            quantity = draftQty,
            onQuantity = { draftQty = it },
            section = draftSection,
            sections = model.sectionSuggestions,
            onSection = { draftSection = it },
            onNewSection = { newSectionPrompt = true },
            onSubmit = {
                val name = draftName
                val qty = draftQty
                val sec = draftSection
                draftName = ""
                draftQty = ""
                if (name.isNotBlank()) scope.launch { model.add(name, qty, sec) }
            },
            onDetails = {
                addingWithDetails = draftName
                draftName = ""
                draftQty = ""
            },
        )
    }

    // ---- sheets & dialogs ------------------------------------------------------

    detailItem?.let { item ->
        ItemDetailEditor(
            item = item,
            sections = model.sectionSuggestions,
            stores = model.storeSuggestions,
            showStore = model.isGrocery,
            onDismiss = { detailItem = null },
            onSave = { name, qty, assignee, section, store, priority ->
                detailItem = null
                scope.launch { model.editDetails(item.id, name, qty, assignee, section, store, priority) }
            },
        )
    }

    addingWithDetails?.let { seed ->
        ItemDetailEditor(
            newItemName = seed,
            sections = model.sectionSuggestions,
            stores = model.storeSuggestions,
            showStore = model.isGrocery,
            onDismiss = { addingWithDetails = null },
            onSave = { name, qty, assignee, section, store, priority ->
                addingWithDetails = null
                scope.launch {
                    model.add(name, qty, section)?.let { created ->
                        model.editDetails(created.id, name, qty, assignee, section, store, priority)
                    }
                }
            },
        )
    }

    if (editingStaples) {
        PantryStaplesEditor(
            initial = board.staples,
            api = model.api,
            onDismiss = { editingStaples = false },
            onChange = { scope.launch { model.reloadStaples() } },
        )
    }

    if (editingList) {
        EditListSheet(
            list = list,
            onDismiss = { editingList = false },
            onSave = { name, emoji ->
                editingList = false
                scope.launch { model.editList(name, emoji) }
            },
        )
    }

    if (newSectionPrompt) {
        NewSectionDialog(
            onDismiss = { newSectionPrompt = false },
            onUse = {
                draftSection = it
                newSectionPrompt = false
            },
        )
    }

    if (confirmingDelete) {
        AlertDialog(
            onDismissRequest = { confirmingDelete = false },
            containerColor = WF.colors.card,
            title = { Text("Delete “${list.name}”?", style = WF.type.sectionTitle, color = WF.colors.ink) },
            text = {
                Text(
                    "This deletes the list and its items. This can’t be undone.",
                    style = WF.type.bodySmall,
                    color = WF.colors.ink2,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmingDelete = false
                    scope.launch { if (model.deleteList()) onBack?.invoke() }
                }) {
                    Text(
                        if (list.isTemplate) "Delete template" else "Delete list",
                        color = WF.colors.danger,
                        style = WF.type.label,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmingDelete = false }) {
                    Text("Cancel", color = WF.colors.ink2, style = WF.type.label)
                }
            },
        )
    }
}

private const val POLL_INTERVAL_MS = 20_000L
private const val SETTLE_DELAY_MS = 2_000L
private const val TOAST_MS = 2_500L

/** Only worth the space once a list is long. */
private const val SEARCH_THRESHOLD = 6

/**
 * The week's label.
 *
 * Beyond ±1 the label is derived from the SERVER's own `weekStart`, so the heading can
 * never name a different week from the one on screen.
 */
internal fun groceryWeekLabel(offset: Int, serverWeekStart: String): String = when (offset) {
    0 -> "This week"
    1 -> "Next week"
    -1 -> "Last week"
    else -> runCatching {
        val d = java.time.LocalDate.parse(serverWeekStart)
        "Week of " + d.format(java.time.format.DateTimeFormatter.ofPattern("MMM d"))
    }.getOrDefault("Another week")
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ListDetailAppBar(
    list: ListSummary,
    shareText: String,
    shareMarkdown: String,
    onBack: (() -> Unit)?,
    onShare: (String, String) -> Unit,
    onCopy: (String) -> Unit,
    onEditList: () -> Unit,
    onDelete: () -> Unit,
    onConvert: () -> Unit,
    onUseTemplate: () -> Unit,
    onMoveToLists: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    TopAppBar(
        title = {
            Text(
                list.name,
                style = WF.type.sectionTitle,
                color = WF.colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        navigationIcon = {
            if (onBack != null) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "Back",
                    tint = WF.colors.ink,
                    modifier = Modifier.padding(horizontal = 12.dp).clickable(onClick = onBack),
                )
            }
        },
        actions = {
            Box {
                Icon(
                    // Grocery is auto-built, so it has no rename/template/delete actions —
                    // but it still shares, and it is the list people actually share, so it
                    // gets the share glyph rather than an overflow with one item in it.
                    imageVector = if (list.isGrocery) Icons.Filled.Share else Icons.Filled.MoreVert,
                    contentDescription = if (list.isGrocery) "Share list" else "List actions",
                    tint = WF.colors.ink,
                    modifier = Modifier.padding(end = 12.dp).clickable { menu = true },
                )
                ListRowMenu(
                    expanded = menu,
                    onDismiss = { menu = false },
                    items = buildList {
                        if (shareText.isNotEmpty()) {
                            add(MenuAction("Share list", Icons.Filled.Share, onClick = { onShare(list.name, shareText) }))
                            // Beside Share rather than replacing it: the share sheet hands
                            // the list to a person, this hands it to a document.
                            add(MenuAction("Copy as checklist", Icons.Filled.ContentCopy, onClick = { onCopy(shareMarkdown) }))
                        }
                        if (!list.isGrocery) {
                            add(MenuAction("Edit list", Icons.Filled.Edit, onEditList))
                            if (list.isTemplate) {
                                add(MenuAction("Use template", Icons.Filled.Checklist, onUseTemplate))
                                add(MenuAction("Move to Lists", Icons.AutoMirrored.Filled.Undo, onMoveToLists))
                                add(MenuAction("Delete template", Icons.Filled.Delete, onDelete, destructive = true))
                            } else {
                                add(MenuAction("Save as template", Icons.Filled.ContentCopy, onConvert))
                                add(MenuAction("Delete list", Icons.Filled.Delete, onDelete, destructive = true))
                            }
                        }
                    },
                )
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = WF.colors.canvas),
    )
}

@Composable
private fun TemplateBanner() {
    Row(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.aiT)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("📑", style = TextStyle(fontSize = 14.sp))
        Text(
            "This is a template. Use it to spin off a fresh list — its items aren’t ticked off here.",
            style = WF.type.caption,
            color = WF.colors.ink2,
        )
    }
}

@Composable
private fun GroceryWeekSwitcher(
    label: String,
    showReset: Boolean,
    onStep: (Int) -> Unit,
    onThisWeek: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        WeekStepButton(Icons.AutoMirrored.Filled.KeyboardArrowLeft, "Previous week") { onStep(-1) }
        Text(
            label,
            style = WF.type.label,
            color = WF.colors.ink,
            modifier = Modifier.weight(1f),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        if (showReset) {
            Text(
                "This week",
                style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ai,
                modifier = Modifier.clickable(onClick = onThisWeek),
            )
        }
        WeekStepButton(Icons.AutoMirrored.Filled.KeyboardArrowRight, "Next week") { onStep(1) }
    }
}

@Composable
private fun WeekStepButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    description: String,
    onClick: () -> Unit,
) {
    Box(
        Modifier
            .size(width = 36.dp, height = 30.dp)
            .background(WF.colors.panel, RoundedCornerShape(WF.radius.pill))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = description, tint = WF.colors.ink2, modifier = Modifier.size(18.dp))
    }
}

/**
 * By aisle / By store / By meal.
 *
 * Material3's `SingleChoiceSegmentedButtonRow` is the native twin of the iOS segmented
 * picker, so it is used as-is with only its colours mapped onto `WF` tokens.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GroceryModeToggle(mode: GroceryViewMode, onMode: (GroceryViewMode) -> Unit) {
    val options = listOf(
        GroceryViewMode.Aisle to "By aisle",
        GroceryViewMode.Store to "By store",
        GroceryViewMode.Meal to "By meal",
    )
    SingleChoiceSegmentedButtonRow(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp),
    ) {
        options.forEachIndexed { index, (value, label) ->
            SegmentedButton(
                selected = mode == value,
                onClick = { onMode(value) },
                shape = SegmentedButtonDefaults.itemShape(index = index, count = options.size),
                colors = SegmentedButtonDefaults.colors(
                    activeContainerColor = WF.colors.primary.copy(alpha = 0.12f),
                    activeContentColor = WF.colors.ink,
                    activeBorderColor = WF.colors.primary,
                    inactiveContainerColor = WF.colors.card,
                    inactiveContentColor = WF.colors.ink2,
                    inactiveBorderColor = WF.colors.hair,
                ),
                label = { Text(label, style = WF.type.bodySmall) },
            )
        }
    }
}

@Composable
private fun SectionHeaderRow(title: String?, count: Int, isOpen: Boolean, onToggle: () -> Unit) {
    // The untitled group keeps its old look — no visible header — but still holds a slot,
    // so a list with no sections at all reads as one plain run of rows.
    if (title == null) {
        Spacer(Modifier.height(2.dp))
        return
    }
    Row(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.canvas)
            .clickable(onClick = onToggle)
            .padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        DisclosureChevron(isOpen = isOpen, size = 10.dp)
        Text(
            title.uppercase(),
            style = WF.type.sectionLabel,
            color = WF.colors.ink3,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text("$count", style = WF.type.micro, color = WF.colors.ink3)
    }
}

/**
 * "By meal" header — the meal's own colour tints the tag, so it doubles as the legend for
 * the per-row dots.
 */
@Composable
private fun MealHeaderRow(group: MealGroup, isOpen: Boolean, onToggle: () -> Unit) {
    val title = group.meal?.title
        ?: group.unscheduledMeal?.name
        ?: group.unscheduled?.title
        ?: "Staples & extras"
    val hex = group.meal?.color ?: group.unscheduledMeal?.color ?: group.unscheduled?.color
    val tint = app.waffled.core.design.colorFromHex(hex) ?: WF.colors.ink3
    Row(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.canvas)
            .clickable(onClick = onToggle)
            .padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        DisclosureChevron(isOpen = isOpen, size = 10.dp)
        Box(Modifier.size(8.dp).background(tint, RoundedCornerShape(WF.radius.pill)))
        Text(
            title.uppercase(),
            style = WF.type.sectionLabel,
            color = WF.colors.ink3,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text("${group.items.size}", style = WF.type.micro, color = WF.colors.ink3)
    }
}

@Composable
private fun CompletedHeaderRow(count: Int, isOpen: Boolean, onToggle: () -> Unit, onClear: (() -> Unit)?) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.canvas)
            .padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            Modifier.weight(1f).clickable(onClick = onToggle),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            DisclosureChevron(isOpen = isOpen, size = 10.dp)
            Text("COMPLETED ($count)", style = WF.type.sectionLabel, color = WF.colors.ink3)
        }
        if (onClear != null) {
            Text(
                "CLEAR",
                style = WF.type.sectionLabel,
                color = WF.colors.primary,
                modifier = Modifier.clickable(onClick = onClear),
            )
        }
    }
}

/**
 * One item row.
 *
 * Tapping the circle ticks it off; tapping the body opens the inline editor (name plus a
 * quantity field on the right). A long-press opens the row's overflow — Details, Move to
 * section, Delete.
 *
 * The overflow is a native `DropdownMenu` rather than a swipe. Material3's
 * `SwipeToDismissBox` offers one action per direction and dismisses the row wholesale,
 * which fits Delete but not Details or a section move; a bespoke multi-action swipe is
 * exactly the hand-rolled gesture the iOS port had to rework. See [ListReorder] for the
 * section rule this menu writes.
 */
@Composable
private fun ListItemRow(
    item: ListItemDTO,
    isTemplate: Boolean,
    showStoreTag: Boolean,
    dots: List<String>,
    editing: Boolean,
    sections: List<String>,
    onStartEdit: () -> Unit,
    onCommitEdit: (String, String) -> Unit,
    onToggle: () -> Unit,
    onDetails: () -> Unit,
    onDelete: () -> Unit,
    onMoveToSection: (String?) -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    var sectionMenu by remember { mutableStateOf(false) }
    var editName by remember(item.id, editing) { mutableStateOf(item.name) }
    var editQty by remember(item.id, editing) { mutableStateOf(item.editableQuantity) }

    Row(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.canvas)
            .padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // The tick target is its own hit area, separate from the row body.
        Icon(
            imageVector = if (item.checked) Icons.Filled.CheckCircle else Icons.Filled.RadioButtonUnchecked,
            contentDescription = if (item.checked) "Mark as not done" else "Mark as done",
            tint = if (item.checked) WF.colors.primary else WF.colors.ink3,
            modifier = Modifier
                .size(26.dp)
                // A template's items are its starting content, not a checklist to tick off.
                .clickable(enabled = !isTemplate, onClick = onToggle),
        )

        if (editing) {
            ListTextField(
                value = editName,
                onValueChange = { editName = it },
                placeholder = "Name",
                boxed = false,
                fontSize = 16.sp,
                imeAction = ImeAction.Next,
                capitalization = KeyboardCapitalization.Sentences,
                modifier = Modifier.weight(1f),
                onSubmit = { onCommitEdit(editName, editQty) },
            )
            ListTextField(
                value = editQty,
                onValueChange = { editQty = it },
                placeholder = "Qty",
                boxed = false,
                fontSize = 14.sp,
                textAlign = androidx.compose.ui.text.style.TextAlign.End,
                modifier = Modifier.width(64.dp),
                onSubmit = { onCommitEdit(editName, editQty) },
            )
            Icon(
                Icons.Filled.CheckCircle,
                contentDescription = "Save",
                tint = WF.colors.primary,
                modifier = Modifier.size(22.dp).clickable { onCommitEdit(editName, editQty) },
            )
        } else {
            Column(
                Modifier.weight(1f).clickable(enabled = !isTemplate, onClick = onStartEdit),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    val flag = ListItemPriority.meta(item.priority)
                    if (flag.icon.isNotEmpty()) {
                        Text(flag.icon, style = TextStyle(fontSize = 13.sp))
                    }
                    Text(
                        text = item.name,
                        style = TextStyle(
                            fontSize = 16.sp,
                            fontWeight = FontWeight.SemiBold,
                            textDecoration = if (item.checked) TextDecoration.LineThrough else null,
                        ),
                        color = if (item.checked) WF.colors.ink3 else WF.colors.ink,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                // The pantry badge sits UNDER the name, not among the trailing chips: the
                // row already carries meal dots, a store tag, a quantity and an avatar, and
                // on a narrow phone a fifth chip competing for that width starved the name
                // and wrapped it mid-word. On its own line it costs no horizontal room.
                item.pantry?.let { hit ->
                    PantryBadgeChip(rowName = item.name, hit = hit, dimmed = item.checked)
                }
            }

            MealDotsRow(dots)
            if (showStoreTag) {
                item.store?.takeIf { it.isNotEmpty() }?.let { ListRowTag("🏬 $it") }
            }
            item.quantity?.takeIf { it.isNotEmpty() }?.let {
                Text(it, style = WF.type.bodySmall, color = WF.colors.ink3)
            }
            item.assignee?.takeIf { it.avatarEmoji != null || it.colorHex != null }?.let { a ->
                AvatarFromHex(colorHex = a.colorHex, emoji = a.avatarEmoji ?: "🙂", size = 24.dp)
            }

            Box {
                Icon(
                    Icons.Filled.MoreVert,
                    contentDescription = "Item actions",
                    tint = WF.colors.ink3,
                    modifier = Modifier.size(20.dp).clickable { menu = true },
                )
                ListRowMenu(
                    expanded = menu,
                    onDismiss = { menu = false },
                    items = listOf(
                        MenuAction("Details", Icons.Filled.Tune, onDetails),
                        MenuAction("Move to section", Icons.Filled.Checklist, { sectionMenu = true }),
                        MenuAction("Delete", Icons.Filled.Delete, onDelete, destructive = true),
                    ),
                )
                ListRowMenu(
                    expanded = sectionMenu,
                    onDismiss = { sectionMenu = false },
                    items = buildList {
                        // "No section" writes null, never a literal "Items" category.
                        add(MenuAction("No section", Icons.AutoMirrored.Filled.Undo, { onMoveToSection(null) }))
                        for (s in sections) add(MenuAction(s, Icons.Filled.Checklist, { onMoveToSection(s) }))
                    },
                )
            }
        }
    }
}

/**
 * The add bar, pinned above the tab bar.
 *
 * `navigationBarsPadding()` plus the bar's own height is what keeps it above the system
 * navigation; the LIST above it, not this bar, is what scrolls under the tab bar.
 */
@Composable
private fun AddItemBar(
    name: String,
    onName: (String) -> Unit,
    quantity: String,
    onQuantity: (String) -> Unit,
    section: String?,
    sections: List<String>,
    onSection: (String?) -> Unit,
    onNewSection: () -> Unit,
    onSubmit: () -> Unit,
    onDetails: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.canvas)
            .padding(horizontal = 16.dp)
            .padding(top = 10.dp)
            // Clears the floating tab bar the same way every other screen does.
            .padding(bottom = WF.spacing.tabBarClearance - 60.dp)
            .navigationBarsPadding(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AnimatedVisibility(visible = name.isNotEmpty() || section != null) {
            ChipFlow {
                ListChip("Auto", selected = section == null, onClick = { onSection(null) }, leading = "✨")
                for (s in sections) {
                    ListChip(s, selected = section.equals(s, ignoreCase = true), onClick = { onSection(s) })
                }
                ListChip("New", selected = false, onClick = onNewSection, leading = "+")
            }
        }
        Row(
            Modifier.wfField().padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(Icons.Filled.Add, contentDescription = null, tint = WF.colors.primary, modifier = Modifier.size(22.dp))
            ListTextField(
                value = name,
                onValueChange = onName,
                placeholder = "Add item",
                boxed = false,
                imeAction = ImeAction.Next,
                modifier = Modifier.weight(1f),
                onSubmit = onSubmit,
            )
            ListTextField(
                value = quantity,
                onValueChange = onQuantity,
                placeholder = "Qty",
                boxed = false,
                fontSize = 15.sp,
                textAlign = androidx.compose.ui.text.style.TextAlign.End,
                modifier = Modifier.width(64.dp),
                onSubmit = onSubmit,
            )
            Icon(
                Icons.Filled.Tune,
                contentDescription = "Add item with details",
                tint = WF.colors.ink3,
                modifier = Modifier.size(20.dp).clickable(onClick = onDetails),
            )
        }
    }
}

@Composable
private fun NewSectionDialog(onDismiss: () -> Unit, onUse: (String) -> Unit) {
    var value by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = WF.colors.card,
        title = { Text("New section", style = WF.type.sectionTitle, color = WF.colors.ink) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("New items will be added to this section.", style = WF.type.bodySmall, color = WF.colors.ink2)
                ListTextField(value = value, onValueChange = { value = it }, placeholder = "Section name")
            }
        },
        confirmButton = {
            TextButton(enabled = value.isNotBlank(), onClick = { onUse(value.trim()) }) {
                Text("Use", color = WF.colors.primary, style = WF.type.label)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel", color = WF.colors.ink2, style = WF.type.label) }
        },
    )
}

/** A transient confirmation ("Added Butter to Dairy & Chilled"). */
@Composable
private fun ToastBanner(message: String, modifier: Modifier = Modifier) {
    Text(
        text = message,
        modifier = modifier
            .padding(16.dp)
            .background(WF.colors.ink, RoundedCornerShape(WF.radius.pill))
            .padding(horizontal = 16.dp, vertical = 10.dp),
        style = WF.type.bodySmall,
        // Text on a solid `ink` fill is `onInk`, never white — `ink` flips to a warm
        // off-white in dark, where white would vanish.
        color = WF.colors.onInk,
    )
}

/**
 * This week's meals, with the two board-level actions.
 *
 * "Refresh from meals" rebuilds the derived rows and keeps everything hand-added and
 * ticked; "Start over" only un-ticks. Both are server operations — the client never
 * decides which rows are derived.
 */
@Composable
private fun MealsRecapPanel(
    board: GroceryBoardDTO,
    onRebuild: () -> Unit,
    onStartOver: () -> Unit,
    onRemoveRecipe: (String) -> Unit,
    onRemoveMeal: (String) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .background(WF.colors.panel, RoundedCornerShape(WF.radius.md))
            .border(1.dp, WF.colors.hair, RoundedCornerShape(WF.radius.md))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("THIS WEEK’S MEALS", style = WF.type.sectionLabel, color = WF.colors.ink3, modifier = Modifier.weight(1f))
            Icon(
                Icons.Filled.Refresh,
                contentDescription = "Refresh from meals",
                tint = WF.colors.ai,
                modifier = Modifier.size(18.dp).clickable(onClick = onRebuild),
            )
            Spacer(Modifier.width(14.dp))
            Icon(
                Icons.Filled.Restore,
                contentDescription = "Start over",
                tint = WF.colors.ink3,
                modifier = Modifier.size(18.dp).clickable(onClick = onStartOver),
            )
        }
        for (meal in board.meals) {
            RecapRow(
                color = meal.color,
                title = meal.title ?: "Planned meal",
                subtitle = meal.date,
                onRemove = meal.mealId?.let { id -> { onRemoveMeal(id) } },
            )
        }
        for (plate in board.unscheduledMeals) {
            RecapRow(color = plate.color, title = plate.name, subtitle = "Off-plan plate") { onRemoveMeal(plate.mealId) }
        }
        for (recipe in board.unscheduled) {
            RecapRow(color = recipe.color, title = recipe.title, subtitle = "Off-plan recipe") {
                onRemoveRecipe(recipe.recipeId)
            }
        }
    }
}

@Composable
private fun RecapRow(color: String, title: String, subtitle: String, onRemove: (() -> Unit)?) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(
            Modifier
                .size(8.dp)
                .background(app.waffled.core.design.colorFromHex(color) ?: WF.colors.ink3, RoundedCornerShape(WF.radius.pill)),
        )
        Column(Modifier.weight(1f)) {
            Text(title, style = WF.type.label, color = WF.colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, style = WF.type.caption, color = WF.colors.ink3)
        }
        if (onRemove != null) {
            Icon(
                Icons.Filled.Delete,
                contentDescription = "Take $title off the list",
                tint = WF.colors.ink3,
                modifier = Modifier.size(16.dp).clickable(onClick = onRemove),
            )
        }
    }
}

/**
 * Pantry staples — assumed in the house, so the grocery list leaves them off. Tap one to
 * add it anyway.
 */
@Composable
private fun PantryStaplesPanel(
    staples: List<GroceryBoardDTO.Staple>,
    onEdit: () -> Unit,
    onAdd: (String) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 10.dp)
            .background(WF.colors.panel, RoundedCornerShape(WF.radius.md))
            .border(1.dp, WF.colors.hair, RoundedCornerShape(WF.radius.md))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("PANTRY CHECK", style = WF.type.sectionLabel, color = WF.colors.ink3, modifier = Modifier.weight(1f))
            Row(
                Modifier.clickable(onClick = onEdit),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Settings, contentDescription = null, tint = WF.colors.ai, modifier = Modifier.size(14.dp))
                Text("Edit staples", style = WF.type.caption, color = WF.colors.ai)
            }
        }
        Text(
            "These staples are assumed in the house, so they’re left off the list. Tap one to add it anyway.",
            style = WF.type.caption,
            color = WF.colors.ink2,
        )
        ChipFlow {
            for (s in staples) {
                ListChip(label = s.name, selected = false, leading = "+", onClick = { onAdd(s.name) })
            }
        }
    }
}
