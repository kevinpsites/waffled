import SwiftUI

/// The Waffled-Bite parent control panel — pushed from a person's page. Mirrors
/// `apps/web/src/kiosk/WaffledBiteDevice.tsx` section-for-section: quiet time, wake-light
/// schedule, nightlight, sound machine, morning alarm, an occasional timer, screen &
/// display, and unpair. Sections are always-expanded field cards rather than the web's
/// mix of cards/expandable rows — a deliberate iOS simplification (one consistent shape,
/// same controls, no collapse state to manage) since this is already a dedicated screen.
struct WaffledBitesView: View {
    @Environment(\.dismiss) private var dismiss
    let personId: String
    let personName: String
    @State private var model: WaffledBitesModel
    @State private var showUnpairConfirm = false
    @State private var quietCustom = 5
    @State private var showQuietCustom = false
    @State private var timerCustom = 10
    @State private var showTimerCustom = false
    @State private var schedules: [WaffledAPI.WaffledBiteSettings.Schedule] = []

    init(personId: String, personName: String) {
        self.personId = personId
        self.personName = personName
        _model = State(initialValue: WaffledBitesModel(personId: personId))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if model.loading {
                    WaffledLoading()
                } else if let device = model.device {
                    paired(device)
                } else {
                    unpairedState
                }
                if let msg = model.errorMessage {
                    DismissibleErrorBanner(message: msg) { }
                }
            }
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 60)
        }
        .background(WF.canvas)
        .navigationTitle("Waffled-Bite")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
        .onChange(of: model.device?.settings.schedules) { _, _ in
            schedules = model.device?.settings.withDefaults.schedules ?? []
        }
        .confirmationDialog("Unpair this Waffled-Bite?", isPresented: $showUnpairConfirm, titleVisibility: .visible) {
            Button("Unpair", role: .destructive) {
                Task { if await model.unpair() { dismiss() } }
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("\(personName) will lose their nightlight, quiet-time, and wake-light settings. This can't be undone.")
        }
    }

    private var unpairedState: some View {
        WaffledEmptyState(emoji: "🧇", title: "No Waffled-Bite paired yet",
                           message: "Pair \(personName)'s Waffled-Bite from their profile page to control it here.")
    }

    @ViewBuilder private func paired(_ device: WaffledAPI.WaffledBiteDevice) -> some View {
        let settings = device.settings.withDefaults
        quietCard(device)
        wakeLightCard(device, settings: settings)
        nightlightCard(settings)
        soundCard(settings)
        alarmCard(settings)
        timerCard(device)
        displayCard(settings)
        unpairRow
    }

    // MARK: quiet time / occasional timer (identical shape, different presets/labels)

    private func quietCard(_ device: WaffledAPI.WaffledBiteDevice) -> some View {
        WaffledFieldCard(title: "Quiet time") {
            WaffledStatusBadge(text: "MOST USED", color: WF.primary)
            countdownBody(state: device.runtimeState.quiet, remaining: model.quietRemaining,
                          presets: WaffledBiteOptions.quietPresetsMin,
                          showCustom: $showQuietCustom, custom: $quietCustom,
                          onStart: { m in Task { await model.startQuiet(minutes: m) } },
                          onPause: { Task { await model.pauseQuiet() } },
                          onResume: { Task { await model.resumeQuiet() } },
                          onAddTime: { Task { await model.addQuietTime() } },
                          onEnd: { Task { await model.endQuiet() } })
        }
    }

    private func timerCard(_ device: WaffledAPI.WaffledBiteDevice) -> some View {
        WaffledFieldCard(title: "Set a timer") {
            countdownBody(state: device.runtimeState.timer, remaining: model.timerRemaining,
                          presets: WaffledBiteOptions.timerPresetsMin,
                          showCustom: $showTimerCustom, custom: $timerCustom,
                          onStart: { m in Task { await model.startTimer(minutes: m) } },
                          onPause: { Task { await model.pauseTimer() } },
                          onResume: { Task { await model.resumeTimer() } },
                          onAddTime: { Task { await model.addTimerTime() } },
                          onEnd: { Task { await model.endTimer() } })
        }
    }

    @ViewBuilder private func countdownBody(
        state: WaffledAPI.WaffledBiteDevice.Countdown, remaining: Int,
        presets: [Int], showCustom: Binding<Bool>, custom: Binding<Int>,
        onStart: @escaping (Int) -> Void, onPause: @escaping () -> Void, onResume: @escaping () -> Void,
        onAddTime: @escaping () -> Void, onEnd: @escaping () -> Void
    ) -> some View {
        if state.active {
            VStack(alignment: .leading, spacing: 10) {
                Text(mmss(remaining)).font(.system(size: 34, weight: .heavy, design: .rounded)).foregroundStyle(WF.ink)
                Text(state.running ? "Counting down on the device" : "Paused")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                HStack(spacing: 8) {
                    WBChip(label: state.running ? "Pause" : "Resume") { state.running ? onPause() : onResume() }
                    WBChip(label: "+5 min") { onAddTime() }
                    WBChip(label: "End now", filled: true) { onEnd() }
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    ForEach(presets, id: \.self) { m in
                        WBChip(label: WaffledBiteOptions.presetLabel(m)) { onStart(m) }
                    }
                }
                if showCustom.wrappedValue {
                    HStack(spacing: 10) {
                        Stepper("\(custom.wrappedValue) min", value: custom, in: 1...90)
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
                        WBChip(label: "Start", filled: true) { onStart(custom.wrappedValue) }
                    }
                } else {
                    WBChip(label: "Custom ＋") { showCustom.wrappedValue = true }
                }
            }
        }
    }

    // MARK: wake-light schedule

    private func wakeLightCard(_ device: WaffledAPI.WaffledBiteDevice, settings: WaffledAPI.WaffledBiteSettings.Filled) -> some View {
        WaffledFieldCard(title: "Wake-light schedule") {
            wakeLightBanner(device.runtimeState.wakeLight)
            ForEach(Array(schedules.enumerated()), id: \.offset) { i, sched in
                scheduleRow(sched, index: i)
                if i < schedules.count - 1 { Divider().overlay(WF.hair) }
            }
            if schedules.isEmpty {
                Text("No schedule set yet").font(.system(size: 13.5, weight: .semibold)).foregroundStyle(WF.ink3)
            }
            WBChip(label: "＋ Add another schedule") {
                schedules.append(.init(days: [], wakeMin: 7 * 60, leadMin: 10, bedtimeMin: nil))
                Task { await model.setSchedules(schedules) }
            }
        }
        .task { schedules = settings.schedules }
    }

    @ViewBuilder private func wakeLightBanner(_ wl: WaffledAPI.WaffledBiteDevice.WakeLight) -> some View {
        switch wl.state {
        case "sleep": bannerRow("🌙 Asleep right now", fg: WBColors.sleepInk, bg: WBColors.sleepTint)
        case "warn":  bannerRow("🟡 Almost time to wake", fg: WF.warn, bg: WF.warnT)
        case "wake":  bannerRow("🟢 Awake — can exit the wake screen", fg: WF.success, bg: WF.successT)
        default: EmptyView()
        }
    }
    private func bannerRow(_ text: String, fg: Color, bg: Color) -> some View {
        Text(text).font(.system(size: 13.5, weight: .bold)).foregroundStyle(fg)
            .padding(.horizontal, 12).padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading)
            .background(bg).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
    }

    private static let dow: [(Int, String)] = [(0, "S"), (1, "M"), (2, "T"), (3, "W"), (4, "T"), (5, "F"), (6, "S")]

    @ViewBuilder private func scheduleRow(_ sched: WaffledAPI.WaffledBiteSettings.Schedule, index i: Int) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                ForEach(Self.dow, id: \.0) { day, label in
                    WeekdayToggleChip(label: label, isOn: schedules[i].days.contains(day)) {
                        if let idx = schedules[i].days.firstIndex(of: day) { schedules[i].days.remove(at: idx) }
                        else { schedules[i].days.append(day); schedules[i].days.sort() }
                        Task { await model.setSchedules(schedules) }
                    }
                }
            }
            HStack {
                Toggle(isOn: Binding(
                    get: { schedules[i].bedtimeMin != nil },
                    set: { on in
                        schedules[i].bedtimeMin = on ? (schedules[i].bedtimeMin ?? 20 * 60) : nil
                        Task { await model.setSchedules(schedules) }
                    })) {
                    Text("Bedtime").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
                }.tint(WF.primary)
            }
            if let bedtimeMin = schedules[i].bedtimeMin {
                minutePicker("Bedtime", minutes: Binding(
                    get: { bedtimeMin },
                    set: { schedules[i].bedtimeMin = $0; Task { await model.setSchedules(schedules) } }))
            } else {
                Text("No bedtime set — this rule shows the day toggle above but never locks the device.")
                    .font(.system(size: 12)).foregroundStyle(WF.ink3)
            }
            minutePicker("Okay to get up", minutes: Binding(
                get: { schedules[i].wakeMin },
                set: { schedules[i].wakeMin = $0; Task { await model.setSchedules(schedules) } }))
            Stepper("Yellow warning starts \(schedules[i].leadMin) min before",
                    value: Binding(
                        get: { schedules[i].leadMin },
                        set: { schedules[i].leadMin = max(0, min(30, $0)); Task { await model.setSchedules(schedules) } }),
                    in: 0...30)
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
            if schedules.count > 1 {
                Button("Remove") {
                    schedules.remove(at: i)
                    Task { await model.setSchedules(schedules) }
                }
                .font(.system(size: 13, weight: .bold)).foregroundStyle(WF.danger)
            }
        }
        .padding(.vertical, 6)
    }

    private func minutePicker(_ label: String, minutes: Binding<Int>) -> some View {
        HStack {
            Text(label).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
            Spacer()
            DatePicker("", selection: Binding(
                get: { minutesToDate(minutes.wrappedValue) },
                set: { minutes.wrappedValue = dateToMinutes($0) }),
                displayedComponents: .hourAndMinute)
                .labelsHidden()
        }
    }

    // MARK: nightlight

    private func nightlightCard(_ settings: WaffledAPI.WaffledBiteSettings.Filled) -> some View {
        WaffledFieldCard(title: "Nightlight") {
            Toggle(isOn: Binding(get: { settings.night.on }, set: { on in Task { await model.setNightOn(on) } })) {
                Text("On").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
            }.tint(WF.primary)
            if settings.night.on {
                HStack(spacing: 10) {
                    ForEach(WaffledBiteOptions.nightColors, id: \.key) { c in
                        Button { Task { await model.setNightColor(c.key) } } label: {
                            Circle().fill(Color(hex: c.hex)).frame(width: 34, height: 34)
                                .overlay(Circle().strokeBorder(WF.ink, lineWidth: settings.night.color == c.key ? 2.5 : 0))
                        }.buttonStyle(.plain)
                    }
                }
                Stepper("Brightness \(settings.night.brightness)%",
                        value: Binding(get: { settings.night.brightness },
                                       set: { v in Task { await model.setNightBrightness(v) } }),
                        in: 1...100, step: 5)
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
            }
        }
    }

    // MARK: sound machine

    private func soundCard(_ settings: WaffledAPI.WaffledBiteSettings.Filled) -> some View {
        WaffledFieldCard(title: "Sound machine") {
            Toggle(isOn: Binding(get: { settings.sound.on }, set: { on in Task { await model.setSoundOn(on) } })) {
                Text(settings.sound.on ? WaffledBiteOptions.soundLabel(settings.sound.sound) : "Off")
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
            }.tint(WF.primary)
            if settings.sound.on {
                WBChipFlow(items: WaffledBiteOptions.sounds.map(\.key),
                           label: WaffledBiteOptions.soundLabel, isSelected: { $0 == settings.sound.sound }) { key in
                    Task { await model.setSoundOption(key) }
                }
                Stepper("Volume \(settings.sound.volume)%",
                        value: Binding(get: { settings.sound.volume }, set: { v in Task { await model.setSoundVolume(v) } }),
                        in: 0...100, step: 5)
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
                HStack(spacing: 8) {
                    ForEach(WaffledBiteOptions.sleepTimerChipsMin, id: \.self) { m in
                        WBChip(label: m == 0 ? "Off" : WaffledBiteOptions.presetLabel(m),
                               filled: settings.sound.timerMin == m) {
                            Task { await model.setSoundSleepTimer(m) }
                        }
                    }
                }
            }
        }
    }

    // MARK: morning alarm

    private func alarmCard(_ settings: WaffledAPI.WaffledBiteSettings.Filled) -> some View {
        WaffledFieldCard(title: "Morning alarm") {
            Toggle(isOn: Binding(get: { settings.alarm.on }, set: { on in Task { await model.setAlarmOn(on) } })) {
                Text(settings.alarm.on ? fmtAmPm(settings.alarm.hour * 60 + settings.alarm.min) : "Off")
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
            }.tint(WF.primary)
            if settings.alarm.on {
                DatePicker("", selection: Binding(
                    get: { minutesToDate(settings.alarm.hour * 60 + settings.alarm.min) },
                    set: { d in
                        let m = dateToMinutes(d)
                        Task { await model.setAlarmTime(hour: m / 60, min: m % 60) }
                    }), displayedComponents: .hourAndMinute)
                    .labelsHidden()
                WBChipFlow(items: WaffledBiteOptions.alarmTones, label: { $0 }, isSelected: { $0 == settings.alarm.tone }) { tone in
                    Task { await model.setAlarmTone(tone) }
                }
            }
        }
    }

    // MARK: screen & display

    private func displayCard(_ settings: WaffledAPI.WaffledBiteSettings.Filled) -> some View {
        WaffledFieldCard(title: "Screen & display") {
            Stepper("Brightness \(settings.display.brightness)%",
                    value: Binding(get: { settings.display.brightness }, set: { v in Task { await model.setDisplayBrightness(v) } }),
                    in: 10...100, step: 10)
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
            Toggle(isOn: Binding(get: { settings.display.nightDim }, set: { on in Task { await model.setDisplayNightDim(on) } })) {
                Text("Screen goes dark at night").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
            }.tint(WF.primary)
        }
    }

    // MARK: unpair

    private var unpairRow: some View {
        Button { showUnpairConfirm = true } label: {
            HStack {
                Text("🔌 Unpair this Waffled-Bite").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.danger)
                Spacer()
            }
            .padding(15).background(WF.dangerT).clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(model.busy)
    }

    // MARK: formatting helpers

    private func mmss(_ sec: Int) -> String { String(format: "%d:%02d", sec / 60, sec % 60) }

    private func fmtAmPm(_ totalMin: Int) -> String {
        let h = totalMin / 60, m = totalMin % 60
        var h12 = h % 12
        if h12 == 0 { h12 = 12 }
        return String(format: "%d:%02d %@", h12, m, h < 12 ? "AM" : "PM")
    }

    private func minutesToDate(_ min: Int) -> Date {
        Calendar.current.date(bySettingHour: min / 60, minute: min % 60, second: 0, of: Date()) ?? Date()
    }
    private func dateToMinutes(_ d: Date) -> Int {
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }
}

