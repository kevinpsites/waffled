import SwiftUI

/// Settings → Pantry: the per-household pantry config the web surfaces — whether the
/// pantry shows a Today card, the default running-low threshold, and the "old" item
/// threshold (in months) that drives the 🕰️ age badge + "Been a while" group. Writes
/// go to `PUT /api/pantry/config` (a partial merge; the server clamps the numbers).
/// Locations / allergen-avoid / icons stay on the web for now — see the note in the
/// hand-off. Mirrors the web `PantrySettings`.
struct PantrySettingsView: View {
    @State private var loaded = false
    @State private var failed = false

    // editable config
    @State private var showOnToday = true
    @State private var lowText = "1"
    @State private var staleText = "6"
    // last-committed values (to revert an invalid entry on blur)
    @State private var lowThreshold: Double = 1
    @State private var staleMonths = 6

    private enum Field { case low, stale }
    @FocusState private var focus: Field?

    private let api = NookAPI()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if loaded {
                    todayCard
                    thresholdsCard
                    Text("Locations, per-location icons, and the allergen avoid-list are still edited on the web.")
                        .font(.system(size: 12)).foregroundStyle(NK.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 4)
                } else if failed {
                    Text("Couldn’t load pantry settings.").font(.system(size: 14)).foregroundStyle(NK.ink3).padding(.vertical, 30)
                } else {
                    NookLoading(top: 40)
                }
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle("Pantry").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focus = nil }.fontWeight(.semibold)
            }
        }
        // Commit whichever numeric field just lost focus (decimal-pad has no return key).
        .onChange(of: focus) { old, _ in
            if old == .low { commitLow() }
            if old == .stale { commitStale() }
        }
        .task { await load() }
    }

    // MARK: cards

    private var todayCard: some View {
        NookCard(padding: 4) {
            settingRow("🥫", "Show a card on Today",
                       "Surface use-soon and running-low items on the Today screen.") {
                Toggle("", isOn: Binding(get: { showOnToday }, set: { setShowOnToday($0) }))
                    .labelsHidden().tint(NK.primary)
            }
        }
    }

    private var thresholdsCard: some View {
        NookCard(padding: 4) {
            VStack(spacing: 0) {
                settingRow("📉", "Running low at (or below)",
                           "Default for all items; set a per-item override in the item editor’s “Warn below”.") {
                    numberField($lowText, field: .low)
                }
                Divider().background(NK.hair)
                settingRow("🕰️", "Flag items older than",
                           "Items on hand longer than this get a 🕰️ age badge and a “Been a while” group.") {
                    HStack(spacing: 6) {
                        numberField($staleText, field: .stale)
                        Text("mo").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
                    }
                }
            }
        }
    }

    // MARK: small views

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

    private func numberField(_ text: Binding<String>, field: Field) -> some View {
        TextField("", text: text)
            .keyboardType(.decimalPad).multilineTextAlignment(.center)
            .font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink).frame(width: 56)
            .padding(.vertical, 8)
            .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
            .focused($focus, equals: field)
    }

    // MARK: logic

    private func setShowOnToday(_ on: Bool) {
        let prev = showOnToday
        showOnToday = on
        Task {
            if (try? await api.setPantryConfig(["showOnToday": .bool(on)])) == nil { showOnToday = prev }
        }
    }

    /// Clamp to ≥ 0 and persist; revert the text to the last good value if unparseable.
    private func commitLow() {
        guard let n = Double(lowText.trimmingCharacters(in: .whitespaces)), n.isFinite, n >= 0 else {
            lowText = formatAmount(lowThreshold); return
        }
        lowThreshold = n
        lowText = formatAmount(n)
        Task {
            if let c = try? await api.setPantryConfig(["lowThreshold": .double(n)]) { adopt(c) }
        }
    }

    /// Clamp to a 1…60 integer and persist; revert if out of range.
    private func commitStale() {
        guard let raw = Double(staleText.trimmingCharacters(in: .whitespaces)), raw.isFinite else {
            staleText = "\(staleMonths)"; return
        }
        let n = min(60, max(1, Int(raw.rounded())))
        staleMonths = n
        staleText = "\(n)"
        Task {
            if let c = try? await api.setPantryConfig(["staleMonths": .int(n)]) { adopt(c) }
        }
    }

    private func adopt(_ c: NookAPI.PantryConfig) {
        showOnToday = c.showOnToday
        lowThreshold = c.lowThreshold
        lowText = formatAmount(c.lowThreshold)
        staleMonths = Int((c.staleMonths ?? 6).rounded())
        staleText = "\(staleMonths)"
    }

    private func load() async {
        do {
            adopt(try await api.pantryConfig())
            loaded = true
        } catch { failed = true }
    }
}
