import SwiftUI
import PhotosUI

/// Pantry item detail — the Open Food Facts product card. Two-column on iPad (a cream
/// photo panel with the OFF badge + "Replace photo" on the left, the facts on the
/// right), stacked on iPhone. Shows location · best-by · amount (with a stepper), the
/// colored "Contains" allergen badges (red ring + "Affects {people}" when the household
/// flags one), "may contain" traces, and the OFF nutrition table. Edit / used-up from
/// here; reads the live item from the model by id so changes reflect and a delete pops.
struct PantryItemDetailView: View {
    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var hSize
    let itemId: String
    let model: PantryModel

    @State private var editing = false
    @State private var photoPick: PhotosPickerItem?
    @State private var uploading = false

    private var item: NookAPI.PantryItem? { model.items.first { $0.id == itemId } }
    private var isWide: Bool { hSize == .regular }

    var body: some View {
        Group {
            if let item {
                if isWide {
                    HStack(spacing: 0) {
                        photoPanel(item).frame(width: 320)
                        ScrollView { infoColumn(item).padding(20) }
                    }
                } else {
                    ScrollView {
                        VStack(spacing: 0) {
                            photoPanel(item).frame(height: 240)
                            infoColumn(item).padding(16)
                        }
                    }
                }
            } else {
                Color.clear.onAppear { dismiss() }
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
        .onChange(of: photoPick) { _, pick in if let pick { replacePhoto(pick) } }
    }

    // MARK: left — photo panel

    private func photoPanel(_ item: NookAPI.PantryItem) -> some View {
        ZStack {
            Color(hex: 0xF3E8D6).ignoresSafeArea()
            CachedImage(item.imageUrl, contentMode: .fit) { Text(PantryFood.emoji(for: item.name)).font(.system(size: 72)) }
                .padding(28)
            VStack {
                HStack {
                    if item.isOff { offBadge }
                    Spacer()
                }
                Spacer()
                PhotosPicker(selection: $photoPick, matching: .images) {
                    HStack(spacing: 7) {
                        Image(systemName: "camera.fill").font(.system(size: 13))
                        Text(uploading ? "Uploading…" : "Replace photo").font(.system(size: 14, weight: .semibold))
                    }
                    .foregroundStyle(.white).padding(.horizontal, 14).padding(.vertical, 10)
                    .background(NK.ink).clipShape(Capsule())
                }
                .disabled(uploading)
            }
            .padding(14)
        }
    }

    private var offBadge: some View {
        HStack(spacing: 5) {
            Circle().fill(Color(hex: 0x167A4A)).frame(width: 7, height: 7)
            Text("OPEN FOOD FACTS").font(.system(size: 10, weight: .heavy)).tracking(0.4).foregroundStyle(NK.ink2)
        }
        .padding(.horizontal, 9).padding(.vertical, 5).background(NK.card).clipShape(Capsule())
    }

    // MARK: right — info column

    @ViewBuilder private func infoColumn(_ item: NookAPI.PantryItem) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(item.name).font(NK.serif(24, .bold)).foregroundStyle(NK.ink).fixedSize(horizontal: false, vertical: true)
                if let sub = subtitle(item) { Text(sub).font(.system(size: 14)).foregroundStyle(NK.ink3) }
            }
            rowsCard(item)
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
    }

