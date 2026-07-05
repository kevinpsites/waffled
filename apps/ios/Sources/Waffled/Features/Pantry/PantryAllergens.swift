import SwiftUI

/// The allergen design system — a small colored letter badge per allergen plus the
/// bottom legend, mirroring apps/web/src/kiosk/components/Allergens.tsx. Avoided
/// allergens (household avoid-list ∪ per-person) get a red ring; traces ("may contain")
/// render outlined. `milk` is OFF's tag for all dairy, surfaced as "Dairy" (badge D).
enum PantryAllergen {
    struct Badge { let short: String; let bg: Color; let fg: Color }

    static let badges: [String: Badge] = [
        "gluten":    Badge(short: "G",  bg: Color(hex: 0xE08A3C), fg: .white),
        "milk":      Badge(short: "D",  bg: Color(hex: 0x4F8FD6), fg: .white),
        "soy":       Badge(short: "S",  bg: Color(hex: 0x3FA45B), fg: .white),
        "egg":       Badge(short: "E",  bg: Color(hex: 0xF0CF52), fg: Color(hex: 0x5A4A00)),
        "peanut":    Badge(short: "P",  bg: Color(hex: 0xA9743B), fg: .white),
        "tree_nut":  Badge(short: "N",  bg: Color(hex: 0xC98A3A), fg: .white),
        "fish":      Badge(short: "F",  bg: Color(hex: 0x3FB0A6), fg: .white),
        "shellfish": Badge(short: "C",  bg: Color(hex: 0xD96E92), fg: .white),
        "sesame":    Badge(short: "Se", bg: Color(hex: 0xCBB079), fg: Color(hex: 0x4A3B1A)),
    ]
    static let labels: [String: String] = [
        "gluten": "Gluten", "milk": "Dairy", "soy": "Soy", "egg": "Egg", "peanut": "Peanut",
        "tree_nut": "Tree nut", "fish": "Fish", "shellfish": "Shellfish", "sesame": "Sesame",
    ]
    /// Canonical order (matches the web legend).
    static let keys = ["gluten", "milk", "soy", "egg", "peanut", "tree_nut", "fish", "shellfish", "sesame"]

    static func label(_ key: String) -> String { labels[key] ?? key.capitalized }
    static func badge(_ key: String) -> Badge {
        badges[key] ?? Badge(short: String(key.prefix(2)).uppercased(), bg: Color(hex: 0x8A8A8A), fg: .white)
    }
}

/// Dietary flags captured from the Open Food Facts ingredients analysis (read-only —
/// they come from the OFF snapshot). Mirrors the web `DIETARY_LABELS`.
enum PantryDietary {
    static let labels: [String: String] = [
        "vegan": "Vegan", "vegetarian": "Vegetarian", "palm_oil_free": "Palm-oil-free",
    ]
    /// Canonical order (matches the web).
    static let keys = ["vegan", "vegetarian", "palm_oil_free"]
    static func label(_ key: String) -> String {
        labels[key] ?? key.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

/// A small green "Vegan / Vegetarian / Palm-oil-free" chip (read-only OFF flag),
/// matching the web `.pl-diet-chip` (green fill, green ink).
struct DietaryChip: View {
    let key: String
    var body: some View {
        Text(PantryDietary.label(key))
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(Color(hex: 0x1C7A44))
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(Color(hex: 0xE6F4EA)).clipShape(Capsule())
    }
}

/// A wrapping row of an item's dietary chips (nil/empty → renders nothing).
struct DietaryChips: View {
    let dietary: [String]?
    var body: some View {
        if let dietary, !dietary.isEmpty {
            ChipFlow(spacing: 7, lineSpacing: 7) {
                ForEach(dietary, id: \.self) { DietaryChip(key: $0) }
            }
        }
    }
}

private let avoidRed = Color(hex: 0xC0392B)

/// One colored allergen letter-badge. `avoid` adds a red ring; `trace` renders it
/// outlined (lighter — "may contain").
struct AllergenBadge: View {
    let allergen: String
    var avoid = false
    var trace = false

    var body: some View {
        let b = PantryAllergen.badge(allergen)
        Text(b.short)
            .font(.system(size: 9.5, weight: .heavy))
            .foregroundStyle(trace ? b.bg : b.fg)
            .frame(width: 18, height: 18)
            .background(trace ? Color.clear : b.bg, in: Circle())
            .overlay { if trace { Circle().strokeBorder(b.bg, lineWidth: 1.5) } }
            .padding(1.5)
            .overlay { if avoid { Circle().strokeBorder(avoidRed, lineWidth: 1.5) } }
    }
}

/// A row of an item's allergen badges (definite first, then traces), avoided ones ringed.
struct AllergenBadges: View {
    let allergens: [String]
    let avoid: Set<String>
    var traces: [String] = []

    var body: some View {
        HStack(spacing: 3) {
            ForEach(allergens, id: \.self) { AllergenBadge(allergen: $0, avoid: avoid.contains($0)) }
            ForEach(traces.filter { !allergens.contains($0) }, id: \.self) {
                AllergenBadge(allergen: $0, avoid: avoid.contains($0), trace: true)
            }
        }
    }
}

/// The persistent legend — badge → name for all 9 keys, avoided ones ringed.
struct AllergenKey: View {
    let avoid: Set<String>

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("ALLERGENS").font(.system(size: 10, weight: .heavy)).tracking(0.6).foregroundStyle(WF.ink3)
            ChipFlow(spacing: 12, lineSpacing: 9) {
                ForEach(PantryAllergen.keys, id: \.self) { k in
                    HStack(spacing: 5) {
                        AllergenBadge(allergen: k, avoid: avoid.contains(k))
                        Text(PantryAllergen.label(k)).font(.system(size: 12)).foregroundStyle(WF.ink2)
                    }
                }
            }
        }
    }
}
