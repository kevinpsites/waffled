package app.waffled.feature.settings

import androidx.compose.runtime.Composable

/**
 * The three tiers of the Settings landing (mirrors the web: Account · Family · System),
 * plus the ungrouped About row. Family is admin-only.
 */
enum class SettingsSection(val label: String?) {
    Account("Account"),
    Family("Family"),
    System("System"),
    About(null),
}

/** Stable ids for every row iOS shows, so `app` can slot panels in by id. */
object SettingsPanelId {
    const val HOUSEHOLDS = "households"
    const val NOTIFICATIONS = "notifications"
    const val FAMILY = "family"
    const val CALENDARS = "calendars"
    const val CHORES_REWARDS = "choresRewards"
    const val MEALS = "meals"
    const val LISTS = "lists"
    const val PANTRY = "pantry"
    const val FAMILY_NIGHT = "familyNight"
    const val WEEKLY_PLANNING = "weeklyPlanning"
    const val MODULES = "modules"
    const val DISPLAY = "display"
    const val APPEARANCE = "appearance"
    const val AI = "ai"
    const val PERMISSIONS = "permissions"
    const val ABOUT = "about"
}

/**
 * A panel built outside this module (the household panels live in a separate feature
 * module), handed in by `app`. A known [id] takes that row's slot and gates; an unknown
 * one is appended to the end of [section].
 *
 * [content] is the WHOLE page: it draws its own header (calling `onBack` from its back
 * affordance), its own scrolling, and its `tabBarClearance`. The shell only routes.
 */
class SettingsPanelEntry(
    val id: String,
    val title: String,
    val icon: String,
    val section: SettingsSection,
    val subtitle: String = "",
    val content: @Composable (onBack: () -> Unit) -> Unit,
)

sealed interface SettingsRowTarget {
    /** Rendered by this module. */
    data object BuiltIn : SettingsRowTarget

    /** Supplied by `app`. */
    class Extra(val entry: SettingsPanelEntry) : SettingsRowTarget

    /** Not built yet: dimmed with a "Soon" pill so the hub never dead-ends. */
    data object Soon : SettingsRowTarget
}

data class SettingsRow(
    val id: String,
    val emoji: String,
    val title: String,
    val subtitle: String,
    val section: SettingsSection,
    val target: SettingsRowTarget,
)

object SettingsCatalog {

    private class Spec(
        val id: String,
        val emoji: String,
        val title: String,
        val subtitle: String,
        val section: SettingsSection,
        val builtIn: Boolean = false,
        val adminOnly: Boolean = false,
        val module: String? = null,
    )

    // Order is iOS `SettingsView.body`; the Family rows follow Settings → Modules order.
    private val specs = listOf(
        Spec(SettingsPanelId.HOUSEHOLDS, "🏠", "Households", "Your households & sign-in", SettingsSection.Account, builtIn = true),
        Spec(SettingsPanelId.NOTIFICATIONS, "🔔", "Notifications", "Your event reminders", SettingsSection.Account),
        Spec(SettingsPanelId.FAMILY, "👨‍👩‍👧‍👦", "Family & People", "Members, roles, household", SettingsSection.Family, builtIn = true, adminOnly = true),
        Spec(SettingsPanelId.CALENDARS, "📅", "Calendars", "Google, Outlook & feeds", SettingsSection.Family, adminOnly = true),
        Spec(SettingsPanelId.CHORES_REWARDS, "⭐", "Chores & Rewards", "Currencies & conversions", SettingsSection.Family, builtIn = true, adminOnly = true),
        Spec(SettingsPanelId.MEALS, "🍽️", "Meals", "Calendar & meal times", SettingsSection.Family, adminOnly = true),
        Spec(SettingsPanelId.LISTS, "📋", "Lists", "Grocery & lists", SettingsSection.Family, adminOnly = true),
        Spec(SettingsPanelId.PANTRY, "🥫", "Pantry", "Today card & thresholds", SettingsSection.Family, adminOnly = true, module = "pantry"),
        Spec(SettingsPanelId.FAMILY_NIGHT, "🏡", "Family Night", "Agenda, day & time", SettingsSection.Family, adminOnly = true, module = "familyNight"),
        Spec(SettingsPanelId.WEEKLY_PLANNING, "🗓️", "Weekly Planning", "Session day, time & steps", SettingsSection.Family, adminOnly = true, module = "weeklyPlanning"),
        Spec(SettingsPanelId.MODULES, "🧩", "Modules", "Optional features on/off", SettingsSection.Family, builtIn = true, adminOnly = true),
        Spec(SettingsPanelId.DISPLAY, "🖥️", "Display & Kiosk", "Screensaver & idle", SettingsSection.Family, adminOnly = true),
        Spec(SettingsPanelId.APPEARANCE, "🌗", "Appearance", "Light, dark or match system", SettingsSection.System, builtIn = true),
        Spec(SettingsPanelId.AI, "✨", "AI & Capture", "Provider & model", SettingsSection.System, adminOnly = true),
        Spec(SettingsPanelId.PERMISSIONS, "🔐", "Permissions", "Health Connect & device access", SettingsSection.System, builtIn = true),
        Spec(SettingsPanelId.ABOUT, "ℹ️", "About", "Version & server", SettingsSection.About, builtIn = true),
    )

    private val known = specs.associateBy { it.id }

    /**
     * The rows to draw, in order. [isModuleOn] takes a module key (`pantry`,
     * `weeklyPlanning`…) — string-keyed because the Settings catalog is wider than the
     * core module enum.
     */
    fun rows(
        isAdmin: Boolean,
        isModuleOn: (String) -> Boolean,
        extras: List<SettingsPanelEntry>,
    ): List<SettingsRow> {
        val supplied = extras.associateBy { it.id }
        val visible: (SettingsSection, Boolean, String?) -> Boolean = { section, adminOnly, module ->
            (!adminOnly && section != SettingsSection.Family || isAdmin) && (module == null || isModuleOn(module))
        }

        val catalog = specs.filter { visible(it.section, it.adminOnly, it.module) }.map { spec ->
            val entry = supplied[spec.id]
            when {
                spec.builtIn || entry == null -> SettingsRow(
                    spec.id, spec.emoji, spec.title, spec.subtitle, spec.section,
                    if (spec.builtIn) SettingsRowTarget.BuiltIn else SettingsRowTarget.Soon,
                )
                else -> SettingsRow(
                    spec.id, entry.icon, entry.title, entry.subtitle.ifEmpty { spec.subtitle },
                    spec.section, SettingsRowTarget.Extra(entry),
                )
            }
        }

        val unknown = extras
            .filter { it.id !in known && visible(it.section, false, null) }
            .map { SettingsRow(it.id, it.icon, it.title, it.subtitle, it.section, SettingsRowTarget.Extra(it)) }

        return SettingsSection.entries.flatMap { section ->
            catalog.filter { it.section == section } + unknown.filter { it.section == section }
        }
    }
}
