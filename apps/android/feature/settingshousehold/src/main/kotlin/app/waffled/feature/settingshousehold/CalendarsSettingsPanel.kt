package app.waffled.feature.settingshousehold

import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledMenuPill
import app.waffled.core.design.colorFromHex
import app.waffled.core.model.Person
import app.waffled.core.model.WaffledDates
import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.ZoneId

/** Where the provider's consent flow returns; `app` already routes the `waffled` scheme. */
const val CALENDAR_CONNECT_REDIRECT = "waffled://calendar-connected"

/**
 * Settings → Calendars: Countdowns wording, ICS feed subscriptions, and connected Google /
 * Outlook accounts — which calendars sync, who each belongs to, the write-target.
 *
 * OAuth runs in a Chrome Custom Tab. A Custom Tab reports nothing back, so the panel
 * re-reads status when the screen resumes after a connect was started.
 */
@Composable
fun CalendarsSettingsPanel(
    api: SettingsHouseholdApi,
    members: List<Person>,
    isAdmin: Boolean,
    zone: ZoneId,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var status by remember { mutableStateOf<SettingsHouseholdApi.CalendarStatus?>(null) }
    var loading by remember { mutableStateOf(true) }
    var syncing by remember { mutableStateOf(false) }
    var connecting by remember { mutableStateOf<CalendarProvider?>(null) }
    var awaitingConsent by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<FeedEditTarget?>(null) }
    var hideReadOnly by remember { mutableStateOf(true) }
    var syncedOnly by remember { mutableStateOf(false) }
    var search by remember { mutableStateOf("") }
    var collapsed by remember { mutableStateOf(setOf<String>()) }
    val countdowns = remember(api) {
        CountdownSettingsModel(
            fetch = { api.countdownConfig() },
            setSleeps = { api.setCountdownSleeps(it) },
            setHorizon = { api.setCountdownBirthdayHorizon(it) },
        )
    }

    suspend fun load(): Boolean {
        val recovering = status == null
        return try {
            status = api.calendarStatus()
            if (recovering) message = null
            true
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            if (status == null) message = "Couldn’t load calendar settings. Check your connection and try again."
            false
        } finally {
            loading = false
        }
    }

    fun whenLabel(iso: String): String =
        WaffledDates.parseInstant(iso, zone)?.let { WaffledDates.format(it, "MMM d, h:mm a", zone) }.orEmpty()

    fun shortDay(iso: String): String =
        WaffledDates.parseInstant(iso, zone)?.let { WaffledDates.format(it, "MMM d", zone) }.orEmpty()

    fun patch(id: String, body: JsonObject) = scope.launch {
        message = null
        if (runCatchingIo { api.updateCalendarLink(id, body) } == null) {
            message = "That calendar setting wasn’t changed. Check your connection and try again."
            return@launch
        }
        if (!load()) message = "The calendar setting was saved, but the latest status couldn’t be loaded."
    }

    LaunchedEffect(api) { load() }
    LaunchedEffect(countdowns) { countdowns.load() }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        if (awaitingConsent) {
            awaitingConsent = false
            scope.launch { load() }
        }
    }

    val providers = CalendarProvider.offered(
        googleConfigured = status?.configured == true,
        microsoftConfigured = status?.microsoftConfigured == true,
    )

    fun connect(p: CalendarProvider) = scope.launch {
        connecting = p; message = null
        try {
            val url = api.connectCalendarUrl(p, CALENDAR_CONNECT_REDIRECT)
            awaitingConsent = true
            CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(url))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            message = "Couldn’t start the ${p.label} connection."
        } finally {
            connecting = null
        }
    }

    SettingsPage(modifier, spacing = 14.dp) {
        val cd by countdowns.state.collectAsState()
        CountdownsSection(cd, onRetry = { scope.launch { countdowns.load() } },
            onSleeps = { scope.launch { countdowns.changeSleeps(!cd.sleeps) } },
            onHorizon = { scope.launch { countdowns.changeHorizon(it) } })

        val s = status
        when {
            s != null -> {
                if (s.connected) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        if (syncing) {
                            CircularProgressIndicator(Modifier.size(18.dp), color = WF.colors.ink3, strokeWidth = 2.dp)
                        } else {
                            Text(
                                "Sync now",
                                modifier = Modifier.clickable {
                                    scope.launch {
                                        syncing = true; message = null
                                        message = runCatchingIo { api.syncCalendars() }?.let(CalendarsLogic::syncSummary)
                                            ?: "Couldn’t sync — check your connection."
                                        syncing = false
                                        load()
                                    }
                                },
                                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                                color = WF.colors.primary,
                            )
                        }
                    }
                }
                // Above everything: feed syncs report here too, and feeds show with no account.
                message?.let { MessageBanner(it) }
                FeedsSection(
                    feeds = s.feeds,
                    isAdmin = isAdmin,
                    statusLine = { CalendarsLogic.feedStatusLine(it, ::whenLabel) },
                    onAdd = { editing = FeedEditTarget(null) },
                    onEdit = { editing = FeedEditTarget(it) },
                    onSync = { f ->
                        scope.launch {
                            message = null
                            message = runCatchingIo { api.syncIcsFeed(f.id) }?.let(CalendarsLogic::feedSyncSummary)
                                ?: "Couldn’t sync that feed."
                            load()
                        }
                    },
                    onRemove = { f ->
                        scope.launch {
                            message = null
                            try {
                                api.deleteIcsFeed(f.id)
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                // If the server says no, say so rather than silently redrawing.
                                message = (e as? WaffledApiException)?.userMessage ?: "Couldn’t remove that feed."
                            }
                            load()
                        }
                    },
                )
                when {
                    providers.isEmpty() -> Notice("No calendar accounts can be connected — this server has no Google or Outlook credentials set up.")
                    !s.connected -> HairlineCard(padding = 16.dp) {
                        Text("Connect a calendar account", style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                        Gap(10.dp)
                        Caption("Bring your family’s calendars into Waffled — you’ll pick which ones sync and who each belongs to.", size = 13f)
                        Gap(10.dp)
                        ConnectButtons(providers, connecting, ::connect)
                    }
                    else -> {
                        FilterControls(search, { search = it }, syncedOnly, { syncedOnly = !syncedOnly }, hideReadOnly, { hideReadOnly = !hideReadOnly })
                        s.accounts.forEach { acct ->
                            val all = CalendarsLogic.sorted(s.calendars.filter { it.accountId == acct.id })
                            AccountCard(
                                acct = acct,
                                all = all,
                                shown = CalendarsLogic.filtered(all, syncedOnly, hideReadOnly, search),
                                collapsed = acct.id in collapsed,
                                connectedDay = shortDay(acct.connectedAt),
                                members = members,
                                statusLine = { CalendarsLogic.calendarStatusLine(it, ::whenLabel) },
                                onToggleCollapse = {
                                    collapsed = if (acct.id in collapsed) collapsed - acct.id else collapsed + acct.id
                                },
                                onDisconnect = {
                                    scope.launch {
                                        message = null
                                        val name = CalendarProvider.accountLabel(acct.provider)
                                        if (runCatchingIo { api.disconnectCalendarAccount(acct.id) } == null) {
                                            message = "The $name wasn’t disconnected. Check your connection and try again."
                                            return@launch
                                        }
                                        if (!load()) message = "The $name was disconnected, but the latest status couldn’t be loaded."
                                    }
                                },
                                onSetAll = { selected ->
                                    scope.launch {
                                        message = null
                                        val targets = all.filter { it.selected != selected }
                                        var updated = 0
                                        for (c in targets) {
                                            val ok = runCatchingIo {
                                                api.updateCalendarLink(c.id, JsonObject(mapOf("selected" to JsonPrimitive(selected))))
                                            }
                                            if (ok == null) break
                                            updated++
                                        }
                                        val refreshed = load()
                                        CalendarsLogic.setAllMessage(updated, targets.size, refreshed)?.let { message = it }
                                    }
                                },
                                onPatch = { id, body -> patch(id, body) },
                            )
                        }
                        ConnectButtons(providers, connecting, ::connect)
                    }
                }
            }
            loading -> WaffledLoading(top = 40.dp)
            else -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Notice(message ?: "Couldn’t load calendar settings.")
                Text(
                    "Try again",
                    modifier = Modifier.clickable { scope.launch { load() } },
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.primary,
                )
            }
        }
    }

    editing?.let { target ->
        IcsFeedEditorSheet(
            api = api,
            feed = target.feed,
            members = members,
            onSaved = { scope.launch { load() } },
            onDismiss = { editing = null },
        )
    }
}

