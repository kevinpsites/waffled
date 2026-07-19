import SwiftUI

/// Settings → Pantry: the per-household pantry config the web surfaces. Mirrors the web
/// `PantrySettings` (Settings.tsx) — whether the pantry shows a Today card, the default
/// running-low threshold, the "old" item threshold (in months), the allergen avoid-list,
/// the storage locations (with a per-location emoji icon), all editable. Writes go to
/// `PUT /api/pantry/config` — a partial merge; the server clamps the numbers, dedupes the
/// locations case-insensitively, and keeps only known allergen keys. Collaborative (any
/// member), like the web — no admin gate.
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

    // locations + per-location icons + allergen avoid-list
    @State private var locations: [String] = []
    @State private var locationIcons: [String: String] = [:]
    @State private var avoid: Set<String> = []
    @State private var addingLocation = ""

    private enum Field: Hashable { case low, stale, addLoc, locName(Int), locIcon(Int) }
    @FocusState private var focus: Field?

    private let api = WaffledAPI()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if loaded {
                    todayCard
                    thresholdsCard
                    allergenCard
                    locationsCard
                } else if failed {
                    Text("Couldn’t load pantry settings.").font(.system(size: 14)).foregroundStyle(WF.ink3).padding(.vertical, 30)
                } else {
                    WaffledLoading(top: 40)
                }
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(WF.canvas)
        .navigationTitle("Pantry").navigationBarTitleDisplayMode(.inline)
        .wfKeyboardDoneToolbar { focus = nil }
        // Commit whichever field just lost focus (decimal-pad has no return key, and
        // a location rename/icon commits on blur to match the web).
        .onChange(of: focus) { old, _ in
            switch old {
            case .low: commitLow()
            case .stale: commitStale()
            case .locName, .locIcon: commitLocations()
            default: break
            }
        }
        .task { await load() }
    }

    // MARK: cards

    private var todayCard: some View {
        WaffledCard(padding: 4) {
            settingRow("🥫", "Show a card on Today",
                       "Surface use-soon and running-low items on the Today screen.") {
                Toggle("", isOn: Binding(get: { showOnToday }, set: { setShowOnToday($0) }))
                    .labelsHidden().tint(WF.primary)
            }
        }
    }

    private var thresholdsCard: some View {
        WaffledCard(padding: 4) {
            VStack(spacing: 0) {
                settingRow("📉", "Running low at (or below)",
                           "Default for all items; set a per-item override in the item editor’s “Warn below”.") {
                    numberField($lowText, field: .low)
                }
                Divider().background(WF.hair)
                settingRow("🕰️", "Flag items older than",
                           "Items on hand longer than this get a 🕰️ age badge and a “Been a while” group.") {
                    HStack(spacing: 6) {
                        numberField($staleText, field: .stale)
                        Text("mo").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                }
            }
        }
    }

    // Allergens to avoid — a chip multi-select over the 9 canonical keys, committed on
    // each tap. Mirrors the web `.pl-allergen-pick`; avoided ones fill in WF.primary.
    private var allergenCard: some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Allergens to avoid")
                Text("Items containing these (from Open Food Facts) get a red warning — e.g. a gluten-free home.")
                    .font(.system(size: 12)).foregroundStyle(WF.ink3).fixedSize(horizontal: false, vertical: true)
                ChipFlow(spacing: 8, lineSpacing: 8) {
                    ForEach(PantryAllergen.keys, id: \.self) { key in allergenChip(key) }
                }
            }
        }
    }

    private func allergenChip(_ key: String) -> some View {
        let on = avoid.contains(key)
        return Button { toggleAvoid(key) } label: {
            HStack(spacing: 6) {
                AllergenBadge(allergen: key, avoid: on)
                Text(PantryAllergen.label(key))
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(on ? .white : WF.ink2)
            }
            .padding(.horizontal, 11).padding(.vertical, 7)
            .background(on ? WF.primary : WF.panel)
            .clipShape(Capsule())
        }.buttonStyle(.plain)
    }

    // Storage locations — each row is an emoji-icon field + a rename field + reorder/remove.
    // Reorder writes the new order; the icon key is the (current) location name, matching
    // how the pantry sidebar looks it up (`model.locationIcons[loc]`).
    private var locationsCard: some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Locations")
                Text("Where items live — the sidebar groups by these. Add an emoji to show next to each.")
                    .font(.system(size: 12)).foregroundStyle(WF.ink3).fixedSize(horizontal: false, vertical: true)
                VStack(spacing: 8) {
                    ForEach(Array(locations.enumerated()), id: \.offset) { idx, _ in locationRow(idx) }
                }
                addLocationRow
            }
        }
    }

    private func locationRow(_ idx: Int) -> some View {
        HStack(spacing: 8) {
            TextField("📦", text: iconBinding(idx))
                .multilineTextAlignment(.center)
                .frame(width: 44).padding(.vertical, 10)
                .wfField(fill: WF.panel)
                .focused($focus, equals: .locIcon(idx))
                .onChange(of: iconBinding(idx).wrappedValue) { _, v in
                    // The server slices to 4 chars; keep it short client-side too.
                    if v.count > 4 { setIcon(idx, String(v.prefix(4))) }
                }
            TextField("Location", text: nameBinding(idx))
                .font(.system(size: 15, weight: .semibold))
                .padding(.horizontal, 12).padding(.vertical, 10)
                .frame(maxWidth: .infinity)
                .wfField(fill: WF.panel)
                .focused($focus, equals: .locName(idx))
                .submitLabel(.done)
                .onSubmit { commitLocations() }
            Button { move(idx, by: -1) } label: {
                Image(systemName: "chevron.up").font(.system(size: 13, weight: .bold)).foregroundStyle(idx == 0 ? WF.ink3.opacity(0.4) : WF.ink3)
                    .frame(width: 30, height: 30)
            }.buttonStyle(.plain).disabled(idx == 0)
            Button { move(idx, by: 1) } label: {
                Image(systemName: "chevron.down").font(.system(size: 13, weight: .bold)).foregroundStyle(idx == locations.count - 1 ? WF.ink3.opacity(0.4) : WF.ink3)
                    .frame(width: 30, height: 30)
            }.buttonStyle(.plain).disabled(idx == locations.count - 1)
            Button { removeLocation(idx) } label: {
                Image(systemName: "minus.circle.fill").font(.system(size: 18)).foregroundStyle(WF.ink3)
                    .frame(width: 30, height: 30)
            }.buttonStyle(.plain)
        }
    }

    private var addLocationRow: some View {
        HStack(spacing: 8) {
            TextField("Add a location…", text: $addingLocation)
                .font(.system(size: 15))
                .padding(.horizontal, 12).padding(.vertical, 10)
                .frame(maxWidth: .infinity)
                .wfField(fill: WF.panel)
                .focused($focus, equals: .addLoc)
                .submitLabel(.done)
                .onSubmit(addLocation)
            Button(action: addLocation) {
                Text("Add").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(addingLocation.trimmingCharacters(in: .whitespaces).isEmpty ? WF.ink3 : WF.primary)
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(addingLocation.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.top, 2)
    }

    // MARK: small views

    private func settingRow<T: View>(_ icon: String, _ title: String, _ sub: String, @ViewBuilder _ control: () -> T) -> some View {
        HStack(spacing: 11) {
            Text(icon).font(.system(size: 17)).frame(width: 34, height: 34)
                .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(WF.ink)
                Text(sub).font(.system(size: 12)).foregroundStyle(WF.ink3).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            control()
        }
        .padding(.horizontal, 11).padding(.vertical, 11)
    }

    private func numberField(_ text: Binding<String>, field: Field) -> some View {
        TextField("", text: text)
            .keyboardType(.decimalPad).multilineTextAlignment(.center)
            .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink).frame(width: 56)
            .padding(.vertical, 8)
            .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
            .focused($focus, equals: field)
    }

    // MARK: bindings into the arrays/maps (bounds-checked so a mid-edit remove is safe)

    private func nameBinding(_ idx: Int) -> Binding<String> {
        Binding(get: { idx < locations.count ? locations[idx] : "" },
                set: { if idx < locations.count { locations[idx] = $0 } })
    }
    private func iconBinding(_ idx: Int) -> Binding<String> {
        Binding(get: { idx < locations.count ? (locationIcons[locations[idx]] ?? "") : "" },
                set: { setIcon(idx, $0) })
    }
    private func setIcon(_ idx: Int, _ v: String) {
        guard idx < locations.count else { return }
        let loc = locations[idx]
        let trimmed = v.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { locationIcons[loc] = nil } else { locationIcons[loc] = trimmed }
    }

    // MARK: logic

    private func setShowOnToday(_ on: Bool) {
        let prev = showOnToday
        showOnToday = on
        Task {
            if (try? await api.setPantryConfig(["showOnToday": .bool(on)])) == nil { showOnToday = prev }
        }
    }

    private func toggleAvoid(_ key: String) {
        let prev = avoid
        if avoid.contains(key) { avoid.remove(key) } else { avoid.insert(key) }
        // Persist in the canonical order the catalog uses.
        let next = PantryAllergen.keys.filter { avoid.contains($0) }
        Task {
            if let c = try? await api.setPantryConfig(["avoidAllergens": .array(next.map(JSONValue.string))]) { adopt(c) }
            else { avoid = prev }
        }
    }

    private func addLocation() {
        let name = addingLocation.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        // Ignore a case-insensitive dup (the server would drop it anyway).
        if locations.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) { addingLocation = ""; return }
        locations.append(name)
        addingLocation = ""
        commitLocations()
    }

    private func removeLocation(_ idx: Int) {
        guard idx < locations.count else { return }
        let loc = locations.remove(at: idx)
        locationIcons[loc] = nil
        commitLocations()
    }

    private func move(_ idx: Int, by delta: Int) {
        let dest = idx + delta
        guard idx < locations.count, dest >= 0, dest < locations.count else { return }
        locations.swapAt(idx, dest)
        commitLocations()
    }

    /// Persist the current locations + icons together (the server merges both keys and
    /// re-derives the config). Prunes icon entries whose location no longer exists.
    private func commitLocations() {
        // Drop blank names, then dedupe case-insensitively (keeping order) — mirroring
        // the server so the optimistic state matches what comes back.
        var seen = Set<String>()
        var clean: [String] = []
        for raw in locations {
            let s = raw.trimmingCharacters(in: .whitespaces)
            let key = s.lowercased()
            if s.isEmpty || seen.contains(key) { continue }
            seen.insert(key)
            clean.append(s)
        }
        let names = Set(clean)
        let icons = locationIcons.filter { names.contains($0.key) && !$0.value.isEmpty }
        let iconObj: [String: JSONValue] = icons.mapValues { .string($0) }
        Task {
            if let c = try? await api.setPantryConfig([
                "locations": .array(clean.map(JSONValue.string)),
                "locationIcons": .object(iconObj),
            ]) { adopt(c) }
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

    private func adopt(_ c: WaffledAPI.PantryConfig) {
        showOnToday = c.showOnToday
        lowThreshold = c.lowThreshold
        lowText = formatAmount(c.lowThreshold)
        staleMonths = Int((c.staleMonths ?? 6).rounded())
        staleText = "\(staleMonths)"
        locations = c.locations
        locationIcons = c.locationIcons ?? [:]
        avoid = Set(c.avoidAllergens)
    }

    private func load() async {
        do {
            adopt(try await api.pantryConfig())
            loaded = true
        } catch { failed = true }
    }
}
