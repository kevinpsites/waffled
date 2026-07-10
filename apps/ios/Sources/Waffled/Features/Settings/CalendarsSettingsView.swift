import SwiftUI
import AuthenticationServices

/// Drives the Google-calendar OAuth consent in a system web session and resolves
/// when the server redirects back to the `waffled://` callback.
@MainActor
final class OAuthLauncher: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func start(url: URL, scheme: String) async -> Bool {
        await authorize(url: url, scheme: scheme) != nil
    }

    /// Run the web session and resolve with the full callback URL (or nil if the
    /// user cancelled) — callers that need a query param (e.g. an OIDC `code`) read it.
    func authorize(url: URL, scheme: String) async -> URL? {
        await withCheckedContinuation { (cont: CheckedContinuation<URL?, Never>) in
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { callback, _ in
                cont.resume(returning: callback)
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
    // ISO8601DateFormatter is expensive to build; these parsers are hit per calendar row.
    private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let isoPlain = ISO8601DateFormatter()

    @Environment(SyncManager.self) private var sync
    @State private var status: WaffledAPI.CalendarStatus?
    @State private var loading = true
    @State private var syncing = false
    @State private var connecting = false
    @State private var message: String?
    @State private var launcher = OAuthLauncher()
    // filters (web parity)
    @State private var hideReadOnly = true
    @State private var syncedOnly = false
    @State private var sleeps = false
    @State private var birthdayHorizon = 183   // days a member birthday stays hidden until it's close
    @State private var search = ""
    @State private var collapsed: Set<String> = []   // account ids

    private let api = WaffledAPI()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                countdownsSection
                if let status {
                    if !status.configured {
                        notice("Google Calendar isn’t set up on this server yet.")
                    } else if !status.connected {
                        connectCard
                    } else {
                        if let m = message {
                            Text(m).font(.system(size: 13, weight: .medium)).foregroundStyle(WF.ink2)
                                .padding(.horizontal, 12).padding(.vertical, 9)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                        }
                        filterControls
                        ForEach(status.accounts) { acct in accountCard(acct) }
                        connectMore
                    }
                } else if loading {
                    WaffledLoading(top: 40)
                }
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(WF.canvas)
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
        .task { if let r = try? await api.countdowns() { sleeps = r.sleeps; birthdayHorizon = r.birthdayHorizonDays } }
    }

    /// Friendly presets for the birthday-horizon window.
    private static let horizonOptions: [(label: String, days: Int)] =
        [("1 month", 31), ("3 months", 92), ("6 months", 183), ("1 year", 366)]
    private var horizonLabel: String {
        Self.horizonOptions.min(by: { abs($0.days - birthdayHorizon) < abs($1.days - birthdayHorizon) })?.label ?? "6 months"
    }

    /// The household "N sleeps" vs "N days" wording toggle (mirrors the web Countdowns
    /// settings). Countdowns themselves are managed on the Today card + event editor.
    private var countdownsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("⏳ Countdowns").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink2)
            Button { toggleSleeps() } label: {
                HStack(spacing: 8) {
                    Image(systemName: sleeps ? "checkmark.square.fill" : "square")
                        .font(.system(size: 17)).foregroundStyle(sleeps ? WF.primary : WF.ink3)
                    Text("Count in “sleeps” instead of “days” (kid-friendly)")
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
                    Spacer(minLength: 0)
                }
            }.buttonStyle(.plain)

            Divider().background(WF.hair)
            HStack(spacing: 8) {
                Text("Show member birthdays within")
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
                Spacer(minLength: 0)
                Menu {
                    ForEach(Self.horizonOptions, id: \.days) { opt in
                        Button(opt.label) { setHorizon(opt.days) }
                    }
                } label: {
                    WaffledMenuPill(text: horizonLabel)
                }
            }
            Text("A birthday further out than this stays hidden until it’s close (keeps a year of family birthdays off the list).")
                .font(.system(size: 12)).foregroundStyle(WF.ink3)

            Text("Count down to trips, birthdays, and anything you flag on the calendar. Add one from the Today “Countdowns” card, or tick “Show a countdown” when editing an event.")
                .font(.system(size: 12)).foregroundStyle(WF.ink3)
        }
        .padding(14)
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    private func toggleSleeps() {
        sleeps.toggle()
        let v = sleeps
        Task { try? await api.setCountdownSleeps(v) }
    }

    private func setHorizon(_ days: Int) {
        birthdayHorizon = days
        Task { try? await api.setCountdownBirthdayHorizon(days) }
    }

    private var filterControls: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 13)).foregroundStyle(WF.ink3)
                TextField("Search calendars…", text: $search).font(.system(size: 14))
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
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
                    .font(.system(size: 15)).foregroundStyle(on.wrappedValue ? WF.primary : WF.ink3)
                Text(label).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
            }
        }
        .buttonStyle(.plain)
    }

    /// Stable A–Z order (case-insensitive), with the primary calendar pinned first.
    private func sortedCals(_ cals: [WaffledAPI.CalendarStatus.Cal]) -> [WaffledAPI.CalendarStatus.Cal] {
        cals.sorted { a, b in
            if a.isPrimary != b.isPrimary { return a.isPrimary }
            return (a.summary ?? "").localizedCaseInsensitiveCompare(b.summary ?? "") == .orderedAscending
        }
    }

    /// Apply search + synced-only + hide-read-only.
    private func filtered(_ cals: [WaffledAPI.CalendarStatus.Cal]) -> [WaffledAPI.CalendarStatus.Cal] {
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
            Text("Connect a Google account").font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink)
            Text("Bring your family’s Google calendars into Waffled — you’ll pick which ones sync and who each belongs to.")
                .font(.system(size: 13)).foregroundStyle(WF.ink3).fixedSize(horizontal: false, vertical: true)
            connectButton
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    private var connectMore: some View { connectButton }

    private var connectButton: some View {
        Button { Task { await connect() } } label: {
            HStack(spacing: 7) {
                Image(systemName: "link").font(.system(size: 13, weight: .bold))
                Text(connecting ? "Connecting…" : "Connect Google Calendar").font(.system(size: 14, weight: .bold))
            }
            .foregroundStyle(.white).frame(maxWidth: .infinity).padding(.vertical, 12)
            .background(WF.primary).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        }
        .buttonStyle(.plain).disabled(connecting)
    }

    // MARK: an account

    private func accountCard(_ acct: WaffledAPI.CalendarStatus.Account) -> some View {
        let all = sortedCals(status?.calendars.filter { $0.accountId == acct.id } ?? [])
        let shown = filtered(all)
        let synced = all.filter(\.selected).count
        let isCollapsed = collapsed.contains(acct.id)
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "link").font(.system(size: 15)).foregroundStyle(WF.ai)
                    .frame(width: 30, height: 30).background(WF.panel).clipShape(Circle())
                VStack(alignment: .leading, spacing: 1) {
                    Text(acct.email ?? "Google account").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink).lineLimit(1)
                    Text("\(synced) of \(all.count) syncing · connected \(shortDay(acct.connectedAt))")
                        .font(.system(size: 12)).foregroundStyle(WF.ink3)
                }
                Spacer(minLength: 0)
                Button(role: .destructive) { Task { await disconnect(acct.id) } } label: {
                    Text("Disconnect").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink2)
                        .padding(.horizontal, 11).padding(.vertical, 6).background(WF.panel).clipShape(Capsule())
                }
                .buttonStyle(.plain)
                Button { toggleCollapse(acct.id) } label: {
                    Image(systemName: isCollapsed ? "chevron.down" : "chevron.up")
                        .font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink3).frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
            }

            if !isCollapsed {
                HStack(spacing: 14) {
                    Button("Sync all") { Task { await setAllSync(acct.id, true) } }
                        .font(.system(size: 12, weight: .bold)).tint(WF.ai)
                    Text("·").foregroundStyle(WF.ink3)
                    Button("Sync none") { Task { await setAllSync(acct.id, false) } }
                        .font(.system(size: 12, weight: .bold)).tint(WF.ai)
                    Spacer()
                }
                VStack(spacing: 8) {
                    ForEach(shown) { c in calendarRow(c) }
                    if shown.isEmpty {
                        Text("No calendars match.").font(.system(size: 12)).foregroundStyle(WF.ink3)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6)
                    }
                }
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
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
        guard let d = Self.isoFrac.date(from: iso) ?? Self.isoPlain.date(from: iso) else { return "" }
        return DateFmt.string(d, "MMM d", sync.householdTz)
    }

    // MARK: a calendar

    private func calendarRow(_ c: WaffledAPI.CalendarStatus.Cal) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 9) {
                Circle().fill(Color(hexString: c.colorHex) ?? WF.ink3).frame(width: 10, height: 10)
                Text(c.summary ?? "Calendar").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                if c.isPrimary { miniTag("primary") }
                Spacer(minLength: 0)
                if c.isWritable && c.personId != nil {
                    Button { Task { await patch(c.id, ["isWriteTarget": .bool(!c.isWriteTarget)]) } } label: {
                        Image(systemName: c.isWriteTarget ? "star.fill" : "star")
                            .font(.system(size: 15)).foregroundStyle(c.isWriteTarget ? WF.gold : WF.ink3)
                    }
                    .buttonStyle(.plain)
                }
            }
            Text(statusLine(c)).font(.system(size: 11.5)).foregroundStyle(WF.ink3)
            HStack(spacing: 8) {
                // sync toggle
                Button { Task { await patch(c.id, ["selected": .bool(!c.selected)]) } } label: {
                    HStack(spacing: 5) {
                        Image(systemName: c.selected ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 14)).foregroundStyle(c.selected ? WF.primary : WF.ink3)
                        Text("Sync").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink2)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6).background(WF.panel).clipShape(Capsule())
                }
                .buttonStyle(.plain)
                // Private (owner-only) vs family (shared kiosk) — only meaningful when synced.
                // Checked = private; unchecked = visible to the whole family.
                if c.selected {
                    Button { Task { await patch(c.id, ["visibility": .string(c.visibility == "personal" ? "family" : "personal")]) } } label: {
                        HStack(spacing: 5) {
                            Image(systemName: c.visibility == "personal" ? "checkmark.circle.fill" : "circle")
                                .font(.system(size: 14)).foregroundStyle(c.visibility == "personal" ? WF.primary : WF.ink3)
                            Text("Private").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink2)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 6).background(WF.panel).clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
                // person assign
                Menu {
                    Button("Unassigned") { Task { await patch(c.id, ["personId": .null]) } }
                    ForEach(sync.members) { m in
                        Button(m.name) { Task { await patch(c.id, ["personId": .string(m.id)]) } }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Text(c.personName ?? "Unassigned").font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(c.personName == nil ? WF.ink3 : WF.ink)
                        Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)).foregroundStyle(WF.ink3)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6).background(WF.panel).clipShape(Capsule())
                }
                Spacer(minLength: 0)
            }
        }
        .padding(11)
        .background(WF.card2).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    private func miniTag(_ t: String) -> some View {
        Text(t).font(.system(size: 9.5, weight: .heavy)).tracking(0.4).foregroundStyle(WF.ink3)
            .padding(.horizontal, 6).padding(.vertical, 2).background(WF.panel).clipShape(Capsule())
    }

    private func statusLine(_ c: WaffledAPI.CalendarStatus.Cal) -> String {
        var parts: [String] = []
        parts.append(c.selected ? (c.lastSyncedAt.map { "Synced \(when($0))" } ?? "Will sync") : "Sync off")
        if let r = c.accessRole { parts.append(r) }
        if c.selected { parts.append(c.visibility == "personal" ? "🔒 Private (only you)" : "👪 Family viewable") }
        if c.isWriteTarget { parts.append("★ new events go here") }
        return parts.joined(separator: " · ")
    }

    private func notice(_ t: String) -> some View {
        Text(t).font(.system(size: 14)).foregroundStyle(WF.ink3)
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
            let urlStr = try await api.connectCalendarURL(redirectTo: "waffled://calendar-connected")
            guard let url = URL(string: urlStr) else { return }
            let ok = await launcher.start(url: url, scheme: "waffled")
            if ok { await load() }
        } catch {
            message = "Couldn’t start the Google connection."
        }
    }

    /// "Jun 19, 2:48 PM" from an ISO timestamp.
    private func when(_ iso: String) -> String {
        let d = Self.isoFrac.date(from: iso) ?? Self.isoPlain.date(from: iso)
        guard let d else { return "" }
        return DateFmt.string(d, "MMM d, h:mm a", sync.householdTz)
    }
}
