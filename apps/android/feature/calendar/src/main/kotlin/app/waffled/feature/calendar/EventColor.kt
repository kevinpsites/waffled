package app.waffled.feature.calendar

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import app.waffled.core.design.colorFromHex
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * Family-aware event colouring + the household's chip style — the Kotlin port of
 * `apps/ios/.../Calendar/EventColor.swift`, itself a mirror of the web's
 * `apps/web/src/lib/event-color.ts` + `display.ts` and the `.ev-tint` rules in
 * `apps/web/src/styles/waffled.css`.
 *
 * Resolution is pure and lives here rather than in the views because several surfaces
 * render events, and a rule applied to only one of them is the defect this app keeps
 * shipping.
 */

/**
 * How the calendar paints an event chip. `Solid` (full-colour blocks — the default, and
 * the most glanceable from across the kitchen) or `Tinted` (a soft wash with coloured
 * text). Stored in `households.settings.display.eventStyle`.
 */
enum class EventStyle(val wire: String, val label: String) {
    Solid("solid", "Solid colors"),
    Tinted("tinted", "Tinted"),
    ;

    companion object {
        /**
         * Resolve the stored value; **anything but an explicit `"tinted"` is solid**, so an
         * unset, typo'd or future value degrades to the default look instead of an empty
         * chip. Case-sensitive on purpose — it matches the web's `eventStyle()` exactly.
         */
        fun resolve(raw: String?): EventStyle = if (raw == "tinted") Tinted else Solid
    }
}

/**
 * The colouring inputs a synced event row does not carry.
 *
 * ⚠️ `SyncedEvent` in `core:sync` has neither the owner's colour nor the participant list
 * — the participants live in the synced `event_participants` table, which nothing joins
 * yet. Rather than guess, colouring takes them explicitly and the model supplies whatever
 * it has. See the port report: this is a missing accessor in `core:sync`, not a schema gap.
 *
 * Built ONCE per row per data load, never in a render path.
 */
@Immutable
data class EventPeople(
    /** The assignee that drives the event's colour (`events.person_id`). */
    val ownerPersonId: String? = null,
    /** That person's `persons.color_hex`, denormalised at load time. */
    val ownerColorHex: String? = null,
    /** That person's avatar emoji — the agenda card's identity glyph. */
    val ownerAvatarEmoji: String? = null,
    val participantIds: Set<String> = emptySet(),
) {
    /** Owner ∪ participants — who this event is "for". */
    val allPersonIds: Set<String>
        get() = if (ownerPersonId == null) participantIds else participantIds + ownerPersonId
}

/**
 * Everything needed to colour one event: who is in the household, the whole-family colour,
 * and the chip style. Precomputed once per data change so a render is a set lookup.
 */
@Immutable
data class EventPalette(
    val memberIds: Set<String> = emptySet(),
    val familyHex: String = DEFAULT_FAMILY_HEX,
    val style: EventStyle = EventStyle.Solid,
) {

    /**
     * A "family event" = its people (participants + the owner) cover every household
     * member. **One-person households never qualify** — there is no whole-vs-part
     * distinction to draw, so a solo household keeps its own colour everywhere.
     */
    fun isFamilyEvent(people: EventPeople): Boolean {
        if (memberIds.size < 2) return false
        return people.allPersonIds.containsAll(memberIds)
    }

    /**
     * The colour this event should paint in: the family colour for whole-family events,
     * else the owner's. `null` means unassigned — the CALL SITE keeps its own grey (the
     * grids and the agenda surfaces deliberately use different ones, matching the two
     * fallbacks the web passes to `useEventColor`).
     */
    fun hex(people: EventPeople): String? =
        if (isFamilyEvent(people)) familyHex else people.ownerColorHex

    companion object {
        /**
         * Default whole-family colour — deliberately not one of the member swatches.
         *
         * A literal hex, and correct: this is the DEFAULT VALUE of a server-stored setting
         * mirrored from the web, not a palette choice. It is data, so it does not belong in
         * (and could not be expressed by) the frozen `WF` token table.
         */
        const val DEFAULT_FAMILY_HEX: String = "#F97316"

        /**
         * A full `#RRGGBB` value, or the default. Mirrors the server's `HEX_COLOR` guard —
         * the stored setting is free-form jsonb, so a hand-edited household row can't leak
         * a malformed colour into the calendar.
         */
        fun normalizedFamilyHex(raw: String?): String =
            if (raw != null && isHex(raw)) raw else DEFAULT_FAMILY_HEX

        /** Is this a full `#RRGGBB` hex? (Shared with the custom-colour picker.) */
        fun isHex(value: String): Boolean =
            value.length == 7 && value.startsWith("#") && value.drop(1).all { it.isHexDigit() }

        private fun Char.isHexDigit(): Boolean =
            this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'
    }
}

/**
 * The readable-ink rule for **solid** chips, ported 1:1 from the web's `solidChipInk`.
 *
 * A solid chip fills with the event's colour, so the text can't be a fixed white: white
 * clears WCAG AA (4.5:1) on only one of the eight preset member colours — gold sits at
 * 2.2:1 and teal at 2.5:1, illegible from across a kitchen. Black or white always works,
 * though: wherever white falls short the fill is light enough that black clears it (the
 * crossover is at luminance ≈0.179, where both give 4.58:1). So each chip takes the winning
 * ink **for the fill it actually gets**, which differs by theme — dark mixes the fill
 * toward black first.
 *
 * Kept as pure hex→hex functions (rather than folded into `Color` maths) so the tests can
 * assert the web function's exact output for every swatch; a drift on any platform then
 * fails on one side.
 *
 * The `#FFFFFF` / `#000000` returned here are hex literals and that is correct: they are
 * the OUTPUT of a contrast algorithm, not a palette choice, and neither is expressible as
 * a `WF` token (both must stay fixed while every token flips with the theme).
 */
