package app.waffled.feature.kiosk

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.FamilyColor
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.colorFromHex
import app.waffled.core.design.wfField
import app.waffled.core.model.Person
import app.waffled.core.model.WaffledDates
import app.waffled.core.sync.SyncedEvent
import app.waffled.feature.lists.ListSummary
import app.waffled.feature.lists.ListsIndexModel
import app.waffled.feature.lists.NewListSheet
import app.waffled.feature.today.ProgressBar
import app.waffled.feature.today.RestStateNotice
import kotlinx.coroutines.launch
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** A serif title + subtitle header for kiosk pages, with an optional trailing action. */
@Composable
fun KioskPageHeader(
    title: String,
    subtitle: String,
    modifier: Modifier = Modifier,
    trailing: @Composable RowScope.() -> Unit = {},
) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = WF.type.serif(34.sp), color = WF.colors.ink)
            Text(subtitle, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
        }
        Spacer(Modifier.width(12.dp))
        trailing()
    }
}

/** The coral pill action for a page header's trailing slot. White on the saturated fill. */
@Composable
fun KioskHeaderButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    Row(
        Modifier.clip(CircleShape).background(WF.colors.primary).clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = Color.White, modifier = Modifier.size(14.dp))
        Text(label, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = Color.White)
    }
}

/** The kiosk-sized card surface (iOS `KioskCard`): a [WaffledCard] with roomier padding. */
@Composable
internal fun KioskCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) =
    WaffledCard(modifier = modifier, padding = 20.dp, content = content)

/**
 * The More hub: a launcher grid of every enabled destination that isn't pinned to the
 * rail. Tapping switches the shell's selection — More has no stack of its own.
 */
@Composable
fun KioskMoreView(visible: List<KioskNav>, navigate: (KioskNav) -> Unit, modifier: Modifier = Modifier) {
    LazyVerticalGrid(
        columns = GridCells.Fixed(3),
        modifier = modifier.fillMaxSize().background(WF.colors.canvas),
        contentPadding = PaddingValues(start = 40.dp, end = 40.dp, top = 28.dp, bottom = 40.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            KioskPageHeader("More", "Everything else in your Waffled.", Modifier.padding(bottom = 6.dp))
        }
        items(visible, key = { it.raw }) { nav ->
            val d = KioskMore.descriptor(nav)
            KioskCard(Modifier.clip(RoundedCornerShape(WF.radius.lg)).clickable { navigate(nav) }) {
                Row(verticalAlignment = Alignment.Top) {
                    Box(
                        Modifier.size(60.dp).background(d.accent.color(), RoundedCornerShape(16.dp)),
                        contentAlignment = Alignment.Center,
                    ) { Text(d.emoji, style = TextStyle(fontSize = 30.sp)) }
                    Spacer(Modifier.weight(1f))
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = WF.colors.ink3, modifier = Modifier.size(20.dp))
                }
                Text(d.title, Modifier.padding(top = 16.dp), style = WF.type.serif(22.sp), color = WF.colors.ink)
                Text(
                    d.subtitle,
                    Modifier.padding(top = 3.dp),
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
            }
        }
    }
}

/** Flipping tokens (dark-aware washes), matching the phone Family tiles. */
@Composable
private fun KioskMore.Accent.color(): Color {
    val dark = WF.colors.isDark
    return when (this) {
        KioskMore.Accent.Person1 -> FamilyColor.Person1.tint(dark)
        KioskMore.Accent.Person2 -> FamilyColor.Person2.tint(dark)
        KioskMore.Accent.Person3 -> FamilyColor.Person3.tint(dark)
        KioskMore.Accent.Person4 -> FamilyColor.Person4.tint(dark)
        KioskMore.Accent.Warn -> WF.colors.warnT
        KioskMore.Accent.Success -> WF.colors.successT
        KioskMore.Accent.Info -> WF.colors.infoT
        KioskMore.Accent.Primary -> WF.colors.primaryT
        KioskMore.Accent.Panel -> WF.colors.panel
    }
}

/**
 * The kiosk Family page: one overview card per member (their chores, stars and today),
 * tapping into the person spotlight. Members and [todayEvents] come from PowerSync, so
 * those cards stay useful while the REST chores/stars load.
 *
 * [todayEvents] is the precomputed `eventsByDay[today]` bucket — no per-render date math.
 */
@Composable
fun KioskFamilyView(
    model: KioskFamilyModel,
    members: List<Person>,
    todayEvents: List<SyncedEvent>,
    zone: ZoneId,
    choresEnabled: Boolean,
    onOpenPerson: (String) -> Unit,
    modifier: Modifier = Modifier,
    /** Bump to re-fetch (chores/rewards refresh revisions). */
    refreshKey: Any? = null,
) {
    val scope = rememberCoroutineScope()
    val snap by model.state.collectAsState()
    LaunchedEffect(choresEnabled, refreshKey) { model.load(choresEnabled) }
    val timeFmt = remember(zone) { DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault()).withZone(zone) }
    val byPerson = remember(todayEvents) { todayEvents.groupBy { it.personId } }

    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 300.dp),
        modifier = modifier.fillMaxSize().background(WF.colors.canvas),
        contentPadding = PaddingValues(24.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                KioskPageHeader("Family", "Tap a person to see just their day, chores & goals.")
                if (snap.rest is app.waffled.core.network.RestState.Loading) {
                    WaffledLoading(top = 12.dp)
                } else {
                    RestStateNotice(snap.rest, retry = { scope.launch { model.load(choresEnabled) } })
                }
            }
        }
        items(members, key = { it.id }) { m ->
            PersonCard(m, snap.card(m.id, m.name), choresEnabled, byPerson[m.id].orEmpty(), timeFmt) { onOpenPerson(m.id) }
        }
    }
}