/** Add a feed (null) or edit an existing one. */
private data class FeedEditTarget(val feed: SettingsHouseholdApi.Feed?)

@Composable
private fun CountdownsSection(
    s: CountdownSettingsModel.State,
    onRetry: () -> Unit,
    onSleeps: () -> Unit,
    onHorizon: (Int) -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val enabled = !s.busy && s.loaded
    HairlineCard {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("⏳ Countdowns", style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink2)
            s.errorMessage?.let { error ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(error, Modifier.weight(1f), style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.primaryD)
                    Spacer(Modifier.width(8.dp))
                    Text("Retry", Modifier.clickable(onClick = onRetry), style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold), color = WF.colors.primary)
                }
            }
            CheckToggle("Count in “sleeps” instead of “days” (kid-friendly)", s.sleeps, onSleeps, enabled = enabled, size = 14f)
            HairDivider()
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Show member birthdays within",
                    Modifier.weight(1f),
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink,
                )
                Box {
                    WaffledMenuPill(
                        CountdownSettingsModel.horizonLabel(s.birthdayHorizon),
                        Modifier.clip(RoundedCornerShape(WF.radius.pill)).clickable(enabled = enabled) { menu = true },
                    )
                    OptionsMenu(menu, { menu = false }, CountdownSettingsModel.horizonOptions.map { (label, days) -> label to { onHorizon(days) } })
                }
            }
            Caption("A birthday further out than this stays hidden until it’s close (keeps a year of family birthdays off the list).")
            Caption("Count down to trips, birthdays, and anything you flag on the calendar. Add one from the Today “Countdowns” card, or tick “Show a countdown” when editing an event.")
        }
    }
}

