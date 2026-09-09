import SwiftUI

/// Weekly Planning · step 2 "Calendar" — "Here's your week. Anything missing?" Web parity
/// with `planning/steps/CalendarStep.tsx`; the rows are `SyncManager.eventsByDay`, painted
/// by the same `eventPalette` every calendar surface uses. Seven DAY ROWS, not columns;
/// the body is content-sized and the SHELL owns the scroll view.
///
/// Four rules this file must not break: THE SERVER OWNS THE WEEK (`props.weekStart` plus
/// 0…6 as string arithmetic, never the device's idea of the week); BUSY WEEKS STAY ONE
/// SCREEN (over four events, four plus a "+N more" pill that opens the day IN PLACE);
/// ADDING IS THE APP'S OWN `EventEditSheet`; and NO INVENTED PRESENCE — no face row, the
/// session is single-driver.
struct CalendarStepView: View {
    let props: PlanningStepProps

    @Environment(SyncManager.self) private var sync
    @State private var model = PlanningCalendarModel()
    /// Days whose "+N more" has been opened. Per day, and never reset by a sync tick: a
    /// row that collapsed again under someone mid-read would be worse than a tall one.
    @State private var opened: Set<String> = []
    @State private var composer: PlanningCalendarComposer?
    @State private var pending: PendingCalendarComposer?
    /// Did `EventEditSheet` report a successful write? It fires `onSaved` BEFORE it
    /// dismisses, so this is the honest answer — never a diff of the events mirror, which
    /// a concurrent sync landing in the same window reads as a save that never happened.
    @State private var composerSaved = false

    private var tz: TimeZone { sync.householdTz }

    var body: some View {
        let days = PlanningWeekDays.days(weekStart: props.weekStart, todayKey: Agenda.todayKey(tz))
        let total = days.reduce(0) { $0 + (sync.eventsByDay[$1.key]?.count ?? 0) }
        let openDays = days.filter { (sync.eventsByDay[$0.key] ?? []).isEmpty }.map(\.full)

        VStack(alignment: .leading, spacing: 14) {
            header(total: total, openDays: openDays)
            week(days)
            notes
        }
        .onAppear {
            // A step WITH a composer lends the shell's "sent here" box its own verb, which
            // answers BOTH halves of that box: a parked note tagged for this step, and a
            // loose end step 1 routed here. Neither is drawn by this body; see
            // `PlanningHandoffBanner`.
            props.lendVerb(PlanningHandoffVerb(label: "Make an event") { text, done in
                openComposer(dayKey: headerDay, prefillTitle: text, done: done)
            })
        }
        .onDisappear { props.lendVerb(nil) }
        .onChange(of: model.revision) { _, _ in props.setDecisionData(model.decisionData) }
        .sheet(item: $composer, onDismiss: composerDismissed) { c in
            eventSheet(c)
        }
    }

    // MARK: - Header

