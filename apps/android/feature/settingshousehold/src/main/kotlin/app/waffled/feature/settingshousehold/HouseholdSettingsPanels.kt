package app.waffled.feature.settingshousehold

import app.waffled.core.model.WaffledModule

/**
 * How each panel in this module appears on the Settings landing — the rows of the iOS
 * `SettingsView`. `app` registers the panels with the Settings shell from this table so
 * titles, glyphs, ordering and gates don't drift from iOS.
 *
 * Stored chore photos are not a landing row: Chores & Rewards opens [StoredProofsSheet].
 */
data class HouseholdPanelSpec(
    val id: String,
    val title: String,
    val emoji: String,
    val subtitle: String,
    /** "Account", "Family" or "System" — the iOS landing sections. */
    val section: String,
    val adminOnly: Boolean,
    /** Shown only while this module is on; null = always. */
    val module: WaffledModule? = null,
)

object HouseholdSettingsPanels {
    val notifications = HouseholdPanelSpec("notifications", "Notifications", "🔔", "Your event reminders", "Account", adminOnly = false)
    val calendars = HouseholdPanelSpec("calendars", "Calendars", "📅", "Google, Outlook & feeds", "Family", adminOnly = true)
    val meals = HouseholdPanelSpec("meals", "Meals", "🍽️", "Calendar & meal times", "Family", adminOnly = true)
    val pantry = HouseholdPanelSpec("pantry", "Pantry", "🥫", "Today card & thresholds", "Family", adminOnly = true, module = WaffledModule.Pantry)
    val display = HouseholdPanelSpec("display", "Display & Kiosk", "🖥️", "Screensaver & idle", "Family", adminOnly = true)
    val ai = HouseholdPanelSpec("ai", "AI & Capture", "✨", "Provider & model", "System", adminOnly = true)

    /** In iOS landing order within each section. */
    val all: List<HouseholdPanelSpec> = listOf(notifications, calendars, meals, pantry, display, ai)
}
