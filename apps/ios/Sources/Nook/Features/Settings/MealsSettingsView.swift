import SwiftUI

/// Settings → Meals: how planned meals land on the calendar — add-to-calendar +
/// Google push toggles, the owning person, who's invited, and per-meal times.
/// Saving re-syncs existing planned meals. Mirrors the web MealsPanel.
struct MealsSettingsView: View {
    @State private var members: [NookAPI.HouseholdSettings.Member] = []
    @State private var loaded = false
    @State private var failed = false
    @State private var dirty = false
    @State private var saving = false
    @State private var saved = false

    // editable settings
    @State private var addToCalendar = true
    @State private var pushToGoogle = true
    @State private var calendarPersonId: String?
    @State private var participantIds: [String]?   // nil = whole family
    @State private var times: [String: String] = [:]
    @State private var durationMinutes = 60

    private let api = NookAPI()
    private static let mealRows: [(key: String, label: String, icon: String)] = [
        ("breakfast", "Breakfast", "🍳"), ("lunch", "Lunch", "🥪"),
        ("dinner", "Dinner", "🍽️"), ("snack", "Snack", "🍎"),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if loaded {
                    calendarCard
                    invitedCard
                    timesCard
                    saveRow
                } else if failed {
                    Text("Couldn’t load meal settings.").font(.system(size: 14)).foregroundStyle(NK.ink3).padding(.vertical, 30)
                } else {
                    NookLoading(top: 40)
                }
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle("Meals").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    // MARK: cards

    private var calendarCard: some View {
        NookCard(padding: 4) {
            VStack(spacing: 0) {
                toggleRow("📅", "Add planned meals to the calendar",
                          "Each meal you plan shows on the Kinnook calendar, linked to its recipe.",
                          isOn: Binding(get: { addToCalendar }, set: { addToCalendar = $0; mark() }))
                Divider().background(NK.hair)
                toggleRow("🔄", "Sync them to Google Calendar",
                          "Also push meal events so they show on everyone’s phones.",
                          isOn: Binding(get: { addToCalendar && pushToGoogle }, set: { pushToGoogle = $0; mark() }),
                          enabled: addToCalendar)
                Divider().background(NK.hair)
                settingRow("👤", "Add to this person’s calendar", "Uses their color + Google write-target.") {
                    Menu {
                        Button("Unassigned") { calendarPersonId = nil; mark() }
                        ForEach(members) { m in Button(m.name) { calendarPersonId = m.id; mark() } }
                    } label: { NookSettingsMenuLabel(value: personName(calendarPersonId) ?? "Unassigned") }
                    .disabled(!addToCalendar)
                }
            }
        }
    }

    private var invitedCard: some View {
        NookCard(padding: 14) {
            VStack(alignment: .leading, spacing: 11) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Who’s invited").font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
                    Text(participantIds == nil ? "The whole family" : "\(participantIds?.count ?? 0) selected")
                        .font(.system(size: 12)).foregroundStyle(NK.ink3)
                }
                ChipFlow(spacing: 8, lineSpacing: 8) {
                    chip("Whole family", on: participantIds == nil) { participantIds = nil; mark() }
                    ForEach(members) { m in
                        chip("\(m.avatarEmoji ?? "🙂") \(m.name)", on: (participantIds ?? allIds).contains(m.id)) {
                            toggleParticipant(m.id)
                        }
                    }
                }
                .opacity(addToCalendar ? 1 : 0.4)
                .disabled(!addToCalendar)
            }
        }
    }

    private var timesCard: some View {
        NookCard(padding: 4) {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Meal times").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink)
                    Text("When each meal lands on the calendar.").font(.system(size: 12)).foregroundStyle(NK.ink3)
                }
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 11).padding(.top, 11).padding(.bottom, 6)
                ForEach(Array(Self.mealRows.enumerated()), id: \.element.key) { i, m in
                    if i > 0 { Divider().background(NK.hair) }
                    HStack(spacing: 10) {
                        Text(m.icon).font(.system(size: 17))
                        Text(m.label).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                        Spacer()
                        DatePicker("", selection: timeBinding(m.key), displayedComponents: .hourAndMinute)
                            .labelsHidden().disabled(!addToCalendar)
                    }
                    .padding(.horizontal, 11).padding(.vertical, 11)
                }
            }
        }
    }

    private var saveRow: some View {
        HStack(spacing: 12) {
            Button { Task { await save() } } label: {
                Text(saving ? "Saving…" : "Save").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                    .padding(.horizontal, 28).padding(.vertical, 12)
                    .background(dirty ? NK.primary : NK.ink3)
                    .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            }
            .buttonStyle(.plain).disabled(!dirty || saving)
            if saved {
                Text("✓ Saved · existing meals updated").font(.system(size: 12, weight: .bold)).foregroundStyle(Color(hex: 0x167A4A))
            }
            Spacer()
        }
    }

    // MARK: small views

    private func toggleRow(_ icon: String, _ title: String, _ sub: String, isOn: Binding<Bool>, enabled: Bool = true) -> some View {
        settingRow(icon, title, sub) {
            Toggle("", isOn: isOn).labelsHidden().tint(NK.primary).disabled(!enabled)
        }
    }

    private func settingRow<T: View>(_ icon: String, _ title: String, _ sub: String, @ViewBuilder _ control: () -> T) -> some View {
        HStack(spacing: 11) {
            Text(icon).font(.system(size: 17)).frame(width: 34, height: 34)
                .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(NK.ink)
                Text(sub).font(.system(size: 12)).foregroundStyle(NK.ink3).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            control()
        }
        .padding(.horizontal, 11).padding(.vertical, 11)
    }

    private func chip(_ label: String, on: Bool, tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            Text(label).font(.system(size: 13, weight: .semibold))
                .foregroundStyle(on ? .white : NK.ink2)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(on ? NK.primary : NK.panel).clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: logic

    private var allIds: [String] { members.map(\.id) }
    private func personName(_ id: String?) -> String? { members.first { $0.id == id }?.name }

    private func toggleParticipant(_ id: String) {
        var next = participantIds ?? allIds
        if next.contains(id) { next.removeAll { $0 == id } } else { next.append(id) }
        participantIds = (next.count == allIds.count) ? nil : next
        mark()
    }

    private func timeBinding(_ key: String) -> Binding<Date> {
        Binding(
            get: { Self.parseTime(times[key] ?? "12:00") },
            set: { times[key] = Self.fmtTime($0); mark() }
        )
    }

    private func mark() { dirty = true; saved = false }

    private func load() async {
        members = (try? await api.householdSettings().members) ?? []
        do {
            let s = try await api.mealCalendarSettings()
            addToCalendar = s.addToCalendar; pushToGoogle = s.pushToGoogle
            calendarPersonId = s.calendarPersonId; participantIds = s.participantIds
            times = s.times; durationMinutes = s.durationMinutes
            loaded = true
        } catch { failed = true }
    }

    private func save() async {
        saving = true; saved = false
        var body: [String: JSONValue] = [
            "addToCalendar": .bool(addToCalendar),
            "pushToGoogle": .bool(pushToGoogle),
            "durationMinutes": .int(durationMinutes),
            "times": .object(times.mapValues { .string($0) }),
        ]
        body["calendarPersonId"] = calendarPersonId.map(JSONValue.string) ?? .null
        body["participantIds"] = participantIds.map { .array($0.map(JSONValue.string)) } ?? .null
        do {
            let s = try await api.setMealCalendarSettings(body)
            addToCalendar = s.addToCalendar; pushToGoogle = s.pushToGoogle
            calendarPersonId = s.calendarPersonId; participantIds = s.participantIds
            times = s.times; durationMinutes = s.durationMinutes
            dirty = false; saved = true
        } catch { failed = false }
        saving = false
    }

    private static func parseTime(_ s: String) -> Date {
        DateFmt.date(s, "HH:mm", .current) ?? DateFmt.date("12:00", "HH:mm", .current)!
    }
    private static func fmtTime(_ d: Date) -> String { DateFmt.string(d, "HH:mm", .current) }
}
