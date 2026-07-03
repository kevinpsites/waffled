import SwiftUI

/// Shared Pantry helpers + the list view-model. The Pantry module (on-hand food
/// inventory, gated behind `WaffledModule.pantry`) mirrors the web kiosk: items carry a
/// free-text amount + unit, a location, an optional best-by date, and — when added via
/// a barcode scan — a denormalized Open Food Facts snapshot (brand, photo, nutrition,
/// allergens). REST-only over `WaffledAPI`; not in the PowerSync mirror.

// (Allergen labels + the colored badge system live in PantryAllergens.swift.)

// MARK: - Food emoji (fallback when there's no product photo)

/// A rough name → emoji map, mirroring the web `foodEmoji`. Default 🥫.
enum PantryFood {
    private static let rules: [(needles: [String], emoji: String)] = [
        (["pork", "bacon", "ham", "sausage"], "🥓"),
        (["chicken", "turkey", "poultry"], "🍗"),
        (["beef", "steak", "burger"], "🥩"),
        (["salmon", "fish", "tuna", "cod", "shrimp"], "🐟"),
        (["broccoli", "lettuce", "spinach", "kale", "greens", "veg"], "🥦"),
        (["tomato"], "🍅"), (["carrot"], "🥕"), (["pepper"], "🫑"),
        (["apple"], "🍎"), (["banana"], "🍌"), (["berry", "berries"], "🫐"),
        (["milk"], "🥛"), (["yogurt", "yoghurt"], "🥛"), (["cheese"], "🧀"),
        (["butter"], "🧈"), (["egg"], "🥚"), (["bread", "bun", "roll"], "🍞"),
        (["rice"], "🍚"), (["pasta", "noodle", "spaghetti"], "🍝"),
        (["pie", "pizza"], "🥧"), (["ice cream", "frozen"], "🍨"),
        (["juice", "soda", "drink"], "🧃"), (["water"], "💧"),
        (["cereal"], "🥣"), (["soup", "broth", "stock"], "🍲"),
    ]
    static func emoji(for name: String) -> String {
        let n = name.lowercased()
        for r in rules where r.needles.contains(where: { n.contains($0) }) { return r.emoji }
        return "🥫"
    }
}

// MARK: - Expiry

/// Days from today to a YYYY-MM-DD date (negative = past), or nil if unparseable.
enum PantryExpiry {
    private static let fmt: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private static let shortFmt: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "MMM d"
        return f
    }()
    static func date(_ s: String?) -> Date? { s.flatMap { fmt.date(from: $0) } }
    static func string(_ date: Date) -> String { fmt.string(from: date) }
    /// "best by Jul 22" style short label.
    static func shortLabel(_ s: String?) -> String? {
        guard let d = date(s) else { return nil }
        return shortFmt.string(from: d)
    }
    static func daysUntil(_ s: String?, tz: TimeZone) -> Int? {
        guard let d = date(s) else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = tz
        let start = cal.startOfDay(for: Date())
        return cal.dateComponents([.day], from: start, to: cal.startOfDay(for: d)).day
    }
    /// Days since a YYYY-MM-DD date (today − date; positive for past dates), or nil.
    static func daysSince(_ s: String?, tz: TimeZone) -> Int? {
        guard let u = daysUntil(s, tz: tz) else { return nil }
        return -u
    }
    /// A compact "on hand for" label from a day count, mirroring the web `ageLabel`:
    /// <14d → "Nd", <1.5 mo → "Nw", <12 mo → "N mo", else years ("1 yr" under ~2y).
    static func ageLabel(daysSince days: Int) -> String {
        let d = Double(max(0, days))
        let m = d / 30.44
        if d < 14 { return "\(max(1, Int(d.rounded())))d" }
        if m < 1.5 { return "\(Int((d / 7).rounded()))w" }
        if m < 12 { return "\(Int(m.rounded())) mo" }
        let y = m / 12
        return y < 1.95 ? "1 yr" : "\(Int(y.rounded())) yr"
    }
}

// MARK: - OFF snapshot → request body

