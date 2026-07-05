import SwiftUI

/// Pantry — on-hand inventory, mirroring the web kiosk: a location / smart-group
/// sidebar (a chip row on iPhone), search, sort (Expiring / A–Z / Recent), a card grid
/// with Open Food Facts photos + colored allergen badges, and the allergen legend.
/// Scan (barcode → OFF) and Add item up top. Gated behind the `pantry` module.
struct PantryView: View {
    @Environment(\.horizontalSizeClass) private var hSize
    @State private var model = PantryModel()
    @State private var showScan = false
    @State private var addManually = false
    @State private var query = ""
    @State private var filter: PantryFilter = .all
    @State private var sort: PantrySort = .expiring

    private var isWide: Bool { hSize == .regular }

    enum PantryFilter: Equatable { case all, useSoon, runningLow, beenAWhile, location(String) }
    enum PantrySort: String, CaseIterable { case expiring, az, recent, oldest
        var label: String {
            switch self {
            case .expiring: return "Expiring"
            case .az: return "A–Z"
            case .recent: return "Recent"
            case .oldest: return "Oldest"
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            headBar
            if model.loading && !model.loaded {
                WaffledLoading(top: 40); Spacer()
            } else if model.error && model.items.isEmpty {
                errorState; Spacer()
            } else if isWide {
                HStack(alignment: .top, spacing: 0) {
                    sidebar.frame(width: 234)
                    Rectangle().fill(WF.hair).frame(width: 1)
                    mainScroll
                }
            } else {
                VStack(spacing: 0) {
                    filterChips
                    mainScroll
                }
            }
        }
        .background(WF.canvas)
        .navigationTitle("Pantry").navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: WaffledAPI.PantryItem.self) { PantryItemDetailView(itemId: $0.id, model: model) }
        .task { await model.load() }
        .refreshable { await model.load() }
        .fullScreenCover(isPresented: $showScan) {
            PantryScanView(locations: model.locations) { await model.load() }
        }
        .sheet(isPresented: $addManually) {
            PantryItemEditor(mode: .add, locations: model.locations) { body in
                _ = try? await WaffledAPI().pantryCreate(body); await model.load()
            }
        }
    }

    // MARK: head bar (search + scan + add)

