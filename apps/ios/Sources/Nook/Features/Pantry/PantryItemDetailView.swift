import SwiftUI

/// Pantry item detail — photo/emoji hero (with an Open Food Facts badge for scanned
/// items), location · best-by · amount stepper, an allergen "Contains" row (red +
/// "Affects {people}" when the household flags it), and the OFF nutrition table. Edit /
/// used-up / delete from here. Reads the live item from the model by id, so a stepper
/// tap or an edit reflects immediately and a delete pops back.
struct PantryItemDetailView: View {
    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss
    let itemId: String
    let model: PantryModel

    @State private var editing = false

    private var item: NookAPI.PantryItem? { model.items.first { $0.id == itemId } }

    var body: some View {
        Group {
            if let item {
                content(item)
            } else {
                Color.clear.onAppear { dismiss() }   // deleted out from under us
            }
        }
        .background(NK.canvas)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $editing) {
            if let item {
                PantryItemEditor(mode: .edit(item), locations: model.locations) { body in
                    if let updated = try? await NookAPI().pantryUpdate(id: item.id, body) { model.replace(updated) }
                }
            }
        }
    }

    @ViewBuilder private func content(_ item: NookAPI.PantryItem) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                hero(item)
                title(item)
                factsRow(item)
                if let allergens = item.allergens, !allergens.isEmpty { containsRow(item, allergens) }
                if let traces = item.traces, !traces.isEmpty {
                    Text("May contain \(traces.map(PantryAllergen.label).joined(separator: ", "))")
                        .font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                }
                if let n = item.nutrition, !n.isEmpty { nutritionCard(item, n) }
                if item.isOff {
                    HStack(spacing: 6) {
                        Circle().fill(Color(hex: 0x167A4A)).frame(width: 8, height: 8)
                        Text("Nutrition & allergens from Open Food Facts").font(.system(size: 12)).foregroundStyle(NK.ink3)
                    }
                }
                actions(item)
            }
            .padding(16).padding(.bottom, 110)
        }
    }

    // MARK: hero + title

    private func hero(_ item: NookAPI.PantryItem) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).fill(NK.panel)
            if let s = item.imageUrl, let url = URL(string: s) {
                AsyncImage(url: url) { $0.resizable().scaledToFit().padding(20) }
                placeholder: { Text(PantryFood.emoji(for: item.name)).font(.system(size: 60)) }
            } else {
                Text(PantryFood.emoji(for: item.name)).font(.system(size: 60))
            }
            if item.isOff {
                VStack { HStack { offBadge; Spacer() }; Spacer() }.padding(12)
            }
        }
        .frame(height: 180).frame(maxWidth: .infinity)
    }

    private var offBadge: some View {
        HStack(spacing: 5) {
            Circle().fill(Color(hex: 0x167A4A)).frame(width: 7, height: 7)
            Text("OPEN FOOD FACTS").font(.system(size: 10, weight: .heavy)).tracking(0.4).foregroundStyle(NK.ink2)
        }
        .padding(.horizontal, 9).padding(.vertical, 5).background(NK.card).clipShape(Capsule())
    }

    private func title(_ item: NookAPI.PantryItem) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.name).font(NK.serif(24, .bold)).foregroundStyle(NK.ink)
                .fixedSize(horizontal: false, vertical: true)
            if let sub = subtitle(item) { Text(sub).font(.system(size: 14)).foregroundStyle(NK.ink3) }
        }
    }
    private func subtitle(_ item: NookAPI.PantryItem) -> String? {
        let parts = [item.brand, item.quantityText].compactMap { $0?.isEmpty == false ? $0 : nil }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // MARK: facts row (location · best by · amount stepper)

    private func factsRow(_ item: NookAPI.PantryItem) -> some View {
        HStack(spacing: 10) {
            Text(item.location).font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink2)
            if let exp = expiryTag(item) {
                Text("·").foregroundStyle(NK.ink3)
                Text(exp.text).font(.system(size: 13, weight: .semibold)).foregroundStyle(exp.color)
            }
            Spacer()
            if !item.usedUp {
                HStack(spacing: 10) {
                    Button { Task { await model.adjust(item, delta: -1) } } label: { stepGlyph("minus") }.buttonStyle(.plain)
                    Text(amountLabel(item)).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink).frame(minWidth: 40)
                    Button { Task { await model.adjust(item, delta: 1) } } label: { stepGlyph("plus") }.buttonStyle(.plain)
                }
            } else {
                Text("Used up").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink3)
                    .padding(.horizontal, 9).padding(.vertical, 4).background(NK.panel).clipShape(Capsule())
            }
        }
        .padding(.vertical, 6)
    }
    private func amountLabel(_ item: NookAPI.PantryItem) -> String {
        let a = item.amount.trimmingCharacters(in: .whitespaces)
        let u = item.unit.trimmingCharacters(in: .whitespaces)
        if a.isEmpty { return u.isEmpty ? "—" : u }
        return u.isEmpty ? a : "\(a) \(u)"
    }
    private func stepGlyph(_ n: String) -> some View {
        Image(systemName: n).font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink)
            .frame(width: 30, height: 30).background(NK.panel).clipShape(Circle())
    }

    private func expiryTag(_ item: NookAPI.PantryItem) -> (text: String, color: Color)? {
        guard let d = PantryExpiry.daysUntil(item.expiresOn, tz: sync.householdTz) else { return nil }
        if d < 0 { return ("Expired", Color(hex: 0xC0392B)) }
        if d == 0 { return ("Today", Color(hex: 0xB8860B)) }
        if d <= 3 { return ("\(d) day\(d == 1 ? "" : "s") left", Color(hex: 0xB8860B)) }
        return ("Best by \(item.expiresOn.flatMap(PantryExpiry.shortLabel) ?? "")", NK.ink3)
    }

    // MARK: allergens

    private func containsRow(_ item: NookAPI.PantryItem, _ allergens: [String]) -> some View {
        let flagged = Set(model.flagged(item))
        let affects = model.affects(item)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("Contains").font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink3)
                ChipFlow(spacing: 6, lineSpacing: 6) {
                    ForEach(allergens, id: \.self) { a in
                        let bad = flagged.contains(a)
                        Text(PantryAllergen.label(a)).font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(bad ? Color(hex: 0xC0392B) : NK.ink2)
                            .padding(.horizontal, 9).padding(.vertical, 4)
                            .background((bad ? Color(hex: 0xC0392B) : NK.ink3).opacity(0.12)).clipShape(Capsule())
                    }
                }
            }
            if !affects.isEmpty {
                Text("⚠ Affects \(affects.joined(separator: ", "))")
                    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Color(hex: 0xC0392B))
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    // MARK: nutrition

    private func nutritionCard(_ item: NookAPI.PantryItem, _ n: NookAPI.PantryNutrition) -> some View {
        var rows: [(String, String)] = []
        if let v = n.calories { rows.append(("Calories", formatAmount(v))) }
        if let v = n.proteinG { rows.append(("Protein", "\(formatAmount(v)) g")) }
        if let v = n.fatG { rows.append(("Total fat", "\(formatAmount(v)) g")) }
        if let v = n.carbsG { rows.append(("Carbohydrate", "\(formatAmount(v)) g")) }
        if let v = n.sodiumMg { rows.append(("Sodium", "\(formatAmount(v)) mg")) }
        return NookCard {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Nutrition").font(.system(size: 17, weight: .bold)).foregroundStyle(NK.ink)
                    Spacer()
                    if let basis = item.servingBasis { Text(basis).font(.system(size: 12)).foregroundStyle(NK.ink3) }
                }
                Rectangle().fill(NK.ink).frame(height: 3).padding(.vertical, 8)
                ForEach(Array(rows.enumerated()), id: \.offset) { i, r in
                    HStack {
                        Text(r.0).font(.system(size: 15)).foregroundStyle(NK.ink)
                        Spacer()
                        Text(r.1).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
                    }
                    .padding(.vertical, 9)
                    if i != rows.count - 1 { Divider().background(NK.hair) }
                }
            }
        }
    }

    // MARK: actions

    private func actions(_ item: NookAPI.PantryItem) -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                Button { editing = true } label: {
                    actionLabel("Edit", "pencil", filled: false)
                }.buttonStyle(.plain)
                Button { Task { await model.setUsedUp(item, !item.usedUp) } } label: {
                    actionLabel(item.usedUp ? "Back on hand" : "Used up", item.usedUp ? "arrow.uturn.backward" : "checkmark", filled: true)
                }.buttonStyle(.plain)
            }
            Button { Task { await model.delete(item); dismiss() } } label: {
                Text("Delete").font(.system(size: 14, weight: .semibold)).foregroundStyle(Color(hex: 0xC0392B))
                    .frame(maxWidth: .infinity).padding(.vertical, 12)
                    .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
            }.buttonStyle(.plain)
        }
        .padding(.top, 4)
    }

    private func actionLabel(_ text: String, _ icon: String, filled: Bool) -> some View {
        HStack(spacing: 7) {
            Image(systemName: icon).font(.system(size: 13, weight: .bold))
            Text(text).font(.system(size: 15, weight: .bold))
        }
        .foregroundStyle(filled ? .white : NK.ink)
        .frame(maxWidth: .infinity).padding(.vertical, 13)
        .background(filled ? NK.primary : NK.card)
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(filled ? .clear : NK.hair, lineWidth: 1))
    }
}
