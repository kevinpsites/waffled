package app.waffled.feature.lists

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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.AICaptureBar
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledEmojiTile
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledPrimaryCTA
import kotlinx.coroutines.launch

/**
 * The Lists index — every list in the household (Grocery, packing lists, …), with the
 * saved templates in their own group beneath.
 *
 * The phone layout of iOS `ListsIndexView`. Tapping a list opens its detail; swiping isn't
 * used here because a row already carries its own overflow affordance and the whole row is
 * a navigation target.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ListsIndexScreen(
    model: ListsIndexModel,
    onOpen: (ListSummary) -> Unit,
    modifier: Modifier = Modifier,
    /** Opens the capture sheet. Wave C owns that screen; until then the host decides. */
    onCapture: (dictate: Boolean) -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    val lists by model.listsState.collectAsStateWithLifecycle()
    val templates by model.templatesState.collectAsStateWithLifecycle()
    val loading by model.loadingState.collectAsStateWithLifecycle()
    val failed by model.errorState.collectAsStateWithLifecycle()

    var creating by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<ListSummary?>(null) }

    LaunchedEffect(Unit) { model.load() }

    Column(modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Lists", style = WF.type.title, color = WF.colors.ink) },
            actions = {
                Icon(
                    imageVector = Icons.Filled.Add,
                    contentDescription = "New list",
                    tint = WF.colors.ink,
                    modifier = Modifier
                        .padding(end = 12.dp)
                        .clickable { creating = true },
                )
            },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = WF.colors.canvas),
        )

        PullToRefreshBox(
            isRefreshing = loading && lists.isNotEmpty(),
            onRefresh = { scope.launch { model.load() } },
            modifier = Modifier.fillMaxSize(),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                // Screens scroll UNDER the tab bar, so the last row owes it clearance.
                contentPadding = PaddingValues(bottom = WF.spacing.tabBarClearance),
                verticalArrangement = Arrangement.spacedBy(WF.spacing.md),
            ) {
                item {
                    AICaptureBar(
                        placeholder = "Add milk & eggs to groceries…",
                        onTap = { onCapture(false) },
                        onMic = { onCapture(true) },
                        modifier = Modifier.padding(horizontal = 18.dp, vertical = 8.dp),
                    )
                }

                if (lists.isNotEmpty()) {
                    item { SectionLabel("Your lists", Modifier.padding(horizontal = 20.dp)) }
                }

                if (loading && lists.isEmpty()) {
                    item { WaffledLoading(top = 40.dp) }
                } else if (lists.isEmpty()) {
                    item {
                        WaffledEmptyState(
                            emoji = if (failed) "😕" else "🗒️",
                            title = if (failed) "Couldn’t load your lists" else "No lists yet",
                            message = if (failed) "Pull to refresh to try again." else "Add one with the + button.",
                        )
                    }
                }

                items(lists, key = { it.id }) { list ->
                    ListIndexRow(
                        list = list,
                        onOpen = { onOpen(list) },
                        // Grocery is auto-built, so it can't be renamed or deleted.
                        onEdit = if (list.isGrocery) null else ({ editing = list }),
                        onDelete = if (list.isGrocery) null else ({ scope.launch { model.delete(list) } }),
                    )
                }

                if (templates.isNotEmpty()) {
                    item {
                        SectionLabel("Templates", Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
                    }
                    items(templates, key = { "tpl:${it.id}" }) { tpl ->
                        ListIndexRow(
                            list = tpl,
                            onOpen = { onOpen(tpl) },
                            onEdit = { editing = tpl },
                            onDelete = { scope.launch { model.deleteTemplate(tpl) } },
                        )
                    }
                }
            }
        }
    }

    if (creating) {
        NewListSheet(
            templates = templates,
            onDismiss = { creating = false },
            onCreate = { name, emoji ->
                creating = false
                scope.launch { model.create(name, emoji)?.let(onOpen) }
            },
            onApply = { tpl, name ->
                creating = false
                scope.launch { model.applyTemplate(tpl, name)?.let(onOpen) }
            },
            onDeleteTemplate = { tpl -> scope.launch { model.deleteTemplate(tpl) } },
        )
    }

    editing?.let { list ->
        EditListSheet(
            list = list,
            onDismiss = { editing = null },
            onSave = { name, emoji ->
                editing = null
                scope.launch { model.update(list, name, emoji) }
            },
        )
    }
}

/**
 * One row of the index.
 *
 * The overflow actions are a native `DropdownMenu` rather than a swipe: Compose's
 * `SwipeToDismissBox` gives one action per direction, and the row's primary gesture is
 * already a tap-to-open — a long-press menu keeps Edit and Delete equally reachable and
 * equally undoable-by-not-tapping.
 */