    private func subtitle(_ item: NookAPI.PantryItem) -> String? {
        let parts = [item.brand, item.quantityText].compactMap { $0?.isEmpty == false ? $0 : nil }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // MARK: rows card (location · best by · amount)

    private func rowsCard(_ item: NookAPI.PantryItem) -> some View {
        VStack(spacing: 0) {
            factRow("Location") { Text(item.location).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink) }
            Divider().background(NK.hair)
            factRow("Best by") {
                if let exp = expiryTag(item) { Text(exp.text).font(.system(size: 15, weight: .bold)).foregroundStyle(exp.color) }
                else { Text("—").font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink3) }
            }
            Divider().background(NK.hair)
            factRow("Amount") {
                if item.usedUp {
                    Text("Used up").font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink3)
                } else {
                    HStack(spacing: 12) {
                        Button { Task { await model.adjust(item, delta: -1) } } label: { stepGlyph("minus") }.buttonStyle(.plain)
                        Text(amountLabel(item)).font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ink).frame(minWidth: 36)
                        Button { Task { await model.adjust(item, delta: 1) } } label: { stepGlyph("plus") }.buttonStyle(.plain)
                    }
                }
            }
        }
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    private func factRow<C: View>(_ label: String, @ViewBuilder _ trailing: () -> C) -> some View {
        HStack {
            Text(label).font(.system(size: 15)).foregroundStyle(NK.ink3)
            Spacer()
            trailing()
        }
        .padding(.horizontal, 14).padding(.vertical, 13)
    }

    private func amountLabel(_ item: NookAPI.PantryItem) -> String {
        let a = item.amount.trimmingCharacters(in: .whitespaces)
        let u = item.unit.trimmingCharacters(in: .whitespaces)
        if a.isEmpty { return u.isEmpty ? "—" : u }
        return u.isEmpty ? a : "\(a) \(u)"
    }
    private func stepGlyph(_ n: String) -> some View {
        Image(systemName: n).font(.system(size: 12, weight: .bold)).foregroundStyle(NK.primary)
            .frame(width: 30, height: 30).background(NK.panel).clipShape(Circle())
    }

    private func expiryTag(_ item: NookAPI.PantryItem) -> (text: String, color: Color)? {
        guard let d = model.days(item) else { return nil }
        if d < 0 { return ("Expired", Color(hex: 0xC0392B)) }
        if d == 0 { return ("Today", Color(hex: 0xB8860B)) }
        if d <= 3 { return ("\(d) day\(d == 1 ? "" : "s") left", Color(hex: 0xB8860B)) }
        return (item.expiresOn.flatMap(PantryExpiry.shortLabel) ?? "—", NK.ink)
    }

    // MARK: allergens

    private func containsRow(_ item: NookAPI.PantryItem, _ allergens: [String]) -> some View {
        let affects = model.affects(item)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                Text("CONTAINS").font(.system(size: 11, weight: .heavy)).tracking(0.4).foregroundStyle(NK.ink3)
                ChipFlow(spacing: 10, lineSpacing: 8) {
                    ForEach(allergens, id: \.self) { a in
                        HStack(spacing: 5) {
                            AllergenBadge(allergen: a, avoid: model.avoidSet.contains(a))
                            Text(PantryAllergen.label(a)).font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink)
                        }
                    }
                }
            }
            if !affects.isEmpty {
                Text("⚠ Affects \(affects.joined(separator: ", "))")
                    .font(.system(size: 13.5, weight: .bold)).foregroundStyle(Color(hex: 0xC0392B))
            }
        }
    }

    // MARK: nutrition

    private func nutritionCard(_ item: NookAPI.PantryItem, _ n: NookAPI.PantryNutrition) -> some View {
        var rows: [(String, String)] = []
        if let v = n.calories { rows.append(("Calories", formatAmount(v))) }
        if let v = n.proteinG { rows.append(("Protein", "\(formatAmount(v)) g")) }
        if let v = n.fatG { rows.append(("Total fat", "\(formatAmount(v)) g")) }
        if let v = n.carbsG { rows.append(("Carbohydrate", "\(formatAmount(v)) g")) }
        if let v = n.sodiumMg { rows.append(("Sodium", "\(formatAmount(v)) mg")) }
        return VStack(alignment: .leading, spacing: 0) {
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
        .padding(14)
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    // MARK: actions

    private func actions(_ item: NookAPI.PantryItem) -> some View {
        HStack(spacing: 10) {
            Button { Task { await model.setUsedUp(item, !item.usedUp) } } label: {
                Text(item.usedUp ? "Back on hand" : "Mark used up")
                    .font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
                    .frame(maxWidth: .infinity).padding(.vertical, 13)
                    .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
            }.buttonStyle(.plain)
            Button { editing = true } label: {
                Text("Edit").font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 13)
                    .background(NK.primary).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            }.buttonStyle(.plain)
        }
        .padding(.top, 4)
    }

    // MARK: replace photo

    private func replacePhoto(_ pick: PhotosPickerItem) {
        uploading = true
        Task {
            defer { uploading = false; photoPick = nil }
            guard let data = try? await pick.loadTransferable(type: Data.self),
                  let img = UIImage(data: data),
                  let up = try? await NookAPI().uploadImage(img),
                  let item,
                  let updated = try? await NookAPI().pantryUpdate(id: item.id, ["imageUrl": .string(up.url)])
            else { return }
            model.replace(updated)
        }
    }
}
