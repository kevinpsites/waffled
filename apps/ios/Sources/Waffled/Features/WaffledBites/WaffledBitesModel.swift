import SwiftUI
import Observation

/// UI-only presets/options for the parent control panel — copied 1:1 from
/// `apps/web/src/kiosk/WaffledBiteDevice.tsx`'s constant tables. None of this is
/// server-enforced (`color`/`sound`/`tone` are free-form strings on the wire); keep
/// this in sync with the web app if it ever changes.
enum WaffledBiteOptions {
    static let quietPresetsMin = [10, 15, 20, 30, 60]
    static let timerPresetsMin = [5, 10, 15, 20, 30]
    static let sleepTimerChipsMin = [0, 15, 30, 60, 120]   // 0 = "Off"

    static let nightColors: [(key: String, hex: UInt32)] = [
        ("amber", 0xF0A94B), ("peach", 0xF28E6B), ("blush", 0xEF7FA6),
        ("lilac", 0xA98BE8), ("ocean", 0x5AA7E0), ("mint", 0x5BC98B),
    ]
    static let sounds: [(key: String, label: String)] = [
        ("white", "White noise"), ("ocean", "Ocean waves"), ("rain", "Gentle rain"),
        ("fan", "Box fan"), ("heartbeat", "Heartbeat"), ("lullaby", "Lullaby"), ("forest", "Forest"),
    ]
    static let alarmTones = ["Sunrise chime", "Birdsong", "Soft harp", "Gentle bells", "Ocean tide", "Twinkle stars"]

    static func nightHex(_ key: String) -> UInt32 { nightColors.first { $0.key == key }?.hex ?? nightColors[0].hex }
    static func soundLabel(_ key: String) -> String { sounds.first { $0.key == key }?.label ?? key.capitalized }

    /// Preset-minutes label: "Nh" at/above an hour, else "Nm" — matches the web's `fmtPreset`.
    static func presetLabel(_ min: Int) -> String { min >= 60 ? "\(min / 60)h" : "\(min)m" }

    /// Quiet/timer custom-duration input clamp — the server backstops to [60,10800]s
    /// (3h) regardless, but the UI only ever offers 1–180 minutes.
    static func clampCustomMinutes(_ min: Int) -> Int { max(1, Swift.min(180, min)) }
}

extension WaffledAPI.WaffledBiteSettings {
    /// A freshly paired device has `settings == {}` — fill in the same fallbacks the
    /// web app applies inline (`night ?? {...}` etc.) before rendering.
    var withDefaults: Filled {
        Filled(
            night: night ?? .init(on: false, color: "amber", brightness: 40),
            sound: sound ?? .init(on: false, sound: "ocean", volume: 45, timerMin: 0),
            alarm: alarm ?? .init(on: false, hour: 6, min: 45, tone: "Sunrise chime"),
            schedules: schedules ?? [],
            display: display ?? .init(brightness: 85, nightDim: true))
    }

    struct Filled {
        var night: Night
        var sound: Sound
        var alarm: Alarm
        var schedules: [Schedule]
        var display: Display
    }
}

/// Loads and controls one kid's Waffled-Bite: pairing, live quiet/timer countdowns, the
/// wake-light schedule, and every settings toggle. One instance per `WaffledBitesView`.
@MainActor
@Observable
final class WaffledBitesModel {
    let personId: String
    private(set) var device: WaffledAPI.WaffledBiteDevice?
    private(set) var loading = true
    private(set) var busy = false
    private(set) var errorMessage: String?

    /// Local countdown smoothing — mirrors the web's `useLocalCountdown`: reseeded from
    /// the server's `remainingSec` on every load, then ticks down locally once a second
    /// while running so the display doesn't stall between refetches. The server value
    /// (recomputed fresh from stored timestamps) is always the source of truth again on
    /// the next load.
    private(set) var quietRemaining = 0
    private(set) var timerRemaining = 0
    private var tickTask: Task<Void, Never>?

