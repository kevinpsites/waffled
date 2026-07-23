import SwiftUI

/// Today card for the Pantry module (phone). Surfaces the items that need attention —
/// use-soon (expiring within 3 days / already past) and running-low — sorted soonest
/// first, with an "N on hand · M soon" header. Tapping opens the Pantry. Mirrors the
/// web `PantryCard`; gated by `sync.module(.pantry)` at the call site.
///
/// Reuses `PantryModel` so the "soon"/"low" logic + precomputed expiry days match the
/// list view exactly (no re-doing date math per render).
struct PantryTodayCard: View {
    var kiosk = false
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
            Group { if kiosk { KioskCard { cardBody } } else { WaffledCard(padding: 15) { cardBody } } }
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private var cardBody: some View {
        VStack(alignment: .leading, spacing: kiosk ? 12 : 10) {
            HStack(spacing: 8) {
                Text("🥫 Pantry")
                    .font(kiosk ? .system(size: 16, weight: .heavy) : .system(size: 12.5, weight: .bold))
                    .foregroundStyle(kiosk ? WF.ink : WF.ink2)
                Spacer(minLength: 6)
                Text(headerCount).font(.system(size: kiosk ? 13 : 12)).foregroundStyle(WF.ink3)
                Image(systemName: "chevron.right").font(.system(size: kiosk ? 13 : 12, weight: kiosk ? .bold : .semibold)).foregroundStyle(WF.ink3)
            }
            if !model.loaded {
                emptyLine("Loading…")
            } else if model.onHand.isEmpty {
                emptyLine("Nothing logged yet — add what’s on hand\(kiosk ? "." : " ›")")
            } else if attention.isEmpty {
                emptyLine("All fresh — nothing to use up soon.")
            } else {
                ForEach(attention.prefix(cap)) { row($0) }
                if attention.count > cap {
                    Text("+\(attention.count - cap) more")
                        .font(.system(size: kiosk ? 13 : 11, weight: .semibold)).foregroundStyle(WF.ink3)
                }
            }
        }
    }

    private func emptyLine(_ text: String) -> some View {
        Text(text).font(.system(size: kiosk ? 15 : 13)).foregroundStyle(WF.ink3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, kiosk ? 4 : 0)
    }

    private var headerCount: String {
        let onHand = model.onHand.count
        let soon = model.onHand.filter { model.isSoon($0) }.count
        return soon > 0 ? "\(onHand) on hand · \(soon) soon" : "\(onHand) on hand"
    }

    private func row(_ item: WaffledAPI.PantryItem) -> some View {
        HStack(spacing: kiosk ? 12 : 10) {
            if kiosk {
                Text(PantryFood.emoji(for: item.name)).font(.system(size: 22))
            } else {
                Text(PantryFood.emoji(for: item.name)).font(.system(size: 17))
                    .frame(width: 32, height: 32)
                    .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(item.name).font(.system(size: kiosk ? 18 : 14, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                if let sub = qtyLabel(item) {
                    Text(sub).font(.system(size: kiosk ? 13 : 11)).foregroundStyle(WF.ink3)
                }
            }
            Spacer(minLength: kiosk ? 8 : 6)
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
                .font(.system(size: kiosk ? 14 : 12, weight: .bold)).foregroundStyle(WF.warn)
                .padding(.horizontal, kiosk ? 9 : 8).padding(.vertical, 3)
                .background(WF.warnT).clipShape(Capsule())
        } else {
            Text("Low")
                .font(.system(size: kiosk ? 14 : 12, weight: .bold)).foregroundStyle(WF.primaryD)
                .padding(.horizontal, kiosk ? 9 : 8).padding(.vertical, 3)
                .background(WF.primaryD.opacity(0.12)).clipShape(Capsule())
        }
    }

    private func expiryText(_ d: Int) -> String {
        if d < 0 { return "Expired" }
        if d == 0 { return "Today" }
        return "\(d) day\(d == 1 ? "" : "s")"
    }
}
