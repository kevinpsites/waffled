import SwiftUI

/// Today card for the Pantry module (phone). Surfaces the items that need attention —
/// use-soon (expiring within 3 days / already past) and running-low — sorted soonest
/// first, with an "N on hand · M soon" header. Tapping opens the Pantry. Mirrors the
/// web `PantryCard`; gated by `sync.module(.pantry)` at the call site.
///
/// Reuses `PantryModel` so the "soon"/"low" logic + precomputed expiry days match the
/// list view exactly (no re-doing date math per render).
struct PantryTodayCard: View {
    @State private var model = PantryModel()
    var onOpen: () -> Void = {}
    private let cap = 5

    /// On-hand items that need attention: use-soon first (by expiry), then the merely
    /// running-low, de-duped. Falls back to nothing when the pantry's all fresh.
    private var attention: [WaffledAPI.PantryItem] {
        let soon = model.onHand.filter { model.isSoon($0) }
            .sorted { (model.days($0) ?? .max) < (model.days($1) ?? .max) }
        let low = model.onHand.filter { model.isLow($0) && !model.isSoon($0) }
            .sorted { $0.name < $1.name }
        return soon + low
    }

    var body: some View {
        Group {
            // Household turned the Pantry Today card off (Settings → Pantry) — hide it,
            // matching the web. `showOnToday` defaults true, so nothing flashes off.
            if model.loaded && !model.showOnToday {
                EmptyView()
            } else {
                card
            }
        }
        .task { await model.load() }
    }

    private var card: some View {
        Button(action: onOpen) {
            WaffledCard(padding: 15) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("🥫 Pantry").font(.system(size: 12.5, weight: .bold)).foregroundStyle(NK.ink2)
                        Spacer()
                        Text(headerCount).font(.system(size: 12)).foregroundStyle(NK.ink3)
                        Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink3)
                    }
                    if !model.loaded {
                        Text("Loading…").font(.system(size: 13)).foregroundStyle(NK.ink3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else if model.onHand.isEmpty {
                        Text("Nothing logged yet — add what’s on hand ›")
                            .font(.system(size: 13)).foregroundStyle(NK.ink3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else if attention.isEmpty {
                        Text("All fresh — nothing to use up soon.")
                            .font(.system(size: 13)).foregroundStyle(NK.ink3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        ForEach(attention.prefix(cap)) { row($0) }
                        if attention.count > cap {
                            Text("+\(attention.count - cap) more")
                                .font(.system(size: 11, weight: .semibold)).foregroundStyle(NK.ink3)
                        }
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }

    private var headerCount: String {
        let onHand = model.onHand.count
        let soon = model.onHand.filter { model.isSoon($0) }.count
        return soon > 0 ? "\(onHand) on hand · \(soon) soon" : "\(onHand) on hand"
    }

    private func row(_ item: WaffledAPI.PantryItem) -> some View {
        HStack(spacing: 10) {
            Text(PantryFood.emoji(for: item.name)).font(.system(size: 17))
                .frame(width: 32, height: 32)
                .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(item.name).font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                if let sub = qtyLabel(item) {
                    Text(sub).font(.system(size: 11)).foregroundStyle(NK.ink3)
                }
            }
            Spacer(minLength: 6)
            statusTag(item)
        }
    }

    private func qtyLabel(_ item: WaffledAPI.PantryItem) -> String? {
        let parts = [item.amount, item.unit].map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    /// The right-side tag: an expiry pill when use-soon, else a "Low" pill.
    @ViewBuilder private func statusTag(_ item: WaffledAPI.PantryItem) -> some View {
        if model.isSoon(item), let d = model.days(item) {
            Text(expiryText(d))
                .font(.system(size: 12, weight: .bold)).foregroundStyle(Color(hex: 0xB8860B))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Color(hex: 0xFBF0D5)).clipShape(Capsule())
        } else {
            Text("Low")
                .font(.system(size: 12, weight: .bold)).foregroundStyle(NK.primaryD)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(NK.primaryD.opacity(0.12)).clipShape(Capsule())
        }
    }

    private func expiryText(_ d: Int) -> String {
        if d < 0 { return "Expired" }
        if d == 0 { return "Today" }
        return "\(d) day\(d == 1 ? "" : "s")"
    }
}
