import SwiftUI

/// Settings → Family & people: manage members (add/edit/remove) and the household
/// basics (name · week start · time zone · location). Admin actions; the owner
/// can't be removed.
struct FamilyPeopleSettingsView: View {
    @Environment(SyncManager.self) private var sync
    @State private var settings: NookAPI.HouseholdSettings?
    @State private var loading = true
    @State private var editor: PersonEditor?
    @State private var hName = ""
    @State private var hLocation = ""

    private let api = NookAPI()

    private enum PersonEditor: Identifiable {
        case new
        case edit(NookAPI.HouseholdSettings.Member)
        var id: String { if case .edit(let m) = self { return m.id }; return "new" }
        var member: NookAPI.HouseholdSettings.Member? { if case .edit(let m) = self { return m }; return nil }
    }

    private static let zones: [(String, String)] = [
        ("America/New_York", "Eastern"), ("America/Chicago", "Central"),
        ("America/Denver", "Mountain"), ("America/Phoenix", "Arizona"),
        ("America/Los_Angeles", "Pacific"), ("America/Anchorage", "Alaska"),
        ("Pacific/Honolulu", "Hawaii"), ("Europe/London", "London"), ("UTC", "UTC"),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Members").padding(.top, 4)
                if let s = settings {
                    ForEach(s.members) { m in memberRow(m) }
                } else if loading {
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 30)
                }
                Button { editor = .new } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "plus").font(.system(size: 13, weight: .bold))
                        Text("Add a person").font(.system(size: 14, weight: .semibold))
                    }
                    .foregroundStyle(NK.ink2).frame(maxWidth: .infinity).padding(.vertical, 12)
                    .background(NK.card2)
                    .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
                        .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 3])).foregroundStyle(NK.hair))
                    .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                }
                .buttonStyle(.plain).padding(.top, 2)

                if let s = settings { householdCard(s.household) }
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle("Family & people").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .sheet(item: $editor) { e in
            PersonEditorSheet(editing: e.member) { await load() }
        }
    }

    // MARK: members

    private func memberRow(_ m: NookAPI.HouseholdSettings.Member) -> some View {
        Button { editor = .edit(m) } label: {
            HStack(spacing: 12) {
                Avatar(colorHex: m.colorHex, emoji: m.avatarEmoji ?? "🙂", size: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text(m.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                    Text(roleLine(m)).font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                }
                Spacer(minLength: 0)
                Image(systemName: "pencil").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
            }
            .padding(12).background(NK.card)
            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func roleLine(_ m: NookAPI.HouseholdSettings.Member) -> String {
        var parts = [m.memberType.capitalized]
        if m.isOwner { parts.append("Owner") }
        if m.isAdmin && !m.isOwner { parts.append("Admin") }
        return parts.joined(separator: " · ")
    }

    // MARK: household

    private func householdCard(_ h: NookAPI.HouseholdSettings.Household) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "Household").padding(.top, 12).padding(.bottom, 8)
            VStack(spacing: 0) {
                fieldRow("🏡", "Name") {
                    TextField("Household", text: $hName)
                        .multilineTextAlignment(.trailing).font(.system(size: 15, weight: .semibold))
                        .submitLabel(.done)
                        .onSubmit { commit(["name": .string(hName.trimmingCharacters(in: .whitespaces))]) }
                }
                Divider().background(NK.hair)
                fieldRow("🗓️", "Week starts") {
                    Menu {
                        Button("Sunday") { commit(["weekStart": .string("sunday")]) }
                        Button("Monday") { commit(["weekStart": .string("monday")]) }
                    } label: { menuLabel(h.weekStart.capitalized) }
                }
                Divider().background(NK.hair)
                fieldRow("🌐", "Time zone") {
                    Menu {
                        ForEach(zoneOptions(h.timezone), id: \.0) { z in
                            Button(z.1) { commit(["timezone": .string(z.0)]) }
                        }
                    } label: { menuLabel(zoneLabel(h.timezone)) }
                }
                Divider().background(NK.hair)
                fieldRow("📍", "Location") {
                    TextField("City, State", text: $hLocation)
                        .multilineTextAlignment(.trailing).font(.system(size: 15))
                        .submitLabel(.done)
                        .onSubmit { commit(["location": .string(hLocation.trimmingCharacters(in: .whitespaces))]) }
                }
            }
            .padding(.horizontal, 14)
            .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        }
    }

    private func fieldRow<T: View>(_ emoji: String, _ label: String, @ViewBuilder _ control: () -> T) -> some View {
        HStack(spacing: 10) {
            Text(emoji).font(.system(size: 16))
            Text(label).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
            Spacer(minLength: 12)
            control()
        }
        .padding(.vertical, 12)
    }

    private func menuLabel(_ t: String) -> some View {
        HStack(spacing: 5) {
            Text(t).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
            Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink3)
        }
    }

    private func zoneOptions(_ current: String) -> [(String, String)] {
        Self.zones.contains { $0.0 == current } ? Self.zones : Self.zones + [(current, current)]
    }
    private func zoneLabel(_ tz: String) -> String { Self.zones.first { $0.0 == tz }?.1 ?? tz }

    // MARK: data

    private func load() async {
        settings = try? await api.householdSettings()
        if let h = settings?.household { hName = h.name; hLocation = h.location ?? "" }
        loading = false
    }

    private func commit(_ body: [String: JSONValue]) {
        Task { _ = await sync.updateHousehold(body); await load() }
    }
}

