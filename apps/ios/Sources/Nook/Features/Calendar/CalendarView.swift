import SwiftUI

/// Calendar tab — an upcoming-agenda list grouped by day, read live from the
/// local mirror. (A month grid can follow; the agenda is the high-value first cut
/// and exercises the same synced data as Today.)
struct CalendarView: View {
    @Environment(SyncManager.self) private var sync

    private var groups: [(day: String, items: [SyncedEvent])] {
        Agenda.upcoming(sync.events, from: Agenda.todayKey(sync.householdTz), tz: sync.householdTz)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Calendar").font(NK.serif(30)).foregroundStyle(NK.ink).padding(.top, 8)

                if groups.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "calendar").font(.system(size: 34)).foregroundStyle(NK.ink3)
                        Text("No upcoming events.").font(.system(size: 14)).foregroundStyle(NK.ink2)
                    }
                    .frame(maxWidth: .infinity).padding(.top, 60)
                } else {
                    ForEach(groups, id: \.day) { group in
                        VStack(alignment: .leading, spacing: 7) {
                            SectionLabel(text: dayHeader(group.day))
                            NookCard(padding: 14) {
                                VStack(spacing: 0) {
                                    ForEach(Array(group.items.enumerated()), id: \.element.id) { idx, ev in
                                        EventRow(event: ev, tz: sync.householdTz).padding(.vertical, 10)
                                        if idx < group.items.count - 1 {
                                            Rectangle().fill(NK.hair2).frame(height: 1)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 18).padding(.bottom, 110)
        }
        .background(NK.canvas)
    }

    private func dayHeader(_ key: String) -> String {
        let tz = sync.householdTz
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        let tomorrow = EventTime.dayKey(cal.date(byAdding: .day, value: 1, to: Date()) ?? Date(), tz)
        if key == Agenda.todayKey(tz) { return "Today" }
        if key == tomorrow { return "Tomorrow" }
        let inF = DateFormatter()
        inF.locale = Locale(identifier: "en_US_POSIX"); inF.timeZone = tz; inF.dateFormat = "yyyy-MM-dd"
        guard let d = inF.date(from: key) else { return key }
        let outF = DateFormatter()
        outF.locale = Locale(identifier: "en_US"); outF.timeZone = tz; outF.dateFormat = "EEE, MMM d"
        return outF.string(from: d)
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
