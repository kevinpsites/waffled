import Foundation
import Testing
@testable import Waffled

// The family-aware event-color rules, mirrored 1:1 from the web
// (apps/web/src/lib/event-color.ts + display.ts and their vitest suites). The
// resolution itself is pure so both device experiences — iPhone Today/Calendar
// and the iPad kiosk — can share one answer; only the painting differs.

private func event(_ id: String, owner: String? = nil, color: String? = nil,
                   participants: [String] = []) -> SyncedEvent {
    SyncedEvent(id: id, title: id, startsAtRaw: nil, startsAt: nil, allDay: false,
                personId: owner, colorHex: color, emoji: nil, participantIds: participants)
}

@Suite struct EventStyleResolutionTests {
    @Test func absentStyleIsSolid() {
        #expect(EventStyle.resolve(nil) == .solid)
    }

    @Test func unknownStyleIsSolid() {
        // Anything that isn't an explicit "tinted" is solid — matches the web's
        // `eventStyle()`, so a typo'd or future value degrades to the default look
        // rather than to an empty chip.
        #expect(EventStyle.resolve("") == .solid)
        #expect(EventStyle.resolve("SOLID") == .solid)
        #expect(EventStyle.resolve("rainbow") == .solid)
        #expect(EventStyle.resolve("Tinted") == .solid)
    }

    @Test func explicitTintedIsTinted() {
        #expect(EventStyle.resolve("tinted") == .tinted)
    }
}

@Suite struct FamilyColorTests {
    @Test func defaultsWhenUnsetOrMalformed() {
        #expect(EventPalette.normalizedFamilyHex(nil) == EventPalette.defaultFamilyHex)
        #expect(EventPalette.normalizedFamilyHex("") == EventPalette.defaultFamilyHex)
        #expect(EventPalette.normalizedFamilyHex("F97316") == EventPalette.defaultFamilyHex)
        #expect(EventPalette.normalizedFamilyHex("#F9731") == EventPalette.defaultFamilyHex)
        #expect(EventPalette.normalizedFamilyHex("#ZZZZZZ") == EventPalette.defaultFamilyHex)
        #expect(EventPalette.normalizedFamilyHex("#F97316AA") == EventPalette.defaultFamilyHex)
    }

    @Test func keepsAValidSixDigitHexInEitherCase() {
        #expect(EventPalette.normalizedFamilyHex("#123abc") == "#123abc")
        #expect(EventPalette.normalizedFamilyHex("#ABCDEF") == "#ABCDEF")
    }

    @Test func defaultIsTheWebsOrange() {
        #expect(EventPalette.defaultFamilyHex == "#F97316")
    }
}

@Suite struct FamilyEventPredicateTests {
    private let palette = EventPalette(memberIds: ["a", "b", "c"], familyHex: "#F97316", style: .solid)

    @Test func ownerPlusParticipantsCoveringEveryoneIsAFamilyEvent() {
        #expect(palette.isFamilyEvent(event("e", owner: "a", participants: ["b", "c"])))
        // Participants alone are enough when they already cover the household.
        #expect(palette.isFamilyEvent(event("e", participants: ["a", "b", "c"])))
    }

    @Test func missingOneMemberIsNotAFamilyEvent() {
        #expect(!palette.isFamilyEvent(event("e", owner: "a", participants: ["b"])))
        #expect(!palette.isFamilyEvent(event("e", owner: "a")))
        #expect(!palette.isFamilyEvent(event("e")))
    }

    @Test func extraNonMemberParticipantsStillCount() {
        // A guest/stale id must not stop a whole-family event from qualifying.
        #expect(palette.isFamilyEvent(event("e", owner: "a", participants: ["b", "c", "ghost"])))
    }

    @Test func onePersonHouseholdNeverQualifies() {
        // There's no whole-vs-part distinction to draw, so a solo household keeps its
        // own color rather than painting every event orange.
        let solo = EventPalette(memberIds: ["a"], familyHex: "#F97316", style: .solid)
        #expect(!solo.isFamilyEvent(event("e", owner: "a", participants: ["a"])))
        #expect(solo.hex(for: event("e", owner: "a", color: "#2F7FED")) == "#2F7FED")
    }

    @Test func emptyHouseholdNeverQualifies() {
        let empty = EventPalette(memberIds: [], familyHex: "#F97316", style: .solid)
        #expect(!empty.isFamilyEvent(event("e", owner: "a")))
    }
}