@Composable
private fun PersonCard(
    m: Person,
    card: KioskFamilyModel.Card,
    choresEnabled: Boolean,
    events: List<SyncedEvent>,
    timeFmt: DateTimeFormatter,
    onClick: () -> Unit,
) {
    val tint = colorFromHex(m.colorHex) ?: WF.colors.ink3
    Column(
        Modifier.fillMaxWidth().wfField().clickable(onClick = onClick).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            AvatarFromHex(m.colorHex, m.avatarEmoji ?: "🙂", size = 52.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(m.name, style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink, maxLines = 1)
                Text(
                    m.memberType?.replaceFirstChar { it.titlecase() }.orEmpty(),
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
            }
            card.stars?.let { Text("★ $it", style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.ExtraBold), color = WF.colors.gold) }
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = WF.colors.ink3, modifier = Modifier.size(18.dp))
        }
        if (choresEnabled && card.choresTotal > 0) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row {
                    Text("CHORES", Modifier.weight(1f), style = MiniLabel, color = WF.colors.ink3)
                    Text("${card.choresDone} of ${card.choresTotal}", style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink2)
                }
                ProgressBar(card.choresDone.toDouble() / card.choresTotal, tint = tint, track = tint.copy(alpha = 0.18f))
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Text("TODAY", style = MiniLabel, color = WF.colors.ink3)
            if (events.isEmpty()) {
                Text("Nothing scheduled", style = TextStyle(fontSize = 13.sp), color = WF.colors.ink3)
            } else {
                events.take(3).forEach { ev ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(width = 3.dp, height = 16.dp).background(tint, CircleShape))
                        Text(
                            if (ev.allDay) "All day" else WaffledDates.parseInstant(ev.startsAt)?.let(timeFmt::format).orEmpty(),
                            Modifier.width(62.dp),
                            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                            color = WF.colors.ink3,
                        )
                        Text(
                            ev.title,
                            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                            color = WF.colors.ink,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                if (events.size > 3) {
                    Text("+${events.size - 3} more", style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
                }
            }
        }
    }
}

private val MiniLabel = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Black, letterSpacing = 0.5.sp)

/**
 * The kiosk Lists page: a compact selector across the top, the selected list filling
 * the page. [detail] renders one list (`app` builds `ListDetailScreen` with its model).
 */
@Composable
fun KioskListsView(
    model: ListsIndexModel,
    detail: @Composable (ListSummary) -> Unit,
    modifier: Modifier = Modifier,
    refreshKey: Any? = null,
) {
    val scope = rememberCoroutineScope()
    val lists by model.listsState.collectAsState()
    val templates by model.templatesState.collectAsState()
    val loading by model.loadingState.collectAsState()
    val failed by model.errorState.collectAsState()
    var selectedId by remember { mutableStateOf<String?>(null) }
    var creating by remember { mutableStateOf(false) }
    val selected = lists.firstOrNull { it.id == selectedId } ?: lists.firstOrNull()

    LaunchedEffect(refreshKey) { model.load() }

    Column(modifier.fillMaxSize().background(WF.colors.canvas)) {
        KioskPageHeader(
            "Lists",
            "Groceries, packing, to-dos — whatever the family needs.",
            Modifier.padding(start = 24.dp, end = 24.dp, top = 20.dp, bottom = 4.dp),
        ) { KioskHeaderButton(Icons.Filled.Add, "New list") { creating = true } }
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            lists.forEach { list -> ListPill(list, list.id == selected?.id) { selectedId = list.id } }
            Row(
                Modifier.clip(CircleShape).background(WF.colors.card).border(1.dp, WF.colors.hair, CircleShape)
                    .clickable { creating = true }.padding(horizontal = 14.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Add, null, tint = WF.colors.ink2, modifier = Modifier.size(12.dp))
                Text("New list", style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink2)
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(WF.colors.hair))
        Box(Modifier.fillMaxSize()) {
            if (selected != null) {
                androidx.compose.runtime.key(selected.id) { detail(selected) }
            } else {
                Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (loading) {
                        WaffledLoading(top = 0.dp)
                    } else {
                        Text("🗒️", style = TextStyle(fontSize = 44.sp))
                        Text(
                            if (failed) "Couldn’t load your lists." else "No lists yet — tap “New list”.",
                            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                            color = WF.colors.ink2,
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
            onCreate = { name, emoji -> scope.launch { model.create(name, emoji)?.let { selectedId = it.id } }; creating = false },
            onApply = { tpl, name -> scope.launch { model.applyTemplate(tpl, name)?.let { selectedId = it.id } }; creating = false },
            onDeleteTemplate = { tpl -> scope.launch { model.deleteTemplate(tpl) } },
        )
    }
}

@Composable
private fun ListPill(list: ListSummary, isSelected: Boolean, onClick: () -> Unit) {
    // White on the coral selected fill (saturated), ink2 on the card otherwise.
    val fg = if (isSelected) Color.White else WF.colors.ink2
    Row(
        Modifier
            .clip(CircleShape)
            .background(if (isSelected) WF.colors.primary else WF.colors.card)
            .then(if (isSelected) Modifier else Modifier.border(1.dp, WF.colors.hair, CircleShape))
            .clickable(onClick = onClick)
            .padding(start = 13.dp, end = 14.dp, top = 8.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(list.emoji ?: "📝", style = TextStyle(fontSize = 16.sp))
        Text(list.name, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = fg, maxLines = 1)
        Text(
            "${list.itemCount}",
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.ExtraBold),
            color = if (isSelected) Color.White.copy(alpha = 0.85f) else WF.colors.ink3,
        )
    }
}
