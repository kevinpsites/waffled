package app.waffled.feature.kiosk

import app.waffled.core.model.WaffledModule
import app.waffled.core.sync.ModuleGate

/**
 * The kiosk rail destinations, in web order (`apps/web/src/kiosk/nav.ts`). Raw values
 * match iOS `KioskNav` so a stored rail string means the same thing on every platform.
 * Family Night deliberately has no page — it is only a Today card.
 */
enum class KioskNav(val raw: String, val label: String) {
    Today("today", "Today"),
    Calendar("calendar", "Calendar"),
    Tasks("tasks", "Chores"),
    Rewards("rewards", "Rewards"),
    Goals("goals", "Goals"),
    Family("family", "Family"),
    Meals("meals", "Meals"),
    Lists("lists", "Lists"),
    Pantry("pantry", "Pantry"),
    Rhythms("rhythms", "Rhythms"),
    Photos("photos", "Photos"),
    More("more", "More"),
    Settings("settings", "Settings"),
    Planning("planning", "Planning");

    companion object {
        fun fromRaw(raw: String?): KioskNav? = entries.firstOrNull { it.raw == raw?.trim() }
    }
}

/**
 * Per-device customisation of the kiosk rail and its More grid: up to [MAX_ITEMS] pins
 * between the always-on Today/Calendar (top) and More/Settings (bottom). Everything
 * choosable but unpinned falls into More. Stored per device under [STORAGE_KEY] as
 * comma-joined raw values, the same shape iOS keeps in `@AppStorage`.
 */
object KioskRail {
    const val STORAGE_KEY = "waffled.kioskRailItems"
    const val MAX_ITEMS = 5

    val choosable: List<KioskNav> = listOf(
        KioskNav.Meals, KioskNav.Tasks, KioskNav.Rewards, KioskNav.Goals, KioskNav.Lists,
        KioskNav.Pantry, KioskNav.Rhythms, KioskNav.Planning, KioskNav.Family, KioskNav.Photos,
    )

    val defaultItems: List<KioskNav> = listOf(KioskNav.Meals, KioskNav.Family)

    val defaultRaw: String get() = serialize(defaultItems)

    private val fixed = listOf(KioskNav.Today, KioskNav.Calendar, KioskNav.More, KioskNav.Settings)

    /** A valid, de-duplicated, capped list of choosable pins; anything else is dropped. */
    fun parse(raw: String?): List<KioskNav> {
        val out = mutableListOf<KioskNav>()
        for (token in raw.orEmpty().split(',')) {
            val nav = KioskNav.fromRaw(token) ?: continue
            if (nav !in choosable || nav in out) continue
            out += nav
            if (out.size >= MAX_ITEMS) break
        }
        return out
    }

    fun serialize(items: List<KioskNav>): String = items.joinToString(",") { it.raw }

    /** Today/Calendar/Family/Photos/More/Settings are core and never gated. */
    fun moduleEnabled(nav: KioskNav, modules: ModuleGate, rewardsOn: Boolean): Boolean = when (nav) {
        KioskNav.Tasks -> modules.isOn(WaffledModule.Chores)
        KioskNav.Rewards -> rewardsOn
        KioskNav.Goals -> modules.isOn(WaffledModule.Goals)
        KioskNav.Meals -> modules.isOn(WaffledModule.Meals)
        KioskNav.Lists -> modules.isOn(WaffledModule.Lists)
        KioskNav.Pantry -> modules.isOn(WaffledModule.Pantry)
        KioskNav.Rhythms -> modules.isOn(WaffledModule.Rhythms)
        KioskNav.Planning -> modules.isOn(WaffledModule.WeeklyPlanning)
        else -> true
    }

    /** Pins to draw, filtered to enabled modules; a disabled module never rewrites storage. */
    fun pinned(raw: String?, modules: ModuleGate, rewardsOn: Boolean): List<KioskNav> =
        parse(raw).filter { moduleEnabled(it, modules, rewardsOn) }

    /** A page with no tile of its own (opened from More) lights the More tile. */
    fun isHighlighted(item: KioskNav, selection: KioskNav, pinned: List<KioskNav>): Boolean {
        if (item == selection) return true
        if (item != KioskNav.More) return false
        return selection !in fixed && selection !in pinned
    }

