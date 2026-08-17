import Foundation
import Testing
@testable import Waffled

// `settings.alarm.tone` used to hold the picker's English label — the row in the
// database literally said "Sunrise chime". Storing the copy meant renaming a chip
// repointed every paired device's alarm, and left nothing translatable. It now
// holds a stable key, matching what `sound` has always done. Migration 0095
// rewrote the existing rows; the firmware's wb_tone_parse accepts both spellings
// so nothing had to ship in lockstep.
@Suite("Waffled-Bite alarm tones")
struct WaffledBiteToneTests {
    @Test("the picker offers stable keys, not display strings")
    func tonesAreKeys() {
        let keys = WaffledBiteOptions.alarmTones.map(\.key)
        #expect(keys == ["sunriseChime", "birdsong", "softHarp", "gentleBells", "oceanTide", "twinkleStars"])
        // These are the exact spellings wb_tone_parse matches (wb_tone.cpp);
        // a typo here is a silently-wrong alarm on a device, not a build error.
        #expect(!keys.contains { $0.contains(" ") })
    }

    @Test("each key renders as its human label")
    func labelsForKeys() {
        #expect(WaffledBiteOptions.toneLabel("sunriseChime") == "Sunrise chime")
        #expect(WaffledBiteOptions.toneLabel("softHarp") == "Soft harp")
        #expect(WaffledBiteOptions.toneLabel("gentleBells") == "Gentle bells")
        #expect(WaffledBiteOptions.toneLabel("oceanTide") == "Ocean tide")
        #expect(WaffledBiteOptions.toneLabel("twinkleStars") == "Twinkle stars")
        #expect(WaffledBiteOptions.toneLabel("birdsong") == "Birdsong")
        // Every offered key must have a label; none may fall through to the raw
        // key, or the panel would show 'sunriseChime' on a chip.
        for (key, label) in WaffledBiteOptions.alarmTones {
            #expect(WaffledBiteOptions.toneLabel(key) == label)
        }
    }

    @Test("an unrecognised stored value still renders as something")
    func unknownToneFallsBack() {
        // A hand-edited or rolled-back row: 0095 deliberately leaves values it
        // doesn't recognise alone, so the panel has to cope with one.
        #expect(WaffledBiteOptions.toneLabel("Kazoo fanfare") == "Kazoo fanfare")
    }

    @Test("birdsong is the one tone still awaiting a recording")
    func birdsongComingSoon() {
        #expect(WaffledBiteOptions.alarmTonesComingSoon == ["birdsong"])
    }

    @Test("a device with no alarm block defaults to a key, not a label")
    func defaultToneIsAKey() {
        // `withDefaults` fills in a freshly paired device's empty settings; if it
        // filled in "Sunrise chime" the very first patch would write a display
        // string straight back into a migrated column.
        let empty = try! JSONDecoder().decode(
            WaffledAPI.WaffledBiteSettings.self,
            from: Data("{}".utf8))
        #expect(empty.withDefaults.alarm.tone == "sunriseChime")
    }
}
