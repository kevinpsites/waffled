import SwiftUI

/// Settings → Family & people: manage members (add/edit/remove) and the household
/// basics (name · week start · time zone · location). Admin actions; the owner
/// can't be removed.
struct FamilyPeopleSettingsView: View {
    @Environment(SyncManager.self) private var sync
    @State private var settings: WaffledAPI.HouseholdSettings?
    @State private var loading = true
    @State private var editor: PersonEditor?
    @State private var hName = ""
    @State private var hLocation = ""

    private let api = WaffledAPI()

    private enum PersonEditor: Identifiable {
        case new
        case edit(WaffledAPI.HouseholdSettings.Member)
        var id: String { if case .edit(let m) = self { return m.id }; return "new" }
        var member: WaffledAPI.HouseholdSettings.Member? { if case .edit(let m) = self { return m }; return nil }
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
                    WaffledLoading(top: 30).padding(.bottom, 30)
                }
                Button { editor = .new } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "plus").font(.system(size: 13, weight: .bold))
                        Text("Add a person").font(.system(size: 14, weight: .semibold))
                    }
                    .foregroundStyle(WF.ink2).frame(maxWidth: .infinity).padding(.vertical, 12)
                    .background(WF.card2)
                    .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
                        .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 3])).foregroundStyle(WF.hair))
                    .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                }
                .buttonStyle(.plain).padding(.top, 2)

                if let s = settings { householdCard(s.household) }

                // Role → capability grid. Admin-only: it loads /api/permissions and
                // hides itself on the 403 a non-admin gets, so it self-gates.
                PermissionsCard()
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(WF.canvas)
        .navigationTitle("Family & People").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .sheet(item: $editor) { e in
            PersonEditorSheet(editing: e.member) { await load() }
        }
    }

    // MARK: members

    private func memberRow(_ m: WaffledAPI.HouseholdSettings.Member) -> some View {
        Button { editor = .edit(m) } label: {
            HStack(spacing: 12) {
                Avatar(colorHex: m.colorHex, emoji: m.avatarEmoji ?? "🙂", size: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text(m.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                    Text(roleLine(m)).font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                }
                Spacer(minLength: 0)
                // Quick badges for who can sign in / has a kiosk PIN.
                if m.hasLogin { glyph("key.fill") }
                if m.hasPin { glyph("lock.fill") }
                Image(systemName: "pencil").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
            }
            .padding(12).background(WF.card)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func glyph(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)
            .frame(width: 22, height: 22).background(WF.panel).clipShape(Circle())
    }

    private func roleLine(_ m: WaffledAPI.HouseholdSettings.Member) -> String {
        var parts = [m.memberType.capitalized]
        if m.isOwner { parts.append("Owner") }
        if m.isAdmin && !m.isOwner { parts.append("Admin") }
        return parts.joined(separator: " · ")
    }

    // MARK: household

    private func householdCard(_ h: WaffledAPI.HouseholdSettings.Household) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "Household").padding(.top, 12).padding(.bottom, 8)
            VStack(spacing: 0) {
                fieldRow("🏡", "Name") {
                    TextField("Household", text: $hName)
                        .multilineTextAlignment(.trailing).font(.system(size: 15, weight: .semibold))
                        .submitLabel(.done)
                        .onSubmit { commit(["name": .string(hName.trimmingCharacters(in: .whitespaces))]) }
                }
                Divider().background(WF.hair)
                fieldRow("🗓️", "Week starts") {
                    Menu {
                        Button("Sunday") { commit(["weekStart": .string("sunday")]) }
                        Button("Monday") { commit(["weekStart": .string("monday")]) }
                    } label: { WaffledSettingsMenuLabel(value: h.weekStart.capitalized) }
                }
                Divider().background(WF.hair)
                fieldRow("🌐", "Time zone") {
                    Menu {
                        ForEach(zoneOptions(h.timezone), id: \.0) { z in
                            Button(z.1) { commit(["timezone": .string(z.0)]) }
                        }
                    } label: { WaffledSettingsMenuLabel(value: zoneLabel(h.timezone)) }
                }
                Divider().background(WF.hair)
                fieldRow("📍", "Location") {
                    TextField("City, State", text: $hLocation)
                        .multilineTextAlignment(.trailing).font(.system(size: 15))
                        .submitLabel(.done)
                        .onSubmit { commit(["location": .string(hLocation.trimmingCharacters(in: .whitespaces))]) }
                }
            }
            .padding(.horizontal, 14)
            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
        }
    }

    private func fieldRow<T: View>(_ emoji: String, _ label: String, @ViewBuilder _ control: () -> T) -> some View {
        HStack(spacing: 10) {
            Text(emoji).font(.system(size: 16))
            Text(label).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
            Spacer(minLength: 12)
            control()
        }
        .padding(.vertical, 12)
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

/// Role-based permissions grid (admin-only). One card per role (Adults / Teens / Kids)
/// with a toggle for each of the four capabilities — admins always have everything, so
/// they aren't listed. Saves the whole matrix on each toggle (optimistic, reverts on
/// failure), mirroring the web's `PermissionsCard`. Non-admins get a 403 on load and the
/// card simply removes itself, so it needs no separate admin check.
struct PermissionsCard: View {
    @State private var matrix: [String: [String: Bool]]?
    @State private var hidden = false
    @State private var saving = false

    private let api = WaffledAPI()

    private static let roles = ["adult", "teen", "kid"]
    private static let caps = ["chore.manage", "chore.approve", "reward.manage", "reward.approve"]
    private static let roleLabel: [String: String] = ["adult": "Adults", "teen": "Teens", "kid": "Kids"]
    private static let capLabel: [String: String] = [
        "chore.manage": "Manage chores", "chore.approve": "Approve chores",
        "reward.manage": "Manage rewards", "reward.approve": "Approve redemptions",
    ]
    private static let capSub: [String: String] = [
        "chore.manage": "Create & edit chores for everyone",
        "chore.approve": "OK or send back finished chores",
        "reward.manage": "Add & edit rewards and currencies",
        "reward.approve": "OK or deny reward redemptions",
    ]

    var body: some View {
        if hidden { EmptyView() } else { content }
    }

    @ViewBuilder private var content: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel(text: "Permissions").padding(.top, 14)
            Text("Choose what each role can do. Admins can always do everything, and everyone can always finish their own chores and redeem their own rewards.")
                .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)
            if let matrix {
                ForEach(Self.roles, id: \.self) { role in roleCard(role, matrix[role] ?? [:]) }
            } else {
                WaffledLoading(top: 12).padding(.bottom, 12)
            }
        }
        .task { await load() }
    }

    private func roleCard(_ role: String, _ row: [String: Bool]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(Self.roleLabel[role] ?? role.capitalized)
                .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 12).padding(.bottom, 4)
            ForEach(Array(Self.caps.enumerated()), id: \.element) { i, cap in
                if i > 0 { Divider().background(WF.hair) }
                Toggle(isOn: Binding(
                    get: { row[cap] ?? false },
                    set: { _ in toggle(role, cap) })) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(Self.capLabel[cap] ?? cap)
                            .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
                        Text(Self.capSub[cap] ?? "")
                            .font(.system(size: 11.5)).foregroundStyle(WF.ink3)
                    }
                }
                .tint(WF.primary).disabled(saving).padding(.vertical, 9)
            }
        }
        .padding(.horizontal, 14).padding(.bottom, 6)
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    /// Flip one cell optimistically and save the whole matrix; revert on failure.
    private func toggle(_ role: String, _ cap: String) {
        guard var m = matrix, !saving else { return }
        let prev = m
        var row = m[role] ?? [:]
        row[cap] = !(row[cap] ?? false)
        m[role] = row
        matrix = m
        saving = true
        Task {
            do { matrix = try await api.setPermissionsMatrix(m) }
            catch { matrix = prev }   // revert on failure
            saving = false
        }
    }

    private func load() async {
        guard matrix == nil, !hidden else { return }
        do { matrix = try await api.permissionsMatrix().permissions }
        catch { hidden = true }   // non-admin (403) → hide the whole card, like web
    }
}

