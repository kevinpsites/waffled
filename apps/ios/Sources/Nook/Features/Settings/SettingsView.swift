import SwiftUI

/// The household color palette — shared by the person + currency editors. Mirrors
/// the web kiosk's member swatches.
enum NKSwatch {
    static let all = ["#2F7FED", "#EC6049", "#25A368", "#8B5CF6", "#E0A500", "#EC4899", "#14B8A6", "#6B7280"]
}

/// A row of color swatches with the current one ringed.
struct ColorSwatchPicker: View {
    @Binding var hex: String
    var body: some View {
        HStack(spacing: 10) {
            ForEach(NKSwatch.all, id: \.self) { s in
                Circle().fill(Color(hexString: s) ?? NK.ink3)
                    .frame(width: 30, height: 30)
                    .overlay(Circle().strokeBorder(hex.lowercased() == s.lowercased() ? NK.ink : .clear, lineWidth: 2.5).padding(-3))
                    .onTapGesture { hex = s }
            }
            Spacer(minLength: 0)
        }
    }
}

/// Settings landing — pushes into the built-out panels; the rest are flagged as
/// coming soon so the hub never dead-ends.
struct SettingsView: View {
    @Binding var path: [HubRoute]
    @Environment(SyncManager.self) private var sync
    @Environment(Session.self) private var session
    @Environment(NotificationManager.self) private var notifications
    @State private var confirmSignOut = false
    @State private var busy = false

    var body: some View {
        ScrollView {
            // Web order (with Accounts before AI, per the kiosk's pending update).
            VStack(alignment: .leading, spacing: 10) {
                row("👨‍👩‍👧‍👦", "Family & People", "Members, roles, household") { path.append(.settingsFamily) }
                row("🔗", "Accounts", "Sign-in & connections") { path.append(.settingsAccount) }
                row("✨", "AI & Capture", "Provider & model") { path.append(.settingsAI) }
                row("📅", "Calendars", "Google sync") { path.append(.settingsCalendars) }
                row("⭐", "Chores & Rewards", "Currencies & conversions") { path.append(.settingsChoresRewards) }
                row("🍽️", "Meals", "Calendar & meal times") { path.append(.settingsMeals) }
                row("📋", "Lists", "Grocery & lists")
                row("🖥️", "Display & Kiosk", "Screensaver & idle") { path.append(.settingsDisplay) }
                row("🔔", "Notifications", "Event reminders") { path.append(.settingsNotifications) }
                row("ℹ️", "About", "Version & server") { path.append(.settingsAbout) }
                signOutFooter
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
        .task { await sync.loadIdentity() }
    }

    /// Sign out lives right on the Settings landing (mirrors the web's footer).
    private var signOutFooter: some View {
        VStack(spacing: 8) {
            if let name = signedInName {
                Text("Signed in as \(name)").font(.system(size: 12.5)).foregroundStyle(NK.ink3)
            }
            Button {
                if confirmSignOut { Task { await signOut() } } else { confirmSignOut = true }
            } label: {
                Text(busy ? "Signing out…" : (confirmSignOut ? "Tap again to sign out" : "Sign out"))
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(confirmSignOut ? .white : NK.primary)
                    .frame(maxWidth: .infinity).padding(.vertical, 14)
                    .background(confirmSignOut ? NK.primary : NK.card)
                    .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
                        .strokeBorder(confirmSignOut ? .clear : NK.primary.opacity(0.4), lineWidth: 1))
            }
            .buttonStyle(.plain).disabled(busy)
        }
        .padding(.top, 14)
    }

    private var signedInName: String? {
        sync.members.first { $0.id == sync.currentPersonId }?.name
    }

    private func signOut() async {
        busy = true
        await session.signOut()    // clear session, → login (Button's Task survives)
        await sync.signOut()       // disconnect sync
        await notifications.clearOurs()   // drop this household's local reminders
    }

    /// A settings row. `tap == nil` ⇒ not built yet (dimmed + a "Soon" pill).
    private func row(_ emoji: String, _ title: String, _ sub: String, tap: (() -> Void)? = nil) -> some View {
        let enabled = tap != nil
        return Button { tap?() } label: {
            HStack(spacing: 12) {
                NookEmojiTile(emoji: emoji)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(enabled ? NK.ink : NK.ink2)
                    Text(sub).font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                }
                Spacer(minLength: 0)
                if enabled {
                    Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink3)
                } else {
                    Text("Soon").font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink3)
                        .padding(.horizontal, 8).padding(.vertical, 3).background(NK.panel).clipShape(Capsule())
                }
            }
            .padding(12).background(NK.card)
            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
            .opacity(enabled ? 1 : 0.6)
        }
        .buttonStyle(.plain).disabled(!enabled)
    }
}

