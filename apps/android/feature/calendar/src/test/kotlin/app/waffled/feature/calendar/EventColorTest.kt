package app.waffled.feature.calendar

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Kotlin port of `apps/ios/Tests/EventColorTests.swift` — the family-aware event
 * colour rules, mirrored 1:1 from the web (`apps/web/src/lib/event-color.ts` +
 * `display.ts` and their vitest suites).
 *
 * Resolution is pure so every surface that renders an event gets one answer; only the
 * painting differs.
 */
class EventColorTest {

    private fun people(
        owner: String? = null,
        color: String? = null,
        participants: List<String> = emptyList(),
    ) = EventPeople(ownerPersonId = owner, ownerColorHex = color, participantIds = participants.toSet())

    // ---- style resolution ------------------------------------------------------

    @Test
    fun anAbsentStyleIsSolid() {
        assertEquals(EventStyle.Solid, EventStyle.resolve(null))
    }

    @Test
    fun anythingButAnExplicitTintedIsSolid() {
        // Matches the web's `eventStyle()`, so a typo'd or future value degrades to the
        // default look rather than to an empty chip.
        assertEquals(EventStyle.Solid, EventStyle.resolve(""))
        assertEquals(EventStyle.Solid, EventStyle.resolve("SOLID"))
        assertEquals(EventStyle.Solid, EventStyle.resolve("rainbow"))
        assertEquals(EventStyle.Solid, EventStyle.resolve("Tinted"))
    }

    @Test
    fun anExplicitTintedIsTinted() {
        assertEquals(EventStyle.Tinted, EventStyle.resolve("tinted"))
    }

    // ---- the family colour setting ---------------------------------------------

    @Test
    fun aMissingOrMalformedFamilyHexFallsBackToTheDefault() {
        // Mirrors the server's HEX_COLOR guard — the stored setting is free-form jsonb, so
        // a hand-edited household row must not leak a malformed colour into the calendar.
        assertEquals(EventPalette.DEFAULT_FAMILY_HEX, EventPalette.normalizedFamilyHex(null))
        assertEquals(EventPalette.DEFAULT_FAMILY_HEX, EventPalette.normalizedFamilyHex(""))
        assertEquals(EventPalette.DEFAULT_FAMILY_HEX, EventPalette.normalizedFamilyHex("F97316"))
        assertEquals(EventPalette.DEFAULT_FAMILY_HEX, EventPalette.normalizedFamilyHex("#F9731"))
        assertEquals(EventPalette.DEFAULT_FAMILY_HEX, EventPalette.normalizedFamilyHex("#ZZZZZZ"))
        assertEquals(EventPalette.DEFAULT_FAMILY_HEX, EventPalette.normalizedFamilyHex("#F97316AA"))
    }

    @Test
    fun keepsAValidSixDigitHexInEitherCase() {
        assertEquals("#123abc", EventPalette.normalizedFamilyHex("#123abc"))
        assertEquals("#ABCDEF", EventPalette.normalizedFamilyHex("#ABCDEF"))
    }

    @Test
    fun theDefaultFamilyColourIsTheWebsOrange() {
        assertEquals("#F97316", EventPalette.DEFAULT_FAMILY_HEX)
    }

    // ---- the family-event predicate --------------------------------------------

    private val palette = EventPalette(memberIds = setOf("a", "b", "c"), familyHex = "#F97316")

    @Test
    fun ownerPlusParticipantsCoveringEveryoneIsAFamilyEvent() {
        assertTrue(palette.isFamilyEvent(people(owner = "a", participants = listOf("b", "c"))))
        // Participants alone are enough when they already cover the household.
        assertTrue(palette.isFamilyEvent(people(participants = listOf("a", "b", "c"))))
    }

    @Test
    fun missingOneMemberIsNotAFamilyEvent() {
        assertFalse(palette.isFamilyEvent(people(owner = "a", participants = listOf("b"))))
        assertFalse(palette.isFamilyEvent(people(owner = "a")))
        assertFalse(palette.isFamilyEvent(people()))
    }

    @Test
    fun extraNonMemberParticipantsStillCount() {
        // A guest / stale id must not stop a whole-family event from qualifying.
        assertTrue(palette.isFamilyEvent(people(owner = "a", participants = listOf("b", "c", "ghost"))))
    }

    @Test
    fun aOnePersonHouseholdNeverQualifies() {
        // There is no whole-vs-part distinction to draw, so a solo household keeps its own
        // colour rather than painting every event orange.
        val solo = EventPalette(memberIds = setOf("a"), familyHex = "#F97316")
        assertFalse(solo.isFamilyEvent(people(owner = "a", participants = listOf("a"))))
        assertEquals("#2F7FED", solo.hex(people(owner = "a", color = "#2F7FED")))
    }

