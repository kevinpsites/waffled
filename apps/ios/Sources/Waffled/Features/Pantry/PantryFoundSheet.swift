import SwiftUI

/// The confirm-and-add sheet shown after a scan resolves. For a found product it
/// prefills name/brand/photo + the OFF snapshot (carried onto the item); for an unknown
/// barcode it just asks for a name. "Add & scan next" commits and the parent re-arms the
/// scanner. The snapshot fields ride along so the item detail can show nutrition later.
struct PantryFoundSheet: View {
    @Environment(\.dismiss) private var dismiss
    let result: ScanResult
    let locations: [String]
    let onAdd: (_ body: [String: JSONValue], _ emoji: String) async -> Void

    @State private var name: String
    @State private var location: String
    @State private var amount: String
    @State private var unit: String
    @State private var hasExpiry = false
    @State private var expiry = Date()
    @State private var saving = false

    init(result: ScanResult, locations: [String], onAdd: @escaping (_ body: [String: JSONValue], _ emoji: String) async -> Void) {
        self.result = result
        self.locations = locations
        self.onAdd = onAdd
        _name = State(initialValue: result.product?.name ?? "")
        _location = State(initialValue: locations.first ?? "Pantry")
        _amount = State(initialValue: "1")
        _unit = State(initialValue: "")
    }

    private var product: WaffledAPI.OffProduct? { result.product }
    private var locationChoices: [String] { locations.isEmpty ? ["Freezer", "Fridge", "Pantry"] : locations }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    statusBadge
                    heroRow
                    if let a = product?.allergens, !a.isEmpty { containsRow(a) }
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

    private func containsRow(_ allergens: [String]) -> some View {
        HStack(spacing: 6) {
            Text("Contains").font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3)
            ForEach(allergens, id: \.self) { a in
                Text(PantryAllergen.label(a)).font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink2)
                    .padding(.horizontal, 9).padding(.vertical, 4).background(WF.panel).clipShape(Capsule())
            }
            Spacer(minLength: 0)
        }
    }

    private var whereRow: some View {
        VStack(alignment: .leading, spacing: 9) {
            SectionLabel(text: "Where")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(locationChoices, id: \.self) { loc in
                        let on = loc.caseInsensitiveCompare(location) == .orderedSame
                        Button { location = loc } label: {
                            Text(loc).font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(on ? WF.ink : WF.ink2)
                                .padding(.horizontal, 12).padding(.vertical, 7).wfChip(selected: on)
                        }.buttonStyle(.plain)
                    }
                }.padding(.vertical, 1)
            }
        }
    }

    private var amountRow: some View {
        HStack {
            SectionLabel(text: "Amount")
            Spacer()
            HStack(spacing: 10) {
                Button { step(-1) } label: { stepGlyph("minus") }.buttonStyle(.plain)
                Text(amount.isEmpty ? "0" : amount).font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink).frame(minWidth: 24)
                Button { step(1) } label: { stepGlyph("plus") }.buttonStyle(.plain)
                TextField("unit", text: $unit)
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink2)
                    .textInputAutocapitalization(.never).frame(width: 64)
                    .padding(.horizontal, 10).padding(.vertical, 8).wfField()
            }
        }
    }

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
        let cur = Double(amount.trimmingCharacters(in: .whitespaces)) ?? 0
        amount = formatAmount(max(0, cur + delta))
    }

    private func add() {
        saving = true
        var body: [String: JSONValue] = [
            "name": .string(name.trimmingCharacters(in: .whitespaces)),
            "amount": .string(amount.trimmingCharacters(in: .whitespaces)),
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