/// Add or edit a member (admins). Editing splits into two tabs, mirroring the web:
/// **General** (profile) and **Sign-in** (email/password login + kiosk PIN).
/// Creating a new person shows only the General fields (login/PIN need a saved id).
struct PersonEditorSheet: View {
    let editing: WaffledAPI.HouseholdSettings.Member?
    let onDone: () async -> Void

    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss

    private let api = WaffledAPI()

    enum Tab: Hashable { case general, signIn }
    @State private var tab: Tab = .general

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

    // Sign-in tab: login (email/password) + kiosk PIN.
    @State private var email: String
    @State private var password = ""
    @State private var pin = ""
    @State private var hasLogin: Bool
    @State private var hasPassword: Bool
    @State private var hasPin: Bool
    @State private var loginBusy = false
    @State private var loginError: String?
    @State private var loginNote: String?
    @State private var confirmRemoveLogin = false
    @State private var pinBusy = false
    @State private var pinError: String?
    @State private var pinNote: String?
    @State private var confirmRemovePin = false

    private let types = ["adult", "teen", "kid"]

    init(editing: WaffledAPI.HouseholdSettings.Member?, onDone: @escaping () async -> Void) {
        self.editing = editing
        self.onDone = onDone
        _name = State(initialValue: editing?.name ?? "")
        _emoji = State(initialValue: editing?.avatarEmoji ?? "🙂")
        _memberType = State(initialValue: editing?.memberType ?? "kid")
        _colorHex = State(initialValue: editing?.colorHex ?? WaffledSwatch.all[0])
        let parsed = Self.parse(editing?.birthday)
        _hasBirthday = State(initialValue: parsed != nil)
        _birthday = State(initialValue: parsed ?? Date())
        _isAdmin = State(initialValue: editing?.isAdmin ?? false)
        _showOnKiosk = State(initialValue: editing?.showOnKiosk ?? true)
        _email = State(initialValue: editing?.loginEmail ?? "")
        _hasLogin = State(initialValue: editing?.hasLogin ?? false)
        _hasPassword = State(initialValue: editing?.hasPassword ?? false)
        _hasPin = State(initialValue: editing?.hasPin ?? false)
    }