    @Test
    fun anEmptyHouseholdNeverQualifies() {
        val empty = EventPalette(memberIds = emptySet(), familyHex = "#F97316")
        assertFalse(empty.isFamilyEvent(people(owner = "a")))
    }

    // ---- resolution ------------------------------------------------------------

    private val pair = EventPalette(memberIds = setOf("a", "b"), familyHex = "#F97316")

    @Test
    fun familyEventsTakeTheFamilyColourOverTheOwners() {
        assertEquals(
            "#F97316",
            pair.hex(people(owner = "a", color = "#2F7FED", participants = listOf("b"))),
        )
    }

    @Test
    fun partialEventsKeepTheOwnerColour() {
        assertEquals("#2F7FED", pair.hex(people(owner = "a", color = "#2F7FED")))
    }

    @Test
    fun unassignedEventsResolveToNullSoTheCallSiteKeepsItsOwnGrey() {
        // The grids and the agenda surfaces use different greys (the web passes two
        // different fallbacks to useEventColor), so resolution declines to pick one.
        assertNull(pair.hex(people()))
    }

    // ---- the readable-ink rule for solid chips ---------------------------------

    /**
     * Expectations are the WEB function's own output for each colour, so a drift on any
     * platform fails here. White clears WCAG AA on only one of the eight preset member
     * colours, so each chip picks black or white by the luminance of the fill it actually
     * gets — which differs per theme, because dark mixes the fill 82% toward black.
     */
    private data class Fixture(val hex: String, val darkFill: String, val lightInk: String, val darkInk: String)

    private val fixtures = listOf(
        Fixture("#2F7FED", "#2768C2", "#000000", "#FFFFFF"),
        Fixture("#EC6049", "#C24F3C", "#000000", "#FFFFFF"),
        Fixture("#25A368", "#1E8655", "#000000", "#000000"),
        Fixture("#8B5CF6", "#724BCA", "#000000", "#FFFFFF"),
        Fixture("#E0A500", "#B88700", "#000000", "#000000"),
        Fixture("#EC4899", "#C23B7D", "#000000", "#FFFFFF"),
        Fixture("#14B8A6", "#109788", "#000000", "#000000"),
        Fixture("#6B7280", "#585D69", "#FFFFFF", "#FFFFFF"),
        // The default family colour, and the extremes.
        Fixture("#F97316", "#CC5E12", "#000000", "#000000"),
        Fixture("#FFFFFF", "#D1D1D1", "#000000", "#000000"),
        Fixture("#000000", "#000000", "#FFFFFF", "#FFFFFF"),
    )

    @Test
    fun theDarkFillMatchesTheWebsSolidDarkMix() {
        for (f in fixtures) {
            assertEquals(f.darkFill, EventChipInk.solidFill(f.hex, dark = true), "dark fill for ${f.hex}")
            assertEquals(
                f.hex.uppercase(),
                EventChipInk.solidFill(f.hex, dark = false),
                "light fill for ${f.hex}",
            )
        }
    }

    @Test
    fun theInkMatchesTheWebsChoicePerTheme() {
        for (f in fixtures) {
            assertEquals(f.lightInk, EventChipInk.ink(f.hex, dark = false), "light ink for ${f.hex}")
            assertEquals(f.darkInk, EventChipInk.ink(f.hex, dark = true), "dark ink for ${f.hex}")
        }
    }

    @Test
    fun theChosenInkAlwaysClearsWcagAA() {
        // The point of the rule: whichever ink wins is never below 4.5:1 — the failure it
        // replaces was a fixed white at 2.20:1 on gold.
        for (f in fixtures.filter { it.hex != "#FFFFFF" }) {
            assertTrue(
                EventChipInk.contrastRatio(f.hex, f.lightInk) >= 4.5,
                "light contrast for ${f.hex}",
            )
        }
        assertTrue(EventChipInk.contrastRatio("#E0A500", "#FFFFFF") < 2.5) // the old fixed white
        assertTrue(EventChipInk.contrastRatio("#14B8A6", "#FFFFFF") < 2.6)
    }

    @Test
    fun malformedInputFallsBackRatherThanCrashing() {
        assertNull(EventChipInk.solidFill("nonsense", dark = true))
        assertEquals(1.0, EventChipInk.contrastRatio("nonsense", "#FFFFFF"))
    }
}