@Composable
private fun MessageBanner(text: String) {
    Text(
        text,
        modifier = Modifier
            .fillMaxWidth()
            .background(WF.colors.panel, RoundedCornerShape(WF.radius.sm))
            .padding(horizontal = 12.dp, vertical = 9.dp),
        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
        color = WF.colors.ink2,
    )
}

@Composable
private fun Notice(text: String) {
    Text(text, Modifier.fillMaxWidth().padding(vertical = 20.dp), style = TextStyle(fontSize = 14.sp), color = WF.colors.ink3)
}

@Composable
private fun FeedsSection(
    feeds: List<SettingsHouseholdApi.Feed>,
    isAdmin: Boolean,
    statusLine: (SettingsHouseholdApi.Feed) -> String,
    onAdd: () -> Unit,
    onEdit: (SettingsHouseholdApi.Feed) -> Unit,
    onSync: (SettingsHouseholdApi.Feed) -> Unit,
    onRemove: (SettingsHouseholdApi.Feed) -> Unit,
) {
    HairlineCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("🔗 Calendar feeds", Modifier.weight(1f), style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink2)
            if (isAdmin) CapsuleButton("Add", onAdd)
        }
        Gap(10.dp)
        if (feeds.isEmpty()) {
            Caption("Follow a calendar by link — school terms, a sports fixture list, holidays. Events come in read-only.")
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                feeds.forEach { f ->
                    var menu by remember { mutableStateOf(false) }
                    HairlineCard(padding = 11.dp, radius = WF.radius.sm, fill = WF.colors.card2) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                            Icon(Icons.Filled.Link, null, tint = WF.colors.ink3, modifier = Modifier.size(14.dp))
                            Text(
                                f.displayName,
                                Modifier.weight(1f),
                                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                                color = WF.colors.ink,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (isAdmin) {
                                Box {
                                    Icon(
                                        Icons.Filled.MoreHoriz,
                                        contentDescription = "Feed options",
                                        tint = WF.colors.ink3,
                                        modifier = Modifier.size(28.dp).clip(CircleShape).clickable { menu = true }.padding(4.dp),
                                    )
                                    OptionsMenu(
                                        menu, { menu = false },
                                        listOf("Sync now" to { onSync(f) }, "Edit" to { onEdit(f) }, "Remove" to { onRemove(f) }),
                                        destructive = setOf("Remove"),
                                    )
                                }
                            }
                        }
                        Gap(6.dp)
                        Text(
                            statusLine(f),
                            style = TextStyle(fontSize = 11.5.sp),
                            color = if (f.hasError) WF.colors.danger else WF.colors.ink3,
                        )
                    }
                }
            }
        }
    }
}