// MARK: - Chores & rewards (currencies + conversions)

struct ChoresRewardsSettingsView: View {
    @Environment(SyncManager.self) private var sync
    @State private var currencies: [NookAPI.Currency] = []
    @State private var conversions: [NookAPI.Conversion] = []
    @State private var loading = true
    @State private var editor: CurrencyEditor?
    // new-conversion form
    @State private var fromKey = ""
    @State private var toKey = ""
    @State private var fromAmt = 10
    @State private var toAmt = 1
    @State private var requireApproval: Bool?   // nil until loaded
    @State private var savingApproval = false

    private let api = NookAPI()

    private enum CurrencyEditor: Identifiable {
        case new
        case edit(NookAPI.Currency)
        var id: String { if case .edit(let c) = self { return c.id }; return "new" }
        var currency: NookAPI.Currency? { if case .edit(let c) = self { return c }; return nil }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // Each group is its own boxed "widget" so it's unmistakable what
                // belongs together: the economy (currencies + their trades)…
                groupTray {
                    currenciesSection
                    if currencies.count > 1 { conversionsSection }
                }
                // …and the separate redemption policy.
                groupTray { approvalsSection }
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle("Chores & Rewards").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: sync.rewardsRev) { _, _ in Task { await load() } }
        .sheet(item: $editor) { e in
            CurrencyEditorSheet(editing: e.currency, canDelete: currencies.count > 1) { await load() }
        }
    }

    /// A boxed group "widget" — a warm tray that visually binds its contents together
    /// and sets them apart from the next group.
    @ViewBuilder
    private func groupTray<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 18) { content() }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(NK.panel)
            .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    private var currenciesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "Currencies & trades")
            Text("Rename stars, add your own, or run several. The **default** is what new chores award; **spendable** ones can buy rewards.")
                .font(.system(size: 13)).foregroundStyle(NK.ink2)
                .fixedSize(horizontal: false, vertical: true)

            ForEach(currencies) { c in currencyRow(c) }

            Button { editor = .new } label: {
                HStack(spacing: 7) {
                    Image(systemName: "plus").font(.system(size: 13, weight: .bold))
                    Text("Add a currency").font(.system(size: 14, weight: .semibold))
                }
                .foregroundStyle(NK.ink2).frame(maxWidth: .infinity).padding(.vertical, 12)
                .background(NK.card2)
                .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 3])).foregroundStyle(NK.hair))
                .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            }
            .buttonStyle(.plain).padding(.top, 2)
        }
    }

    /// Default applied to *new* rewards. Each reward also carries its own approval flag
    /// (edited in the reward sheet), so this is just the starting value. Off → kids redeem
    /// instantly with currency they've earned (a balance guard still applies server-side).
    /// Optimistic toggle, reverts on failure.
    private var approvalsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "Reward approvals")
            Text("Sets the default for **new** rewards. On = a parent OKs the purchase; off = the kid redeems instantly with what they’ve earned. Even if off, each reward can have an override to explicitly require approval.")
                .font(.system(size: 13)).foregroundStyle(NK.ink2)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 12) {
                Text("✅").font(.system(size: 20)).frame(width: 40, height: 40)
                    .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                Text("New rewards need a parent’s OK by default")
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                Spacer(minLength: 8)
                Toggle("", isOn: Binding(
                    get: { requireApproval ?? true },
                    set: { setApproval($0) }))
                    .labelsHidden().tint(NK.primary)
                    .disabled(requireApproval == nil || savingApproval)
            }
            .padding(12).background(NK.card)
            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        }
    }

    private func setApproval(_ on: Bool) {
        let previous = requireApproval
        requireApproval = on
        savingApproval = true
        Task {
            do { try await api.setRewardApproval(on) }
            catch { requireApproval = previous }   // revert on failure
            savingApproval = false
        }
    }

    private func currencyRow(_ c: NookAPI.Currency) -> some View {
        Button { editor = .edit(c) } label: {
            HStack(spacing: 12) {
                Text(c.symbol).font(.system(size: 20)).frame(width: 40, height: 40)
                    .background((Color(hexString: c.color) ?? NK.gold).opacity(0.16))
                    .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(c.label).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                    HStack(spacing: 6) {
                        if c.isDefault { tag("★ Default", NK.gold) }
                        tag(c.spendable ? "Spendable" : "Earn-only", c.spendable ? NK.primary : NK.ink3)
                    }
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

    private func tag(_ t: String, _ color: Color) -> some View {
        NookStatusBadge(text: t, color: color)
    }

    // MARK: conversions

    private var conversionsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            // A sub-header (not a full SectionLabel) so it reads as part of the
            // "Currencies & trades" group rather than a peer section.
            Text("Conversions").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink2)
            Text("Let the family trade up a tier — e.g. 10 ⭐ → 1 🥢. Anyone can convert their own balance on the Rewards tab.")
                .font(.system(size: 13)).foregroundStyle(NK.ink2)
                .fixedSize(horizontal: false, vertical: true)

            ForEach(conversions) { c in conversionRow(c) }
            addConversionForm
        }
    }

    private func conversionRow(_ c: NookAPI.Conversion) -> some View {
        HStack(spacing: 8) {
            Text("\(c.fromAmount) \(c.from.symbol ?? "•") \(c.from.label ?? c.fromCurrency)")
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink)
            Image(systemName: "arrow.right").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink3)
            Text("\(c.toAmount) \(c.to.symbol ?? "•") \(c.to.label ?? c.toCurrency)")
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink)
            Spacer(minLength: 0)
            Button { Task { _ = await sync.deleteConversion(id: c.id); await load() } } label: {
                Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink3)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    private var addConversionForm: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                amountField($fromAmt)
                currencyMenu(selected: $fromKey)
                Image(systemName: "arrow.right").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink3)
                amountField($toAmt)
                currencyMenu(selected: $toKey)
            }
            Button { Task { await addConversion() } } label: {
                Text("＋ Add rate").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 11)
                    .background(fromKey == toKey ? NK.ink3 : NK.primary)
                    .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            }
            .buttonStyle(.plain).disabled(fromKey == toKey || fromKey.isEmpty)
        }
        .padding(12)
        .background(NK.card2).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        .padding(.top, 2)
    }

    private func amountField(_ value: Binding<Int>) -> some View {
        TextField("0", value: value, format: .number)
            .keyboardType(.numberPad).multilineTextAlignment(.center)
            .font(.system(size: 15, weight: .bold)).frame(width: 44)
            .padding(.vertical, 8).background(NK.panel).clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
    }

    private func currencyMenu(selected: Binding<String>) -> some View {
        let cur = currencies.first { $0.key == selected.wrappedValue }
        return Menu {
            ForEach(currencies) { c in Button("\(c.symbol) \(c.label)") { selected.wrappedValue = c.key } }
        } label: {
            HStack(spacing: 4) {
                Text(cur.map { "\($0.symbol)" } ?? "•").font(.system(size: 15))
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)).foregroundStyle(NK.ink3)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
        }
    }

    private func addConversion() async {
        guard fromKey != toKey, !fromKey.isEmpty, !toKey.isEmpty else { return }
        let body: [String: JSONValue] = [
            "fromCurrency": .string(fromKey), "toCurrency": .string(toKey),
            "fromAmount": .int(max(1, fromAmt)), "toAmount": .int(max(1, toAmt)),
        ]
        if await sync.createConversion(body) { fromAmt = 10; toAmt = 1; await load() }
    }

    private func load() async {
        async let cur = api.currencies()
        async let conv = api.conversions()
        async let approval = api.rewardSettings()
        currencies = (try? await cur) ?? []
        conversions = (try? await conv) ?? []
        requireApproval = (try? await approval)?.requireApproval ?? true
        // seed the new-conversion currency pickers
        if fromKey.isEmpty || !currencies.contains(where: { $0.key == fromKey }) { fromKey = currencies.first?.key ?? "" }
        if toKey.isEmpty || !currencies.contains(where: { $0.key == toKey }) {
            toKey = currencies.first(where: { $0.key != fromKey })?.key ?? currencies.first?.key ?? ""
        }
        loading = false
    }
}