    private var showGeneral: Bool { editing == nil || tab == .general }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if editing != nil { tabPicker }
                    if showGeneral { generalForm } else { signInForm }
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle(editing == nil ? "New person" : "Edit \(editing?.name ?? "person")")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private var tabPicker: some View {
        HStack(spacing: 0) {
            ForEach([Tab.general, Tab.signIn], id: \.self) { t in
                Button { tab = t } label: {
                    Text(t == .general ? "General" : "Sign-in")
                        .font(.system(size: 14, weight: tab == t ? .bold : .medium))
                        .foregroundStyle(tab == t ? WF.ink : WF.ink3)
                        .frame(maxWidth: .infinity).padding(.vertical, 9)
                        .background(tab == t
                            ? AnyView(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous).fill(WF.card))
                            : AnyView(Color.clear))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3).background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
    }

    // MARK: general (profile)

    @ViewBuilder private var generalForm: some View {
        HStack(spacing: 14) {
            TextField("🙂", text: $emoji)
                .font(.system(size: 30)).multilineTextAlignment(.center)
                .frame(width: 64, height: 64).background(WF.panel)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .onChange(of: emoji) { _, v in if v.count > 3 { emoji = String(v.prefix(3)) } }
            TextField("Name", text: $name)
                .font(.system(size: 17, weight: .semibold))
                .padding(.horizontal, 14).padding(.vertical, 14)
                .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        }

        VStack(alignment: .leading, spacing: 9) {
            SectionLabel(text: "Type")
            HStack(spacing: 0) {
                ForEach(types, id: \.self) { t in
                    Button { memberType = t } label: {
                        Text(t.capitalized)
                            .font(.system(size: 14, weight: memberType == t ? .bold : .medium))
                            .foregroundStyle(memberType == t ? WF.ink : WF.ink3)
                            .frame(maxWidth: .infinity).padding(.vertical, 9)
                            .background(memberType == t
                                ? AnyView(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous).fill(WF.card))
                                : AnyView(Color.clear))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(3).background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        }

        VStack(alignment: .leading, spacing: 9) {
            SectionLabel(text: "Color")
            ColorSwatchPicker(hex: $colorHex)
        }

        Toggle(isOn: $hasBirthday) {
            Text("Birthday").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
        }.tint(WF.primary)
        if hasBirthday {
            DatePicker("", selection: $birthday, displayedComponents: .date)
                .datePickerStyle(.compact).labelsHidden()
                .frame(maxWidth: .infinity, alignment: .leading)
        }

        Toggle(isOn: $isAdmin) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Admin").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                Text("Can add people & change settings").font(.system(size: 12)).foregroundStyle(WF.ink3)
            }
        }.tint(WF.primary)
        Toggle(isOn: $showOnKiosk) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Show on kiosk").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                Text("Appears on the family display").font(.system(size: 12)).foregroundStyle(WF.ink3)
            }
        }.tint(WF.primary)

