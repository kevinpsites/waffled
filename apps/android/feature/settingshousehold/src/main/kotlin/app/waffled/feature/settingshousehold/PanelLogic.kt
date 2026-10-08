package app.waffled.feature.settingshousehold

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.text.Collator
import java.util.Locale
import kotlin.math.roundToInt

/** Settings → AI & Capture. Keys live in the server env, so only provider + model are edited. */
object AiSettingsLogic {
    data class Meta(val label: String, val sub: String, val envHint: String)

    val order = listOf("heuristic", "ollama", "anthropic", "openai")

    val meta: Map<String, Meta> = mapOf(
        "heuristic" to Meta("On-device", "Built-in parser — no AI, works offline", ""),
        "ollama" to Meta("Local server (Ollama)", "Private — text stays on your network", "OLLAMA_HOST"),
        "anthropic" to Meta("Claude (Anthropic)", "Most accurate · hosted", "ANTHROPIC_API_KEY"),
        "openai" to Meta("OpenAI / compatible", "Hosted, or a local OpenAI-compatible server", "OPENAI_API_KEY"),
    )

    fun isEnabled(provider: String, cfg: SettingsHouseholdApi.CaptureConfig): Boolean =
        provider == "heuristic" || cfg.available[provider] == true

    /** Picking a provider pre-fills its default model; the on-device parser has none. */
    fun modelOnPick(provider: String, cfg: SettingsHouseholdApi.CaptureConfig): String =
        if (provider == "heuristic") "" else cfg.defaultModels[provider].orEmpty()

    /** A blank model means "use the server default", sent as null. */
    fun modelForSave(provider: String, model: String): String? =
        if (provider == "heuristic") null else model.trim().ifEmpty { null }

    fun isDirty(cfg: SettingsHouseholdApi.CaptureConfig, provider: String, model: String): Boolean {
        if (provider != cfg.provider) return true
        if (provider == "heuristic") return false
        return modelForSave(provider, model) != cfg.model
    }
}

/** Settings → Calendars: ordering, filtering and the status copy. */
object CalendarsLogic {
    private val collator: Collator = Collator.getInstance(Locale.getDefault()).apply { strength = Collator.SECONDARY }

    /** Primary pinned first, then A–Z ignoring case. */
    fun sorted(cals: List<SettingsHouseholdApi.Cal>): List<SettingsHouseholdApi.Cal> =
        cals.sortedWith { a, b ->
            if (a.isPrimary != b.isPrimary) {
                if (a.isPrimary) -1 else 1
            } else {
                collator.compare(a.summary.orEmpty(), b.summary.orEmpty())
            }
        }

    fun filtered(
        cals: List<SettingsHouseholdApi.Cal>,
        syncedOnly: Boolean,
        hideReadOnly: Boolean,
        search: String,
    ): List<SettingsHouseholdApi.Cal> = cals.filter { c ->
        if (syncedOnly && !c.selected) return@filter false
        if (hideReadOnly && !c.selected && !c.isWritable) return@filter false
        if (search.isNotEmpty() && !c.summary.orEmpty().contains(search, ignoreCase = true)) return@filter false
        true
    }

    /** [whenLabel] formats an ISO timestamp in the household zone. */
    fun calendarStatusLine(c: SettingsHouseholdApi.Cal, whenLabel: (String) -> String): String {
        val parts = mutableListOf<String>()
        parts += if (c.selected) c.lastSyncedAt?.let { "Synced ${whenLabel(it)}" } ?: "Will sync" else "Sync off"
        c.accessRole?.let { parts += it }
        if (c.selected) parts += if (c.visibility == "personal") "🔒 Private (only you)" else "👪 Family viewable"
        if (c.isWriteTarget) parts += "★ new events go here"
        return parts.joinToString(" · ")
    }

    /** A failing feed leads with why. */
    fun feedStatusLine(f: SettingsHouseholdApi.Feed, whenLabel: (String) -> String): String {
        val parts = mutableListOf<String>()
        parts += if (f.hasError) {
            "⚠️ ${f.lastError ?: "sync failed"}"
        } else {
            f.lastSyncedAt?.let { "Synced ${whenLabel(it)}" } ?: "Will sync shortly"
        }
        parts += f.personName?.let { "👤 $it" } ?: "👪 Whole family"
        if (f.visibility == "personal") parts += "🔒 Private"
        return parts.joinToString(" · ")
    }

    fun syncSummary(r: SettingsHouseholdApi.CalendarSyncResult): String =
        if (r.errors.isEmpty()) {
            "Imported ${r.imported}, updated ${r.updated}, removed ${r.deleted}."
        } else {
            "Synced with ${r.errors.size} error(s): ${r.errors.first()}"
        }

