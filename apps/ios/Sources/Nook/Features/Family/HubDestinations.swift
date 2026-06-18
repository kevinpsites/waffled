import SwiftUI

/// The launcher tiles on the Family hub. Each pushes a destination in the Family
/// tab's NavigationStack — Lists is built out; the rest are live-summary
/// placeholders until their screens land.
enum HubRoute: Hashable {
    case chores, goals, rewards, lists, photos, settings
    case list(NookAPI.ListSummary)   // a specific list pushed from the Lists index
    case goal(NookAPI.Goal)          // a specific goal pushed from the Goals screen
    case person(String)              // a person spotlight pushed from the people row
    case recipe(NookAPI.RecipeSummary) // a recipe opened from the grocery meal recap
}

/// A consistent "screen coming soon" destination that still surfaces the tile's
/// real summary line, so the hub never navigates into a dead end.
struct HubPlaceholder: View {
    let emoji: String
    let title: String
    let summary: String

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Text(emoji)
                    .font(.system(size: 52))
                    .frame(width: 96, height: 96)
                    .background(NK.panel)
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                    .padding(.top, 28)
                Text(summary)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(NK.ink2)
                    .multilineTextAlignment(.center)
                Text("This screen is coming soon.")
                    .font(.system(size: 13))
                    .foregroundStyle(NK.ink3)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
            .padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}
