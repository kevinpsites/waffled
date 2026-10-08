package app.waffled.android.shell

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.android.AppContainer
import app.waffled.android.BuildConfig
import app.waffled.feature.familynight.FamilyNightSettingsModel
import app.waffled.feature.familynight.FamilyNightSettingsScreen
import app.waffled.feature.pantry.AllergenBadge
import app.waffled.feature.pantry.PantryAllergen
import app.waffled.feature.settings.SettingsHost
import app.waffled.feature.settings.SettingsPanelEntry
import app.waffled.feature.settings.SettingsPanelId
import app.waffled.feature.settings.SettingsScreen
import app.waffled.feature.settings.SettingsSection
import app.waffled.feature.settingshousehold.AiSettingsPanel
import app.waffled.feature.settingshousehold.CalendarsSettingsPanel
import app.waffled.feature.settingshousehold.DisplayKioskSettingsPanel
import app.waffled.feature.settingshousehold.HouseholdPanelSpec
import app.waffled.feature.settingshousehold.HouseholdSettingsPanels
import app.waffled.feature.settingshousehold.MealsSettingsPanel
import app.waffled.feature.settingshousehold.NotificationsSettingsPanel
import app.waffled.feature.settingshousehold.PantrySettingsPanel
import app.waffled.feature.settingshousehold.SettingsHouseholdApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.feature.kiosk.KioskRailPickerCard
import app.waffled.feature.kiosk.KioskShellLayout
import app.waffled.feature.kiosk.KioskThisDeviceCard
import app.waffled.feature.kiosk.ScreensaverPreview
import app.waffled.feature.planning.PlanningSettingsScreen
import kotlinx.coroutines.launch

/**
 * Settings — the `feature:settings` shell with the household panels slotted in by id.
 * The shell routes its own panels (and handles Back between them); this only supplies
 * the session hooks and the panels other modules own.
 */
@Composable
fun SettingsRoute(
    container: AppContainer,
    actions: ShellActions,
    modifier: Modifier = Modifier,
    initialPanel: String? = null,
    onBack: (() -> Unit)? = null,
) {
    val members by container.syncManager.members.collectAsStateWithLifecycle()
    val viewer by container.identity.viewer.collectAsStateWithLifecycle()
    val zone by container.syncManager.householdZone.collectAsStateWithLifecycle()
    val isAdmin = viewer?.isAdmin == true
    val isTablet = KioskShellLayout.isTablet(LocalConfiguration.current.smallestScreenWidthDp)

    val host = remember(container) {
        SettingsHost(
            server = container.serverConnection,
            signOut = actions.signOut,
            adoptHouseholdSession = container::adoptHouseholdSession,
            pendingUploads = { container.syncManager.pendingUploads.value },
            appVersion = BuildConfig.VERSION_NAME,
            appBuild = BuildConfig.VERSION_CODE.toString(),
            healthConnectAvailable = false,
        )
    }

    val api = container.householdSettingsApi
    val bus = container.refreshBus
    val panels = listOf(
        panel(HouseholdSettingsPanels.notifications) { NotificationsSettingsPanel(container.eventReminders) },
        panel(HouseholdSettingsPanels.calendars) { CalendarsSettingsPanel(api, members, isAdmin, zone) },
        panel(HouseholdSettingsPanels.meals) { MealsSettingsPanel(api, bus = bus) },
        panel(HouseholdSettingsPanels.pantry) {
            PantrySettingsPanel(
                api = api,
                allergenKeys = PantryAllergen.keys,
                allergenLabel = PantryAllergen::label,
                allergenBadge = { key, avoid -> AllergenBadge(key, avoid = avoid) },
                bus = bus,
            )
        },
        panel(HouseholdSettingsPanels.display) { DisplayKioskSettingsPanel(api, isParent = viewer?.memberType == "adult") },
        panel(HouseholdSettingsPanels.ai) { AiSettingsPanel(api) },
        SettingsPanelEntry(
            id = SettingsPanelId.FAMILY_NIGHT,
            title = "Family Night",
            icon = "🏡",
            section = SettingsSection.Family,
            content = { onBack ->
                val model = remember { FamilyNightSettingsModel(container.familyNightApi) }
                PageWithBack(onBack = onBack, title = "Family Night") {
                    FamilyNightSettingsScreen(model, isAdmin)
                }
            },
        ),
        SettingsPanelEntry(
            id = SettingsPanelId.WEEKLY_PLANNING,
            title = "Weekly Planning",
            icon = "🗓️",
            section = SettingsSection.Family,
            content = { onBack ->
                PageWithBack(onBack = onBack, title = "Weekly Planning") {
                    PlanningSettingsScreen(env = container.planningEnv(actions.isKiosk), isAdmin = isAdmin)
                }
            },
        ),
    ) + if (isTablet) listOf(thisTabletPanel(container)) else emptyList()

    SettingsScreen(
        api = container.settingsApi,
        sync = container.syncManager,
        themeStore = container.themeStore,
        host = host,
        modifier = modifier,
        extraPanels = panels,
        initialPanel = initialPanel,
        onBack = onBack,
    )
}