/** One button per configured provider; only the first is filled, so two don't compete. */
@Composable
private fun ConnectButtons(
    providers: List<CalendarProvider>,
    connecting: CalendarProvider?,
    onConnect: (CalendarProvider) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        providers.forEachIndexed { idx, p ->
            val prominent = idx == 0
            // White is correct on the saturated primary fill.
            val fg = if (prominent) Color.White else WF.colors.ink
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(WF.radius.md))
                    .background(if (prominent) WF.colors.primary else WF.colors.panel)
                    .clickable(enabled = connecting == null) { onConnect(p) }
                    .padding(vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(7.dp, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Link, null, tint = fg, modifier = Modifier.size(14.dp))
                Text(
                    if (connecting == p) "Connecting…" else p.connectTitle,
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                    color = fg,
                )
            }
        }
    }
}

@Composable
private fun FilterControls(
    search: String,
    onSearch: (String) -> Unit,
    syncedOnly: Boolean,
    onSyncedOnly: () -> Unit,
    hideReadOnly: Boolean,
    onHideReadOnly: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(WF.colors.panel, RoundedCornerShape(WF.radius.sm))
                .padding(horizontal = 12.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Search, null, tint = WF.colors.ink3, modifier = Modifier.size(15.dp))
            // Bare BasicTextField: the panel fill IS the field chrome here, as on iOS.
            BasicTextField(
                value = search,
                onValueChange = onSearch,
                singleLine = true,
                textStyle = TextStyle(fontSize = 14.sp, color = WF.colors.ink),
                cursorBrush = SolidColor(WF.colors.primary),
                modifier = Modifier.weight(1f),
                decorationBox = { inner ->
                    if (search.isEmpty()) Text("Search calendars…", style = TextStyle(fontSize = 14.sp), color = WF.colors.ink3)
                    inner()
                },
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
            CheckToggle("Synced only", syncedOnly, onSyncedOnly, size = 13f, color = WF.colors.ink2)
            CheckToggle("Hide read-only", hideReadOnly, onHideReadOnly, size = 13f, color = WF.colors.ink2)
        }
    }
}

@Composable
private fun AccountCard(
    acct: SettingsHouseholdApi.Account,
    all: List<SettingsHouseholdApi.Cal>,
    shown: List<SettingsHouseholdApi.Cal>,
    collapsed: Boolean,
    connectedDay: String,
    members: List<Person>,
    statusLine: (SettingsHouseholdApi.Cal) -> String,
    onToggleCollapse: () -> Unit,
    onDisconnect: () -> Unit,
    onSetAll: (Boolean) -> Unit,
    onPatch: (String, JsonObject) -> Unit,
) {
    val accountLabel = CalendarProvider.accountLabel(acct.provider)
    HairlineCard {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(30.dp).background(WF.colors.panel, CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.Link, null, tint = WF.colors.ai, modifier = Modifier.size(16.dp))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(
                    acct.email ?: accountLabel,
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                // Name the provider on every row: an email alone doesn't say which service.
                Caption("$accountLabel · ${all.count { it.selected }} of ${all.size} syncing · connected $connectedDay")
            }
            CapsuleButton("Disconnect", onDisconnect)
            Icon(
                if (collapsed) Icons.Filled.KeyboardArrowDown else Icons.Filled.KeyboardArrowUp,
                contentDescription = if (collapsed) "Expand" else "Collapse",
                tint = WF.colors.ink3,
                modifier = Modifier.size(28.dp).clip(CircleShape).clickable(onClick = onToggleCollapse).padding(4.dp),
            )
        }
        if (!collapsed) {
            Gap(12.dp)
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Sync all", Modifier.clickable { onSetAll(true) }, style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold), color = WF.colors.ai)
                Text("·", color = WF.colors.ink3)
                Text("Sync none", Modifier.clickable { onSetAll(false) }, style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold), color = WF.colors.ai)
            }
            Gap(12.dp)
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                shown.forEach { c -> CalendarRow(c, members, statusLine(c), onPatch) }
                if (shown.isEmpty()) Caption("No calendars match.", Modifier.padding(vertical = 6.dp))
            }
        }
    }
}

