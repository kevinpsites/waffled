import SwiftUI

/// The five surfaces of the phone app, mirroring the handoff tab bar:
/// Today · Calendar · (✨ capture) · Meals · Family.
enum Tab: Hashable {
    case today, calendar, meals, family
}

/// Root navigation: the current screen filling the canvas, with a custom bottom
/// tab bar whose raised center button opens the AI capture sheet.
struct AppRoot: View {
    @State private var tab: Tab = .today
    @State private var showCapture = false

    var body: some View {
        ZStack(alignment: .bottom) {
            NK.canvas.ignoresSafeArea()

            // Active screen. Each tab keeps its own NavigationStack later; for the
            // scaffold they're simple views.
            Group {
                switch tab {
                case .today:    TodayView()
                case .calendar: CalendarView()
                case .meals:    MealsView()
                case .family:   FamilyView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            NookTabBar(tab: $tab, onCapture: { showCapture = true })
        }
        .sheet(isPresented: $showCapture) {
            CaptureSheet()
                .presentationDragIndicator(.visible)
        }
    }
}

/// Custom bottom bar — stock `TabView` can't do the raised center FAB the design
/// calls for, so we draw our own and overlay the floating capture button.
struct NookTabBar: View {
    @Binding var tab: Tab
    var onCapture: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            item(.today, "house.fill", "Today")
            item(.calendar, "calendar", "Calendar")
            captureButton
            item(.meals, "fork.knife", "Meals")
            item(.family, "checklist", "Family")
        }
        .padding(.horizontal, 8)
        .padding(.top, 10)
        .background(
            NK.card
                .overlay(NK.hair.frame(height: 1), alignment: .top)
                .ignoresSafeArea(edges: .bottom)
        )
    }

    private func item(_ t: Tab, _ icon: String, _ label: String) -> some View {
        let on = tab == t
        return Button {
            tab = t
        } label: {
            VStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 20))
                Text(label).font(.system(size: 10.5, weight: .semibold))
            }
            .foregroundStyle(on ? NK.primary : NK.ink3)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
    }

    private var captureButton: some View {
        Button(action: onCapture) {
            ZStack {
                Circle().fill(NK.primary)
                Image(systemName: "sparkles")
                    .font(.system(size: 24, weight: .bold))
                    .foregroundStyle(.white)
            }
            .frame(width: 54, height: 54)
            .nkShadow3()
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .offset(y: -18)
    }
}

#Preview {
    AppRoot().tint(NK.primary)
}
