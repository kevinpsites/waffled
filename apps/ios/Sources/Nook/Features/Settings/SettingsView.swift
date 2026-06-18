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

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Household").padding(.top, 4)
                row("👨‍👩‍👧‍👦", "Family & people", "Members, roles, household") { path.append(.settingsFamily) }
                row("⭐", "Currencies", "Stars, symbols, colors") { path.append(.settingsCurrencies) }

                SectionLabel(text: "Coming soon").padding(.top, 10)
                soon("✨", "AI & capture", "Provider & model")
                soon("📅", "Calendars", "Google sync")
                soon("🔁", "Conversions", "Trade rates")
                soon("🔔", "Notifications", "Reminders")
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ emoji: String, _ title: String, _ sub: String, tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            HStack(spacing: 12) {
                Text(emoji).font(.system(size: 22)).frame(width: 40, height: 40)
                    .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                    Text(sub).font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink3)
            }
            .padding(12).background(NK.card)
            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func soon(_ emoji: String, _ title: String, _ sub: String) -> some View {
        HStack(spacing: 12) {
            Text(emoji).font(.system(size: 20)).frame(width: 36, height: 36)
                .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous)).opacity(0.6)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink2)
                Text(sub).font(.system(size: 12)).foregroundStyle(NK.ink3)
            }
            Spacer(minLength: 0)
            Text("Soon").font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink3)
                .padding(.horizontal, 8).padding(.vertical, 3).background(NK.panel).clipShape(Capsule())
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }
}

// MARK: - Currencies

struct CurrenciesSettingsView: View {
    @Environment(SyncManager.self) private var sync
    @State private var currencies: [NookAPI.Currency] = []
    @State private var loading = true
    @State private var editor: CurrencyEditor?

    private let api = NookAPI()

    private enum CurrencyEditor: Identifiable {
        case new
        case edit(NookAPI.Currency)
        var id: String { if case .edit(let c) = self { return c.id }; return "new" }
        var currency: NookAPI.Currency? { if case .edit(let c) = self { return c }; return nil }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("Rename stars, add your own, or run several. The **default** is what new chores award; **spendable** ones can buy rewards.")
                    .font(.system(size: 13)).foregroundStyle(NK.ink2)
                    .fixedSize(horizontal: false, vertical: true).padding(.bottom, 4)

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
            .padding(16).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle("Currencies").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: sync.rewardsRev) { _, _ in Task { await load() } }
        .sheet(item: $editor) { e in
            CurrencyEditorSheet(editing: e.currency, canDelete: currencies.count > 1) { await load() }
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
        Text(t).font(.system(size: 11, weight: .bold)).foregroundStyle(color)
            .padding(.horizontal, 7).padding(.vertical, 2).background(color.opacity(0.12)).clipShape(Capsule())
    }

    private func load() async {
        currencies = (try? await api.currencies()) ?? []
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