struct CurrencyEditorSheet: View {
    let editing: NookAPI.Currency?
    let canDelete: Bool
    let onDone: () async -> Void

    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss

    @State private var label: String
    @State private var symbol: String
    @State private var colorHex: String
    @State private var isDefault: Bool
    @State private var spendable: Bool
    @State private var busy = false
    @State private var confirmDelete = false
    @State private var error: String?

    init(editing: NookAPI.Currency?, canDelete: Bool, onDone: @escaping () async -> Void) {
        self.editing = editing
        self.canDelete = canDelete
        self.onDone = onDone
        _label = State(initialValue: editing?.label ?? "")
        _symbol = State(initialValue: editing?.symbol ?? "⭐")
        _colorHex = State(initialValue: editing?.color ?? NKSwatch.all[4])   // gold-ish default
        _isDefault = State(initialValue: editing?.isDefault ?? false)
        _spendable = State(initialValue: editing?.spendable ?? true)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 14) {
                        TextField("⭐", text: $symbol)
                            .font(.system(size: 30)).multilineTextAlignment(.center)
                            .frame(width: 64, height: 64).background(NK.panel)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .onChange(of: symbol) { _, v in if v.count > 2 { symbol = String(v.prefix(2)) } }
                        TextField("Stars, Family Dollars…", text: $label)
                            .font(.system(size: 17, weight: .semibold))
                            .padding(.horizontal, 14).padding(.vertical, 14)
                            .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Color")
                        ColorSwatchPicker(hex: $colorHex)
                    }

