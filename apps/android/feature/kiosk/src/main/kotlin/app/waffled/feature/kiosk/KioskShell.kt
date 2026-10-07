package app.waffled.feature.kiosk

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.FormatListBulleted
import androidx.compose.material.icons.filled.Autorenew
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.EditCalendar
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.Photo
import androidx.compose.material.icons.filled.Restaurant
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.TrackChanges
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledIcons
import app.waffled.core.design.wfShadow1
import app.waffled.core.model.Person
import app.waffled.core.sync.ModuleGate
import app.waffled.core.sync.SyncManager
import kotlinx.coroutines.delay

/** What a page slot receives: where it is, its reset counter, and a way to jump. */
class KioskPage(
    val nav: KioskNav,
    /** Key your page's root on this: it bumps when the open rail item is re-tapped. */
    val resetKey: Int,
    val navigate: (KioskNav) -> Unit,
)

/** A page `app` supplies for one rail destination (Today, Calendar, Goals…). */
typealias KioskPageContent = @Composable (KioskPage) -> Unit

val KioskNav.icon: ImageVector
    get() = when (this) {
        KioskNav.Today -> Icons.Filled.Home
        KioskNav.Calendar -> Icons.Filled.CalendarMonth
        KioskNav.Tasks -> Icons.Filled.Checklist
        KioskNav.Rewards -> Icons.Filled.Star
        KioskNav.Goals -> Icons.Filled.TrackChanges
        KioskNav.Family -> Icons.Filled.Group
        KioskNav.Meals -> Icons.Filled.Restaurant
        KioskNav.Lists -> Icons.AutoMirrored.Filled.FormatListBulleted
        KioskNav.Pantry -> Icons.Filled.Inventory2
        KioskNav.Rhythms -> Icons.Filled.Autorenew
        KioskNav.Planning -> Icons.Filled.EditCalendar
        KioskNav.Photos -> Icons.Filled.Photo
        KioskNav.More -> Icons.Filled.GridView
        KioskNav.Settings -> Icons.Filled.Settings
    }

/**
 * The tablet root: [KioskShell] under the idle screensaver, with the branded boot cover
 * for the cold-start window. If sync hasn't landed after [KioskBoot.STALL_AFTER_MS] the
 * cover offers Retry / Sign out, so a device whose token can't authenticate is never
 * trapped on it.
 */
@Composable
fun KioskRoot(
    sync: SyncManager,
    kiosk: KioskMode,
    railStore: KioskRailStore,
    rewardsOn: Boolean,
    screensaver: ScreensaverModel,
    baseUrl: String,
    pages: Map<KioskNav, KioskPageContent>,
    onCapture: () -> Unit,
    onRetry: () -> Unit,
    onSignOut: () -> Unit,
    modifier: Modifier = Modifier,
    /** A plain-language sync error for the stalled cover, when `app` has one. */
    bootDetail: String? = null,
    screensaverMotion: Boolean = true,
    returnToPicker: suspend () -> Unit = { kiosk.returnToPicker() },
) {
    val members by sync.members.collectAsState()
    val syncState by sync.state.collectAsState()
    val modules by sync.modules.collectAsState()
    val current by sync.currentPerson.collectAsState()
    val events by sync.visibleEvents.collectAsState()
    val zone by sync.householdZone.collectAsState()
    val kioskState by kiosk.state.collectAsState()
    val railRaw by railStore.raw.collectAsState()
    var pendingPicker by remember { mutableStateOf(false) }

    val booting = KioskBoot.isBooting(members.isEmpty(), syncState)
    var stalled by remember { mutableStateOf(false) }
    // Keyed on retries too: a Retry that doesn't land must re-arm the escape.
    var retries by remember { mutableStateOf(0) }
    LaunchedEffect(booting, retries) {
        stalled = false
        if (booting) {
            delay(KioskBoot.STALL_AFTER_MS)
            stalled = true
        }
    }
    LaunchedEffect(pendingPicker) {
        if (pendingPicker) { returnToPicker(); pendingPicker = false }
    }

    Box(modifier.fillMaxSize()) {
        KioskScreensaverHost(
            model = screensaver,
            isShared = kioskState.isShared,
            events = events,
            zone = zone,
            baseUrl = baseUrl,
            onReturnToPicker = { pendingPicker = true },
            motion = screensaverMotion,
        ) {
            KioskShell(
                current = current,
                modules = modules,
                rewardsOn = rewardsOn,
                isShared = kioskState.isShared,
                railRaw = railRaw,
                pages = pages,
                onCapture = onCapture,
                onSwitchProfile = { pendingPicker = true },
            )
        }
        AnimatedVisibility(visible = booting, enter = fadeIn(tween(400)), exit = fadeOut(tween(400))) {
            KioskBootCover(stalled = stalled, detail = bootDetail, onRetry = { retries++; onRetry() }, onSignOut = onSignOut)
        }
    }
}