/// Add or edit a member (admins). Name · emoji · type · color · birthday · admin ·
/// show-on-kiosk. The household owner can't be deleted.
struct PersonEditorSheet: View {
    let editing: NookAPI.HouseholdSettings.Member?
    let onDone: () async -> Void

    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss

    @State private var name: String
    @State private var emoji: String
    @State private var memberType: String
    @State private var colorHex: String
    @State private var hasBirthday: Bool
    @State private var birthday: Date
    @State private var isAdmin: Bool
    @State private var showOnKiosk: Bool
    @State private var busy = false
    @State private var confirmDelete = false
    @State private var error: String?

    private let types = ["adult", "teen", "kid"]

    init(editing: NookAPI.HouseholdSettings.Member?, onDone: @escaping () async -> Void) {
        self.editing = editing
        self.onDone = onDone
        _name = State(initialValue: editing?.name ?? "")
        _emoji = State(initialValue: editing?.avatarEmoji ?? "🙂")
        _memberType = State(initialValue: editing?.memberType ?? "kid")
        _colorHex = State(initialValue: editing?.colorHex ?? NKSwatch.all[0])
        let parsed = Self.parse(editing?.birthday)
        _hasBirthday = State(initialValue: parsed != nil)
        _birthday = State(initialValue: parsed ?? Date())
        _isAdmin = State(initialValue: editing?.isAdmin ?? false)
        _showOnKiosk = State(initialValue: editing?.showOnKiosk ?? true)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 14) {
                        TextField("🙂", text: $emoji)
                            .font(.system(size: 30)).multilineTextAlignment(.center)
                            .frame(width: 64, height: 64).background(NK.panel)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .onChange(of: emoji) { _, v in if v.count > 3 { emoji = String(v.prefix(3)) } }
                        TextField("Name", text: $name)
                            .font(.system(size: 17, weight: .semibold))
                            .padding(.horizontal, 14).padding(.vertical, 14)
                            .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Type")
                        HStack(spacing: 0) {
                            ForEach(types, id: \.self) { t in
                                Button { memberType = t } label: {
                                    Text(t.capitalized)
                                        .font(.system(size: 14, weight: memberType == t ? .bold : .medium))
                                        .foregroundStyle(memberType == t ? NK.ink : NK.ink3)
                                        .frame(maxWidth: .infinity).padding(.vertical, 9)
                                        .background(memberType == t
                                            ? AnyView(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous).fill(NK.card))
                                            : AnyView(Color.clear))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(3).background(NK.panel).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Color")
                        ColorSwatchPicker(hex: $colorHex)
                    }

                    Toggle(isOn: $hasBirthday) {
                        Text("Birthday").font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                    }.tint(NK.primary)
                    if hasBirthday {
                        DatePicker("", selection: $birthday, displayedComponents: .date)
                            .datePickerStyle(.compact).labelsHidden()
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Toggle(isOn: $isAdmin) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Admin").font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                            Text("Can add people & change settings").font(.system(size: 12)).foregroundStyle(NK.ink3)
                        }
                    }.tint(NK.primary)
                    Toggle(isOn: $showOnKiosk) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Show on kiosk").font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                            Text("Appears on the family display").font(.system(size: 12)).foregroundStyle(NK.ink3)
                        }
                    }.tint(NK.primary)

                    if let error { Text(error).font(.system(size: 13, weight: .medium)).foregroundStyle(NK.primary) }

                    Button { Task { await save() } } label: {
                        Text(busy ? "Saving…" : (editing == nil ? "Add person" : "Save"))
                            .font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 14)
                            .background(name.trimmingCharacters(in: .whitespaces).isEmpty ? NK.ink3 : NK.primary)
                            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    }
                    .buttonStyle(.plain).disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)

                    if let editing, !editing.isOwner {
                        Button(role: .destructive) {
                            if confirmDelete { Task { await remove() } } else { confirmDelete = true }
                        } label: {
                            Text(confirmDelete ? "Tap again to remove" : "Remove person")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(confirmDelete ? NK.primary : NK.ink3).frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.plain)
                    } else if editing?.isOwner == true {
                        Text("The household owner can’t be removed.")
                            .font(.system(size: 12)).foregroundStyle(NK.ink3).frame(maxWidth: .infinity)
                    }
                }
                .padding(20)
            }
            .background(NK.canvas)
            .navigationTitle(editing == nil ? "New person" : "Edit person")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func payload() -> [String: JSONValue] {
        var b: [String: JSONValue] = [
            "name": .string(name.trimmingCharacters(in: .whitespaces)),
            "memberType": .string(memberType),
            "colorHex": .string(colorHex),
            "isAdmin": .bool(isAdmin),
            "showOnKiosk": .bool(showOnKiosk),
        ]
        b["avatarEmoji"] = emoji.isEmpty ? .null : .string(emoji)
        if hasBirthday { b["birthday"] = .string(Self.format(birthday)) }
        return b
    }

    private func save() async {
        busy = true; error = nil
        let ok = await sync.savePerson(id: editing?.id, payload())
        busy = false
        if ok { await onDone(); dismiss() } else { error = "Couldn’t save. Admins only." }
    }

    private func remove() async {
        guard let editing else { return }
        busy = true; error = nil
        let ok = await sync.deletePerson(id: editing.id)
        busy = false
        if ok { await onDone(); dismiss() } else { error = "Couldn’t remove this person." }
    }

    private static func parse(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "UTC")
        return f.date(from: String(s.prefix(10)))
    }
    private static func format(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "UTC")
        return f.string(from: d)
    }
}
