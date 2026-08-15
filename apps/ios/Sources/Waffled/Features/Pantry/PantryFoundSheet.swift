import SwiftUI

/// The confirm-and-add sheet shown after a scan resolves. For a found product it
/// prefills name/brand/photo + the OFF snapshot (carried onto the item); for an unknown
/// barcode it just asks for a name. "Add & scan next" commits and the parent re-arms the
/// scanner. The snapshot fields ride along so the item detail can show nutrition later.
struct PantryFoundSheet: View {
    @Environment(\.dismiss) private var dismiss
    let result: ScanResult
    let locations: [String]
    /// The household's avoid-list ∪ per-person allergens, and who each one affects —
    /// so a scan can say not just what's in the box but who it matters to.
    var avoid: Set<String> = []
    var allergenPeople: [String: [String]] = [:]
    var onLocationsChanged: (() async -> Void)?
    let onAdd: (_ body: [String: JSONValue], _ emoji: String) async -> Void

    @State private var name: String
    @State private var location: String
    @State private var amount: String
    @State private var unit: String
    @State private var hasExpiry = false
    @State private var expiry = Date()
    @State private var saving = false

    init(result: ScanResult, locations: [String], avoid: Set<String> = [],
         allergenPeople: [String: [String]] = [:], onLocationsChanged: (() async -> Void)? = nil,
         onAdd: @escaping (_ body: [String: JSONValue], _ emoji: String) async -> Void) {
        self.result = result
        self.locations = locations
        self.avoid = avoid
        self.allergenPeople = allergenPeople
        self.onLocationsChanged = onLocationsChanged
        self.onAdd = onAdd
        _name = State(initialValue: result.product?.name ?? "")
        _location = State(initialValue: locations.first ?? "Pantry")
        _amount = State(initialValue: "1")
        _unit = State(initialValue: "")
    }

