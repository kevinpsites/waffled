package app.waffled.feature.settings

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.ThemeStore
import app.waffled.core.design.WF
import app.waffled.core.sync.ModuleGate
import app.waffled.core.sync.SyncManager
import kotlinx.coroutines.launch

/**
 * What Settings needs from `app` beyond the API: the session and the connection, which
 * `app` owns because changing either tears down sync and local data.
 */
class SettingsHost(
    /** The editable server address (About → Server). */
    val server: ServerConnection,
    /** Sign out of this device. Optimistic; `app` flips to the login screen. */
    val signOut: () -> Unit,
    /**
     * Adopt the token pair minted for another household and re-scope sync against it.
     * Return false (with nothing adopted) when the local mirror could not be cleared.
     */
    val adoptHouseholdSession: suspend (accessToken: String, refreshToken: String) -> Boolean,
    /** Writes still queued for upload; switching households is blocked while any are. */
    val pendingUploads: () -> Int = { 0 },
    val appVersion: String,
    val appBuild: String,
    /** Show the Health Connect row on Permissions once Health Connect is wired up. */
    val healthConnectAvailable: Boolean = false,
)

/**
 * Settings landing — the port of iOS `SettingsView`: Account · Family · System tiers,
 * About, then sign-out. Panels built elsewhere arrive as [extraPanels] and slot in by id
 * (see [SettingsPanelId]); a row with no panel yet shows "Soon".
 */
@Composable
fun SettingsScreen(
    api: SettingsApi,
    sync: SyncManager,
    themeStore: ThemeStore,
    host: SettingsHost,
    modifier: Modifier = Modifier,
    extraPanels: List<SettingsPanelEntry> = emptyList(),
) {
    var route by rememberSaveable { mutableStateOf<String?>(null) }
    var overview by remember { mutableStateOf<SettingsApi.HouseholdOverview?>(null) }
    var flags by remember { mutableStateOf<Map<String, Boolean>>(emptyMap()) }
    val members by sync.members.collectAsStateWithLifecycle()
    val syncPerson by sync.currentPerson.collectAsStateWithLifecycle()

    // Re-read on every return to the landing: a household switch or a module toggle
    // inside a panel changes who is admin and which rows exist.
    LaunchedEffect(route == null) {
        if (route != null) return@LaunchedEffect
        runCatching { api.household() }.getOrNull()?.let {
            overview = it
            flags = it.modules().modules
        }
    }

    val personId = overview?.person?.id ?: syncPerson?.id
    val isAdmin = overview?.person?.isAdmin ?: (syncPerson?.isAdmin == true)
    val onModulesChanged: (Map<String, Boolean>) -> Unit = { merged ->
        flags = merged
        sync.setModules(ModuleGate.fromServer(merged))
    }

    BackHandler(enabled = route != null) { route = null }
    val back = { route = null }

    val rows = SettingsCatalog.rows(isAdmin, ModuleGate.fromServer(flags), extraPanels)
    val open = rows.firstOrNull { it.id == route }
    // A row can disappear under an open route (module switched off, admin revoked).
    if (route != null && (open == null || open.target is SettingsRowTarget.Soon)) {
        LaunchedEffect(route) { route = null }
    }

    when {
        open == null || open.target is SettingsRowTarget.Soon -> SettingsLanding(
            rows = rows,
            signedInName = members.firstOrNull { it.id == personId }?.name,
            onOpen = { route = it },
            onSignOut = host.signOut,
            modifier = modifier,
        )
        open.target is SettingsRowTarget.Extra -> open.target.entry.content(back)
        else -> when (open.id) {
            SettingsPanelId.HOUSEHOLDS -> AccountSettingsScreen(api, host, onBack = back, modifier = modifier)
            SettingsPanelId.FAMILY -> FamilyPeopleSettingsScreen(api, onBack = back, modifier = modifier)
            SettingsPanelId.CHORES_REWARDS -> ChoresRewardsSettingsScreen(api, isAdmin, host.server.currentUrl(), onBack = back, modifier = modifier)
            SettingsPanelId.MODULES -> ModulesSettingsScreen(api, isAdmin, onModulesChanged, onBack = back, modifier = modifier)
            SettingsPanelId.APPEARANCE -> AppearanceSettingsScreen(themeStore, onBack = back, modifier = modifier)
            SettingsPanelId.PERMISSIONS -> DevicePermissionsScreen(host.healthConnectAvailable, onBack = back, modifier = modifier)
            else -> AboutSettingsScreen(api, host, onBack = back, modifier = modifier)
        }
    }
}

@Composable
private fun SettingsLanding(
    rows: List<SettingsRow>,
    signedInName: String?,
    onOpen: (String) -> Unit,
    onSignOut: () -> Unit,
    modifier: Modifier,
) {
    SettingsPage(title = "Settings", onBack = null, modifier = modifier, spacing = 10.dp) {
        var previous: SettingsSection? = null
        rows.forEach { row ->
            if (row.section != previous) {
                val first = previous == null
                row.section.label?.let { SectionLabel(it, Modifier.padding(top = if (first) 0.dp else 8.dp)) }
                if (row.section.label == null && !first) Gap(8.dp)
                previous = row.section
            }
            SettingsNavRow(
                emoji = row.emoji,
                title = row.title,
                subtitle = row.subtitle,
                onClick = if (row.target is SettingsRowTarget.Soon) null else ({ onOpen(row.id) }),
            )
        }
        SignOutFooter(signedInName, onSignOut)
    }
}

/** Sign out sits on the landing, like the web footer. Two taps so it's never an accident. */
@Composable
private fun SignOutFooter(signedInName: String?, onSignOut: () -> Unit) {
    var armed by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val shape = RoundedCornerShape(WF.radius.md)
    Column(
        Modifier.fillMaxWidth().padding(top = 14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        signedInName?.let {
            Text("Signed in as $it", style = TextStyle(fontSize = 12.5.sp), color = WF.colors.ink3)
        }
        Text(
            when {
                busy -> "Signing out…"
                armed -> "Tap again to sign out"
                else -> "Sign out"
            },
            modifier = Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(if (armed) WF.colors.primary else WF.colors.card, shape)
                .border(1.dp, if (armed) Color.Transparent else WF.colors.primary.copy(alpha = 0.4f), shape)
                .clickable(enabled = !busy) {
                    if (armed) {
                        busy = true
                        scope.launch { onSignOut() }
                    } else {
                        armed = true
                    }
                }
                .padding(vertical = 14.dp),
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold, textAlign = androidx.compose.ui.text.style.TextAlign.Center),
            // White on the saturated coral fill once armed; coral text on the card before.
            color = if (armed) Color.White else WF.colors.primary,
        )
    }
}
