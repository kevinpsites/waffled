import SwiftUI

/// Calendar tab — placeholder for Phase 0. The real agenda/month grid arrives
/// once events sync (Phase 1+, mirroring the kiosk Calendar).
struct CalendarView: View {
    var body: some View {
        TabPlaceholder(icon: "calendar", title: "Calendar",
                       note: "Agenda & month view land once events sync.")
    }
}

/// Shared empty-state for not-yet-built tabs — keeps the scaffold honest about
/// what's real vs. stubbed.
struct TabPlaceholder: View {
    let icon: String
    let title: String
    let note: String
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 40, weight: .regular))
                .foregroundStyle(NK.ink3)
            Text(title).font(NK.serif(26)).foregroundStyle(NK.ink)
            Text(note)
                .font(.system(size: 14)).foregroundStyle(NK.ink2)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(NK.canvas)
    }
}
