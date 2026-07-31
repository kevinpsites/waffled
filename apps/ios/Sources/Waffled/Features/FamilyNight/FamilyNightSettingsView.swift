import SwiftUI

@MainActor
@Observable
final class FamilyNightSettingsModel {
    typealias Fetch = () async throws -> WaffledAPI.FamilyNightView
    typealias SetConfig = ([String: JSONValue]) async throws -> WaffledAPI.FamilyNightConfig
    typealias Schedule = () async throws -> String
    typealias Unschedule = () async throws -> Void

    var parts: [WaffledAPI.FamilyNightPart] = []
    private(set) var dayOfWeek = 1
    private(set) var time = "19:00"
    private(set) var onCalendar = false
    private(set) var loading = true
    private(set) var loaded = false
    private(set) var savingAgenda = false
    private(set) var busySchedule = false
    private(set) var busyCalendar = false
    var errorMessage: String?

    private let fetch: Fetch
    private let setConfig: SetConfig
    private let schedule: Schedule
    private let unschedule: Unschedule

    init(
        fetch: @escaping Fetch = { try await WaffledAPI().familyNight() },
        setConfig: @escaping SetConfig = { try await WaffledAPI().setFamilyNightConfig($0) },
        schedule: @escaping Schedule = { try await WaffledAPI().scheduleFamilyNight() },
        unschedule: @escaping Unschedule = { try await WaffledAPI().unscheduleFamilyNight() }
    ) {
        self.fetch = fetch
        self.setConfig = setConfig
        self.schedule = schedule
        self.unschedule = unschedule
    }

    func load() async {
        loading = true
        do {
            adopt((try await fetch()).config)
            loaded = true
            errorMessage = nil
        } catch {
            errorMessage = "Couldn’t load Family Night settings. Check your connection and try again."
        }
        loading = false
    }

    func setDay(_ newDay: Int) async {
        guard !busySchedule, newDay != dayOfWeek else { return }
        let previous = (dayOfWeek, time)
        dayOfWeek = newDay
        await persistSchedule(previous: previous)
    }

    func setTime(_ newTime: String) async {
        guard !busySchedule, newTime != time else { return }
        let previous = (dayOfWeek, time)
        time = newTime
        await persistSchedule(previous: previous)
    }

    /// A schedule write and its calendar refresh are separate server operations. If
    /// only the second one fails, keep the confirmed new day/time and say exactly what
    /// remains stale instead of rolling back a write that already succeeded.
    private func persistSchedule(previous: (day: Int, time: String)) async {
        busySchedule = true
        errorMessage = nil
        defer { busySchedule = false }
        do {
            let confirmed = try await setConfig([
                "dayOfWeek": .int(dayOfWeek),
                "time": .string(time),
            ])
            dayOfWeek = confirmed.dayOfWeek
            time = confirmed.time
            if onCalendar {
                do {
                    _ = try await schedule()
                } catch {
                    errorMessage = "The Family Night schedule was saved, but its calendar event couldn’t be updated. Try again."
                }
            }
        } catch {
            dayOfWeek = previous.day
            time = previous.time
            errorMessage = "The Family Night schedule wasn’t saved. Your previous schedule is still in place."
        }
    }

    func setCalendar(_ enabled: Bool) async {
        guard !busyCalendar, enabled != onCalendar else { return }
        let previous = onCalendar
        onCalendar = enabled
        busyCalendar = true
        errorMessage = nil
        defer { busyCalendar = false }
        do {
            if enabled { _ = try await schedule() }
            else { try await unschedule() }
        } catch {
            onCalendar = previous
            errorMessage = "The calendar setting wasn’t changed. Check your connection and try again."
        }
    }

    func saveAgenda() async {
        guard !savingAgenda, !parts.isEmpty else { return }
        savingAgenda = true
        errorMessage = nil
        defer { savingAgenda = false }
        let payload: [JSONValue] = parts.map { part in
            .object([
                "id": .string(part.id),
                "label": .string(part.label),
                "emoji": .string(part.emoji.isEmpty ? "⭐" : part.emoji),
                "rotates": .bool(part.rotates),
            ])
        }
        do {
            // Adopt only the confirmed agenda. Day/time/calendar are managed by their
            // own controls and may have an independent request in flight.
            parts = try await setConfig(["parts": .array(payload)]).parts
        } catch {
            // Intentionally keep the edited parts so Save is an in-place retry.
            errorMessage = "The agenda wasn’t saved. Your edits are still here so you can try again."
        }
    }

    private func adopt(_ config: WaffledAPI.FamilyNightConfig) {
        parts = config.parts
        dayOfWeek = config.dayOfWeek
        time = config.time
        onCalendar = config.eventId != nil
    }
}

