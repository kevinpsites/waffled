package app.waffled.feature.pantry

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledImages
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledMenuPill
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.wfChip
import app.waffled.core.model.WaffledModule
import app.waffled.core.sync.ModuleGate
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch

/**
 * The Pantry — on-hand inventory, phone layout.
 *
 * Search, filter chips (All / Use soon / Low / Been a while / each section), a sort menu,
 * and a card per item with a ± stepper, colour-coded allergen badges and an expiry tag.
 * "Scan" opens the barcode flow; "Add" opens the by-hand editor. The allergen legend sits
 * at the bottom whenever the household actually avoids something.
 *
 * **Scope:** phone only. The iPad sidebar layout (a nav rail plus a two-column grid) is a
 * later phase.
 *
 * Pantry is an **optional module, default OFF** — this screen assumes the caller has
 * already checked [ModuleGate.isOn]; [PantryModuleGate] is the wrapper that does it.
 *
 * Navigation into the item detail and the scan flow is handled **inside** this screen
 * rather than through the app's nav host, because a feature module doesn't own the nav
 * graph. Both honour the system back gesture.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PantryScreen(
    model: PantryModel,
    modifier: Modifier = Modifier,
    /** Meals is a separate module; when it is off, "Cook from your pantry" doesn't apply. */
    mealsEnabled: Boolean = false,
    /**
     * Cross-module seams. Pantry owns nothing under `api/recipes` or `api/meals`, and the
     * Recipes and Meals modules are built in parallel — so every affordance that would
     * leave the pantry is hoisted to the integrator. A null hides that affordance rather
     * than showing a dead control.
     */
    hooks: CookHooks = CookHooks(),
) {
    val scope = rememberCoroutineScope()
    val snapshot by model.state.collectAsStateWithLifecycle()
    val loading by model.loadingState.collectAsStateWithLifecycle()
    val failed by model.errorState.collectAsStateWithLifecycle()
    val config by model.config.collectAsStateWithLifecycle()

    var query by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf<PantryFilter>(PantryFilter.All) }
    var sort by remember { mutableStateOf(PantrySort.Expiring) }
    var editing by remember { mutableStateOf<PantryEditorMode?>(null) }
    var openItemId by remember { mutableStateOf<String?>(null) }
    var scanning by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { model.load() }

    val rows = snapshot.value.orEmpty()
    // Recomputed only when the inputs change — never per row, and never per frame. Every
    // predicate inside is a field read off the row derived at load time.
    val shown = remember(rows, filter, query, sort) { model.shown(filter, query, sort) }
    val usedUp = remember(rows, query) { model.usedUp(query) }
    val counts = remember(rows) { model.counts() }
    val avoid = remember(config) { model.avoidSet }
    // Memoized like the rest: it walks every item (and calls `counts()` again), so left
    // unwrapped it would rerun on every search keystroke.
    val sections = remember(rows) { model.sectionsInUse() }

    // --- the scan flow and the item detail are full-screen states of this screen ---

    if (scanning) {
        BackHandler { scanning = false }
        PantryScanScreen(
            model = model,
            onClose = {
                scanning = false
                scope.launch { model.load() }
            },
        )
        return
    }

    val openRow = openItemId?.let { id -> rows.firstOrNull { it.id == id } }
    if (openItemId != null) {
        BackHandler { openItemId = null }
        if (openRow == null) {
            // The item was deleted from the detail; fall back to the list.
            LaunchedEffect(rows) { openItemId = null }
        } else {
            PantryItemDetailScreen(
                row = openRow,
                model = model,
                onBack = { openItemId = null },
            )
            return
        }
    }

    Column(modifier.fillMaxSize().background(WF.colors.canvas)) {
        HeadBar(
            query = query,
            onQuery = { query = it },
            itemCount = counts.all,
            onScan = { scanning = true },
            onAdd = { editing = PantryEditorMode.Add },
        )

        FilterChips(
            counts = counts,
            sections = sections,
            icons = config.locationIcons.orEmpty(),
            selected = filter,
            onSelect = { filter = it },
        )

        PullToRefreshBox(
            isRefreshing = loading,
            onRefresh = { scope.launch { model.load() } },
            modifier = Modifier.weight(1f),
        ) {
            when {
                !snapshot.loaded -> WaffledLoading()

                failed && rows.isEmpty() -> ErrorState { scope.launch { model.load() } }

                else -> LazyColumn(
                    contentPadding = PaddingValues(
                        start = 16.dp,
                        end = 16.dp,
                        top = 4.dp,
                        bottom = WF.spacing.tabBarClearance,
                    ),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (mealsEnabled) {
                        item("cook") { CookFromPantryCard(model, hooks) }
                    }

                    item("head") {
                        ListHead(
                            title = filter.label(),
                            count = shown.size,
                            sort = sort,
                            onSort = { sort = it },
                        )
                    }

                    if (shown.isEmpty() && usedUp.isEmpty()) {
                        item("empty") {
                            WaffledEmptyState(
                                emoji = "🥫",
                                title = if (query.isBlank()) {
                                    "Nothing here yet"
                                } else {
                                    "Nothing matches your search"
                                },
                                message = if (query.isBlank()) "Add what's on hand." else null,
                            )
                        }
                    }

                    items(shown, key = { it.id }) { row ->
                        PantryItemCard(
                            row = row,
                            avoid = avoid,
                            sectionIcon = config.locationIcons.orEmpty()[row.section],
                            onOpen = { openItemId = row.id },
                            onEdit = { editing = PantryEditorMode.Edit(row) },
                            onDelete = { scope.launch { model.delete(row) } },
                            onStep = { delta -> scope.launch { model.adjust(row, delta) } },
                        )
                    }

                    if (usedUp.isNotEmpty()) {
                        item("usedUpHead") {
                            Text(
                                "Used up",
                                Modifier.padding(top = 6.dp),
                                style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
                                color = WF.colors.ink3,
                            )
                        }
                        items(usedUp, key = { "used-" + it.id }) { row ->
                            // Restock is only offered when the integrator wired a grocery
                            // hook — adding to a list is a Lists route this module doesn't own.
                            val restock: (() -> Unit)? = hooks.onAddToGroceryList?.let { add ->
                                {
                                    scope.launch {
                                        add(row.name)
                                        model.delete(row)
                                    }
                                }
                            }
                            UsedUpCard(
                                row = row,
                                onRestock = restock,
                                onRemove = { scope.launch { model.delete(row) } },
                            )
                        }
                    }

                    if (avoid.isNotEmpty()) {
                        item("legend") {
                            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                HorizontalDivider(color = WF.colors.hair)
                                AllergenKey(avoid)
                            }
                        }
                    }
                }
            }
        }
    }

    editing?.let { mode ->
        PantryItemEditorSheet(
            mode = mode,
            locations = config.locations,
            api = model.api,
            onDismiss = { editing = null },
            onLocationsChanged = { model.load() },
            onSave = { body ->
                when (mode) {
                    PantryEditorMode.Add -> {
                        runCatching { model.api.create(body) }
                        model.load()
                    }
                    is PantryEditorMode.Edit -> model.update(mode.row.id, body)
                }
            },
            onDelete = (mode as? PantryEditorMode.Edit)?.let { edit ->
                { model.delete(edit.row) }
            },
        )
    }
}

