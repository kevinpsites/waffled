import SwiftUI

/// The Phase 1 de-risk made visible: PowerSync connection state, what's mirrored
/// in local SQLite, the pending-upload queue, and a button to make an offline
/// write. Reached from the cloud icon on the Family hub.
///
/// Airplane-mode demo: stop the backend (`docker compose stop api powersync`) →
/// status flips to "offline" but the member list still renders from SQLite →
/// "Add offline test event" queues a write (pending → 1) → restart the backend →
/// pending drains to 0 and the event count ticks up. Read + write + reconnect.
struct SyncStatusView: View {
    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss
    @State private var token = AppConfig.devToken
    @State private var baseURL = AppConfig.apiBaseURL

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    statusCard
                    statsRow
                    Button(action: { Task { await sync.addTestEvent() } }) {
                        Label("Add offline test event", systemImage: "plus.circle.fill")
                            .font(.system(size: 15, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 13)
                            .background(NK.primary).foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    }
                    .buttonStyle(.plain)

                    membersCard
                    connectionCard
                    if let err = sync.lastError {
                        Text(err).font(.system(size: 12)).foregroundStyle(.red).textSelection(.enabled)
                    }
                }
                .padding(18)
            }
            .background(NK.canvas)
            .navigationTitle("Sync")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
    }

    private var statusCard: some View {
        WaffledCard {
            HStack(spacing: 12) {
                Circle().fill(statusColor).frame(width: 12, height: 12)
                VStack(alignment: .leading, spacing: 2) {
                    Text(sync.status.rawValue.capitalized)
                        .font(.system(size: 17, weight: .bold)).foregroundStyle(NK.ink)
                    Text(lastSyncedText).font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                }
                Spacer()
                if sync.pendingUploads > 0 {
                    Text("↑ \(sync.pendingUploads)")
                        .font(.system(size: 13, weight: .bold)).foregroundStyle(NK.gold)
                }
            }
        }
    }

    private var statsRow: some View {
        HStack(spacing: 12) {
            stat("Persons", sync.personCount, "person.2.fill")
            stat("Events", sync.eventCount, "calendar")
            stat("Pending", sync.pendingUploads, "arrow.up.circle")
        }
    }

    private func stat(_ label: String, _ value: Int, _ icon: String) -> some View {
        WaffledCard(padding: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Image(systemName: icon).font(.system(size: 14)).foregroundStyle(NK.ink3)
                Text("\(value)").font(.system(size: 24, weight: .bold)).foregroundStyle(NK.ink)
                Text(label).font(.system(size: 12)).foregroundStyle(NK.ink3)
            }
        }
    }

    private var membersCard: some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Family · from local SQLite")
                if sync.members.isEmpty {
                    Text("No members synced yet.").font(.system(size: 13)).foregroundStyle(NK.ink3)
                } else {
                    ForEach(sync.members) { m in
                        HStack(spacing: 10) {
                            Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 30)
                            Text(m.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                            Spacer()
                            if let t = m.memberType {
                                Text(t).font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink3)
                            }
                        }
                    }
                }
            }
        }
    }

    private var connectionCard: some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Connection")
                field("API URL", text: $baseURL)
                field("Dev token", text: $token, secure: true)
                Button {
                    AppConfig.setApiBaseURL(baseURL)
                    AppConfig.setDevToken(token)
                    Task { await sync.reconnect() }
                } label: {
                    Text("Save & reconnect")
                        .font(.system(size: 14, weight: .semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 11)
                        .background(NK.panel).foregroundStyle(NK.ink)
                        .clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private func field(_ label: String, text: Binding<String>, secure: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink2)
            Group {
                if secure { SecureField("", text: text) } else { TextField("", text: text) }
            }
            .font(.system(size: 13, design: .monospaced))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .padding(10).background(NK.panel)
            .clipShape(RoundedRectangle(cornerRadius: NK.rXS, style: .continuous))
        }
    }

    private var statusColor: Color {
        switch sync.status {
        case .connected: return FamilyColor.wally.solid
        case .connecting: return NK.gold
        case .offline, .idle: return NK.ink3
        }
    }

    private var lastSyncedText: String {
        guard let at = sync.lastSyncedAt else { return "Not yet synced" }
        let f = RelativeDateTimeFormatter()
        return "Last synced \(f.localizedString(for: at, relativeTo: Date()))"
    }
}