// The readable-ink rule for solid chips. Ported from the web's `solidChipInk`
// (apps/web/src/lib/event-color.ts): white clears WCAG AA on only one of the eight
// preset member colors, so each chip picks black or white by the luminance of the
// fill it actually gets — which differs per theme, because dark mixes the fill 82%
// toward black. Expectations below are the *web function's own output* for each
// color, so a drift on either platform fails here.
@Suite struct SolidChipInkTests {
    private struct Fixture { let hex, darkFill, lightInk, darkInk: String }
    private let fixtures: [Fixture] = [
        .init(hex: "#2F7FED", darkFill: "#2768C2", lightInk: "#000000", darkInk: "#FFFFFF"),
        .init(hex: "#EC6049", darkFill: "#C24F3C", lightInk: "#000000", darkInk: "#FFFFFF"),
        .init(hex: "#25A368", darkFill: "#1E8655", lightInk: "#000000", darkInk: "#000000"),
        .init(hex: "#8B5CF6", darkFill: "#724BCA", lightInk: "#000000", darkInk: "#FFFFFF"),
        .init(hex: "#E0A500", darkFill: "#B88700", lightInk: "#000000", darkInk: "#000000"),
        .init(hex: "#EC4899", darkFill: "#C23B7D", lightInk: "#000000", darkInk: "#FFFFFF"),
        .init(hex: "#14B8A6", darkFill: "#109788", lightInk: "#000000", darkInk: "#000000"),
        .init(hex: "#6B7280", darkFill: "#585D69", lightInk: "#FFFFFF", darkInk: "#FFFFFF"),
        // The default family color, and the extremes.
        .init(hex: "#F97316", darkFill: "#CC5E12", lightInk: "#000000", darkInk: "#000000"),
        .init(hex: "#FFFFFF", darkFill: "#D1D1D1", lightInk: "#000000", darkInk: "#000000"),
        .init(hex: "#000000", darkFill: "#000000", lightInk: "#FFFFFF", darkInk: "#FFFFFF"),
    ]

    @Test func darkFillMatchesTheWebsSolidDarkMix() {
        for f in fixtures {
            #expect(EventChipInk.solidFill(f.hex, dark: true) == f.darkFill, "dark fill for \(f.hex)")
            #expect(EventChipInk.solidFill(f.hex, dark: false) == f.hex.uppercased(), "light fill for \(f.hex)")
        }
    }

    @Test func inkMatchesTheWebsChoicePerTheme() {
        for f in fixtures {
            let ink = EventChipInk.ink(for: f.hex)
            #expect(ink.light == f.lightInk, "light ink for \(f.hex)")
            #expect(ink.dark == f.darkInk, "dark ink for \(f.hex)")
        }
    }

    @Test func theChosenInkAlwaysClearsWcagAA() {
        // The point of the rule: whichever ink wins is never below 4.5:1 — the failure
        // it replaces was a fixed white at 2.20:1 on gold.
        for f in fixtures where f.hex != "#FFFFFF" {
            #expect(EventChipInk.contrastRatio(f.hex, f.lightInk) >= 4.5, "light contrast for \(f.hex)")
        }
        #expect(EventChipInk.contrastRatio("#E0A500", "#FFFFFF") < 2.5)   // the old fixed white
        #expect(EventChipInk.contrastRatio("#14B8A6", "#FFFFFF") < 2.6)
    }

    @Test func malformedInputFallsBackRatherThanCrashing() {
        #expect(EventChipInk.solidFill("nonsense", dark: true) == nil)
        #expect(EventChipInk.contrastRatio("nonsense", "#FFFFFF") == 1)
    }
}

@Suite struct EventPaletteHexTests {
    private let palette = EventPalette(memberIds: ["a", "b"], familyHex: "#F97316", style: .solid)

    @Test func familyEventsTakeTheFamilyColorOverTheOwners() {
        let whole = event("e", owner: "a", color: "#2F7FED", participants: ["b"])
        #expect(palette.hex(for: whole) == "#F97316")
    }

    @Test func partialEventsKeepTheOwnerColor() {
        #expect(palette.hex(for: event("e", owner: "a", color: "#2F7FED")) == "#2F7FED")
    }

    @Test func unassignedEventsReturnNilSoTheCallSiteKeepsItsOwnGrey() {
        // The grids and the agenda surfaces use different greys (the web passes two
        // different fallbacks to useEventColor), so resolution declines to pick one.
        #expect(palette.hex(for: event("e")) == nil)
    }
}