/**
 * The module gate.
 *
 * Pantry is optional and **default OFF**, so a household that has never enabled it must
 * not see the surface at all. The server enforces this independently; this is the UX half.
 */
@Composable
fun PantryModuleGate(
    gate: ModuleGate,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    if (gate.isOn(WaffledModule.Pantry)) {
        content()
    } else {
        Box(modifier.fillMaxSize().background(WF.colors.canvas)) {
            WaffledEmptyState(
                emoji = "🥫",
                title = "Pantry is turned off",
                message = "Turn it on in Settings → Modules to track what's on hand.",
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Head bar
// ---------------------------------------------------------------------------

@Composable
private fun HeadBar(
    query: String,
    onQuery: (String) -> Unit,
    itemCount: Int,
    onScan: () -> Unit,
    onAdd: () -> Unit,
) {
    Column(
        Modifier
            .statusBarsPadding()
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("Pantry", style = WF.type.hero, color = WF.colors.ink)
        Row(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            WaffledTextField(
                value = query,
                onValueChange = onQuery,
                modifier = Modifier.weight(1f),
                placeholder = "Search all $itemCount items…",
            )
            PillButton(
                icon = Icons.Filled.QrCodeScanner,
                label = "Scan",
                onClick = onScan,
                filled = false,
            )
            PillButton(
                icon = Icons.Filled.Add,
                label = "Add",
                onClick = onAdd,
                filled = true,
            )
        }
    }
}

/**
 * A small icon+label capsule.
 *
 * Hand-rolled rather than a Material `Button`: `WaffledPrimaryCTA` is full-width by
 * contract and M3's `Button` draws from a colour scheme this app doesn't populate, so it
 * would fight the palette. Two of these sit beside a text field in one row.
 */
@Composable
private fun PillButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
    filled: Boolean,
) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Row(
        Modifier
            .background(if (filled) WF.colors.primary else WF.colors.card, shape)
            .then(if (filled) Modifier else Modifier.border(1.dp, WF.colors.hair, shape))
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            // White is correct on the saturated coral fill; `ink` on the card fill.
            tint = if (filled) Color.White else WF.colors.ink,
            modifier = Modifier.size(15.dp),
        )
        Text(
            label,
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
            color = if (filled) Color.White else WF.colors.ink,
        )
    }
}

// ---------------------------------------------------------------------------
// Filters + head
// ---------------------------------------------------------------------------

private fun PantryFilter.label(): String = when (this) {
    PantryFilter.All -> "All items"
    PantryFilter.UseSoon -> "Use soon"
    PantryFilter.RunningLow -> "Running low"
    PantryFilter.BeenAWhile -> "Been a while"
    is PantryFilter.Location -> name
}

@Composable
private fun FilterChips(
    counts: PantryCounts,
    sections: List<String>,
    icons: Map<String, String>,
    selected: PantryFilter,
    onSelect: (PantryFilter) -> Unit,
) {
    Row(
        Modifier
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        FilterChip("All", counts.all, PantryFilter.All, selected, onSelect)
        FilterChip("Use soon", counts.useSoon, PantryFilter.UseSoon, selected, onSelect)
        FilterChip("Low", counts.runningLow, PantryFilter.RunningLow, selected, onSelect)
        if (counts.beenAWhile > 0) {
            FilterChip("Been a while", counts.beenAWhile, PantryFilter.BeenAWhile, selected, onSelect)
        }
        sections.forEach { section ->
            val icon = icons[section]
            FilterChip(
                label = if (icon != null) "$icon $section" else section,
                count = counts.byLocation[section] ?: 0,
                filter = PantryFilter.Location(section),
                selected = selected,
                onSelect = onSelect,
            )
        }
        Spacer(Modifier.width(4.dp))
    }
}

@Composable
private fun FilterChip(
    label: String,
    count: Int,
    filter: PantryFilter,
    selected: PantryFilter,
    onSelect: (PantryFilter) -> Unit,
) {
    val on = filter == selected
    Row(
        Modifier
            .wfChip(selected = on)
            .clickable { onSelect(filter) }
            .padding(horizontal = 12.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
            color = if (on) WF.colors.ink else WF.colors.ink2,
        )
        Text(
            count.toString(),
            style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold),
            color = if (on) WF.colors.primaryD else WF.colors.ink3,
        )
    }
}

