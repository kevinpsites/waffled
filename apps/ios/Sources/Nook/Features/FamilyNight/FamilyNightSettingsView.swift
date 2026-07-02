import SwiftUI

/// Settings → Family Night — the admin editor mirroring the web `FamilyNightSettings`:
/// which weekday + time it happens, an optional weekly calendar event, and the agenda
/// "parts" (emoji · label · whether they auto-rotate). Day/time/calendar save on change;
/// the agenda saves with an explicit button. Non-admins see it read-only.
struct FamilyNightSettingsView: View {
    @Environment(SyncManager.self) private var sync

    @State private var parts: [NookAPI.FamilyNightPart] = []
    @State private var dayOfWeek = 1
    @State private var time = Date()
    @State private var onCalendar = false
    @State private var loading = true
    @State private var savingAgenda = false
    @State private var busyCalendar = false

    private let api = NookAPI()
    private var isAdmin: Bool { sync.currentPerson?.isAdmin == true }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if !isAdmin {
                    Text("Only an admin can change Family Night.")
                        .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(NK.ink3)
                }
                if loading {
                    NookLoading(top: 30)
                } else {
                    scheduleCard
                    calendarCard
                    agendaCard
                }
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle("Family Night").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    // MARK: schedule (day + time)

    private var scheduleCard: some View {
        NookCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Happens on")
                HStack(spacing: 12) {
                    Menu {
                        ForEach(0..<7, id: \.self) { d in
                            Button { dayOfWeek = d; Task { await saveSchedule() } } label: {
                                if d == dayOfWeek { Label(FamilyNightFormat.weekday(d), systemImage: "checkmark") }
                                else { Text(FamilyNightFormat.weekday(d)) }
                            }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Text(FamilyNightFormat.weekday(dayOfWeek)).font(.system(size: 15, weight: .semibold))
                            Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold))
                        }
                        .foregroundStyle(NK.ink)
                        .padding(.horizontal, 14).padding(.vertical, 11).frame(maxWidth: .infinity, alignment: .leading)
                        .nkField()
                    }
                    .disabled(!isAdmin)

                    DatePicker("", selection: $time, displayedComponents: .hourAndMinute)
                        .labelsHidden().datePickerStyle(.compact).tint(NK.primary)
                        .disabled(!isAdmin)
                        .onChange(of: time) { _, _ in Task { await saveSchedule() } }
                }
            }
        }
    }

    // MARK: calendar toggle

    private var calendarCard: some View {
        NookCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Show on the calendar").font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                        Text("Adds a weekly “🏡 Family Night” event; syncs to Google if connected.")
                            .font(.system(size: 12)).foregroundStyle(NK.ink3).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                    Toggle("", isOn: Binding(get: { onCalendar }, set: { toggleCalendar($0) }))
                        .labelsHidden().tint(NK.primary).disabled(!isAdmin || busyCalendar)
                }
            }
        }
    }

    // MARK: agenda parts

    private var agendaCard: some View {
        NookCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Agenda")
                Text("Each part can rotate a different person through it every week.")
                    .font(.system(size: 12)).foregroundStyle(NK.ink3)
                ForEach($parts) { $part in partRow($part) }
                if isAdmin {
                    Button {
                        parts.append(.init(id: UUID().uuidString, label: "New part", emoji: "⭐", rotates: true))
                    } label: {
                        Label("Add part", systemImage: "plus").font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ai)
                    }.buttonStyle(.plain).padding(.top, 2)

                    Button { Task { await saveAgenda() } } label: {
                        Text(savingAgenda ? "Saving…" : "Save agenda")
                            .font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 12)
                            .background(NK.primary).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    }
                    .buttonStyle(.plain).disabled(savingAgenda || parts.isEmpty).padding(.top, 4)
                }
            }
        }
    }

    private func partRow(_ part: Binding<NookAPI.FamilyNightPart>) -> some View {
        HStack(spacing: 10) {
            TextField("⭐", text: part.emoji)
                .multilineTextAlignment(.center)
                .frame(width: 44).padding(.vertical, 10)
                .nkField().disabled(!isAdmin)
                .onChange(of: part.emoji.wrappedValue) { _, v in part.emoji.wrappedValue = String(v.prefix(2)) }
            TextField("Label", text: part.label)
                .font(.system(size: 15, weight: .semibold))
                .padding(.horizontal, 12).padding(.vertical, 10)
                .frame(maxWidth: .infinity).nkField().disabled(!isAdmin)
            Toggle("", isOn: part.rotates).labelsHidden().tint(NK.primary).disabled(!isAdmin)
                .help("Rotate a person weekly")
            if isAdmin {
                Button { parts.removeAll { $0.id == part.id.wrappedValue } } label: {
                    Image(systemName: "minus.circle.fill").font(.system(size: 18)).foregroundStyle(NK.ink3)
                }.buttonStyle(.plain)
            }
        }
    }

    // MARK: data

    private func load() async {
        if let v = try? await api.familyNight() { apply(v.config) }
        loading = false
    }

    private func apply(_ c: NookAPI.FamilyNightConfig) {
        parts = c.parts
        dayOfWeek = c.dayOfWeek
        time = Self.parseTime(c.time)
        onCalendar = c.eventId != nil
    }

    /// Save day + time; if Family Night is on the calendar, re-schedule so the event
    /// follows the new slot (matches the web behavior).
    private func saveSchedule() async {
        guard isAdmin else { return }
        _ = try? await api.setFamilyNightConfig(["dayOfWeek": .int(dayOfWeek), "time": .string(Self.formatTime(time))])
        if onCalendar { _ = try? await api.scheduleFamilyNight() }
    }

    private func toggleCalendar(_ on: Bool) {
        guard isAdmin else { return }
        onCalendar = on
        busyCalendar = true
        Task {
            if on { _ = try? await api.scheduleFamilyNight() }
            else { try? await api.unscheduleFamilyNight() }
            // Reflect the server's event link (and re-sync the calendar mirror).
            if let v = try? await api.familyNight() { onCalendar = v.config.eventId != nil }
            busyCalendar = false
        }
    }

    private func saveAgenda() async {
        guard isAdmin, !parts.isEmpty else { return }
        savingAgenda = true
        let payload: [JSONValue] = parts.map { p in
            .object(["id": .string(p.id), "label": .string(p.label),
                     "emoji": .string(p.emoji.isEmpty ? "⭐" : p.emoji), "rotates": .bool(p.rotates)])
        }
        if let c = try? await api.setFamilyNightConfig(["parts": .array(payload)]) { apply(c) }
        savingAgenda = false
    }

    // MARK: "HH:mm" ↔ Date

    private static func parseTime(_ hhmm: String) -> Date {
        let parts = hhmm.split(separator: ":")
        var c = DateComponents(); c.hour = Int(parts.first ?? "19") ?? 19; c.minute = Int(parts.last ?? "0") ?? 0
        return Calendar(identifier: .gregorian).date(from: c) ?? Date()
    }
    private static func formatTime(_ d: Date) -> String {
        let c = Calendar(identifier: .gregorian).dateComponents([.hour, .minute], from: d)
        return String(format: "%02d:%02d", c.hour ?? 19, c.minute ?? 0)
    }
}