    fun overflow(raw: String?, modules: ModuleGate, rewardsOn: Boolean): List<KioskNav> {
        val pins = parse(raw).toSet()
        return choosable.filter { it !in pins && moduleEnabled(it, modules, rewardsOn) }
    }

    fun bottomBarItems(pinned: List<KioskNav>): List<KioskNav> =
        listOf(KioskNav.Today, KioskNav.Calendar) + pinned + listOf(KioskNav.More, KioskNav.Settings)

    /** How many bar entries sit left of the centred capture button. */
    fun captureSplit(entryCount: Int): Int = (entryCount + 1) / 2

    fun pin(raw: String?, nav: KioskNav, modules: ModuleGate, rewardsOn: Boolean): String {
        val pins = pinned(raw, modules, rewardsOn)
        if (pins.size >= MAX_ITEMS || nav in pins || nav !in choosable) return serialize(pins)
        return serialize(pins + nav)
    }

    fun move(raw: String?, from: Int, to: Int, modules: ModuleGate, rewardsOn: Boolean): String {
        val pins = pinned(raw, modules, rewardsOn).toMutableList()
        if (from !in pins.indices) return serialize(pins)
        val item = pins.removeAt(from)
        pins.add(to.coerceIn(0, pins.size), item)
        return serialize(pins)
    }

    fun remove(raw: String?, nav: KioskNav, modules: ModuleGate, rewardsOn: Boolean): String =
        serialize(pinned(raw, modules, rewardsOn) - nav)
}

data class KioskInsets(val top: Float = 0f, val left: Float = 0f, val bottom: Float = 0f, val right: Float = 0f)

object KioskShellLayout {
    /**
     * Judged from the FULL container — insets added back. The keyboard insets the bottom,
     * so a bare `height > width` check flips a focused portrait tablet to landscape,
     * rebuilding the page and dropping the text being typed.
     */
    fun isPortrait(width: Float, height: Float, insets: KioskInsets): Boolean =
        (height + insets.top + insets.bottom) > (width + insets.left + insets.right)

    /**
     * iOS splits planner vs kiosk by device idiom. Android has no idiom, so the closest
     * equivalent is the configuration's smallest width: 600dp is the platform's own
     * "tablet" breakpoint.
     */
    fun isTablet(smallestScreenWidthDp: Int): Boolean = smallestScreenWidthDp >= TABLET_MIN_DP

    const val TABLET_MIN_DP = 600
}

/** The More grid's tiles. The accent is a key so this stays free of composable reads. */
object KioskMore {
    const val FALLBACK_EMOJI = "✨"

    enum class Accent { Person1, Person2, Person3, Person4, Warn, Success, Info, Primary, Panel }

    data class Descriptor(val emoji: String, val title: String, val subtitle: String, val accent: Accent)

    fun descriptor(nav: KioskNav): Descriptor = when (nav) {
        KioskNav.Tasks -> Descriptor("✅", "Chores", "Who's doing what today", Accent.Person3)
        KioskNav.Rewards -> Descriptor("⭐", "Rewards", "Stars, jars & redemptions", Accent.Warn)
        KioskNav.Goals -> Descriptor("🎯", "Goals", "What the family's working toward", Accent.Success)
        KioskNav.Lists -> Descriptor("📋", "Lists", "Groceries, packing & to-dos", Accent.Person1)
        KioskNav.Pantry -> Descriptor("🥫", "Pantry", "What's on hand", Accent.Warn)
        KioskNav.Rhythms -> Descriptor("🔁", "Rhythms", "What should keep happening", Accent.Info)
        KioskNav.Photos -> Descriptor("📷", "Photos", "The family album", Accent.Success)
        KioskNav.Meals -> Descriptor("🍽️", "Meals", "This week's plan & recipes", Accent.Primary)
        KioskNav.Family -> Descriptor("👪", "Family", "People, spotlights & more", Accent.Person4)
        KioskNav.Planning -> Descriptor("🗓️", "Weekly Planning", "Plan the week ahead", Accent.Person2)
        else -> Descriptor(FALLBACK_EMOJI, nav.label, "Open ${nav.label}", Accent.Panel)
    }
}