    fun feedSyncSummary(r: SettingsHouseholdApi.IcsFeedSyncResult): String =
        r.error?.let { "Feed sync failed: $it" }
            ?: "Imported ${r.imported}, updated ${r.updated}, removed ${r.deleted}."

    /** "Sync all/none" patches one calendar at a time and stops at the first refusal. */
    fun setAllMessage(updated: Int, total: Int, refreshed: Boolean): String? = when {
        updated < total -> "Updated $updated of $total calendars. The rest weren’t changed; try again."
        !refreshed -> "The calendars were updated, but the latest status couldn’t be loaded."
        else -> null
    }
}

/** Settings → Meals. */
object MealsSettingsLogic {
    data class MealRow(val key: String, val label: String, val icon: String)

    val mealRows = listOf(
        MealRow("breakfast", "Breakfast", "🍳"),
        MealRow("lunch", "Lunch", "🥪"),
        MealRow("dinner", "Dinner", "🍽️"),
        MealRow("snack", "Snack", "🍎"),
    )

    /** Selecting everyone collapses back to null, which the server reads as "whole family". */
    fun toggleParticipant(current: List<String>?, id: String, all: List<String>): List<String>? {
        val next = (current ?: all).toMutableList()
        if (id in next) next.remove(id) else next.add(id)
        return if (next.size == all.size) null else next
    }

    fun toggle(list: List<String>, key: String): List<String> = if (key in list) list - key else list + key

    fun body(s: SettingsHouseholdApi.MealCalendarSettings): JsonObject = buildJsonObject {
        put("addToCalendar", s.addToCalendar)
        put("pushToGoogle", s.pushToGoogle)
        put("durationMinutes", s.durationMinutes)
        put("times", JsonObject(s.times.mapValues { JsonPrimitive(it.value) }))
        put("prepReminder", s.prepReminder)
        put("prepReminderTime", s.prepReminderTime)
        put("prepReminderMealTypes", JsonArray(s.prepReminderMealTypes.map(::JsonPrimitive)))
        put("calendarPersonId", s.calendarPersonId?.let(::JsonPrimitive) ?: JsonNull)
        put("participantIds", s.participantIds?.let { ids -> JsonArray(ids.map(::JsonPrimitive)) } ?: JsonNull)
    }
}

/** Settings → Pantry. Mirrors the server's own normalisation so optimistic state matches. */
object PantrySettingsLogic {
    /** Drop blanks, then dedupe case-insensitively keeping the first spelling and order. */
    fun cleanLocations(raw: List<String>): List<String> {
        val seen = HashSet<String>()
        return raw.mapNotNull { r ->
            val s = r.trim()
            if (s.isEmpty() || !seen.add(s.lowercase())) null else s
        }
    }

    fun prunedIcons(icons: Map<String, String>, locations: List<String>): Map<String, String> {
        val names = locations.toSet()
        return icons.filter { (k, v) -> k in names && v.isNotEmpty() }
    }

    /** At or above zero; null means "revert to the last good value". */
    fun parseLow(text: String): Double? =
        text.trim().toDoubleOrNull()?.takeIf { it.isFinite() && it >= 0 }

    /** Rounded and clamped into 1…60 months. */
    fun parseStale(text: String): Int? {
        val raw = text.trim().toDoubleOrNull()?.takeIf { it.isFinite() } ?: return null
        return raw.roundToInt().coerceIn(1, 60)
    }

    fun formatAmount(value: Double): String =
        if (value == Math.floor(value) && !value.isInfinite()) value.toLong().toString() else value.toString()

    /** The server keeps four characters of a location icon. */
    fun clampIcon(value: String): String {
        if (value.codePointCount(0, value.length) <= 4) return value
        return value.substring(0, value.offsetByCodePoints(0, 4))
    }
}

/** Settings → Display & Kiosk. */
object DisplayKioskLogic {
    val screensaverChoices = listOf(1, 2, 3, 5, 10, 15, 30, 60)
    val idleChoices = listOf(0, 1, 2, 3, 5, 10, 15, 30)
    val intervalChoices = listOf(3, 5, 8, 10, 15, 20, 30)

    fun minutesLabel(m: Int): String = if (m == 1) "1 min" else "$m min"

    fun idleLabel(m: Int): String = if (m == 0) "Never" else minutesLabel(m)

    fun secondsLabel(s: Int): String = if (s == 1) "1 second" else "$s seconds"

    fun albumChoices(memories: List<String?>): List<String> =
        memories.filterNotNull().filter { it.isNotEmpty() }.toSortedSet().toList()
}