    /// Bumped on every `load()` call, captured before the await — lets a response that
    /// resolves out of order (e.g. two rapid schedule edits' PATCH+reload round trips
    /// racing on the network) recognize it's stale and skip applying, instead of
    /// clobbering a newer `device` with older data. Without this, a stale response could
    /// silently revert an edit that was already saved successfully — flagged in PR review.
    private var loadGeneration = 0

    private let api = WaffledAPI()

    init(personId: String) {
        self.personId = personId
    }

    func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        do {
            let fetched = try await api.waffledBiteDevice(personId: personId)
            guard generation == loadGeneration else { return }
            device = fetched
            errorMessage = nil
        } catch {
            guard generation == loadGeneration else { return }
            errorMessage = "Couldn't load this Waffled-Bite."
        }
        loading = false
        quietRemaining = device?.runtimeState.quiet.remainingSec ?? 0
        timerRemaining = device?.runtimeState.timer.remainingSec ?? 0
        restartTicking()
    }

    private func restartTicking() {
        tickTask?.cancel()
        guard device != nil else { return }
        tickTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, !Task.isCancelled else { return }
                if self.device?.runtimeState.quiet.running == true, self.quietRemaining > 0 {
                    self.quietRemaining -= 1
                }
                if self.device?.runtimeState.timer.running == true, self.timerRemaining > 0 {
                    self.timerRemaining -= 1
                }
            }
        }
    }

    // MARK: unpair

    /// Returns `true` on success so the caller can pop back to the person page.
    @discardableResult
    func unpair() async -> Bool {
        guard let id = device?.id else { return false }
        busy = true
        defer { busy = false }
        do {
            try await api.unpairWaffledBite(deviceId: id)
            return true
        } catch {
            errorMessage = "Couldn't unpair — try again."
            return false
        }
    }

    // MARK: quiet time / occasional timer

    func startQuiet(minutes: Int) async {
        await withDeviceId { id in
            try await self.api.waffledBiteQuietStart(deviceId: id, durationSec: WaffledBiteOptions.clampCustomMinutes(minutes) * 60)
        }
    }
    func pauseQuiet() async { await withDeviceId { try await self.api.waffledBiteQuietPause(deviceId: $0) } }
    func resumeQuiet() async { await withDeviceId { try await self.api.waffledBiteQuietResume(deviceId: $0) } }
    func addQuietTime() async { await withDeviceId { try await self.api.waffledBiteQuietAddTime(deviceId: $0) } }
    func endQuiet() async { await withDeviceId { try await self.api.waffledBiteQuietEnd(deviceId: $0) } }

    func startTimer(minutes: Int) async {
        await withDeviceId { id in
            try await self.api.waffledBiteTimerStart(deviceId: id, durationSec: WaffledBiteOptions.clampCustomMinutes(minutes) * 60)
        }
    }
    func pauseTimer() async { await withDeviceId { try await self.api.waffledBiteTimerPause(deviceId: $0) } }
    func resumeTimer() async { await withDeviceId { try await self.api.waffledBiteTimerResume(deviceId: $0) } }
    func addTimerTime() async { await withDeviceId { try await self.api.waffledBiteTimerAddTime(deviceId: $0) } }
    func endTimer() async { await withDeviceId { try await self.api.waffledBiteTimerEnd(deviceId: $0) } }

    // MARK: settings — night / sound / alarm / display
    //
    // Every setter sends the FULL sub-object (current values + the one changed field),
    // never just the changed key. The server's deepMerge only merges into an EXISTING
    // object — a freshly paired device has `settings == {}}`, so a bare `{"on":true}`
    // patch would be stored verbatim, missing `color`/`brightness`. Those fields are
    // non-optional in `WaffledBiteSettings.Night` (WaffledAPI.swift), so the next decode
    // of that device (this PATCH's own response, or any later load) throws and the panel
    // never recovers — this exact bug was flagged in PR review. Matches the web app's
    // `patchSettings({ night: { ...night, on: v } })` pattern (WaffledBiteDevice.tsx).

    func setNightOn(_ on: Bool) async { await patchNight { $0.on = on } }
    func setNightColor(_ key: String) async { await patchNight { $0.color = key } }
    func setNightBrightness(_ b: Int) async { await patchNight { $0.brightness = b } }

    func setSoundOn(_ on: Bool) async { await patchSound { $0.on = on } }
    func setSoundOption(_ key: String) async { await patchSound { $0.sound = key } }
    func setSoundVolume(_ v: Int) async { await patchSound { $0.volume = v } }
    func setSoundSleepTimer(_ min: Int) async { await patchSound { $0.timerMin = min } }

    func setAlarmOn(_ on: Bool) async { await patchAlarm { $0.on = on } }
    func setAlarmTime(hour: Int, min: Int) async { await patchAlarm { $0.hour = hour; $0.min = min } }
    func setAlarmTone(_ tone: String) async { await patchAlarm { $0.tone = tone } }

    func setDisplayBrightness(_ b: Int) async { await patchDisplay { $0.brightness = b } }
    func setDisplayNightDim(_ on: Bool) async { await patchDisplay { $0.nightDim = on } }

    private func patchNight(_ mutate: (inout WaffledAPI.WaffledBiteSettings.Night) -> Void) async {
        var night = device?.settings.withDefaults.night ?? .init(on: false, color: "amber", brightness: 40)
        mutate(&night)
        await patch(["night": .object(["on": .bool(night.on), "color": .string(night.color), "brightness": .int(night.brightness)])])
    }
    private func patchSound(_ mutate: (inout WaffledAPI.WaffledBiteSettings.Sound) -> Void) async {
        var sound = device?.settings.withDefaults.sound ?? .init(on: false, sound: "ocean", volume: 45, timerMin: 0)
        mutate(&sound)
        await patch(["sound": .object(["on": .bool(sound.on), "sound": .string(sound.sound), "volume": .int(sound.volume), "timerMin": .int(sound.timerMin)])])
    }
    private func patchAlarm(_ mutate: (inout WaffledAPI.WaffledBiteSettings.Alarm) -> Void) async {
        var alarm = device?.settings.withDefaults.alarm ?? .init(on: false, hour: 6, min: 45, tone: "Sunrise chime")
        mutate(&alarm)
        await patch(["alarm": .object(["on": .bool(alarm.on), "hour": .int(alarm.hour), "min": .int(alarm.min), "tone": .string(alarm.tone)])])
    }
    private func patchDisplay(_ mutate: (inout WaffledAPI.WaffledBiteSettings.Display) -> Void) async {
        var display = device?.settings.withDefaults.display ?? .init(brightness: 85, nightDim: true)
        mutate(&display)
        await patch(["display": .object(["brightness": .int(display.brightness), "nightDim": .bool(display.nightDim)])])
    }

    /// Wake-light schedules always round-trip the FULL array — the server replaces
    /// arrays outright rather than merging them, matching the web app's own behavior.
    func setSchedules(_ schedules: [WaffledAPI.WaffledBiteSettings.Schedule]) async {
        let encoded = schedules.map { s -> JSONValue in
            var obj: [String: JSONValue] = [
                "days": .array(s.days.map(JSONValue.int)),
                "wakeMin": .int(s.wakeMin),
                "leadMin": .int(s.leadMin),
            ]
            if let bedtimeMin = s.bedtimeMin { obj["bedtimeMin"] = .int(bedtimeMin) }
            return .object(obj)
        }
        await patch(["schedules": .array(encoded)])
    }

    // MARK: helpers

    private func withDeviceId(_ action: @escaping (String) async throws -> Void) async {
        guard let id = device?.id else { return }
        busy = true
        do {
            try await action(id)
            await load()
        } catch {
            errorMessage = "That didn't stick — try again."
        }
        busy = false
    }

    private func patch(_ body: [String: JSONValue]) async {
        guard let id = device?.id else { return }
        busy = true
        do {
            try await api.updateWaffledBiteSettings(deviceId: id, patch: body)
            await load()
        } catch {
            errorMessage = "That didn't stick — try again."
        }
        busy = false
    }
}