extension WaffledAPI.OffProduct {
    /// The OFF snapshot fields as a create-body fragment (merged with the user's
    /// name/amount/location/best-by when adding a scanned item).
    var snapshotBody: [String: JSONValue] {
        var b: [String: JSONValue] = ["source": .string(source), "barcode": .string(barcode)]
        if let v = brand { b["brand"] = .string(v) }
        if let v = imageUrl { b["imageUrl"] = .string(v) }
        if let v = quantityText { b["quantityText"] = .string(v) }
        if let v = servingBasis { b["servingBasis"] = .string(v) }
        if !allergens.isEmpty { b["allergens"] = .array(allergens.map(JSONValue.string)) }
        if let t = traces, !t.isEmpty { b["traces"] = .array(t.map(JSONValue.string)) }
        if !dietary.isEmpty { b["dietary"] = .array(dietary.map(JSONValue.string)) }
        var n: [String: JSONValue] = [:]
        if let v = nutrition.calories { n["calories"] = .double(v) }
        if let v = nutrition.proteinG { n["protein_g"] = .double(v) }
        if let v = nutrition.fatG { n["fat_g"] = .double(v) }
        if let v = nutrition.carbsG { n["carbs_g"] = .double(v) }
        if let v = nutrition.sodiumMg { n["sodium_mg"] = .double(v) }
        if !n.isEmpty { b["nutrition"] = .object(n) }
        return b
    }
}

// MARK: - View-model

@MainActor
@Observable
final class PantryModel {
    private(set) var items: [WaffledAPI.PantryItem] = []
    private(set) var locations: [String] = []
    private(set) var avoidAllergens: [String] = []
    private(set) var allergenPeople: [String: [String]] = [:]
    private(set) var lowThreshold: Double = 1
    private(set) var locationIcons: [String: String] = [:]
    /// Household "show the Pantry card on Today" toggle — respected by the Today cards.
    private(set) var showOnToday = true
    /// Household "old" threshold in months (default 6); items on hand longer are flagged.
    private(set) var staleMonths: Double = 6
    private(set) var loading = true
    private(set) var error = false
    private(set) var loaded = false
    /// Days-to-expiry per item id, computed once at load — so sort/filter/badges don't
    /// re-do date math (a `Calendar` alloc + `startOfDay`) on every keystroke.
    private(set) var daysToExpiry: [String: Int] = [:]
    /// Days on hand per item id (today − addedOn), likewise precomputed once at load.
    private(set) var daysOnHand: [String: Int] = [:]

    private let api = WaffledAPI()

    func load() async {
        loading = !loaded
        do {
            let r = try await api.pantryList()
            items = r.items
            locations = r.locations
            avoidAllergens = r.avoidAllergens
            allergenPeople = r.allergenPeople
            lowThreshold = r.lowThreshold
            locationIcons = r.locationIcons ?? [:]
            staleMonths = r.staleMonths ?? 6
            showOnToday = r.showOnToday
            recomputeDays()
            error = false
            loaded = true
        } catch { self.error = true }
        loading = false
    }

    private func recomputeDays() {
        var d: [String: Int] = [:]
        var age: [String: Int] = [:]
        for i in items {
            if i.expiresOn != nil, let n = PantryExpiry.daysUntil(i.expiresOn, tz: .current) { d[i.id] = n }
            if let n = PantryExpiry.daysSince(i.addedOn, tz: .current) { age[i.id] = n }
        }
        daysToExpiry = d
        daysOnHand = age
    }

    func days(_ item: WaffledAPI.PantryItem) -> Int? { daysToExpiry[item.id] }
    /// Days this item has been on hand (nil if it has no added-date). O(1) lookup.
    func ageDays(_ item: WaffledAPI.PantryItem) -> Int? { daysOnHand[item.id] }
    /// "Been a while" — on hand at least the household's stale threshold (default 6 mo).
    func isOld(_ item: WaffledAPI.PantryItem) -> Bool {
        guard let d = daysOnHand[item.id] else { return false }
        return Double(d) >= staleMonths * 30.44
    }

    /// The effective avoid-set: household avoid-list ∪ any allergen a member has.
    var avoidSet: Set<String> { Set(avoidAllergens).union(allergenPeople.keys) }