/// Fixed status hues for the wake-light "asleep" banner — no `WF.*` semantic token
/// covers purple, so this is a proper light/dark pair (not a hardcoded literal),
/// matching the web app's fixed `#E7E1F0`/`#4A3F73`.
private enum WBColors {
    static let sleepTint = Color.wash(light: 0xE7E1F0, darkBase: 0x8A5CF0, darkAlpha: 0.20)
    static let sleepInk = Color(light: 0x4A3F73, dark: 0xA48CF0)
}

/// A small capsule chip button — presets, sound/tone options, sleep-timer choices.
/// Hand-rolled: `Pill` isn't tappable and `WeekdayToggleChip` is fixed-width/square,
/// wrong shape for variable-width text labels.
private struct WBChip: View {
    let label: String
    var filled: Bool = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(label).font(.system(size: 13, weight: .bold))
                .foregroundStyle(filled ? .white : WF.ink2)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(filled ? WF.primary : WF.panel)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// A wrapping row of `WBChip`s for option pickers (sound, alarm tone) whose count
/// doesn't reliably fit one line on iPhone width.
private struct WBChipFlow: View {
    let items: [String]
    let label: (String) -> String
    let isSelected: (String) -> Bool
    let onSelect: (String) -> Void

    var body: some View {
        // FlowLayout isn't available pre-iOS 16 idioms here; a simple wrap via
        // LazyVGrid-style flexible columns keeps this dependency-free.
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 90), spacing: 8)], alignment: .leading, spacing: 8) {
            ForEach(items, id: \.self) { key in
                WBChip(label: label(key), filled: isSelected(key)) { onSelect(key) }
            }
        }
    }
}
