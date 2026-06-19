import SwiftUI
import AuthenticationServices

/// Drives the Google-calendar OAuth consent in a system web session and resolves
/// when the server redirects back to the `nook://` callback.
@MainActor
final class OAuthLauncher: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func start(url: URL, scheme: String) async -> Bool {
        await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { callback, _ in
                cont.resume(returning: callback != nil)
            }
            s.presentationContextProvider = self
            session = s
            s.start()
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scene = UIApplication.shared.connectedScenes.first { $0 is UIWindowScene } as? UIWindowScene
        return scene?.keyWindow ?? ASPresentationAnchor()
    }
}

/// Settings → Calendars: connect Google accounts, pick which calendars sync and who
/// each belongs to, set the write-target, and run a manual sync. Mirrors the web
/// CalendarsPanel.
struct CalendarsSettingsView: View {
    @Environment(SyncManager.self) private var sync
    @State private var status: NookAPI.CalendarStatus?
    @State private var loading = true
    @State private var syncing = false
    @State private var connecting = false
    @State private var message: String?
    @State private var launcher = OAuthLauncher()

    private let api = NookAPI()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let status {
                    if !status.configured {
                        notice("Google Calendar isn’t set up on this server yet.")
                    } else if !status.connected {
                        connectCard
                    } else {
                        if let m = message {
                            Text(m).font(.system(size: 13, weight: .medium)).foregroundStyle(NK.ink2)
                                .padding(.horizontal, 12).padding(.vertical, 9)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
                        }
                        ForEach(status.accounts) { acct in accountCard(acct) }
                        connectMore
                    }
                } else if loading {
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 40)
                }
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle("Calendars").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    // MARK: connect

    private var connectCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Connect a Google account").font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ink)
            Text("Bring your family’s Google calendars into Nook — you’ll pick which ones sync and who each belongs to.")
                .font(.system(size: 13)).foregroundStyle(NK.ink3).fixedSize(horizontal: false, vertical: true)
            connectButton
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    private var connectMore: some View { connectButton }

    private var connectButton: some View {
        Button { Task { await connect() } } label: {
            HStack(spacing: 7) {
                Image(systemName: "link").font(.system(size: 13, weight: .bold))
                Text(connecting ? "Connecting…" : "Connect Google Calendar").font(.system(size: 14, weight: .bold))
            }
            .foregroundStyle(.white).frame(maxWidth: .infinity).padding(.vertical, 12)
            .background(NK.primary).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        }
        .buttonStyle(.plain).disabled(connecting)
    }

    // MARK: an account

    private func accountCard(_ acct: NookAPI.CalendarStatus.Account) -> some View {
        let cals = status?.calendars.filter { $0.accountId == acct.id } ?? []
        let synced = cals.filter(\.selected).count
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "person.crop.circle").font(.system(size: 18)).foregroundStyle(NK.ai)
                VStack(alignment: .leading, spacing: 1) {
                    Text(acct.email ?? "Google account").font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink).lineLimit(1)
                    Text("\(synced) of \(cals.count) syncing").font(.system(size: 12)).foregroundStyle(NK.ink3)
                }
                Spacer(minLength: 0)
                Button { Task { await syncNow() } } label: {
                    HStack(spacing: 5) {
                        if syncing { ProgressView().controlSize(.mini) }
                        else { Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 12, weight: .bold)) }
                        Text(syncing ? "Syncing…" : "Sync now").font(.system(size: 12, weight: .bold))
                    }
                    .foregroundStyle(NK.ai)
                }
                .buttonStyle(.plain).disabled(syncing)
            }

            VStack(spacing: 8) {
                ForEach(cals) { c in calendarRow(c) }
            }

            Button(role: .destructive) { Task { await disconnect(acct.id) } } label: {
                Text("Disconnect account").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
            }
            .buttonStyle(.plain)
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    // MARK: a calendar

    private func calendarRow(_ c: NookAPI.CalendarStatus.Cal) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 9) {
                Circle().fill(Color(hexString: c.colorHex) ?? NK.ink3).frame(width: 10, height: 10)
                Text(c.summary ?? "Calendar").font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                if c.isPrimary { miniTag("primary") }
                Spacer(minLength: 0)
                if c.isWritable && c.personId != nil {
                    Button { Task { await patch(c.id, ["isWriteTarget": .bool(!c.isWriteTarget)]) } } label: {
                        Image(systemName: c.isWriteTarget ? "star.fill" : "star")
                            .font(.system(size: 15)).foregroundStyle(c.isWriteTarget ? NK.gold : NK.ink3)
                    }
                    .buttonStyle(.plain)
                }
            }
            Text(statusLine(c)).font(.system(size: 11.5)).foregroundStyle(NK.ink3)
            HStack(spacing: 8) {
                // sync toggle
                Button { Task { await patch(c.id, ["selected": .bool(!c.selected)]) } } label: {
                    HStack(spacing: 5) {
                        Image(systemName: c.selected ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 14)).foregroundStyle(c.selected ? NK.primary : NK.ink3)
                        Text("Sync").font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink2)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6).background(NK.panel).clipShape(Capsule())
                }
                .buttonStyle(.plain)
                // person assign
                Menu {
                    Button("Unassigned") { Task { await patch(c.id, ["personId": .null]) } }
                    ForEach(sync.members) { m in
                        Button(m.name) { Task { await patch(c.id, ["personId": .string(m.id)]) } }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Text(c.personName ?? "Unassigned").font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(c.personName == nil ? NK.ink3 : NK.ink)
                        Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)).foregroundStyle(NK.ink3)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6).background(NK.panel).clipShape(Capsule())
                }
                Spacer(minLength: 0)
            }
        }
        .padding(11)
        .background(NK.card2).clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    private func miniTag(_ t: String) -> some View {
        Text(t).font(.system(size: 9.5, weight: .heavy)).tracking(0.4).foregroundStyle(NK.ink3)
            .padding(.horizontal, 6).padding(.vertical, 2).background(NK.panel).clipShape(Capsule())
    }

    private func statusLine(_ c: NookAPI.CalendarStatus.Cal) -> String {
        var parts: [String] = []
        parts.append(c.selected ? (c.lastSyncedAt.map { "Synced \(when($0))" } ?? "Will sync") : "Sync off")
        if let r = c.accessRole { parts.append(r) }
        if c.isWriteTarget { parts.append("★ new events go here") }
        return parts.joined(separator: " · ")
    }

    private func notice(_ t: String) -> some View {
        Text(t).font(.system(size: 14)).foregroundStyle(NK.ink3)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 20)
    }

    // MARK: actions

    private func load() async {
        status = try? await api.calendarStatus()
        loading = false
    }

    private func patch(_ id: String, _ body: [String: JSONValue]) async {
        try? await api.updateCalendarLink(id: id, body)
        await load()
    }

    private func disconnect(_ accountId: String) async {
        try? await api.disconnectCalendarAccount(id: accountId)
        await load()
    }

    private func syncNow() async {
        syncing = true; message = nil
        do {
            let r = try await api.syncCalendars()
            message = r.errors.isEmpty
                ? "Imported \(r.imported), updated \(r.updated), removed \(r.deleted)."
                : "Synced with \(r.errors.count) error(s): \(r.errors.first ?? "")"
        } catch {
            message = "Couldn’t sync — check your connection."
        }
        syncing = false
        await load()
    }

    private func connect() async {
        connecting = true; message = nil
        defer { connecting = false }
        do {
            let urlStr = try await api.connectCalendarURL(redirectTo: "nook://calendar-connected")
            guard let url = URL(string: urlStr) else { return }
            let ok = await launcher.start(url: url, scheme: "nook")
            if ok { await load() }
        } catch {
            message = "Couldn’t start the Google connection."
        }
    }

    /// "Jun 19, 2:48 PM" from an ISO timestamp.
    private func when(_ iso: String) -> String {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let d else { return "" }
        let out = DateFormatter(); out.dateFormat = "MMM d, h:mm a"; out.timeZone = sync.householdTz
        return out.string(from: d)
    }
}