        if let error { Text(error).font(.system(size: 13, weight: .medium)).foregroundStyle(WF.primary) }

        Button { Task { await save() } } label: {
            Text(busy ? "Saving…" : (editing == nil ? "Add person" : "Save"))
                .font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                .frame(maxWidth: .infinity).padding(.vertical, 14)
                .background(name.trimmingCharacters(in: .whitespaces).isEmpty ? WF.ink3 : WF.primary)
                .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        }
        .buttonStyle(.plain).disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)

        if let editing, !editing.isOwner {
            Button(role: .destructive) {
                if confirmDelete { Task { await remove() } } else { confirmDelete = true }
            } label: {
                Text(confirmDelete ? "Tap again to remove" : "Remove person")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(confirmDelete ? WF.primary : WF.ink3).frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
        } else if editing?.isOwner == true {
            Text("The household owner can’t be removed.")
                .font(.system(size: 12)).foregroundStyle(WF.ink3).frame(maxWidth: .infinity)
        }
    }

    // MARK: sign-in (login + kiosk PIN)

    @ViewBuilder private var signInForm: some View {
        loginCard
        pinCard
    }

    private var loginCard: some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "🔑  Login")
                Text(loginStatus).font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                TextField("Email", text: $email)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .keyboardType(.emailAddress).textContentType(.username)
                    .padding(12).background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                SecureField(hasPassword ? "New password (leave blank to keep)" : "Password (optional — blank invites SSO)", text: $password)
                    .textContentType(.newPassword)
                    .padding(12).background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                if let loginError { Text(loginError).font(.system(size: 12.5, weight: .medium)).foregroundStyle(WF.primary) }
                else if let loginNote { Text(loginNote).font(.system(size: 12.5, weight: .medium)).foregroundStyle(WF.success) }

                Button { Task { await saveLogin() } } label: {
                    Text(loginBusy ? "Saving…" : (hasLogin ? "Update login" : "Give a login"))
                        .font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                        .background(canSaveLogin ? WF.primary : WF.ink3)
                        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                }
                .buttonStyle(.plain).disabled(!canSaveLogin || loginBusy)

                if hasLogin, editing?.isOwner == false {
                    Button(role: .destructive) {
                        if confirmRemoveLogin { Task { await removeLogin() } } else { confirmRemoveLogin = true }
                    } label: {
                        Text(confirmRemoveLogin ? "Tap again to remove login" : "Remove login")
                            .font(.system(size: 13.5, weight: .semibold))
                            .foregroundStyle(confirmRemoveLogin ? WF.primary : WF.ink3).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var pinCard: some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "🔒  Kiosk PIN")
                Text(hasPin ? "Set — required to open this profile on the kiosk."
                            : "Optional — set one to protect this profile on a shared kiosk.")
                    .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                SecureField("4–8 digits", text: $pin)
                    .keyboardType(.numberPad).textContentType(.oneTimeCode)
                    .onChange(of: pin) { _, v in pin = String(v.filter(\.isNumber).prefix(8)) }
                    .padding(12).background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                if let pinError { Text(pinError).font(.system(size: 12.5, weight: .medium)).foregroundStyle(WF.primary) }
                else if let pinNote { Text(pinNote).font(.system(size: 12.5, weight: .medium)).foregroundStyle(WF.success) }

                Button { Task { await savePin() } } label: {
                    Text(pinBusy ? "Saving…" : (hasPin ? "Update PIN" : "Set PIN"))
                        .font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                        .background(validPin ? WF.primary : WF.ink3)
                        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                }
                .buttonStyle(.plain).disabled(!validPin || pinBusy)

                if hasPin {
                    Button(role: .destructive) {
                        if confirmRemovePin { Task { await removePin() } } else { confirmRemovePin = true }
                    } label: {
                        Text(confirmRemovePin ? "Tap again to remove PIN" : "Remove PIN")
                            .font(.system(size: 13.5, weight: .semibold))
                            .foregroundStyle(confirmRemovePin ? WF.primary : WF.ink3).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var loginStatus: String {
        if !hasLogin { return "No login yet — add an email so this member can sign in." }
        return hasPassword ? "Can sign in with email & password." : "Invited via SSO (no password set)."
    }

    private var trimmedEmail: String { email.trimmingCharacters(in: .whitespaces) }
    private var canSaveLogin: Bool { trimmedEmail.contains("@") && trimmedEmail.contains(".") }
    private var validPin: Bool { (4...8).contains(pin.count) && pin.allSatisfy(\.isNumber) }

    // MARK: actions — general

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

    // MARK: actions — login

    private func saveLogin() async {
        guard let id = editing?.id, canSaveLogin else { return }
        loginBusy = true; loginError = nil; loginNote = nil
        do {
            try await api.setPersonLogin(id: id, email: trimmedEmail, password: password.isEmpty ? nil : password)
            hasLogin = true
            if !password.isEmpty { hasPassword = true }
            password = ""
            loginNote = "Saved."
            await onDone()
        } catch let WaffledAPI.APIError.http(code, _) {
            loginError = code == 409 ? "That email is already in use."
                : (code == 400 ? "Check the email, and use 8+ characters for a password."
                : "Couldn’t save (error \(code)).")
        } catch { loginError = "Couldn’t reach the server." }
        loginBusy = false
    }

    private func removeLogin() async {
        guard let id = editing?.id else { return }
        loginBusy = true; loginError = nil; loginNote = nil
        do {
            try await api.removePersonLogin(id: id)
            hasLogin = false; hasPassword = false; email = ""; confirmRemoveLogin = false
            loginNote = "Login removed."
            await onDone()
        } catch let WaffledAPI.APIError.http(code, _) {
            loginError = code == 400 ? "The household owner’s login can’t be removed." : "Couldn’t remove the login."
        } catch { loginError = "Couldn’t reach the server." }
        loginBusy = false
    }

    // MARK: actions — PIN

    private func savePin() async {
        guard let id = editing?.id, validPin else { return }
        pinBusy = true; pinError = nil; pinNote = nil
        do {
            try await api.setPersonPin(id: id, pin: pin)
            hasPin = true; pin = ""; confirmRemovePin = false
            pinNote = "PIN saved."
            await onDone()
        } catch let WaffledAPI.APIError.http(code, _) {
            pinError = code == 400 ? "A PIN must be 4–8 digits." : "Couldn’t save the PIN (error \(code))."
        } catch { pinError = "Couldn’t reach the server." }
        pinBusy = false
    }

    private func removePin() async {
        guard let id = editing?.id else { return }
        pinBusy = true; pinError = nil; pinNote = nil
        do {
            try await api.clearPersonPin(id: id)
            hasPin = false; pin = ""; confirmRemovePin = false
            pinNote = "PIN removed."
            await onDone()
        } catch { pinError = "Couldn’t remove the PIN." }
        pinBusy = false
    }

    private static func parse(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        return DateFmt.date(String(s.prefix(10)), "yyyy-MM-dd", DateFmt.utc)
    }
    private static func format(_ d: Date) -> String { DateFmt.string(d, "yyyy-MM-dd", DateFmt.utc) }
}