@Composable
private fun ListHead(
    title: String,
    count: Int,
    sort: PantrySort,
    onSort: (PantrySort) -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = WF.type.sectionTitle, color = WF.colors.ink)
        Spacer(Modifier.width(8.dp))
        Text(
            "· $count item" + if (count == 1) "" else "s",
            style = WF.type.bodySmall,
            color = WF.colors.ink3,
        )
        Spacer(Modifier.weight(1f))
        Box {
            // The app-wide compact menu family (see `Components.kt`) rather than a third
            // control: iOS uses a segmented picker, which has no Material twin that fits.
            WaffledMenuPill(sort.label, Modifier.clickable { menu = true })
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                PantrySort.entries.forEach { option ->
                    DropdownMenuItem(
                        text = { Text(option.label) },
                        onClick = {
                            onSort(option)
                            menu = false
                        },
                    )
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * One item card.
 *
 * A tap opens the detail; a long-press opens the row's overflow — Edit, Delete.
 *
 * The overflow is a native `DropdownMenu`, not a swipe. Material3's `SwipeToDismissBox`
 * gives one action per direction and dismisses the row wholesale, which fits Delete but
 * not Edit; a bespoke two-action swipe is exactly the hand-rolled gesture the iOS pantry
 * had to rework, and Lists already settled on this menu for the same reason. Keeping both
 * modules on one gesture vocabulary is the point.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PantryItemCard(
    row: PantryRow,
    avoid: Set<String>,
    sectionIcon: String?,
    onOpen: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onStep: (Double) -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(WF.radius.md)

    Row(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            // A red hairline is the only whole-card signal that this item carries an
            // allergen the household avoids — visible before any badge is read.
            .border(
                1.dp,
                if (row.flagged.isEmpty()) WF.colors.hair else WF.colors.danger.copy(alpha = 0.4f),
                shape,
            )
            .clip(shape)
            .combinedClickableCompat(onClick = onOpen, onLongClick = { menu = true })
            .padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Thumb(row)

        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                row.name,
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = if (sectionIcon != null) "$sectionIcon ${row.section}" else row.section,
                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium),
                    color = WF.colors.ink3,
                    maxLines = 1,
                )
                row.item.allergens?.takeIf { it.isNotEmpty() }?.let {
                    AllergenBadges(it, avoid, traces = row.item.traces.orEmpty())
                }
                row.expiryLabel?.let {
                    Text(
                        it,
                        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                        color = row.expiryTone.color(),
                        maxLines = 1,
                    )
                }
                if (row.isOld) row.ageLabel?.let { AgePill(it) }
            }
        }

        Stepper(row, onStep)

        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(
                text = { Text("Edit") },
                leadingIcon = { Icon(Icons.Filled.Edit, null, tint = WF.colors.ink2) },
                onClick = {
                    menu = false
                    onEdit()
                },
            )
            DropdownMenuItem(
                text = { Text("Delete", color = WF.colors.danger) },
                leadingIcon = { Icon(Icons.Filled.Delete, null, tint = WF.colors.danger) },
                onClick = {
                    menu = false
                    onDelete()
                },
            )
        }
    }
}