/**
 * Tablet only: this device as a kiosk, its rail, and a screensaver preview. A separate
 * row because `DisplayKioskSettingsPanel` scrolls itself and has no slot for them.
 */
private fun thisTabletPanel(container: AppContainer) = SettingsPanelEntry(
    id = "thisTablet",
    title = "This tablet",
    icon = "📟",
    section = SettingsSection.entries.first { it.label == HouseholdSettingsPanels.display.section },
    subtitle = "Shared kiosk, rail pages, screensaver preview",
    content = { onBack ->
        val modules by container.syncManager.modules.collectAsStateWithLifecycle()
        val rewardsSub by container.identity.rewardsEnabled.collectAsStateWithLifecycle()
        val events by container.syncManager.visibleEvents.collectAsStateWithLifecycle()
        val zone by container.syncManager.householdZone.collectAsStateWithLifecycle()
        val scope = rememberCoroutineScope()
        var preview by remember { mutableStateOf<SettingsHouseholdApi.DisplayConfig?>(null) }
        var previewFailed by remember { mutableStateOf(false) }
        PageWithBack(onBack = onBack, title = "This tablet") {
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                KioskThisDeviceCard(container.kioskMode)
                WaffledPrimaryCTA(
                    label = if (previewFailed) "Couldn’t load the screensaver — try again" else "Preview the screensaver",
                    onClick = {
                        scope.launch {
                            val cfg = runCatching { container.householdSettingsApi.displayConfig() }.getOrNull()
                            previewFailed = cfg == null
                            preview = cfg
                        }
                    },
                )
                KioskRailPickerCard(container.kioskRailStore, modules, modules.rewardsOn(rewardsSub))
                Spacer(Modifier.height(24.dp))
            }
        }
        preview?.let { cfg ->
            ScreensaverPreview(
                config = cfg,
                fetchPhotos = { container.photosApi.list() },
                fetchWeather = { container.todayApi.weather() },
                events = events,
                zone = zone,
                baseUrl = container.serverAddress.baseUrl(),
                onDismiss = { preview = null },
            )
        }
    },
)

/**
 * A household panel as a Settings row. Panels draw no header, so the page adds the back
 * row; the panel itself sits in the bounded slot and scrolls and pads itself.
 */
private fun panel(spec: HouseholdPanelSpec, body: @Composable () -> Unit) = SettingsPanelEntry(
    id = spec.id,
    title = spec.title,
    icon = spec.emoji,
    section = SettingsSection.entries.first { it.label == spec.section },
    subtitle = spec.subtitle,
    content = { onBack -> PageWithBack(onBack = onBack, title = spec.title) { body() } },
)