    private var product: WaffledAPI.OffProduct? { result.product }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    statusBadge
                    heroRow
                    allergenBlock
                    Divider().background(WF.hair)
                    whereRow
                    amountRow
                    bestByRow
                }
                .padding(20).padding(.bottom, 90)
            }
            .background(WF.canvas)
            .safeAreaInset(edge: .bottom) { addBar }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    // MARK: pieces

    private var statusBadge: some View {
        let found = product != nil
        // Credit whichever database answered (Open Food/Beauty/Products/Pet Food Facts);
        // an unrecognized barcode still adds cleanly by name.
        let foundText = product?.sourceLabel.map { "Found · \($0)" } ?? "Found · \(result.barcode)"
        return HStack(spacing: 6) {
            Image(systemName: found ? "checkmark.circle.fill" : "questionmark.circle.fill")
                .font(.system(size: 13, weight: .bold))
            Text(found ? foundText : "Not found in a product database · \(result.barcode)")
                .font(.system(size: 12.5, weight: .bold))
        }
        .foregroundStyle(found ? WF.success : WF.ink3)
        .padding(.horizontal, 11).padding(.vertical, 6)
        .background((found ? WF.success : WF.ink3).opacity(0.12)).clipShape(Capsule())
    }

    private var heroRow: some View {
        HStack(spacing: 14) {
            hero.frame(width: 64, height: 64)
                .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            VStack(alignment: .leading, spacing: 6) {
                TextField("Item name", text: $name)
                    .font(WF.serif(20, .bold)).foregroundStyle(WF.ink)
                if let sub = subtitle { Text(sub).font(.system(size: 13)).foregroundStyle(WF.ink3).lineLimit(1) }
            }
            Spacer(minLength: 0)
        }
    }

    private var hero: some View {
        CachedImage(product?.imageUrl) { Text(PantryFood.emoji(for: name.isEmpty ? "x" : name)).font(.system(size: 30)) }
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var subtitle: String? {
        let parts = [product?.brand, product?.quantityText].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // What the product database says is in it. Anything the household avoids is ringed
    // red and called out by name — "contains milk" only helps if you remember who
    // reacts to it, and at the scanner you're deciding in about two seconds.
    @ViewBuilder private var allergenBlock: some View {
        let allergens = product?.allergens ?? []
        let traces = (product?.traces ?? []).filter { !allergens.contains($0) }
        if !allergens.isEmpty || !traces.isEmpty {
            VStack(alignment: .leading, spacing: 7) {
                if !allergens.isEmpty { contains(allergens, label: "Contains", trace: false) }
                if !traces.isEmpty { contains(traces, label: "May contain", trace: true) }
                let flagged = PantryAllergen.flagged(allergens, avoid: avoid)
                if !flagged.isEmpty {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 12, weight: .bold))
                        Text(warning(flagged))
                            .font(.system(size: 12.5, weight: .bold))
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(WF.danger)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .background(WF.dangerT)
                    .clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                }
            }
        }
    }

    private func warning(_ flagged: [String]) -> String {
        let what = flagged.map(PantryAllergen.label).joined(separator: ", ")
        let who = PantryAllergen.affected(flagged, people: allergenPeople)
        return who.isEmpty
            ? "Contains \(what) — your household avoids it."
            : "Contains \(what) — affects \(who.joined(separator: ", "))."
    }

    private func contains(_ allergens: [String], label: String, trace: Bool) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text(label).font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3).padding(.top, 3)
            ChipFlow(spacing: 6, lineSpacing: 6) {
                ForEach(allergens, id: \.self) { a in
                    HStack(spacing: 5) {
                        AllergenBadge(allergen: a, avoid: avoid.contains(a), trace: trace)
                        Text(PantryAllergen.label(a)).font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink2)
                    }
                    .padding(.horizontal, 8).padding(.vertical, 3).background(WF.panel).clipShape(Capsule())
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var whereRow: some View {
        PantryLocationPicker(selection: $location, locations: locations, onLocationsChanged: onLocationsChanged)
    }

    // Typeable, not just steppable: half a bag of flour and a quarter block of cheese
    // are normal things to put away, and ±1 can't express either. The quick chips are
    // for the scan loop, where reaching for the keyboard is the slow part.
    private var amountRow: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                SectionLabel(text: "Amount")
                Spacer()
                HStack(spacing: 10) {
                    Button { step(-1) } label: { stepGlyph("minus") }.buttonStyle(.plain)
                    TextField("1", text: $amount)
                        .keyboardType(.decimalPad).multilineTextAlignment(.center)
                        .font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink)
                        .frame(width: 62)
                        .padding(.horizontal, 8).padding(.vertical, 8).wfField()
                    Button { step(1) } label: { stepGlyph("plus") }.buttonStyle(.plain)
                    TextField("unit", text: $unit)
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink2)
                        .textInputAutocapitalization(.never).frame(width: 64)
                        .padding(.horizontal, 10).padding(.vertical, 8).wfField()
                }
            }
            HStack(spacing: 8) {
                ForEach(PantryFoundSheet.fractions, id: \.value) { f in
                    let on = AmountEntry.value(of: amount) == f.value
                    Button { amount = formatAmount(f.value) } label: {
                        Text(f.label).font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(on ? WF.ink : WF.ink2)
                            .padding(.horizontal, 12).padding(.vertical, 6).wfChip(selected: on)
                    }.buttonStyle(.plain)
                }
                Spacer(minLength: 0)
            }
        }
    }

    /// Part-of-a-package shortcuts — the fractions people actually reach for.
    private static let fractions: [(label: String, value: Double)] = [("¼", 0.25), ("½", 0.5), ("¾", 0.75)]

    private var bestByRow: some View {
        HStack {
            SectionLabel(text: "Best by")
            Spacer()
            if hasExpiry {
                DatePicker("", selection: $expiry, displayedComponents: .date).labelsHidden().tint(WF.primary)
                Button { hasExpiry = false } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 16)).foregroundStyle(WF.ink3)
                }.buttonStyle(.plain)
            } else {
                Button { hasExpiry = true } label: {
                    Text("Add date").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.primary)
                        .padding(.horizontal, 12).padding(.vertical, 7).background(WF.panel).clipShape(Capsule())
                }.buttonStyle(.plain)
            }
        }
    }

    private var addBar: some View {
        Button { add() } label: {
            HStack(spacing: 8) {
                Image(systemName: "barcode")
                Text(saving ? "Adding…" : "Add & scan next").fontWeight(.bold)
            }
            .font(.system(size: 16)).foregroundStyle(.white)
            .frame(maxWidth: .infinity).padding(.vertical, 15)
            .background(WF.primary)
        }
        .buttonStyle(.plain)
        .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty)
        .opacity(name.trimmingCharacters(in: .whitespaces).isEmpty ? 0.5 : 1)
    }

    private func stepGlyph(_ n: String) -> some View {
        Image(systemName: n).font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink)
            .frame(width: 30, height: 30).background(WF.panel).clipShape(Circle())
    }

    private func step(_ delta: Double) {
        amount = PantryAmount.stepped(amount, by: delta)
    }

    private func add() {
        saving = true
        var body: [String: JSONValue] = [
            "name": .string(name.trimmingCharacters(in: .whitespaces)),
            "amount": .string(PantryAmount.canonical(amount)),
            "unit": .string(unit.trimmingCharacters(in: .whitespaces)),
            "location": .string(location),
            "expiresOn": hasExpiry ? .string(PantryExpiry.string(expiry)) : .null,
        ]
        if let p = product { body.merge(p.snapshotBody) { a, _ in a } }
        else { body["barcode"] = .string(result.barcode) }
        let emoji = PantryFood.emoji(for: name)
        Task { await onAdd(body, emoji); saving = false }
    }
}
