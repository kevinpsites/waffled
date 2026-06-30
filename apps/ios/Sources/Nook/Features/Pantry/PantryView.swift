import SwiftUI

/// Pantry — on-hand food inventory, grouped by location. A prominent **Scan** entry
/// (barcode → Open Food Facts → add) sits up top; items can also be added by hand.
/// Tapping an item opens its detail (nutrition + allergens for scanned items).
struct PantryView: View {
    @Environment(SyncManager.self) private var sync
    @State private var model = PantryModel()
    @State private var showScan = false
    @State private var addManually = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                scanCard
                if model.loading && model.items.isEmpty {
                    NookLoading(top: 40)
                } else if model.error && model.items.isEmpty {
                    errorState
                } else if model.onHand.isEmpty && model.usedUp.isEmpty {
                    emptyState
                } else {
                    ForEach(model.sectionLocations, id: \.self) { loc in
                        locationSection(loc)
                    }
                    if !model.usedUp.isEmpty { usedUpSection }
                }
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle("Pantry").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { addManually = true } label: { Image(systemName: "plus").foregroundStyle(NK.ink2) }
            }
        }
        .navigationDestination(for: NookAPI.PantryItem.self) { item in
            PantryItemDetailView(itemId: item.id, model: model)
        }
        .refreshable { await model.load() }
        .task { await model.load() }
        .fullScreenCover(isPresented: $showScan) {
            PantryScanView(locations: model.locations) { await model.load() }
        }
        .sheet(isPresented: $addManually) {
            PantryItemEditor(mode: .add, locations: model.locations) { body in
                _ = try? await NookAPI().pantryCreate(body); await model.load()
            }
        }
    }

    // MARK: scan entry

    private var scanCard: some View {
        Button { showScan = true } label: {
            HStack(spacing: 14) {
                Image(systemName: "barcode.viewfinder")
                    .font(.system(size: 26, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: 50, height: 50)
                    .background(NK.ink).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text("Scan into pantry").font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ink)
                    Text("Point at a barcode — looks it up on Open Food Facts")
                        .font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink3)
            }
            .padding(14).background(NK.card)
            .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // MARK: sections

    private func locationSection(_ loc: String) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            SectionLabel(text: loc)
            VStack(spacing: 0) {
                let rows = model.onHand(in: loc)
                ForEach(rows) { item in
                    NavigationLink(value: item) { row(item) }.buttonStyle(.plain)
                    if item.id != rows.last?.id { Divider().background(NK.hair).padding(.leading, 58) }
                }
            }
            .background(NK.card)
            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        }
    }

    private var usedUpSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            SectionLabel(text: "Used up")
            VStack(spacing: 0) {
                ForEach(model.usedUp) { item in
                    NavigationLink(value: item) { row(item) }.buttonStyle(.plain).opacity(0.55)
                    if item.id != model.usedUp.last?.id { Divider().background(NK.hair).padding(.leading, 58) }
                }
            }
            .background(NK.card)
            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        }
    }

    // MARK: a row

    private func row(_ item: NookAPI.PantryItem) -> some View {
        HStack(spacing: 12) {
            thumb(item).frame(width: 38, height: 38)
                .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                HStack(spacing: 6) {
                    if let exp = PantryExpiry.shortLabel(item.expiresOn) { ExpiryBadge(label: exp, days: PantryExpiry.daysUntil(item.expiresOn, tz: sync.householdTz)) }
                    if model.isLow(item) { Text("Low").font(.system(size: 11, weight: .bold)).foregroundStyle(NK.gold) }
                    if !model.flagged(item).isEmpty {
                        Text("⚠ \(model.flagged(item).map(PantryAllergen.label).joined(separator: ", "))")
                            .font(.system(size: 11, weight: .semibold)).foregroundStyle(Color(hex: 0xC0392B)).lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 8)
            if !item.usedUp { stepper(item) }
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink3)
        }
        .padding(12)
        .contentShape(Rectangle())
    }

    @ViewBuilder private func thumb(_ item: NookAPI.PantryItem) -> some View {
        if let s = item.imageUrl, let url = URL(string: s) {
            AsyncImage(url: url) { $0.resizable().scaledToFill() }
            placeholder: { Text(PantryFood.emoji(for: item.name)).font(.system(size: 20)) }
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        } else {
            Text(PantryFood.emoji(for: item.name)).font(.system(size: 20))
        }
    }

    /// Compact − amount + control. Buttons live outside the NavigationLink's label so
    /// they get their own taps; stepping below 1 marks the item used up.
    private func stepper(_ item: NookAPI.PantryItem) -> some View {
        HStack(spacing: 8) {
            Button { Task { await model.adjust(item, delta: -1) } } label: { stepGlyph("minus") }.buttonStyle(.plain)
            Text(amountText(item)).font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink).frame(minWidth: 22)
            Button { Task { await model.adjust(item, delta: 1) } } label: { stepGlyph("plus") }.buttonStyle(.plain)
        }
    }
    private func stepGlyph(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink)
            .frame(width: 26, height: 26).background(NK.panel).clipShape(Circle())
    }
    private func amountText(_ item: NookAPI.PantryItem) -> String {
        let amt = item.amount.trimmingCharacters(in: .whitespaces)
        let unit = item.unit.trimmingCharacters(in: .whitespaces)
        if amt.isEmpty { return unit.isEmpty ? "—" : unit }
        return unit.isEmpty ? amt : "\(amt)"
    }

    // MARK: states

    private var emptyState: some View {
        VStack(spacing: 12) {
            Text("🥫").font(.system(size: 48))
            Text("Your pantry is empty").font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ink)
            Text("Scan groceries in as you put them away, or add an item by hand.")
                .font(.system(size: 13)).foregroundStyle(NK.ink2).multilineTextAlignment(.center)
            Button { showScan = true } label: {
                Text("Scan items in").font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                    .padding(.horizontal, 18).padding(.vertical, 11)
                    .background(NK.primary).clipShape(Capsule())
            }.buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 30)
    }

    private var errorState: some View {
        VStack(spacing: 10) {
            Text("Couldn’t load your pantry.").font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink2)
            Button { Task { await model.load() } } label: {
                Text("Try again").font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.primary)
            }.buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 30)
    }
}

/// A small "best by" pill — red when past, amber within 3 days, muted otherwise.
struct ExpiryBadge: View {
    let label: String
    let days: Int?
    var body: some View {
        let (fg, text): (Color, String) = {
            guard let d = days else { return (NK.ink3, "best by \(label)") }
            if d < 0 { return (Color(hex: 0xC0392B), "Expired") }
            if d == 0 { return (Color(hex: 0xB8860B), "Today") }
            if d <= 3 { return (Color(hex: 0xB8860B), "best by \(label)") }
            return (NK.ink3, "best by \(label)")
        }()
        Text(text).font(.system(size: 11, weight: .semibold)).foregroundStyle(fg)
    }
}