                    Toggle(isOn: $isDefault) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Default").font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                            Text("New chores award this").font(.system(size: 12)).foregroundStyle(NK.ink3)
                        }
                    }.tint(NK.primary)
                    Toggle(isOn: $spendable) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Spendable").font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                            Text("Can buy rewards").font(.system(size: 12)).foregroundStyle(NK.ink3)
                        }
                    }.tint(NK.primary)

                    if let error { Text(error).font(.system(size: 13, weight: .medium)).foregroundStyle(NK.primary) }

                    Button { Task { await save() } } label: {
                        Text(busy ? "Saving…" : (editing == nil ? "Add currency" : "Save"))
                            .font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 14)
                            .background(label.trimmingCharacters(in: .whitespaces).isEmpty ? NK.ink3 : NK.primary)
                            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    }
                    .buttonStyle(.plain).disabled(busy || label.trimmingCharacters(in: .whitespaces).isEmpty)

                    if editing != nil, canDelete, !(editing?.isDefault ?? false) {
                        Button(role: .destructive) {
                            if confirmDelete { Task { await remove() } } else { confirmDelete = true }
                        } label: {
                            Text(confirmDelete ? "Tap again to delete" : "Delete currency")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(confirmDelete ? NK.primary : NK.ink3)
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(20)
            }
            .background(NK.canvas)
            .navigationTitle(editing == nil ? "New currency" : "Edit currency")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func payload() -> [String: JSONValue] {
        [
            "label": .string(label.trimmingCharacters(in: .whitespaces)),
            "symbol": symbol.isEmpty ? .null : .string(symbol),
            "color": .string(colorHex),
            "isDefault": .bool(isDefault),
            "spendable": .bool(spendable),
        ]
    }

    private func save() async {
        busy = true; error = nil
        let ok = await sync.saveCurrency(id: editing?.id, payload())
        busy = false
        if ok { await onDone(); dismiss() } else { error = "Couldn’t save. Check your connection." }
    }

    private func remove() async {
        guard let editing else { return }
        busy = true; error = nil
        let ok = await sync.deleteCurrency(id: editing.id)
        busy = false
        if ok { await onDone(); dismiss() }
        else { error = sync.lastError?.contains("default") == true
            ? "Set another currency as default first." : "Couldn’t delete this currency." }
    }
}