object EventChipInk {

    /** Dark mode mixes the fill toward black; keep in step with the web's `SOLID_DARK_MIX`. */
    const val SOLID_DARK_MIX: Double = 0.82

    const val WHITE = "#FFFFFF"
    const val BLACK = "#000000"

    /** The fill a solid chip actually gets in that theme, as `#RRGGBB`; null if malformed. */
    fun solidFill(hex: String, dark: Boolean): String? {
        val rgb = components(hex) ?: return null
        if (!dark) return format(rgb)
        return format(rgb.map { Math.round(it * SOLID_DARK_MIX).toDouble() })
    }

    /**
     * WCAG contrast ratio between two `#RRGGBB` colours (1–21); 1 for malformed input,
     * which makes an unparseable colour fall through to the same answer on every platform.
     */
    fun contrastRatio(a: String, b: String): Double {
        val ca = components(a) ?: return 1.0
        val cb = components(b) ?: return 1.0
        val la = luminance(ca)
        val lb = luminance(cb)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    /** Black or white — whichever reads better on this colour's fill in [dark]. */
    fun ink(hex: String, dark: Boolean): String = inkFor(solidFill(hex, dark) ?: hex)

    /**
     * The winning ink for an ALREADY-RESOLVED Compose colour — the entry point the chip
     * painter uses, since by then the theme has collapsed the token to concrete channels.
     */
    fun inkOn(fill: Color): String {
        val hex = "#%02X%02X%02X".format(
            (fill.red * 255).roundToInt().coerceIn(0, 255),
            (fill.green * 255).roundToInt().coerceIn(0, 255),
            (fill.blue * 255).roundToInt().coerceIn(0, 255),
        )
        return inkFor(hex)
    }

    private fun inkFor(background: String): String =
        if (contrastRatio(background, WHITE) >= contrastRatio(background, BLACK)) WHITE else BLACK

    /** WCAG relative luminance of 0–255 components. */
    private fun luminance(rgb: List<Double>): Double {
        val c = rgb.map { v ->
            val s = v / 255.0
            if (s <= 0.03928) s / 12.92 else ((s + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    }

    private fun components(hex: String): List<Double>? {
        val s = hex.trim()
        if (!s.startsWith("#")) return null
        val body = s.drop(1)
        if (body.length != 6) return null
        val v = body.toLongOrNull(16) ?: return null
        return listOf(
            ((v shr 16) and 0xFF).toDouble(),
            ((v shr 8) and 0xFF).toDouble(),
            (v and 0xFF).toDouble(),
        )
    }

    private fun format(rgb: List<Double>): String =
        "#%02X%02X%02X".format(
            rgb[0].coerceIn(0.0, 255.0).roundToInt(),
            rgb[1].coerceIn(0.0, 255.0).roundToInt(),
            rgb[2].coerceIn(0.0, 255.0).roundToInt(),
        )
}

/**
 * The two colours one event chip is painted with, resolved for a theme. Mirrors the web
 * stylesheet exactly:
 *
 *  * **solid** — the chip fills with the event colour and the title takes the ink that
 *    stays readable on that fill (see [EventChipInk]). This is *not* a `WF.colors.ink`
 *    fill, so neither `onInk` nor a literal white is right here. In dark the fill mixes 18%
 *    toward black so it keeps depth against the warm charcoal card, and the ink is
 *    re-picked for that darker fill.
 *  * **tinted** — a 14% (dark: 24%) wash of the colour, with the text mixed 58% (dark: 42%)
 *    of the colour into the theme's ink. Mixing against ink rather than using the raw hex
 *    is what keeps a dark-ish member colour legible on a dark card.
 */
@Immutable
data class EventChipPaint(
    /** The event's resolved colour, unstyled — what an accent bar or dot should use. */
    val color: Color,
    val background: Color,
    val foreground: Color,
) {
    companion object {
        private const val SOLID_DARK_BLEND = 0.18f
        private const val TINT_ALPHA_LIGHT = 0.14f
        private const val TINT_ALPHA_DARK = 0.24f
        private const val TINT_INK_MIX_LIGHT = 0.42f
        private const val TINT_INK_MIX_DARK = 0.58f

        /**
         * Resolve a chip's paint. [color] is the event colour, [ink] the theme's ink token
         * (only the tinted branch needs it), [isDark] the current theme.
         */
        fun of(color: Color, style: EventStyle, ink: Color, isDark: Boolean): EventChipPaint = when (style) {
            EventStyle.Solid -> {
                val fill = if (isDark) lerp(color, Color.Black, SOLID_DARK_BLEND) else color
                EventChipPaint(
                    color = color,
                    background = fill,
                    // The ink follows the RESOLVED fill, so an unassigned chip painted in a
                    // theme grey gets the right answer in each theme too.
                    foreground = if (EventChipInk.inkOn(fill) == EventChipInk.WHITE) Color.White else Color.Black,
                )
            }
            EventStyle.Tinted -> EventChipPaint(
                color = color,
                background = color.copy(alpha = if (isDark) TINT_ALPHA_DARK else TINT_ALPHA_LIGHT),
                foreground = lerp(color, ink, if (isDark) TINT_INK_MIX_DARK else TINT_INK_MIX_LIGHT),
            )
        }
    }
}

/** An event's colour as a Compose [Color], falling back to the caller's own grey. */
fun EventPalette.color(people: EventPeople, fallback: Color): Color =
    colorFromHex(hex(people)) ?: fallback