    /// "Use soon" — expires within 3 days (or already past).
    func isSoon(_ item: WaffledAPI.PantryItem) -> Bool {
        guard let d = daysToExpiry[item.id] else { return false }
        return d <= 3
    }

    // MARK: grouping

    var onHand: [WaffledAPI.PantryItem] { items.filter { !$0.usedUp } }
    var usedUp: [WaffledAPI.PantryItem] { items.filter { $0.usedUp } }
    func onHand(in loc: String) -> [WaffledAPI.PantryItem] {
        onHand.filter { $0.location == loc }.sorted { $0.name < $1.name }
    }
    /// Configured locations (in order) plus any "stray" locations that still hold items,
    /// keeping only those with at least one on-hand item.
    var sectionLocations: [String] {
        var locs = locations
        let extra = Set(onHand.map(\.location)).subtracting(locs).sorted()
        locs.append(contentsOf: extra)
        return locs.filter { !onHand(in: $0).isEmpty }
    }

    // MARK: derived flags

    func isLow(_ item: WaffledAPI.PantryItem) -> Bool {
        guard let n = Double(item.amount.trimmingCharacters(in: .whitespaces)) else { return false }
        return n <= (item.lowAt ?? lowThreshold)
    }
    /// Allergens on this item that the household (avoid-list ∪ per-person) flags.
    func flagged(_ item: WaffledAPI.PantryItem) -> [String] {
        let avoid = Set(avoidAllergens).union(allergenPeople.keys)
        return (item.allergens ?? []).filter { avoid.contains($0) }
    }
    /// People affected by this item's flagged allergens.
    func affects(_ item: WaffledAPI.PantryItem) -> [String] {
        var names: Set<String> = []
        for a in flagged(item) { for p in allergenPeople[a] ?? [] { names.insert(p) } }
        return names.sorted()
    }

    // MARK: mutations (optimistic, revert on failure)

    func replace(_ updated: WaffledAPI.PantryItem) {
        if let i = items.firstIndex(where: { $0.id == updated.id }) { items[i] = updated }
        else { items.append(updated) }
    }

    /// Bump a numeric amount by ±1. Stepping at/below 1 marks it used up instead of
    /// going to zero (mirrors the web stepper).
    func adjust(_ item: WaffledAPI.PantryItem, delta: Double) async {
        let current = Double(item.amount.trimmingCharacters(in: .whitespaces)) ?? (delta > 0 ? 0 : 1)
        let next = current + delta
        if next <= 0 { await setUsedUp(item, true); return }
        await patch(item, ["amount": .string(formatAmount(next))])
    }

    func setUsedUp(_ item: WaffledAPI.PantryItem, _ used: Bool) async {
        await patch(item, ["usedUp": .bool(used)])
    }

    private func patch(_ item: WaffledAPI.PantryItem, _ body: [String: JSONValue]) async {
        do { replace(try await api.pantryUpdate(id: item.id, body)) }
        catch { await load() }
    }

    func delete(_ item: WaffledAPI.PantryItem) async {
        let snapshot = items
        items.removeAll { $0.id == item.id }
        do { try await api.pantryDelete(id: item.id) }
        catch { items = snapshot }
    }
}

/// The amber "been a while" age chip — 🕰️ + a compact age label (e.g. "8 mo"), used on
/// list rows (old items only) and the item detail. `trailing` appends " ago" for the
/// detail's Added row, matching the web.
struct AgePill: View {
    let days: Int
    var icon: Bool = true
    var trailing: String = ""
    var size: CGFloat = 10.5
    var body: some View {
        Text("\(icon ? "🕰️ " : "")\(PantryExpiry.ageLabel(daysSince: days))\(trailing)")
            .font(.system(size: size, weight: .bold))
            .foregroundStyle(Color(hex: 0x8A6D3B))
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Color(hex: 0xF4ECD8)).clipShape(Capsule())
    }
}

/// Format a numeric amount back to a tidy string ("2", "1.5", not "2.0").
func formatAmount(_ n: Double) -> String {
    if n == n.rounded() { return String(Int(n)) }
    return String(format: "%g", (n * 100).rounded() / 100)
}
