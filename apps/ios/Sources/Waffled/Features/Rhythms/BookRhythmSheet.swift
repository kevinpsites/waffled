import SwiftUI

/// Book a period: turn "this should happen" into an actual dated event.
///
/// Deliberately the smallest sheet in the app. The server fills the title and the assignee
/// from the rhythm, so all that's left to decide is WHEN — and making someone retype
/// "Temple visit" is exactly the friction that keeps these things off the calendar in the
/// first place.
///
/// The date picker is bounded to the period, because `periodEnd` is the **exclusive** next
/// boundary: a booking on that date lands in the next period and satisfies the wrong one.
struct BookRhythmSheet: View {
    let item: WaffledAPI.RhythmAttentionItem
    let model: RhythmsModel

    @Environment(\.dismiss) private var dismiss
    @State private var when = Date()
    @State private var allDay = false
    @State private var saving = false
    @State private var error: String?
    /// The bookable window, computed once — not per render.
    @State private var window: ClosedRange<Date>?

    private var rhythm: WaffledAPI.Rhythm { item.rhythm }
    /// An autoSchedule rhythm here means the calendar and the intention have disagreed (the
    /// event was deleted, or the recurrence ran out), so the offer is to put the series back
    /// rather than to pick a one-off slot.
    private var series: Bool { rhythm.autoSchedule }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 12) {
                        RhythmGlyph(rhythm)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(rhythm.title).font(.system(size: 17, weight: .bold)).foregroundStyle(WF.ink)
                            Text(series
                                 ? "Puts the whole series back on the calendar, \(RhythmFormat.cadenceLabel(rhythm.every))."
                                 : "Pick a time and it goes on the calendar — \(RhythmFormat.cadenceLabel(rhythm.every)).")
                                .font(.system(size: 13)).foregroundStyle(WF.ink3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    WaffledFieldCard(title: "When") {
                        VStack(alignment: .leading, spacing: 10) {
                            if let window {
                                DatePicker("Date", selection: $when, in: window,
                                           displayedComponents: allDay ? [.date] : [.date, .hourAndMinute])
                                    .datePickerStyle(.compact)
                            } else {
                                DatePicker("Date", selection: $when,
                                           displayedComponents: allDay ? [.date] : [.date, .hourAndMinute])
                                    .datePickerStyle(.compact)
                            }
                            Toggle("All day", isOn: $allDay)
                                .font(.system(size: 15, weight: .semibold))
                                .tint(WF.primary)
                        }
                    }

                    if let end = item.periodEnd {
                        Text("It counts for this period as long as it lands on or before \(RhythmFormat.shortDate(RhythmFormat.lastDayOfPeriod(end))).")
                            .font(.system(size: 12)).foregroundStyle(WF.ink3)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if let error {
                        Text(error).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    WaffledPrimaryCTA(label: series ? "Put it back on the calendar" : "Put it on the calendar",
                                      isBusy: saving) {
                        Task { await book() }
                    }
                }
                .padding(16)
            }
            .background(WF.canvas)
            .navigationTitle("Book a time")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .onAppear(perform: seed)
        }
    }

    /// Default to today when today is inside the period (the common case — the runway only
    /// opens near the end), otherwise the first day it could go. Six in the evening is the
    /// same default the web picks.
    private func seed() {
        let cal = Cal.current
        guard let start = item.periodStart.flatMap({ DateFmt.date($0, "yyyy-MM-dd", cal.timeZone) }),
              let end = item.periodEnd.flatMap({ DateFmt.date(RhythmFormat.lastDayOfPeriod($0), "yyyy-MM-dd", cal.timeZone) })
        else { return }
        let last = cal.date(bySettingHour: 23, minute: 59, second: 0, of: end) ?? end
        guard start <= last else { return }
        window = start...last
        let today = cal.startOfDay(for: Date())
        let day = (today >= start && today <= last) ? today : start
        when = cal.date(bySettingHour: 18, minute: 0, second: 0, of: day).map { min(max($0, start), last) } ?? day
    }

    private func book() async {
        guard !saving else { return }
        saving = true
        error = nil
        do {
            // An all-day booking still hands the server an instant; it flags the event all-day.
            let startsAt = allDay ? Cal.current.startOfDay(for: when) : when
            try await model.book(id: rhythm.id, startsAt: startsAt, allDay: allDay)
            dismiss()
        } catch {
            self.error = APIErrorText.message(for: error, fallback: "Couldn’t book it — try again.")
            saving = false
        }
    }
}