/**
 * The tablet shell — a fixed left rail + detail pane in landscape, a bottom bar with a
 * centred capture button in portrait (mirroring the web `KioskLayout`). Today, Calendar
 * and every feature page are [pages] slots from `app`; More is built in.
 */
@Composable
fun KioskShell(
    current: Person?,
    modules: ModuleGate,
    rewardsOn: Boolean,
    isShared: Boolean,
    railRaw: String?,
    pages: Map<KioskNav, KioskPageContent>,
    onCapture: () -> Unit,
    onSwitchProfile: () -> Unit,
    modifier: Modifier = Modifier,
    initial: KioskNav = KioskNav.Today,
) {
    // Saveable: a rotation recreates the activity, and must not bounce the user to Today.
    var nav by rememberSaveable(stateSaver = NavSaver) { mutableStateOf(KioskShellNav(selection = initial)) }
    val pinned = KioskRail.pinned(railRaw, modules, rewardsOn)
    LaunchedEffect(modules, rewardsOn) { nav = nav.corrected(modules, rewardsOn) }

    // The WINDOW size, not this node's: the keyboard shrinks content but not the window,
    // so typing can't flip a portrait tablet into the landscape layout.
    val window = LocalWindowInfo.current.containerSize
    val portrait = KioskShellLayout.isPortrait(window.width.toFloat(), window.height.toFloat(), KioskInsets())

    val detail: @Composable () -> Unit = {
        val selection = nav.selection
        val page = KioskPage(selection, nav.resetKey(selection)) { nav = nav.navigate(it) }
        // Edge-to-edge: pages start below the status bar. Not the IME inset — pages own that.
        Box(Modifier.fillMaxSize().background(WF.colors.canvas).windowInsetsPadding(WindowInsets.statusBars)) {
            key(selection, page.resetKey) {
                when {
                    selection == KioskNav.More -> KioskMoreView(KioskRail.overflow(railRaw, modules, rewardsOn), page.navigate)
                    else -> pages[selection]?.invoke(page) ?: MissingPage(selection)
                }
            }
        }
    }

    Box(modifier.fillMaxSize().background(WF.colors.canvas)) {
        if (portrait) {
            Column(Modifier.fillMaxSize()) {
                Box(Modifier.weight(1f).fillMaxWidth()) { detail() }
                BottomBar(nav.selection, pinned, current, isShared, onTap = { nav = nav.tap(it) }, onCapture, onSwitchProfile)
            }
        } else {
            Row(Modifier.fillMaxSize()) {
                Rail(nav.selection, pinned, current, isShared, onTap = { nav = nav.tap(it) }, onCapture, onSwitchProfile)
                Box(Modifier.width(1.dp).fillMaxHeight().background(WF.colors.hair))
                Box(Modifier.weight(1f).fillMaxHeight()) { detail() }
            }
        }
    }
}

private val NavSaver = androidx.compose.runtime.saveable.Saver<KioskShellNav, String>(
    save = { it.selection.raw },
    restore = { KioskShellNav(selection = KioskNav.fromRaw(it) ?: KioskNav.Today) },
)

@Composable
private fun MissingPage(nav: KioskNav) {
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(KioskMore.descriptor(nav).emoji, style = TextStyle(fontSize = 44.sp))
        Text("${nav.label} isn’t available on this tablet yet.", style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink2)
    }
}