/** The product photo, or the name-derived emoji when there isn't one. */
@Composable
internal fun Thumb(row: PantryRow, size: androidx.compose.ui.unit.Dp = 40.dp) {
    val shape = RoundedCornerShape(10.dp)
    Box(
        Modifier
            .size(size)
            .background(WF.colors.panel, shape)
            .clip(shape),
        contentAlignment = Alignment.Center,
    ) {
        if (row.imageUrl != null) {
            val context = LocalContext.current
            AsyncImage(
                // Keyed on the storage PATH via the shared loader — a signed URL's
                // expiry would otherwise change the key on every load and the memory
                // cache would never hit, which is the documented lazy-list trap.
                model = WaffledImages.request(context, row.imageUrl, row.imageCacheKey),
                contentDescription = row.name,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Text(row.emoji, style = TextStyle(fontSize = (size.value * 0.52f).sp))
        }
    }
}

@Composable
private fun Stepper(row: PantryRow, onStep: (Double) -> Unit) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StepperGlyph(Icons.Filled.Remove, "One fewer ${row.name}", { onStep(-1.0) })
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                row.item.amount.ifBlank { "—" },
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink,
                maxLines = 1,
            )
            if (row.item.unit.isNotBlank()) {
                Text(
                    row.item.unit,
                    style = TextStyle(fontSize = 9.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink3,
                    maxLines = 1,
                )
            }
        }
        StepperGlyph(Icons.Filled.Add, "One more ${row.name}", { onStep(1.0) })
    }
}

/**
 * A used-up row.
 *
 * "＋ Shopping list" is only offered when the integrator has wired a grocery hook —
 * adding to a list is a Lists route, which this module doesn't own. Without it the row
 * still removes cleanly.
 */
@Composable
private fun UsedUpCard(row: PantryRow, onRestock: (() -> Unit)?, onRemove: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.md)
    Column(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clip(shape)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            row.name,
            style = TextStyle(fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink2,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (onRestock != null) {
                Text(
                    "＋ Shopping list",
                    Modifier
                        .background(WF.colors.primary, RoundedCornerShape(WF.radius.pill))
                        .clip(RoundedCornerShape(WF.radius.pill))
                        .clickable(onClick = onRestock)
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                    style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
                    color = Color.White,
                )
            }
            Text(
                "Remove",
                Modifier
                    .border(1.dp, WF.colors.hair, RoundedCornerShape(WF.radius.pill))
                    .clip(RoundedCornerShape(WF.radius.pill))
                    .clickable(onClick = onRemove)
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink2,
            )
        }
    }
}

@Composable
private fun ErrorState(onRetry: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(top = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            "Pantry isn't enabled, or couldn't load.",
            style = WF.type.label,
            color = WF.colors.ink2,
        )
        Text(
            "Turn it on in Settings → Modules.",
            style = WF.type.bodySmall,
            color = WF.colors.ink3,
        )
        Text(
            "Try again",
            Modifier.clickable(onClick = onRetry).padding(8.dp),
            style = WF.type.label,
            color = WF.colors.primary,
        )
    }
}

/** `combinedClickable` behind one opt-in, so the call sites stay readable. */
@OptIn(ExperimentalFoundationApi::class)
private fun Modifier.combinedClickableCompat(
    onClick: () -> Unit,
    onLongClick: () -> Unit,
): Modifier = this.combinedClickable(onClick = onClick, onLongClick = onLongClick)
