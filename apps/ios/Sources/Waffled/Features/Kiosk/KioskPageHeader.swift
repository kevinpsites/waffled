import SwiftUI

/// A title + subtitle page header for iPad pages (matches the Family page's polish),
/// with an optional trailing action. Draw it at the top of a page's content and hide
/// the nav bar so the title isn't duplicated. Used by the header-less rail pages
/// (Chores, Goals, Rewards). See `apps/ios/IPAD_ROADMAP.md`.
struct KioskPageHeader<Trailing: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder var trailing: () -> Trailing

    init(_ title: String, _ subtitle: String, @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }) {
        self.title = title
        self.subtitle = subtitle
        self.trailing = trailing
    }

    var body: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(WF.serif(34)).foregroundStyle(WF.ink)
                Text(subtitle).font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3)
            }
            Spacer(minLength: 12)
            trailing()
        }
    }
}

/// A coral pill action button for a page header's trailing slot.
struct KioskHeaderButton: View {
    let icon: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 14, weight: .bold))
                Text(label).font(.system(size: 15, weight: .bold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(WF.primary).clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}