@Composable
private fun Rail(
    selection: KioskNav,
    pinned: List<KioskNav>,
    current: Person?,
    isShared: Boolean,
    onTap: (KioskNav) -> Unit,
    onCapture: () -> Unit,
    onSwitchProfile: () -> Unit,
) {
    Column(
        Modifier
            .width(120.dp)
            .fillMaxHeight()
            .background(WF.colors.panel)
            .windowInsetsPadding(WindowInsets.statusBars)
            .windowInsetsPadding(WindowInsets.navigationBars)
            .padding(start = 10.dp, end = 10.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Spacer(Modifier.height(12.dp))
        (listOf(KioskNav.Today, KioskNav.Calendar) + pinned + KioskNav.More).forEach { item ->
            RailItem(item, KioskRail.isHighlighted(item, selection, pinned)) { onTap(item) }
        }
        Spacer(Modifier.weight(1f))
        val shape = RoundedCornerShape(14.dp)
        Column(
            Modifier.fillMaxWidth().padding(bottom = 4.dp).wfShadow1(shape).clip(shape).background(WF.colors.primary)
                .clickable(onClick = onCapture).padding(vertical = 11.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            // White on the saturated coral fill.
            Icon(WaffledIcons.Sparkles, "Add anything", tint = Color.White, modifier = Modifier.size(20.dp))
            Text("Add", style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold), color = Color.White)
        }
        current?.let { UserChip(it, isShared, avatar = 40.dp, ringed = true, onSwitchProfile) }
        RailItem(KioskNav.Settings, KioskRail.isHighlighted(KioskNav.Settings, selection, pinned)) { onTap(KioskNav.Settings) }
    }
}

@Composable
private fun RailItem(item: KioskNav, on: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(14.dp)
    val tint = if (on) WF.colors.primary else WF.colors.ink3
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (on) WF.colors.card else Color.Transparent)
            .border(1.dp, if (on) WF.colors.hair else Color.Transparent, shape)
            .clickable(onClick = onClick)
            .padding(vertical = 11.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Icon(item.icon, null, tint = tint, modifier = Modifier.size(21.dp))
        Text(item.label, style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold), color = tint, maxLines = 1)
    }
}