    private var headBar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3)
                TextField("Search all \(model.onHand.count) items…", text: $query)
                    .font(.system(size: 15)).textInputAutocapitalization(.never)
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(WF.ink3) }.buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(WF.card).clipShape(Capsule())
            .overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1))
            Button { showScan = true } label: {
                Label("Scan", systemImage: "barcode.viewfinder").font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
                    .padding(.horizontal, 14).padding(.vertical, 10).background(WF.card).clipShape(Capsule())
                    .overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1))
            }.buttonStyle(.plain)
            Button { addManually = true } label: {
                Label("Add", systemImage: "plus").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                    .padding(.horizontal, 14).padding(.vertical, 10).background(WF.primary).clipShape(Capsule())
            }.buttonStyle(.plain)
        }
        .labelStyle(.titleAndIcon)
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    // MARK: sidebar (iPad)

    private var sidebar: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                navRow("🗂️", "All items", counts.all, .all)
                navRow("⏰", "Use soon", counts.useSoon, .useSoon)
                navRow("📉", "Running low", counts.runningLow, .runningLow)
                if counts.beenAWhile > 0 { navRow("🕰️", "Been a while", counts.beenAWhile, .beenAWhile) }
                Rectangle().fill(WF.hair).frame(height: 1).padding(.vertical, 8)
                ForEach(model.locations, id: \.self) { loc in
                    navRow(model.locationIcons[loc] ?? "📦", loc, counts.byLoc[loc] ?? 0, .location(loc))
                }
                if (counts.byLoc["Other"] ?? 0) > 0 {
                    navRow("📦", "Other", counts.byLoc["Other"] ?? 0, .location("Other"))
                }
                if !model.avoidSet.isEmpty {
                    Rectangle().fill(WF.hair).frame(height: 1).padding(.vertical, 8)
                    AllergenKey(avoid: model.avoidSet)
                }
                Rectangle().fill(WF.hair).frame(height: 1).padding(.vertical, 8)
                CookFromPantryCard(model: model)
            }
            .padding(14)
        }
    }

    private func navRow(_ icon: String, _ label: String, _ count: Int, _ f: PantryFilter) -> some View {
        let on = filter == f
        return Button { filter = f } label: {
            HStack(spacing: 10) {
                Text(icon).font(.system(size: 15))
                Text(label).font(.system(size: 14, weight: on ? .bold : .semibold)).foregroundStyle(on ? WF.ink : WF.ink2)
                Spacer(minLength: 4)
                Text("\(count)").font(.system(size: 12, weight: .bold)).foregroundStyle(on ? WF.primaryD : WF.ink3)
            }
            .padding(.horizontal, 11).padding(.vertical, 9)
            .background(on ? WF.primary.opacity(0.12) : .clear)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        }.buttonStyle(.plain)
    }

    // MARK: filter chips (iPhone)

    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("All", counts.all, .all)
                chip("Use soon", counts.useSoon, .useSoon)
                chip("Low", counts.runningLow, .runningLow)
                if counts.beenAWhile > 0 { chip("Been a while", counts.beenAWhile, .beenAWhile) }
                ForEach(model.locations, id: \.self) { loc in chip(loc, counts.byLoc[loc] ?? 0, .location(loc)) }
                if (counts.byLoc["Other"] ?? 0) > 0 { chip("Other", counts.byLoc["Other"] ?? 0, .location("Other")) }
            }
            .padding(.horizontal, 16).padding(.bottom, 8)
        }
    }
    private func chip(_ label: String, _ count: Int, _ f: PantryFilter) -> some View {
        let on = filter == f
        return Button { filter = f } label: {
            HStack(spacing: 5) {
                Text(label).font(.system(size: 13, weight: .semibold))
                Text("\(count)").font(.system(size: 11, weight: .bold)).foregroundStyle(on ? WF.primaryD : WF.ink3)
            }
            .foregroundStyle(on ? WF.ink : WF.ink2)
            .padding(.horizontal, 12).padding(.vertical, 7).wfChip(selected: on)
        }.buttonStyle(.plain)
    }

    // MARK: main column

    private var mainScroll: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if !isWide { CookFromPantryCard(model: model) }
                mainHead
                if shown.isEmpty && model.usedUp.isEmpty {
                    Text(query.isEmpty ? "Nothing here yet. Add what’s on hand." : "Nothing matches your search.")
                        .font(.system(size: 14)).foregroundStyle(WF.ink3)
                        .frame(maxWidth: .infinity).padding(.vertical, 30)
                } else {
                    LazyVGrid(columns: gridColumns, alignment: .leading, spacing: 12) {
                        ForEach(shown) { card($0) }
                    }
                    if !filteredUsed.isEmpty { usedUpSection }
                }
                if !isWide && !model.avoidSet.isEmpty {
                    Rectangle().fill(WF.hair).frame(height: 1).padding(.top, 4)
                    AllergenKey(avoid: model.avoidSet)
                }
            }
            .padding(16).padding(.bottom, 110)
        }
    }

    private var gridColumns: [GridItem] {
        isWide ? [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)] : [GridItem(.flexible())]
    }

    private var mainHead: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(filterLabel).font(.system(size: 17, weight: .bold)).foregroundStyle(WF.ink)
            + Text("  · \(shown.count) item\(shown.count == 1 ? "" : "s")").font(.system(size: 13)).foregroundStyle(WF.ink3)
            Spacer()
            Picker("", selection: $sort) {
                ForEach(PantrySort.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented).fixedSize()
        }
    }

    // MARK: a card

    private func card(_ item: WaffledAPI.PantryItem) -> some View {
        HStack(spacing: 10) {
            NavigationLink(value: item) {
                HStack(spacing: 10) {
                    thumb(item).frame(width: 40, height: 40)
                        .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                        subline(item)
                    }
                    Spacer(minLength: 0)
                }
            }.buttonStyle(.plain)
            stepper(item)
        }
        .padding(10)
        .background(WF.card)
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
            .strokeBorder(model.flagged(item).isEmpty ? WF.hair : Color(hex: 0xC0392B).opacity(0.4), lineWidth: 1))
    }

    private func subline(_ item: WaffledAPI.PantryItem) -> some View {
        HStack(spacing: 6) {
            Text(locOf(item)).font(.system(size: 12, weight: .medium)).foregroundStyle(WF.ink3)
            if let a = item.allergens, !a.isEmpty {
                AllergenBadges(allergens: a, avoid: model.avoidSet, traces: item.traces ?? [])
            }
            if let exp = expiryTag(item) {
                Text("·").font(.system(size: 12)).foregroundStyle(WF.ink3)
                Text(exp.text).font(.system(size: 12, weight: .semibold)).foregroundStyle(exp.color)
            }
            if model.isOld(item), let d = model.ageDays(item) {
                AgePill(days: d)
            }
            Spacer(minLength: 0)
        }
    }

    private func thumb(_ item: WaffledAPI.PantryItem) -> some View {
        CachedImage(item.imageUrl) { Text(PantryFood.emoji(for: item.name)).font(.system(size: 21)) }
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func stepper(_ item: WaffledAPI.PantryItem) -> some View {
        HStack(spacing: 8) {
            Button { Task { await model.adjust(item, delta: -1) } } label: { stepGlyph("minus") }.buttonStyle(.plain)
            VStack(spacing: -1) {
                Text(item.amount.isEmpty ? "—" : item.amount).font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
                if !item.unit.isEmpty { Text(item.unit).font(.system(size: 9, weight: .semibold)).foregroundStyle(WF.ink3) }
            }
            .frame(minWidth: 34)
            Button { Task { await model.adjust(item, delta: 1) } } label: { stepGlyph("plus") }.buttonStyle(.plain)
        }
    }
    private func stepGlyph(_ n: String) -> some View {
        Image(systemName: n).font(.system(size: 11, weight: .bold)).foregroundStyle(WF.primary)
            .frame(width: 28, height: 28).background(WF.panel).clipShape(Circle())
    }

    private var usedUpSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Used up").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3).padding(.top, 6)
            ForEach(filteredUsed) { item in
                NavigationLink(value: item) {
                    HStack(spacing: 10) {
                        Text(item.name).font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink2)
                        Text("• Used up").font(.system(size: 12)).foregroundStyle(WF.ink3)
                        Spacer()
                    }
                    .padding(10).background(WF.card).opacity(0.6)
                    .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                }.buttonStyle(.plain)
            }
        }
    }

    private var errorState: some View {
        VStack(spacing: 10) {
            Text("Pantry isn’t enabled, or couldn’t load.").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink2)
            Text("Turn it on in Settings → Modules.").font(.system(size: 13)).foregroundStyle(WF.ink3)
            Button { Task { await model.load() } } label: {
                Text("Try again").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.primary)
            }.buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 30)
    }

    // MARK: derived data

    private func locOf(_ i: WaffledAPI.PantryItem) -> String { model.locations.contains(i.location) ? i.location : "Other" }

    private struct Counts { var all = 0; var useSoon = 0; var runningLow = 0; var beenAWhile = 0; var byLoc: [String: Int] = [:] }
    private var counts: Counts {
        var c = Counts()
        for i in model.onHand {
            c.all += 1
            if model.isSoon(i) { c.useSoon += 1 }
            if model.isLow(i) { c.runningLow += 1 }
            if model.isOld(i) { c.beenAWhile += 1 }
            c.byLoc[locOf(i), default: 0] += 1
        }
        return c
    }

    private var filterLabel: String {
        switch filter {
        case .all: return "All items"
        case .useSoon: return "Use soon"
        case .runningLow: return "Running low"
        case .beenAWhile: return "Been a while"
        case let .location(l): return l
        }
    }

    private var shown: [WaffledAPI.PantryItem] {
        var out = model.onHand
        switch filter {
        case .all: break
        case .useSoon: out = out.filter(model.isSoon)
        case .runningLow: out = out.filter(model.isLow)
        case .beenAWhile: out = out.filter(model.isOld)
        case let .location(l): out = out.filter { locOf($0) == l }
        }
        let s = query.trimmingCharacters(in: .whitespaces).lowercased()
        if !s.isEmpty { out = out.filter { $0.name.lowercased().contains(s) || ($0.brand ?? "").lowercased().contains(s) } }
        return sorted(out)
    }
    private var filteredUsed: [WaffledAPI.PantryItem] {
        let s = query.trimmingCharacters(in: .whitespaces).lowercased()
        return model.usedUp.filter { s.isEmpty || $0.name.lowercased().contains(s) }
    }

    private func sorted(_ list: [WaffledAPI.PantryItem]) -> [WaffledAPI.PantryItem] {
        switch sort {
        case .az: return list.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        case .recent: return list.sorted { ($0.createdAt ?? "") > ($1.createdAt ?? "") }
        case .oldest: return list.sorted { ($0.addedOn ?? "") < ($1.addedOn ?? "") }
        case .expiring:
            return list.sorted {
                let a = model.days($0)
                let b = model.days($1)
                switch (a, b) {
                case let (x?, y?): return x != y ? x < y : $0.name < $1.name
                case (_?, nil): return true
                case (nil, _?): return false
                default: return $0.name < $1.name
                }
            }
        }
    }

    private func expiryTag(_ item: WaffledAPI.PantryItem) -> (text: String, color: Color)? {
        guard let d = model.days(item) else { return nil }
        if d < 0 { return ("Expired", Color(hex: 0xC0392B)) }
        if d == 0 { return ("Today", Color(hex: 0xB8860B)) }
        if d <= 3 { return ("\(d) day\(d == 1 ? "" : "s")", Color(hex: 0xB8860B)) }
        return (item.expiresOn.flatMap(PantryExpiry.shortLabel) ?? "", WF.ink3)
    }
}