@Composable
private fun CalendarRow(
    c: SettingsHouseholdApi.Cal,
    members: List<Person>,
    statusLine: String,
    onPatch: (String, JsonObject) -> Unit,
) {
    var personMenu by remember { mutableStateOf(false) }
    HairlineCard(padding = 11.dp, radius = WF.radius.sm, fill = WF.colors.card2) {
        Row(horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).background(colorFromHex(c.colorHex) ?: WF.colors.ink3, CircleShape))
            Text(
                c.summary ?: "Calendar",
                Modifier.weight(1f, fill = false),
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (c.isPrimary) MiniTag("primary")
            Spacer(Modifier.weight(1f))
            if (c.isWritable && c.personId != null) {
                Icon(
                    if (c.isWriteTarget) Icons.Filled.Star else Icons.Filled.StarBorder,
                    contentDescription = "New events go here",
                    tint = if (c.isWriteTarget) WF.colors.gold else WF.colors.ink3,
                    modifier = Modifier
                        .size(22.dp)
                        .clip(CircleShape)
                        .clickable { onPatch(c.id, JsonObject(mapOf("isWriteTarget" to JsonPrimitive(!c.isWriteTarget)))) },
                )
            }
        }
        Gap(8.dp)
        Text(statusLine, style = TextStyle(fontSize = 11.5.sp), color = WF.colors.ink3)
        Gap(8.dp)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            RoundCheckCapsule("Sync", c.selected) {
                onPatch(c.id, JsonObject(mapOf("selected" to JsonPrimitive(!c.selected))))
            }
            // Private (owner-only) vs family — only meaningful while syncing.
            if (c.selected) {
                RoundCheckCapsule("Private", c.visibility == "personal") {
                    val next = if (c.visibility == "personal") "family" else "personal"
                    onPatch(c.id, JsonObject(mapOf("visibility" to JsonPrimitive(next))))
                }
            }
            Box {
                CapsuleButton(
                    c.personName ?: "Unassigned",
                    onClick = { personMenu = true },
                    color = if (c.personName == null) WF.colors.ink3 else WF.colors.ink,
                    trailing = {
                        Icon(Icons.Filled.KeyboardArrowDown, null, tint = WF.colors.ink3, modifier = Modifier.size(13.dp))
                    },
                )
                OptionsMenu(
                    personMenu, { personMenu = false },
                    listOf("Unassigned" to { onPatch(c.id, JsonObject(mapOf("personId" to JsonNull))) }) +
                        members.map { m -> m.name to { onPatch(c.id, JsonObject(mapOf("personId" to JsonPrimitive(m.id)))) } },
                )
            }
        }
    }
}

@Composable
private fun RoundCheckCapsule(label: String, on: Boolean, onClick: () -> Unit) {
    CapsuleButton(
        label,
        onClick,
        leading = {
            Icon(
                if (on) Icons.Filled.CheckCircle else Icons.Filled.RadioButtonUnchecked,
                contentDescription = null,
                tint = if (on) WF.colors.primary else WF.colors.ink3,
                modifier = Modifier.size(15.dp),
            )
        },
    )
}

@Composable
private fun MiniTag(text: String) {
    Text(
        text,
        modifier = Modifier.background(WF.colors.panel, RoundedCornerShape(WF.radius.pill)).padding(horizontal = 6.dp, vertical = 2.dp),
        style = TextStyle(fontSize = 9.5.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 0.4.sp),
        color = WF.colors.ink3,
    )
}
