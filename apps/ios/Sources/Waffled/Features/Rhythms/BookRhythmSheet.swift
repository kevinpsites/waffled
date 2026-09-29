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
    /// The rhythm's suggested day, when the sheet opened on it.
    @State private var suggestion: String?

    private var rhythm: WaffledAPI.Rhythm { item.rhythm }
    /// True only when there is no recurrence left, so the offer really is to put a series
    /// back. While the series is alive an empty period wants one event in it — the server
    /// refuses to clone the rule a second time, and this copy must not promise otherwise.
    private var series: Bool { rhythm.autoSchedule && item.hasSeries != true }

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

                    if let end = item.bookableUntil {
                        Text("It counts for this period as long as it lands on or before \(RhythmFormat.shortDate(RhythmFormat.lastDayOfPeriod(end))).")
                            .font(.system(size: 12)).foregroundStyle(WF.ink3)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if let suggestion {
                        Text(suggestion)
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

    /// The day comes from `RhythmFormat.bookingDay` — the suggestion, else today, else the
    /// first day it could go. Six in the evening is the same default the web picks.
    private func seed() {
        let cal = Cal.current
        guard let day = RhythmFormat.bookingDay(periodStart: item.periodStart, bookableUntil: item.bookableUntil,
                                                suggestedOn: item.suggestedOn, calendar: cal),
              let start = item.periodStart.flatMap({ DateFmt.date($0, "yyyy-MM-dd", cal.timeZone) }),
              let end = item.bookableUntil.flatMap({ DateFmt.date(RhythmFormat.lastDayOfPeriod($0), "yyyy-MM-dd", cal.timeZone) })
        else { return }
        let last = cal.date(bySettingHour: 23, minute: 59, second: 0, of: end) ?? end
        window = start...last
        when = cal.date(bySettingHour: 18, minute: 0, second: 0, of: day).map { min(max($0, start), last) } ?? day
        if let suggested = item.suggestedOn, RhythmFormat.ymd(day, calendar: cal) == suggested {
            suggestion = RhythmFormat.suggestionNote(
                day, hint: rhythm.autoSchedule ? nil : RhythmFormat.dayHintLabel(rhythm.rrule), calendar: cal)
        }
    }

    private func book() async {
        guard !saving else { return }
        saving = true
        error = nil
        do {
            // An all-day booking still hands the server an instant; it flags the event all-day.
            let startsAt = allDay ? Cal.current.startOfDay(for: when) : when
            try await model.book(id: rhythm.id, startsAt: startsAt, allDay: allDay, periodStart: item.periodStart)
            dismiss()
        } catch {
            self.error = APIErrorText.message(for: error, fallback: "Couldn’t book it — try again.")
            saving = false
        }
    }
}
