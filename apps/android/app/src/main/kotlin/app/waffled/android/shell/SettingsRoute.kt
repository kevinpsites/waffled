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

/**
 * Settings — the `feature:settings` shell with the household panels slotted in by id.
 * The shell routes its own panels (and handles Back between them); this only supplies
 * the session hooks and the panels other modules own.
 */
@Composable
fun SettingsRoute(container: AppContainer, actions: ShellActions, modifier: Modifier = Modifier) {
    val members by container.syncManager.members.collectAsStateWithLifecycle()
    val viewer by container.identity.viewer.collectAsStateWithLifecycle()
    val zone by container.syncManager.householdZone.collectAsStateWithLifecycle()
    val isAdmin = viewer?.isAdmin == true

    val host = remember(container) {
        SettingsHost(
            server = container.serverConnection,
            signOut = actions.signOut,
            // core:sync cannot clear its local mirror, so a household switch is refused
            // rather than adopted over another household's rows (see AppContainer).
            adoptHouseholdSession = { _, _ -> container.clearLocalSync() },
            pendingUploads = container::pendingUploads,
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
    )

    SettingsScreen(
        api = container.settingsApi,
        sync = container.syncManager,
        themeStore = container.themeStore,
        host = host,
        modifier = modifier,
        extraPanels = panels,
    )
}

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