@Composable
private fun ListIndexRow(
    list: ListSummary,
    onOpen: () -> Unit,
    onEdit: (() -> Unit)?,
    onDelete: (() -> Unit)?,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Box(Modifier.padding(horizontal = 18.dp)) {
        WaffledCard(padding = 15.dp, modifier = Modifier.clickable(onClick = onOpen)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                WaffledEmojiTile(emoji = list.emoji ?: if (list.isTemplate) "📑" else "📝")
                Spacer(Modifier.width(13.dp))
                Text(
                    text = list.name,
                    style = WF.type.cardTitle,
                    color = WF.colors.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = "${list.itemCount}",
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
                if (onEdit != null || onDelete != null) {
                    Box {
                        Icon(
                            imageVector = Icons.Filled.MoreVert,
                            contentDescription = "List actions",
                            tint = WF.colors.ink3,
                            modifier = Modifier
                                .padding(start = 10.dp)
                                .size(20.dp)
                                .clickable { menuOpen = true },
                        )
                        ListRowMenu(
                            expanded = menuOpen,
                            onDismiss = { menuOpen = false },
                            items = buildList {
                                onEdit?.let { add(MenuAction("Edit", Icons.Filled.Edit, it)) }
                                onDelete?.let {
                                    add(MenuAction(if (list.isTemplate) "Delete template" else "Delete", Icons.Filled.Delete, it, destructive = true))
                                }
                            },
                        )
                    }
                } else {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = null,
                        tint = WF.colors.ink3,
                        modifier = Modifier.padding(start = 6.dp),
                    )
                }
            }
        }
    }
}

/**
 * New list — name + optional emoji, with an inline "Or start from a template" picker.
 *
 * You **type a name, optionally pick a template, then tap Create** — a template is a
 * selection, not an immediate action, so there's no accidental list on every tap. Picking
 * one pre-fills the name if you haven't typed one.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewListSheet(
    templates: List<ListSummary>,
    onDismiss: () -> Unit,
    onCreate: (name: String, emoji: String) -> Unit,
    onApply: (template: ListSummary, name: String) -> Unit,
    onDeleteTemplate: (ListSummary) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var emoji by remember { mutableStateOf("") }
    var selectedTemplateId by remember { mutableStateOf<String?>(null) }
    val selected = templates.firstOrNull { it.id == selectedTemplateId }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Text("New list", style = WF.type.title, color = WF.colors.ink)

            NameAndEmojiFields(
                name = name,
                onName = { name = it },
                emoji = emoji,
                onEmoji = { emoji = it },
                namePlaceholder = "Camping gear",
            )

            if (templates.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "Or start from a template",
                        style = WF.type.label,
                        color = WF.colors.ink3,
                    )
                    Text(
                        "Tap to select · long-press to delete",
                        style = WF.type.caption,
                        color = WF.colors.ink3,
                    )
                    ChipFlow {
                        for (tpl in templates) {
                            var menu by remember(tpl.id) { mutableStateOf(false) }
                            Box {
                                ListChip(
                                    label = tpl.name,
                                    leading = tpl.emoji ?: "📑",
                                    selected = tpl.id == selectedTemplateId,
                                    onLongClick = { menu = true },
                                    onClick = {
                                        if (tpl.id == selectedTemplateId) {
                                            selectedTemplateId = null
                                        } else {
                                            selectedTemplateId = tpl.id
                                            // Pre-fill so you can just hit Create.
                                            if (name.isBlank()) name = tpl.name
                                        }
                                    },
                                )
                                ListRowMenu(
                                    expanded = menu,
                                    onDismiss = { menu = false },
                                    items = listOf(
                                        MenuAction(
                                            label = "Delete template",
                                            icon = Icons.Filled.Delete,
                                            onClick = {
                                                if (selectedTemplateId == tpl.id) selectedTemplateId = null
                                                onDeleteTemplate(tpl)
                                            },
                                            destructive = true,
                                        ),
                                    ),
                                )
                            }
                        }
                    }
                }
            }

            WaffledPrimaryCTA(
                label = if (selected == null) "Create list" else "Create from template",
                onClick = {
                    val trimmed = name.trim()
                    if (selected != null) onApply(selected, trimmed) else onCreate(trimmed, emoji.trim())
                },
                isDisabled = name.isBlank(),
            )
        }
    }
}

/** Rename a list / change its emoji. PATCHes on Save; a cleared emoji really clears. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditListSheet(
    list: ListSummary,
    onDismiss: () -> Unit,
    onSave: (name: String, emoji: String) -> Unit,
) {
    var name by remember(list.id) { mutableStateOf(list.name) }
    var emoji by remember(list.id) { mutableStateOf(list.emoji.orEmpty()) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Text("Edit list", style = WF.type.title, color = WF.colors.ink)
            NameAndEmojiFields(
                name = name,
                onName = { name = it },
                emoji = emoji,
                onEmoji = { emoji = it },
                namePlaceholder = "List name",
            )
            WaffledPrimaryCTA(
                label = "Save",
                onClick = { onSave(name.trim(), emoji.trim()) },
                isDisabled = name.isBlank(),
            )
        }
    }
}

@Composable
private fun NameAndEmojiFields(
    name: String,
    onName: (String) -> Unit,
    emoji: String,
    onEmoji: (String) -> Unit,
    namePlaceholder: String,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            SectionLabel("List name")
            ListTextField(
                value = name,
                onValueChange = onName,
                placeholder = namePlaceholder,
                capitalization = KeyboardCapitalizationWords,
            )
        }
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            SectionLabel("Emoji")
            ListTextField(
                value = emoji,
                // Two code points is enough for every emoji this field accepts, including
                // the ones built from a base plus a modifier.
                onValueChange = { onEmoji(it.take(4)) },
                placeholder = "📝",
                modifier = Modifier.width(72.dp),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
        }
    }
}

private val KeyboardCapitalizationWords = androidx.compose.ui.text.input.KeyboardCapitalization.Words