    private func header(total: Int, openDays: [String]) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(PlanningWeekDays.weekRangeLabel(props.weekStart))
                    .font(WF.serif(20)).foregroundStyle(WF.ink)
                Text(PlanningWeekDays.summary(total: total, openDays: openDays))
                    .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Button {
                openComposer(dayKey: headerDay)
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "plus").font(.system(size: 11, weight: .heavy))
                    Text("Add an event").font(.system(size: 13, weight: .bold))
                }
                .foregroundStyle(props.busy ? WF.ink3 : WF.primary)
            }
            .buttonStyle(.plain)
            .disabled(props.busy)
        }
    }

    /// Which day the header's button opens on: today when today is INSIDE the week being
    /// planned, and the week's first day otherwise — a session run on a Sunday is usually
    /// planning the week ahead. Computed rather than read off the rendered days, so the
    /// verb lent to the shell's banner on `onAppear` can't hold a week the session has
    /// stepped away from. `YYYY-MM-DD` sorts lexicographically, which is why the week
    /// stays a string here.
    private var headerDay: String {
        let today = Agenda.todayKey(tz)
        let last = PlanningWeekDays.addDays(props.weekStart, 6)
        return (today >= props.weekStart && today <= last) ? today : props.weekStart
    }

    // MARK: - The week

    private func week(_ days: [PlanningWeekDay]) -> some View {
        WaffledCard(padding: 0) {
            VStack(spacing: 0) {
                ForEach(Array(days.enumerated()), id: \.element.id) { index, day in
                    dayRow(day)
                    if index < days.count - 1 {
                        Rectangle().fill(WF.hair).frame(height: 1)
                    }
                }
            }
        }
    }

    private func dayRow(_ day: PlanningWeekDay) -> some View {
        let list = sync.eventsByDay[day.key] ?? []
        let showAll = opened.contains(day.key) || list.count <= PlanningWeekDays.rowMax
        let shown = showAll ? list : Array(list.prefix(PlanningWeekDays.rowMax))
        let hidden = list.count - shown.count

        return HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(day.dow)
                    .font(.system(size: 10.5, weight: .heavy)).tracking(0.6)
                    .foregroundStyle(day.isToday ? WF.primary : WF.ink3)
                Text(day.date)
                    .font(WF.serif(17))
                    .foregroundStyle(day.isToday ? WF.primary : WF.ink)
            }
            .frame(width: 62, alignment: .leading)

            VStack(alignment: .leading, spacing: 5) {
                ForEach(shown) { event in
                    chip(event)
                }
                if hidden > 0 {
                    Button {
                        withAnimation { _ = opened.insert(day.key) }
                    } label: {
                        Text("+\(hidden) more")
                            .font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink2)
                            .padding(.horizontal, 9).padding(.vertical, 4)
                            .background(WF.panel).clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
                if list.isEmpty {
                    Text("Nothing on the calendar")
                        .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink3)
                        .padding(.vertical, 3)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                openComposer(dayKey: day.key)
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundStyle(props.busy ? WF.ink3.opacity(0.5) : WF.ink2)
                    .frame(width: 28, height: 28)
                    .background(WF.panel).clipShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(props.busy)
            .accessibilityLabel("Add an event on \(day.full), \(day.date)")
        }
        .padding(.horizontal, 13).padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        // An open day takes a tint so it reads as an opportunity, not as a hole.
        .background(list.isEmpty ? WF.panel.opacity(0.45) : Color.clear)
    }

    /// One event as the week draws it: a coloured time, the title, and the owner's bubble.
    ///
    /// Hand-rolled rather than `EventCard` — that is a full-width 48pt row with a shadow,
    /// and seven of those stacked four deep is a different screen. The PAINT is not
    /// hand-rolled: `eventPalette.chip(for:)` is the same fill/ink pair the month cells
    /// use, so the household's solid-vs-tinted style falls out of it rather than being a
    /// branch here.
    private func chip(_ event: SyncedEvent) -> some View {
        let paint = sync.eventPalette.chip(for: event)
        return HStack(spacing: 6) {
            Text(whenText(event))
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(paint.foreground.opacity(0.8))
            Text(event.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(paint.foreground)
                .lineLimit(1)
            Spacer(minLength: 0)
            if let emoji = event.emoji {
                Avatar(colorHex: event.colorHex, emoji: emoji, size: 20)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(paint.background)
        .clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
    }

    /// "1:00 PM" — or a real "All day" label rather than a whispered aside.
    private func whenText(_ event: SyncedEvent) -> String {
        if event.allDay { return "All day" }
        guard let start = event.startsAt else { return "" }
        return EventTime.timeLabel(start, tz)
    }

    // MARK: - What step 1 sent here
    //
    // NOT DRAWN BY THIS BODY, on purpose. Both a routed loose end and a parked note tagged
    // for this step live in `PlanningHandoffBanner`, above this body, and the verb lent on
    // `onAppear` is what opens this step's composer for either. Drawing them here as well
    // double-shows a routed note, whose `step_key` makes it arrive through both doors.

    private var notes: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("This is everything your calendars already have. Add what isn’t here yet.")
                .font(.system(size: 12)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)
            Text("Busy weeks stay one screen — a day over four events shows “+N more”, which opens that day.")
                .font(.system(size: 12)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - The composer

    /// The app's own event sheet — NOT a second event form. It carries the day it was
    /// opened on and, when a note or a routed loose end opened it, the words somebody
    /// already wrote.
    ///
    /// `onSaved` is ASSIGNED rather than passed: it is a property on `EventEditSheet` with
    /// no matching parameter on that type's explicit initializer, and this file may not
    /// edit it. It fires after a successful write and before the dismiss, which is what
    /// makes "saved or cancelled?" answerable at all.
    private func eventSheet(_ c: PlanningCalendarComposer) -> EventEditSheet {
        var sheet = EventEditSheet(event: nil, initialDate: c.day, prefillTitle: c.prefillTitle)
        sheet.onSaved = { onSaved() }
        return sheet
    }

    private func openComposer(
        dayKey: String,
        prefillTitle: String? = nil,
        done: ((Bool) -> Void)? = nil
    ) {
        composerSaved = false
        pending = PendingCalendarComposer(done: done)
        composer = PlanningCalendarComposer(
            day: DateFmt.date(dayKey, "yyyy-MM-dd", tz) ?? Date(), prefillTitle: prefillTitle)
    }

    /// The sheet really wrote something.
    private func onSaved() {
        composerSaved = true
        model.recordEventAdded()
        // The shell's counter and its agenda sheet should agree with what just happened.
        props.refresh()
    }

    /// A CANCELLED COMPOSER MUST REPORT `false`. Settling a parked note — or taking a
    /// routed loose end off the box — on a cancel would throw away the only record that
    /// the thing still needs doing.
    private func composerDismissed() {
        let p = pending
        pending = nil
        p?.done?(composerSaved)
        composerSaved = false
    }
}

/// What the shared event sheet is opening on.
private struct PlanningCalendarComposer: Identifiable {
    let id = UUID().uuidString
    let day: Date
    let prefillTitle: String?
}

/// What must survive the sheet's item being cleared on dismissal.
private struct PendingCalendarComposer {
    /// The "sent here" box's completion, if the box opened this composer. `nil` when the
    /// step's own `＋` did.
    let done: ((Bool) -> Void)?
}
