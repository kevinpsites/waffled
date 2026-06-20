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

    @State private var detail: NookAPI.EventDetailDTO?
    @State private var insight: NookAPI.EventInsight?
    @State private var loadingInsight = true
    @State private var editing = false
    @State private var confirmDelete = false

    private var tz: TimeZone { sync.householdTz }
    private var tint: Color { Color(hexString: detail?.personColor ?? event.colorHex ?? "") ?? NK.ink3 }
    private var title: String { detail?.title ?? event.title }
    private var start: Date? { parseISO(detail?.startsAt) ?? event.startsAt }
    private var end: Date? { parseISO(detail?.endsAt) ?? event.endsAt }
    private var allDay: Bool { detail?.allDay ?? event.allDay }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    hero
                    if let gid = detail?.goalId, !gid.isEmpty { goalChip }
                    detailsCard
                    if let note = detail?.description, !note.isEmpty { notesCard(note) }
                    aiCard
                    timelineCard
                    Button {
                        if confirmDelete { Task { _ = await sync.deleteEvent(id: event.id); dismiss() } }
                        else { withAnimation { confirmDelete = true } }
                    } label: {
                        Text(confirmDelete ? "Tap again to delete this event" : "Delete event")
                            .font(.system(size: 15, weight: .bold)).foregroundStyle(NK.primary)
                            .frame(maxWidth: .infinity).padding(.vertical, 12)
                    }
                    .buttonStyle(.plain).padding(.top, 4)
                }
                .padding(18).padding(.bottom, 40)
            }
            .background(NK.canvas)
            .navigationTitle("Event").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .primaryAction) { Button("Edit") { editing = true } }
            }
            .task { await load() }
            .sheet(isPresented: $editing, onDismiss: { Task { await load() } }) {
                EventEditSheet(event: event, initialDate: start ?? Date())
            }
        }
        .presentationDetents([.large])
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
            Text(title).font(NK.serif(28)).foregroundStyle(.white).fixedSize(horizontal: false, vertical: true)
            Text(timeLine).font(.system(size: 22, weight: .heavy)).foregroundStyle(.white)
            Text(dateLine).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white.opacity(0.9))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(LinearGradient(colors: [tint, tint.opacity(0.78)], startPoint: .topLeading, endPoint: .bottomTrailing))
        .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
    }

    private var goalChip: some View {
        HStack(spacing: 8) {
            Image(systemName: "target").font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ai)
            Text("Counts toward a goal").font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink)
            Spacer()
            Image(systemName: "checkmark.circle.fill").font(.system(size: 14)).foregroundStyle(NK.ai)
        }
        .padding(12)
        .background(NK.ai.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.ai.opacity(0.25), lineWidth: 1))
    }

    // MARK: details card

    private var detailsCard: some View {
        VStack(spacing: 0) {
            if let loc = detail?.location ?? event.location, !loc.isEmpty {
                row("📍", "Location", loc) {
                    Button { openDirections(loc) } label: {
                        Text("Directions").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.primary)
                            .padding(.horizontal, 11).padding(.vertical, 6)
                            .overlay(Capsule().strokeBorder(NK.primary.opacity(0.5), lineWidth: 1))
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
        .background(NK.card)
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    private func row<Trailing: View>(_ icon: String, _ label: String, _ value: String,
                                     @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(spacing: 12) {
            Text(icon).font(.system(size: 16)).frame(width: 26)
            VStack(alignment: .leading, spacing: 1) {
                Text(label).font(.system(size: 11, weight: .heavy)).tracking(0.4).foregroundStyle(NK.ink3)
                Text(value).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.vertical, 13)
    }

    private var divider: some View { Rectangle().fill(NK.hair).frame(height: 1) }

    private func notesCard(_ note: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("NOTES").font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(NK.ink3)
            Text(note).font(.system(size: 14)).foregroundStyle(NK.ink).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(14)
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    // MARK: AI insight

    private var aiCard: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "sparkles").font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ai)
                .frame(width: 34, height: 34).background(NK.ai.opacity(0.12)).clipShape(Circle())
            VStack(alignment: .leading, spacing: 4) {
                if let ins = insight {
                    Text(ins.headline).font(.system(size: 14, weight: .heavy)).foregroundStyle(NK.ink)
                    Text(ins.body).font(.system(size: 13)).foregroundStyle(NK.ink2).fixedSize(horizontal: false, vertical: true)
                    if let lb = ins.leaveBy, !lb.isEmpty {
                        Text("🚗 Leave by \(lb)").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.primary)
                            .padding(.horizontal, 9).padding(.vertical, 4).background(NK.primary.opacity(0.1)).clipShape(Capsule())
                            .padding(.top, 2)
                    }
                } else if loadingInsight {
                    Text("Thinking…").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
                    ProgressView().controlSize(.small).tint(NK.ai)
                } else {
                    Text("No insight available.").font(.system(size: 13)).foregroundStyle(NK.ink3)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(NK.ai.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.ai.opacity(0.18), lineWidth: 1))
    }

    // MARK: "where it falls today" timeline

    private var timelineCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("WHERE IT FALLS TODAY").font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(NK.ink3)
            ForEach(sameDayEvents) { e in
                HStack(spacing: 10) {
                    Text(e.allDay ? "all day" : fmtTime(e.startsAt))
                        .font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink3)
                        .frame(width: 64, alignment: .leading)
                    RoundedRectangle(cornerRadius: 2).fill(Color(hexString: e.colorHex ?? "") ?? NK.ink3)
                        .frame(width: 4, height: 22)
                    Text(e.title).font(.system(size: 14, weight: e.id == event.id ? .bold : .semibold))
                        .foregroundStyle(e.id == event.id ? NK.ink : NK.ink2).lineLimit(1)
                    Spacer(minLength: 6)
                    if e.id == event.id {
                        Text("this event").font(.system(size: 10, weight: .heavy)).foregroundStyle(FamilyColor.wally.solid)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(FamilyColor.wally.solid.opacity(0.14)).clipShape(Capsule())
                    } else if let g = gapLabel(e.startsAt) {
                        Text(g).font(.system(size: 11, weight: .semibold)).foregroundStyle(NK.ink3)
                    }
                }
            }
            Text(timelineFooter).font(.system(size: 12, weight: .medium)).foregroundStyle(NK.ink3).padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(14)
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    // MARK: data

    private func load() async {
        async let d = try? await NookAPI().eventDetail(id: event.id)
        detail = await d
        loadingInsight = true
        insight = try? await NookAPI().eventInsight(id: event.id)
        loadingInsight = false
    }

    private func openDirections(_ location: String) {
        let q = location.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? location
        if let u = URL(string: "http://maps.apple.com/?q=\(q)") { openURL(u) }
    }

    // MARK: derived

    private var calendarStatus: String {
        guard let name = detail?.calendarName, !name.isEmpty else { return "Nook only" }
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
    private var participantAvatars: [NookAPI.EventDetailDTO.Participant] { detail?.participants ?? [] }

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
        let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian); f.timeZone = tz; f.dateFormat = "EEEE, MMMM d"
        var line = f.string(from: s)
        if !allDay, let e = end {
            let mins = max(0, Int(e.timeIntervalSince(s) / 60))
            if mins > 0 { line += " · \(durationLabel(mins))" }
        }
        return line
    }
    private func fmtTime(_ d: Date?) -> String {
        guard let d else { return "" }
        let f = DateFormatter(); f.timeZone = tz; f.dateFormat = "h:mm a"
        return f.string(from: d)
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
    private func dayKey(_ d: Date) -> String {
        let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian); f.timeZone = tz; f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }
    private func parseISO(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}
