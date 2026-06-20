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
    // filters (web parity)
    @State private var hideReadOnly = true
    @State private var syncedOnly = false
    @State private var search = ""
    @State private var collapsed: Set<String> = []   // account ids

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
                        filterControls
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
        .toolbar {
            if status?.connected == true {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await syncNow() } } label: {
                        if syncing { ProgressView().controlSize(.small) }
                        else { Text("Sync now").font(.system(size: 15, weight: .semibold)) }
                    }
                    .disabled(syncing)
                }
            }
        }
        .task { await load() }
    }

    private var filterControls: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 13)).foregroundStyle(NK.ink3)
                TextField("Search calendars…", text: $search).font(.system(size: 14))
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
            HStack(spacing: 18) {
                checkToggle("Synced only", $syncedOnly)
                checkToggle("Hide read-only", $hideReadOnly)
                Spacer()
            }
        }
    }

    private func checkToggle(_ label: String, _ on: Binding<Bool>) -> some View {
        Button { on.wrappedValue.toggle() } label: {
            HStack(spacing: 6) {
                Image(systemName: on.wrappedValue ? "checkmark.square.fill" : "square")
                    .font(.system(size: 15)).foregroundStyle(on.wrappedValue ? NK.primary : NK.ink3)
                Text(label).font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink2)
            }
        }
        .buttonStyle(.plain)
    }

    /// Stable A–Z order (case-insensitive), with the primary calendar pinned first.
    private func sortedCals(_ cals: [NookAPI.CalendarStatus.Cal]) -> [NookAPI.CalendarStatus.Cal] {
        cals.sorted { a, b in
            if a.isPrimary != b.isPrimary { return a.isPrimary }
            return (a.summary ?? "").localizedCaseInsensitiveCompare(b.summary ?? "") == .orderedAscending
        }
    }

    /// Apply search + synced-only + hide-read-only.
    private func filtered(_ cals: [NookAPI.CalendarStatus.Cal]) -> [NookAPI.CalendarStatus.Cal] {
        cals.filter { c in
            if syncedOnly && !c.selected { return false }
            if hideReadOnly && !c.selected && !c.isWritable { return false }
            if !search.isEmpty && !(c.summary ?? "").localizedCaseInsensitiveContains(search) { return false }
            return true
        }
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
        let all = sortedCals(status?.calendars.filter { $0.accountId == acct.id } ?? [])
        let shown = filtered(all)
        let synced = all.filter(\.selected).count
        let isCollapsed = collapsed.contains(acct.id)
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "link").font(.system(size: 15)).foregroundStyle(NK.ai)
                    .frame(width: 30, height: 30).background(NK.panel).clipShape(Circle())
                VStack(alignment: .leading, spacing: 1) {
                    Text(acct.email ?? "Google account").font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink).lineLimit(1)
                    Text("\(synced) of \(all.count) syncing · connected \(shortDay(acct.connectedAt))")
                        .font(.system(size: 12)).foregroundStyle(NK.ink3)
                }
                Spacer(minLength: 0)
                Button(role: .destructive) { Task { await disconnect(acct.id) } } label: {
                    Text("Disconnect").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink2)
                        .padding(.horizontal, 11).padding(.vertical, 6).background(NK.panel).clipShape(Capsule())
                }
                .buttonStyle(.plain)
                Button { toggleCollapse(acct.id) } label: {
                    Image(systemName: isCollapsed ? "chevron.down" : "chevron.up")
                        .font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink3).frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
            }

            if !isCollapsed {
                HStack(spacing: 14) {
                    Button("Sync all") { Task { await setAllSync(acct.id, true) } }
                        .font(.system(size: 12, weight: .bold)).tint(NK.ai)
                    Text("·").foregroundStyle(NK.ink3)
                    Button("Sync none") { Task { await setAllSync(acct.id, false) } }
                        .font(.system(size: 12, weight: .bold)).tint(NK.ai)
                    Spacer()
                }
                VStack(spacing: 8) {
                    ForEach(shown) { c in calendarRow(c) }
                    if shown.isEmpty {
                        Text("No calendars match.").font(.system(size: 12)).foregroundStyle(NK.ink3)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6)
                    }
                }
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    private func toggleCollapse(_ id: String) {
        if collapsed.contains(id) { collapsed.remove(id) } else { collapsed.insert(id) }
    }

    private func setAllSync(_ accountId: String, _ selected: Bool) async {
        let cals = status?.calendars.filter { $0.accountId == accountId && $0.selected != selected } ?? []
        for c in cals { try? await api.updateCalendarLink(id: c.id, ["selected": .bool(selected)]) }
        await load()
    }

    private func shortDay(_ iso: String) -> String {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "" }
        return DateFmt.string(d, "MMM d", sync.householdTz)
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
        return DateFmt.string(d, "MMM d, h:mm a", sync.householdTz)
    }
}