/// Settings → Family Night — the admin editor mirroring the web `FamilyNightSettings`:
/// which weekday + time it happens, an optional weekly calendar event, and the agenda
/// "parts" (emoji · label · whether they auto-rotate). Day/time/calendar save on change;
/// the agenda saves with an explicit button. Non-admins see it read-only.
struct FamilyNightSettingsView: View {
    @Environment(SyncManager.self) private var sync
    @State private var model = FamilyNightSettingsModel()
    private var isAdmin: Bool { sync.currentPerson?.isAdmin == true }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if !isAdmin {
                    Text("Only an admin can change Family Night.")
                        .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                if let error = model.errorMessage {
                    HStack {
                        Text(error)
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.primaryD)
                        Spacer(minLength: 8)
                        if !model.loaded {
                            Button("Retry") { Task { await model.load() } }
                                .font(.system(size: 13, weight: .bold)).tint(WF.primary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(WF.primary.opacity(0.1))
                        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                }
                if model.loading {
                    WaffledLoading(top: 30)
                } else if model.loaded {
                    scheduleCard
                    calendarCard
                    agendaCard
                }
            }
            .padding(16).padding(.bottom, WF.tabBarClearance)
        }
        .background(WF.canvas)
        .navigationTitle("Family Night").navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
    }

    // MARK: schedule (day + time)

    private var scheduleCard: some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Happens on")
                HStack(spacing: 12) {
                    Menu {
                        ForEach(0..<7, id: \.self) { d in
                            Button { Task { await model.setDay(d) } } label: {
                                if d == model.dayOfWeek { Label(FamilyNightFormat.weekday(d), systemImage: "checkmark") }
                                else { Text(FamilyNightFormat.weekday(d)) }
                            }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Text(FamilyNightFormat.weekday(model.dayOfWeek)).font(.system(size: 15, weight: .semibold))
                            Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold))
                        }
                        .foregroundStyle(WF.ink)
                        .padding(.horizontal, 14).padding(.vertical, 11).frame(maxWidth: .infinity, alignment: .leading)
                        .wfField()
                    }
                    .disabled(!isAdmin || model.busySchedule)

                    DatePicker("", selection: scheduleTime, displayedComponents: .hourAndMinute)
                        .labelsHidden().datePickerStyle(.compact).tint(WF.primary)
                        .disabled(!isAdmin || model.busySchedule)
                }
            }
        }
    }

    // MARK: calendar toggle

    private var calendarCard: some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Show on the calendar").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                        Text("Adds a weekly “🏡 Family Night” event; syncs to Google if connected.")
                            .font(.system(size: 12)).foregroundStyle(WF.ink3).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                    Toggle("", isOn: Binding(
                        get: { model.onCalendar },
                        set: { enabled in Task { await model.setCalendar(enabled) } }
                    ))
                    .labelsHidden().tint(WF.primary).disabled(!isAdmin || model.busyCalendar)
                }
            }
        }
    }

    // MARK: agenda parts

    private var agendaCard: some View {
        @Bindable var model = model
        return WaffledCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Agenda")
                Text("Each part can rotate a different person through it every week.")
                    .font(.system(size: 12)).foregroundStyle(WF.ink3)
                ForEach($model.parts) { $part in partRow($part) }
                if isAdmin {
                    Button {
                        model.parts.append(.init(id: UUID().uuidString, label: "New part", emoji: "⭐", rotates: true))
                    } label: {
                        Label("Add part", systemImage: "plus").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ai)
                    }.buttonStyle(.plain).padding(.top, 2)

                    Button { Task { await model.saveAgenda() } } label: {
                        Text(model.savingAgenda ? "Saving…" : "Save agenda")
                            .font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 12)
                            .background(WF.primary).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    }
                    .buttonStyle(.plain).disabled(model.savingAgenda || model.parts.isEmpty).padding(.top, 4)
                }
            }
        }
    }

    private func partRow(_ part: Binding<WaffledAPI.FamilyNightPart>) -> some View {
        HStack(spacing: 10) {
            TextField("⭐", text: part.emoji)
                .multilineTextAlignment(.center)
                .frame(width: 44).padding(.vertical, 10)
                .wfField().disabled(!isAdmin)
                .onChange(of: part.emoji.wrappedValue) { _, v in part.emoji.wrappedValue = String(v.prefix(2)) }
            TextField("Label", text: part.label)
                .font(.system(size: 15, weight: .semibold))
                .padding(.horizontal, 12).padding(.vertical, 10)
                .frame(maxWidth: .infinity).wfField().disabled(!isAdmin)
            Toggle("", isOn: part.rotates).labelsHidden().tint(WF.primary).disabled(!isAdmin)
                .help("Rotate a person weekly")
            if isAdmin {
                Button { model.parts.removeAll { $0.id == part.id.wrappedValue } } label: {
                    Image(systemName: "minus.circle.fill").font(.system(size: 18)).foregroundStyle(WF.ink3)
                }.buttonStyle(.plain)
            }
        }
    }

    // MARK: "HH:mm" ↔ Date

    private var scheduleTime: Binding<Date> {
        Binding(
            get: { Self.parseTime(model.time) },
            set: { value in
                guard isAdmin else { return }
                Task { await model.setTime(Self.formatTime(value)) }
            }
        )
    }

    private static func parseTime(_ hhmm: String) -> Date {
        let parts = hhmm.split(separator: ":")
        var c = DateComponents(); c.hour = Int(parts.first ?? "19") ?? 19; c.minute = Int(parts.last ?? "0") ?? 0
        return Cal.current.date(from: c) ?? Date()
    }
    private static func formatTime(_ d: Date) -> String {
        let c = Cal.current.dateComponents([.hour, .minute], from: d)
        return String(format: "%02d:%02d", c.hour ?? 19, c.minute ?? 0)
    }
}
