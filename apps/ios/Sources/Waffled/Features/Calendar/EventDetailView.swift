import SwiftUI

/// The full-screen event detail (mirrors the web's /calendar/event/:id): a hero
/// with who/when, a details card (location → Directions, calendar + Google sync
/// state, repeats, participants, notes), a linked-goal chip, an AI insight card,
/// and a "where it falls today" timeline. Edit opens the existing editor; Delete
/// confirms then removes. The thin local mirror lacks most of these fields, so it
/// fetches GET /api/events/:id; the timeline reads the local same-day events.
struct EventDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(SyncManager.self) private var sync
    let event: SyncedEvent

    @State private var detail: WaffledAPI.EventDetailDTO?
    @State private var insight: WaffledAPI.EventInsight?
    @State private var loadingInsight = true
    @State private var editing = false
    @State private var confirmDelete = false
    /// The linked goal's emoji + title (when this event counts toward one).
    @State private var linkedGoal: (emoji: String?, title: String)?

    private var tz: TimeZone { sync.householdTz }
    /// The id to load full detail / insight / delete against. A recurring occurrence's
    /// row id (`event.id`) doesn't exist in the `events` table — its detail lives on the
    /// master, so we resolve through `seriesId` (mirrors the web's getLocalEvent). For a
    /// single event `seriesId == id`, so this is a no-op there.
    private var seriesId: String { event.seriesId ?? event.id }
    private var tint: Color { Color(hexString: detail?.personColor ?? event.colorHex ?? "") ?? WF.ink3 }
    private var title: String { detail?.title ?? event.title }
    private var start: Date? { parseISO(detail?.startsAt) ?? event.startsAt }
    private var end: Date? { parseISO(detail?.endsAt) ?? event.endsAt }
    private var allDay: Bool { detail?.allDay ?? event.allDay }

    var body: some View {
        NavigationStack {
            ScrollView {
                detailBody.padding(isKiosk ? 24 : 18).padding(.bottom, 40)
            }
            .background(WF.canvas)
            .navigationTitle("Event").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .primaryAction) { Button("Edit") { editing = true } }
            }
            .task { await load() }
            .sheet(isPresented: $editing, onDismiss: { Task { await load() } }) {
                EventEditSheet(event: event, initialDate: start ?? Date(),
                               prefillGoalId: detail?.goalId, prefillGoalStepId: detail?.goalStepId)
            }
        }
        .modifier(KioskSheetPresentation(kiosk: isKiosk))
    }

    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    /// Single column on iPhone; a wider two-column layout on the iPad (hero on top,
    /// then details/notes alongside insight/timeline) so the larger modal reads like
    /// the web event screen.
    @ViewBuilder private var detailBody: some View {
        if isKiosk {
            VStack(alignment: .leading, spacing: 16) {
                hero
                HStack(alignment: .top, spacing: 16) {
                    VStack(spacing: 14) {
                        if let gid = detail?.goalId, !gid.isEmpty { goalChip }
                        detailsCard
                        if let note = detail?.description, !note.isEmpty { notesCard(note) }
                    }
                    .frame(maxWidth: .infinity, alignment: .top)
                    VStack(spacing: 14) {
                        aiCard
                        timelineCard
                    }
                    .frame(maxWidth: .infinity, alignment: .top)
                }
                deleteButton
            }
        } else {
            VStack(alignment: .leading, spacing: 14) {
                hero
                if let gid = detail?.goalId, !gid.isEmpty { goalChip }
                detailsCard
                if let note = detail?.description, !note.isEmpty { notesCard(note) }
                aiCard
                timelineCard
                deleteButton
            }
        }
    }

    private var deleteButton: some View {
        Button {
            if confirmDelete { Task { _ = await sync.deleteEvent(id: seriesId); dismiss() } }
            else { withAnimation { confirmDelete = true } }
        } label: {
            Text(confirmDelete ? "Tap again to delete this event" : "Delete event")
                .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.primary)
                .frame(maxWidth: .infinity).padding(.vertical, 12)
        }
        .buttonStyle(.plain).padding(.top, 4)
    }

    // MARK: hero

    private var hero: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let name = detail?.personName ?? sync.members.first(where: { $0.id == event.personId })?.name {
                HStack(spacing: 6) {
                    Text(detail?.personEmoji ?? event.emoji ?? "🙂").font(.system(size: 13))
                    Text(name).font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                }
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(.white.opacity(0.22)).clipShape(Capsule())
            }
            Text(title).font(WF.serif(28)).foregroundStyle(.white).fixedSize(horizontal: false, vertical: true)
            Text(timeLine).font(.system(size: 22, weight: .heavy)).foregroundStyle(.white)
            Text(dateLine).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white.opacity(0.9))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(LinearGradient(colors: [tint, tint.opacity(0.78)], startPoint: .topLeading, endPoint: .bottomTrailing))
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
    }

    private var goalChip: some View {
        HStack(spacing: 8) {
            Image(systemName: "target").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ai)
            VStack(alignment: .leading, spacing: 1) {
                Text("Counts toward this goal").font(.system(size: 11, weight: .heavy)).tracking(0.3).foregroundStyle(WF.ai)
                Text(goalChipTitle).font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink).lineLimit(1)
            }
            Spacer()
            Image(systemName: "checkmark.circle.fill").font(.system(size: 16)).foregroundStyle(WF.ai)
        }
        .padding(12)
        .background(WF.ai.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.ai.opacity(0.25), lineWidth: 1))
    }
    private var goalChipTitle: String {
        guard let g = linkedGoal else { return "Linked goal" }
        return "\(g.emoji.map { "\($0) " } ?? "")\(g.title)"
    }

    // MARK: details card

    private var detailsCard: some View {
        VStack(spacing: 0) {
            if let loc = detail?.location ?? event.location, !loc.isEmpty {
                row("📍", "Location", loc) {
                    Button { openDirections(loc) } label: {
                        Text("Directions").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.primary)
                            .padding(.horizontal, 11).padding(.vertical, 6)
                            .overlay(Capsule().strokeBorder(WF.primary.opacity(0.5), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
                divider
            }
            row("📅", "Calendar", calendarStatus) {
                if (detail?.syncState ?? "") == "synced" {
                    Circle().fill(tint).frame(width: 8, height: 8)
                }
            }
            if let rrule = detail?.rrule, !rrule.isEmpty {
                divider; row("🔁", "Repeats", repeatLabel(rrule)) { EmptyView() }
            }
            if !peopleNames.isEmpty {
                divider; row("👥", "With", peopleNames.joined(separator: " · ")) {
                    HStack(spacing: -8) {
                        ForEach(participantAvatars.prefix(4)) { p in
                            Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 26)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .wfField()
    }

    private func row<Trailing: View>(_ icon: String, _ label: String, _ value: String,
                                     @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(spacing: 12) {
            Text(icon).font(.system(size: 16)).frame(width: 26)
            VStack(alignment: .leading, spacing: 1) {
                Text(label).font(.system(size: 11, weight: .heavy)).tracking(0.4).foregroundStyle(WF.ink3)
                Text(value).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.vertical, 13)
    }

    private var divider: some View { Rectangle().fill(WF.hair).frame(height: 1) }

    private func notesCard(_ note: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("NOTES").font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(WF.ink3)
            Text(note).font(.system(size: 14)).foregroundStyle(WF.ink).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(14)
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    // MARK: AI insight

    private var aiCard: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "sparkles").font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ai)
                .frame(width: 34, height: 34).background(WF.ai.opacity(0.12)).clipShape(Circle())
            VStack(alignment: .leading, spacing: 4) {
                if let ins = insight {
                    Text(ins.headline).font(.system(size: 14, weight: .heavy)).foregroundStyle(WF.ink)
                    Text(ins.body).font(.system(size: 13)).foregroundStyle(WF.ink2).fixedSize(horizontal: false, vertical: true)
                    if let lb = ins.leaveBy, !lb.isEmpty {
                        Text("🚗 Leave by \(lb)").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.primary)
                            .padding(.horizontal, 9).padding(.vertical, 4).background(WF.primary.opacity(0.1)).clipShape(Capsule())
                            .padding(.top, 2)
                    }
                } else if loadingInsight {
                    Text("Thinking…").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                    ProgressView().controlSize(.small).tint(WF.ai)
                } else {
                    Text("No insight available.").font(.system(size: 13)).foregroundStyle(WF.ink3)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(WF.ai.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.ai.opacity(0.18), lineWidth: 1))
    }

    // MARK: "where it falls today" timeline

    private var timelineCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("WHERE IT FALLS TODAY").font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(WF.ink3)
            ForEach(sameDayEvents) { e in
                HStack(spacing: 10) {
                    Text(e.allDay ? "all day" : fmtTime(e.startsAt))
                        .font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                        .frame(width: 64, alignment: .leading)
                    RoundedRectangle(cornerRadius: 2).fill(Color(hexString: e.colorHex ?? "") ?? WF.ink3)
                        .frame(width: 4, height: 22)
                    Text(e.title).font(.system(size: 14, weight: e.id == event.id ? .bold : .semibold))
                        .foregroundStyle(e.id == event.id ? WF.ink : WF.ink2).lineLimit(1)
                    Spacer(minLength: 6)
                    if e.id == event.id {
                        Text("this event").font(.system(size: 10, weight: .heavy)).foregroundStyle(FamilyColor.wally.solid)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(FamilyColor.wally.solid.opacity(0.14)).clipShape(Capsule())
                    } else if let g = gapLabel(e.startsAt) {
                        Text(g).font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                }
            }
            Text(timelineFooter).font(.system(size: 12, weight: .medium)).foregroundStyle(WF.ink3).padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(14)
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    // MARK: data

    private func load() async {
        detail = try? await WaffledAPI().eventDetail(id: seriesId)
        if let gid = detail?.goalId, !gid.isEmpty, let g = try? await WaffledAPI().goalDetail(id: gid) {
            linkedGoal = (g.emoji, g.title)
        } else {
            linkedGoal = nil
        }
        loadingInsight = true
        insight = try? await WaffledAPI().eventInsight(id: seriesId)
        loadingInsight = false
    }

    private func openDirections(_ location: String) {
        let q = location.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? location
        if let u = URL(string: "http://maps.apple.com/?q=\(q)") { openURL(u) }
    }

    // MARK: derived

    private var calendarStatus: String {
        guard let name = detail?.calendarName, !name.isEmpty else { return "Waffled only" }
        switch detail?.syncState {
        case "synced": return "\(name) · synced from Google"
        case "pending": return "\(name) · pending sync"
        case "failed": return "\(name) · sync failed"
        default: return name
        }
    }
    private var peopleNames: [String] {
        if let ps = detail?.participants, !ps.isEmpty { return ps.map(\.name) }
        return []
    }
    private var participantAvatars: [WaffledAPI.EventDetailDTO.Participant] { detail?.participants ?? [] }

    /// Same-day events from the local mirror, earliest first (the timeline).
    private var sameDayEvents: [SyncedEvent] {
        guard let s = start else { return [event] }
        let key = dayKey(s)
        return sync.events
            .filter { $0.startsAt.map(dayKey) == key || ($0.allDay && $0.startsAtRaw?.prefix(10) == key.prefix(10)) }
            .sorted { ($0.startsAt ?? .distantPast) < ($1.startsAt ?? .distantPast) }
    }

    /// True if another timed event overlaps this one (for the footer).
    private var timelineFooter: String {
        guard let s = start, let e = end ?? start, !allDay else { return "" }
        let clash = sameDayEvents.contains { other in
            guard other.id != event.id, !other.allDay, let os = other.startsAt else { return false }
            let oe = other.endsAt ?? os
            return os < e && oe > s
        }
        return clash ? "Heads up — this overlaps another event." : "No conflicts — you’re clear right before & after."
    }

    private func gapLabel(_ other: Date?) -> String? {
        guard let other, let s = start else { return nil }
        let mins = Int(other.timeIntervalSince(s) / 60)
        if abs(mins) < 1 { return nil }
        let mag = abs(mins)
        let txt = mag < 60 ? "\(mag) min" : (mag % 60 == 0 ? "\(mag / 60) hr" : String(format: "%.1f hr", Double(mag) / 60))
        return mins < 0 ? "\(txt) before" : "\(txt) later"
    }

    // MARK: formatting

    private var timeLine: String { allDay ? "All day" : (start.map(fmtTime) ?? "") }
    private var dateLine: String {
        guard let s = start else { return "" }
        var line = DateFmt.string(s, "EEEE, MMMM d", tz)
        if !allDay, let e = end {
            let mins = max(0, Int(e.timeIntervalSince(s) / 60))
            if mins > 0 { line += " · \(durationLabel(mins))" }
        }
        return line
    }
    private func fmtTime(_ d: Date?) -> String {
        guard let d else { return "" }
        return DateFmt.string(d, "h:mm a", tz)
    }
    private func durationLabel(_ m: Int) -> String {
        if m < 60 { return "\(m) min" }
        let h = m / 60, r = m % 60
        return r == 0 ? "\(h) hr" : "\(h) hr \(r) min"
    }
    private func repeatLabel(_ rrule: String) -> String {
        let r = rrule.uppercased()
        if r.contains("FREQ=DAILY") { return "Every day" }
        if r.contains("FREQ=WEEKLY") { return "Every week" }
        if r.contains("FREQ=MONTHLY") { return "Every month" }
        if r.contains("FREQ=YEARLY") { return "Every year" }
        return "Repeats"
    }
    private func dayKey(_ d: Date) -> String { DateFmt.string(d, "yyyy-MM-dd", tz) }
    private func parseISO(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}

/// Presentation sizing for calendar sheets (event detail + editor): a large
/// `.page`-sized modal on the iPad (bigger, web-like — but not full screen), the
/// standard large sheet on iPhone. Shared by `EventDetailView` and `EventEditSheet`.
struct KioskSheetPresentation: ViewModifier {
    let kiosk: Bool
    func body(content: Content) -> some View {
        if kiosk {
            content.presentationSizing(.page)
        } else {
            content.presentationDetents([.large])
        }
    }
}
