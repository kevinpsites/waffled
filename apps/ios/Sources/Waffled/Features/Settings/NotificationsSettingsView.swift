import SwiftUI
import UIKit

/// Settings → Notifications (roadmap 6.7-ios). Drives the on-device event reminders
/// in `NotificationManager`. Everything here is local: no server, no APNs.
struct NotificationsSettingsView: View {
    @Environment(NotificationManager.self) private var notifications

    /// Lead-time choices (minutes before the event).
    private let leads: [(Int, String)] = [(0, "At start"), (5, "5 min"), (15, "15 min"), (30, "30 min"), (60, "1 hour")]
    /// All-day reminder hour choices.
    private let hours = [6, 7, 8, 9, 10, 12, 18]

    private var blocked: Bool {
        notifications.enabled && (notifications.authorization == .denied)
    }

    var body: some View {
        @Bindable var n = notifications
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                intro

                card {
                    Toggle(isOn: $n.enabled) {
                        rowLabel("Event reminders", "Get a heads-up before your calendar events")
                    }
                    .tint(WF.primary)
                    .padding(.vertical, 14)
                }

                if blocked { permissionNotice }

                if notifications.enabled {
                    settingsCard(n: $n)
                    footnote
                }
            }
            .padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 110)
        }
        .background(WF.canvas)
        .navigationTitle("Notifications").navigationBarTitleDisplayMode(.inline)
        .task { await notifications.refreshAuthorization() }
        // Turning reminders on for the first time prompts for permission.
        .onChange(of: notifications.enabled) { _, on in
            if on { Task { await notifications.requestAuthorization() } }
        }
    }

    private var intro: some View {
        Text("Reminders are scheduled **on this device** from your synced calendar, so they work offline. They don't send anything to a server.")
            .font(.system(size: 13)).foregroundStyle(WF.ink2)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func settingsCard(n: Bindable<NotificationManager>) -> some View {
        card {
            VStack(spacing: 0) {
                menuRow("Remind me", value: leads.first { $0.0 == notifications.leadMinutes }?.1 ?? "15 min") {
                    ForEach(leads, id: \.0) { lead in
                        Button(lead.1) { n.wrappedValue.leadMinutes = lead.0 }
                    }
                }
                divider
                menuRow("All-day events at", value: hourLabel(notifications.allDayHour)) {
                    ForEach(hours, id: \.self) { h in
                        Button(hourLabel(h)) { n.wrappedValue.allDayHour = h }
                    }
                }
                divider
                menuRow("Which events", value: notifications.myEventsOnly ? "My events only" : "Everyone’s") {
                    Button("My events only") { n.wrappedValue.myEventsOnly = true }
                    Button("Everyone’s") { n.wrappedValue.myEventsOnly = false }
                }
            }
        }
    }

    private var footnote: some View {
        Text("Reminders cover your upcoming events. Recurring events and chore reminders are coming separately.")
            .font(.system(size: 12)).foregroundStyle(WF.ink3)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var permissionNotice: some View {
        card {
            VStack(alignment: .leading, spacing: 10) {
                rowLabel("Notifications are turned off", "Allow Waffled to send notifications in iOS Settings to get reminders.")
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                } label: {
                    Text("Open Settings").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.primary)
                }
                .buttonStyle(.plain)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 16)
        }
    }

    // MARK: building blocks

    private func rowLabel(_ title: String, _ sub: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
            Text(sub).font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func menuRow<Content: View>(_ title: String, value: String, @ViewBuilder menu: () -> Content) -> some View {
        Menu {
            menu()
        } label: {
            HStack {
                Text(title).font(.system(size: 15, weight: .medium)).foregroundStyle(WF.ink)
                Spacer(minLength: 8)
                WaffledSettingsMenuLabel(value: value)
            }
            .padding(.vertical, 15)
        }
    }

    private var divider: some View { Rectangle().fill(WF.hair).frame(height: 1) }

    @ViewBuilder
    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .padding(.horizontal, 18)
            .background(WF.card)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    private func hourLabel(_ h: Int) -> String {
        var c = DateComponents(); c.hour = h
        guard let date = Cal.current.date(from: c) else { return "\(h):00" }
        return DateFmt.string(date, "h a", TimeZone.current)
    }
}
