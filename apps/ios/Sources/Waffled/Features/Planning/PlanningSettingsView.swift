import SwiftUI

/// Settings → Weekly Planning — when the session happens, which steps this household runs,
/// and which lists the first step is about. Mirrors the web `WeeklyPlanningSettings`.
///
/// A step whose module is off is NOT shown as a choice, because it isn't one; those are named
/// in prose instead. Every control sends ONLY the field that changed: `steps` is a sparse
/// opt-out map merged server-side, so a whole map would clobber another device's change.
struct PlanningSettingsView: View {
    @Environment(SyncManager.self) private var sync
    @State private var model = PlanningModel()

    private var isAdmin: Bool { sync.currentPerson?.isAdmin == true }
    private var locked: Bool { !isAdmin || model.busy }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if !sync.module(.weeklyPlanning) {
                    Text("Weekly Planning is off. Turn it on in Settings → Modules first.")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                } else if let config = model.config {
                    if !isAdmin {
                        Text("Only an admin can change Weekly Planning.")
                            .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                    if let message = model.errorMessage {
                        DismissibleErrorBanner(message: message) { model.dismissError() }
                    }
                    scheduleCard(config)
                    todayCard(config)
                    stepsCard(config)
                    unavailableNote(config)
                    listsCard(config)
                } else if model.loaded {
                    Text("Couldn’t load the planning settings.")
                        .font(.system(size: 14)).foregroundStyle(WF.ink3).padding(.vertical, 30)
                } else {
                    WaffledLoading(top: 40)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16).padding(.bottom, WF.tabBarClearance)
        }
        .background(WF.canvas)
        .navigationTitle("Weekly Planning").navigationBarTitleDisplayMode(.inline)
        .task(id: sync.refreshRev) {
            await model.load()
            // A second read, for the list NAMES only — after `load()`, so the panel draws first.
            await model.loadListCandidates()
        }
    }

    // MARK: - When

    private func scheduleCard(_ config: WaffledAPI.WeeklyPlanningConfig) -> some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Session happens on")
                HStack(spacing: 12) {
                    Menu {
                        ForEach(0..<7, id: \.self) { day in
                            Button {
                                Task { await model.saveConfig(dayOfWeek: day) }
                            } label: {
                                if day == config.dayOfWeek {
                                    Label(PlanningFormat.planningDayName(day), systemImage: "checkmark")
                                } else {
                                    Text(PlanningFormat.planningDayName(day))
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Text(PlanningFormat.planningDayName(config.dayOfWeek))
                                .font(.system(size: 15, weight: .semibold))
                            Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold))
                        }
                        .foregroundStyle(WF.ink)
                        .padding(.horizontal, 14).padding(.vertical, 11)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .wfField()
                    }
                    .disabled(locked)

                    DatePicker("", selection: timeBinding(config), displayedComponents: .hourAndMinute)
                        .labelsHidden().datePickerStyle(.compact).tint(WF.primary)
                        .disabled(locked)
                }
                Text("When to nudge the family to sit down. The session always plans the week ahead — which seven days that is follows your household’s first day of the week.")
                    .font(.system(size: 12)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// A `Binding<Date>` straight onto the saved `"HH:MM"`, with no mirrored `@State`. The
    /// equality guard is load-bearing: `DatePicker` reports a set on every appearance, so
    /// without it merely opening this screen would PUT the config back.
    private func timeBinding(_ config: WaffledAPI.WeeklyPlanningConfig) -> Binding<Date> {
        Binding(
            get: { DateFmt.date(config.time, "HH:mm", .current) ?? Self.fallbackTime },
            set: { picked in
                let hhmm = DateFmt.string(picked, "HH:mm", .current)
                guard hhmm != config.time else { return }
                Task { await model.saveConfig(time: hhmm) }
            })
    }

    /// 17:00 — the server's own default, reached only if a stored time fails to parse.
    private static let fallbackTime = DateFmt.date("17:00", "HH:mm", .current) ?? Date()

    // MARK: - Today card

    private func todayCard(_ config: WaffledAPI.WeeklyPlanningConfig) -> some View {
        WaffledCard(padding: 14) {
            HStack(spacing: 11) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Show on the family display’s Today")
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                    // NAMED FOR THE SURFACE IT AFFECTS: `PlanningTodayCard` is rendered by
                    // `KioskDashboard` only, so "the Today page" promised what the phone can't.
                    Text("A card on the session day on the family display, and a way back into a week that’s part-planned. The phone reaches the session from the Family tab.")
                        .font(.system(size: 12)).foregroundStyle(WF.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Toggle("", isOn: Binding(
                    get: { config.showOnToday },
                    set: { on in Task { await model.saveConfig(showOnToday: on) } }))
                    .labelsHidden().tint(WF.primary).disabled(locked)
            }
        }
    }

    // MARK: - Steps

    private func stepsCard(_ config: WaffledAPI.WeeklyPlanningConfig) -> some View {
        WaffledCard(padding: 4) {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Steps").font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
                    Text("Turn off anything your family doesn’t do — the session skips it and never counts it.")
                        .font(.system(size: 12)).foregroundStyle(WF.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 11).padding(.top, 11).padding(.bottom, 6)

                ForEach(Array(choosable(config).enumerated()), id: \.element.key) { i, step in
                    if i > 0 { Divider().background(WF.hair) }
                    HStack(spacing: 11) {
                        Text(step.title)
                            .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                        Spacer(minLength: 8)
                        Toggle("", isOn: Binding(
                            get: { config.steps[step.key] != false },
                            set: { on in Task { await model.saveConfig(steps: [step.key: on]) } }))
                            .labelsHidden().tint(WF.primary).disabled(locked)
                            .accessibilityLabel("Include \(step.title) in the session")
                    }
                    .padding(.horizontal, 11).padding(.vertical, 11)
                }
            }
        }
    }

    // MARK: - Which lists the first step is about

    /// Only LISTS get this choice, and the asymmetry is the point: an overdue chore is late by
    /// definition, but an unchecked row on a long-lived list is that list working as intended.
    /// Absent from the map ⇒ relevant, and the card hides when there is nothing to choose.
    @ViewBuilder private func listsCard(_ config: WaffledAPI.WeeklyPlanningConfig) -> some View {
        if !model.listCandidates.isEmpty {
            WaffledCard(padding: 4) {
                VStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Lists it asks about")
                            .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
                        Text("The first step asks about anything still unchecked from before this week. Turn off a list that’s meant to stay open — a someday list, a wishlist — and it stops coming up every session. Your grocery list is never asked about: it rebuilds itself from the meal plan.")
                            .font(.system(size: 12)).foregroundStyle(WF.ink3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 11).padding(.top, 11).padding(.bottom, 6)

                    ForEach(Array(model.listCandidates.enumerated()), id: \.element.id) { i, list in
                        if i > 0 { Divider().background(WF.hair) }
                        HStack(spacing: 11) {
                            Text([list.emoji, list.name].compactMap { $0 }.joined(separator: " "))
                                .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                            Spacer(minLength: 8)
                            Toggle("", isOn: Binding(
                                get: { config.asksAbout(list.id) },
                                set: { on in Task { await model.saveConfig(lists: [list.id: on]) } }))
                                .labelsHidden().tint(WF.primary).disabled(locked)
                                .accessibilityLabel("Ask about \(list.name) in the weekly planning session")
                        }
                        .padding(.horizontal, 11).padding(.vertical, 11)
                    }
                }
            }
        }
    }

    @ViewBuilder private func unavailableNote(_ config: WaffledAPI.WeeklyPlanningConfig) -> some View {
        let off = offForModule(config)
        if !off.isEmpty {
            Text("Not in the session because the module it reads is off: \(off.map(\.title).joined(separator: ", ")).")
                .font(.system(size: 12)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Everything with no module behind it, module on, or already switched off by hand — so
    /// the toggle that turned it off can turn it back on.
    private func choosable(_ config: WaffledAPI.WeeklyPlanningConfig) -> [WaffledAPI.PlanningStep] {
        model.steps.filter { $0.requiresModule == nil || $0.available || config.steps[$0.key] == false }
    }

    /// Unavailable purely because its module is off — named in prose, not a dead toggle.
    private func offForModule(_ config: WaffledAPI.WeeklyPlanningConfig) -> [WaffledAPI.PlanningStep] {
        model.steps.filter { $0.requiresModule != nil && config.steps[$0.key] != false && !$0.available }
    }
}