/** On a shared kiosk the chip (with a swap badge) returns to the picker; otherwise it's only an indicator. */
@Composable
private fun UserChip(
    m: Person,
    isShared: Boolean,
    avatar: androidx.compose.ui.unit.Dp,
    ringed: Boolean,
    onSwitchProfile: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .then(if (isShared) Modifier.clickable(onClick = onSwitchProfile) else Modifier)
            .padding(vertical = if (ringed) 8.dp else 5.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(if (ringed) 4.dp else 3.dp),
    ) {
        Box {
            AvatarFromHex(
                m.colorHex,
                m.avatarEmoji ?: "🙂",
                size = avatar,
                modifier = if (ringed) Modifier.border(2.dp, WF.colors.card, CircleShape) else Modifier,
            )
            if (isShared) {
                val badge = if (ringed) 17.dp else 13.dp
                Box(
                    Modifier.align(Alignment.BottomEnd).offset(x = 3.dp, y = 2.dp).size(badge)
                        .background(if (ringed) WF.colors.panel else WF.colors.card, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Box(Modifier.size(badge - 2.dp).background(WF.colors.primary, CircleShape), contentAlignment = Alignment.Center) {
                        Icon(Icons.Filled.SwapHoriz, "Switch profile", tint = Color.White, modifier = Modifier.size(badge - 6.dp))
                    }
                }
            }
        }
        Text(
            KioskBoot.firstName(m.name),
            style = TextStyle(fontSize = 10.5.sp, fontWeight = if (ringed) FontWeight.Bold else FontWeight.SemiBold),
            color = if (ringed) WF.colors.ink2 else WF.colors.ink3,
            maxLines = 1,
        )
    }
}

@Composable
private fun BottomBar(
    selection: KioskNav,
    pinned: List<KioskNav>,
    current: Person?,
    isShared: Boolean,
    onTap: (KioskNav) -> Unit,
    onCapture: () -> Unit,
    onSwitchProfile: () -> Unit,
) {
    val items = KioskRail.bottomBarItems(pinned)
    // The user chip rides at the end, like the rail; the capture button splits the row.
    val count = items.size + if (current != null) 1 else 0
    val mid = KioskRail.captureSplit(count)
    Column(Modifier.fillMaxWidth().background(WF.colors.card)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(WF.colors.hair))
        Row(
            Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).padding(start = 6.dp, end = 6.dp, top = 8.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            for (i in 0 until count) {
                if (i == mid) CaptureFab(onCapture)
                val entry = items.getOrNull(i)
                if (entry != null) {
                    val on = KioskRail.isHighlighted(entry, selection, pinned)
                    val tint = if (on) WF.colors.primary else WF.colors.ink3
                    Column(
                        Modifier.weight(1f).clickable { onTap(entry) }.padding(vertical = 5.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Icon(entry.icon, null, tint = tint, modifier = Modifier.size(20.dp))
                        Text(entry.label, style = TextStyle(fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold), color = tint, maxLines = 1)
                    }
                } else if (current != null) {
                    UserChip(current, isShared, avatar = 25.dp, ringed = false, onSwitchProfile, Modifier.weight(1f))
                }
            }
            if (mid >= count) CaptureFab(onCapture)
        }
    }
}

@Composable
private fun CaptureFab(onCapture: () -> Unit) {
    Box(
        Modifier
            .padding(horizontal = 8.dp)
            .offset(y = (-16).dp)
            .size(54.dp)
            .wfShadow1(CircleShape)
            .clip(CircleShape)
            .background(WF.colors.primary)
            .clickable(onClick = onCapture),
        contentAlignment = Alignment.Center,
    ) { Icon(WaffledIcons.Sparkles, "Add anything", tint = Color.White, modifier = Modifier.size(22.dp)) }
}

/**
 * The cold-start cover: the mark breathing while the first sync lands, then — once
 * [stalled] — a plain-language "couldn't connect" with Retry and Sign out.
 */
@Composable
fun KioskBootCover(stalled: Boolean, detail: String?, onRetry: () -> Unit, onSignOut: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().background(WF.colors.canvas).clickable(enabled = false) {}, contentAlignment = Alignment.Center) {
        if (!stalled) {
            val pulse by rememberInfiniteTransition(label = "boot").animateFloat(
                initialValue = 0.94f,
                targetValue = 1.08f,
                animationSpec = infiniteRepeatable(tween(1000), RepeatMode.Reverse),
                label = "pulse",
            )
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(18.dp)) {
                KioskMark(116.dp, Modifier.scale(pulse))
                Text("Setting up your family hub…", style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
            }
        } else {
            Column(
                Modifier.padding(28.dp).widthIn(max = 420.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                KioskMark(96.dp, Modifier.alpha(0.7f))
                Text("Couldn’t reach your hub", style = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                Text(
                    "Still connecting to sync. Check this device’s Server address and your network — or sign out and back in.",
                    style = TextStyle(fontSize = 14.sp, textAlign = TextAlign.Center),
                    color = WF.colors.ink3,
                )
                if (!detail.isNullOrEmpty()) {
                    Text(
                        detail,
                        style = TextStyle(fontSize = 11.sp, fontFamily = FontFamily.Monospace, textAlign = TextAlign.Center),
                        color = WF.colors.ink3.copy(alpha = 0.7f),
                        maxLines = 3,
                    )
                }
                Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        "Retry",
                        Modifier.clip(CircleShape).background(WF.colors.card).border(1.dp, WF.colors.hair, CircleShape)
                            .clickable(onClick = onRetry).padding(horizontal = 22.dp, vertical = 12.dp),
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.ink2,
                    )
                    Text(
                        "Sign out",
                        Modifier.clip(CircleShape).background(WF.colors.primary).clickable(onClick = onSignOut)
                            .padding(horizontal = 22.dp, vertical = 12.dp),
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                        color = Color.White,
                    )
                }
            }
        }
    }
}
