import SwiftUI

/// The goal-detail data-view switcher: fetches the goal's day-bucketed activity,
/// derives stats once (memoized in `stats`), offers only the views that fit this
/// goal's type + timeframe, and persists the last-selected view per goal. Sits in
/// the goal-detail body in place of the old flat "by person" card.
struct GoalDataViewSwitcher: View {
    let goal: WaffledAPI.GoalDetail
    @State private var activity: WaffledAPI.GoalActivity?
    @State private var loading = true
    @State private var view: GoalViewKey?
    @State private var selectedDay: DayItem?
    @State private var selectedMonth: MonthItem?
    private let api = WaffledAPI()

    struct DayItem: Identifiable { var id: String { dateKey }; let dateKey: String }
    struct MonthItem: Identifiable { var id: String { "\(year)-\(month)" }; let year: Int; let month: Int }

    private var timeframe: GoalTimeframe? {
        activity.map { GoalStats.classifyTimeframe(startDate: $0.startDate, endDate: $0.endDate) }
    }
    private var offered: [GoalViewKey] {
        guard let timeframe else { return [] }
        return GoalStats.availableViews(goalType: goal.goalType, timeframe: timeframe)
    }
    private var stats: GoalStatsResult? {
        guard let activity else { return nil }
        let days = activity.days.map { DayEntry(dateKey: $0.dateKey, total: $0.total, perMember: $0.perMember) }
        return GoalStats.compute(today: activity.today, startDate: activity.startDate, endDate: activity.endDate, target: goal.target, days: days)
    }
    private var personMap: [String: WaffledAPI.Goal.Participant] {
        Dictionary(uniqueKeysWithValues: goal.participants.map { ($0.personId, $0) })
    }

    // `loading` is checked before `offered.isEmpty` so the very first render (before
    // `activity` has loaded) never resolves to `EmptyView()` — SwiftUI's `.task`/
    // `.onAppear` don't fire on a modifier host whose content IS `EmptyView`, which
    // would otherwise deadlock the load that's supposed to populate `offered`.
    // Attaching `.task` to a concrete `VStack` (not a bare `Group`) is the second
    // half of the same guarantee: the host always exists regardless of branch.
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if loading {
                ProgressView().tint(WF.ink3).frame(maxWidth: .infinity, minHeight: 140)
            } else if offered.isEmpty {
                EmptyView() // checklist: the existing steps card covers it
            } else if stats == nil || view == nil {
                ProgressView().tint(WF.ink3).frame(maxWidth: .infinity, minHeight: 140)
            } else {
                content
            }
        }
        // Keyed on more than just goal.id: logging progress changes totalProgress/
        // recent/streakDays without changing the id, and activity must refetch then
        // or the charts go stale until the goal is closed and reopened.
        .task(id: "\(goal.id)|\(goal.totalProgress)|\(goal.recent.count)|\(goal.streakDays)") { await load() }
    }

    @ViewBuilder private var content: some View {
        let ctx = GoalDataContext(
            goal: goal, stats: stats!, personMap: personMap,
            onDayTap: { selectedDay = DayItem(dateKey: $0) },
            onMonthTap: { y, m in selectedMonth = MonthItem(year: y, month: m) }
        )
        VStack(alignment: .leading, spacing: 12) {
            switch view! {
            case .week: WeekHeatmapView(ctx: ctx, headerRight: AnyView(segControl))
            case .month: MonthHeatmapView(ctx: ctx, headerRight: AnyView(segControl))
            case .pace: PaceChartView(ctx: ctx, headerRight: AnyView(segControl))
            case .year: YearGridView(ctx: ctx, headerRight: AnyView(segControl))
            case .byPerson: ByPersonBarsView(ctx: ctx, headerRight: AnyView(segControl))
            case .yearRing: YearRingView(ctx: ctx, headerRight: AnyView(segControl))
            case .collection: CollectionGridView(ctx: ctx, headerRight: AnyView(segControl))
            case .consistency: ConsistencyCalendarView(ctx: ctx, headerRight: AnyView(segControl))
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .wfField()
        .sheet(item: $selectedDay) { item in
            GoalDayDetailSheet(goal: goal, dateKey: item.dateKey, dayEntry: ctx.stats.dayEntry(item.dateKey), personMap: personMap)
        }
        .sheet(item: $selectedMonth) { item in
            GoalMonthDetailSheet(goal: goal, year: item.year, month: item.month, stats: ctx.stats, personMap: personMap)
        }
    }

    // `.fixedSize()` keeps every label (incl. "Year ring" / "By person") fully
    // readable instead of being squeezed to illegible slivers — but with 6 offered
    // views that's wider than an iPhone screen, so it's wrapped in its own
    // horizontal ScrollView: that contains the overflow to the control itself
    // instead of forcing the whole page layout sideways.
    private var segControl: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                Picker("View", selection: Binding(
                    get: { view ?? offered[0] },
                    set: { v in view = v; GoalViewPreference.set(goal.id, v) }
                )) {
                    ForEach(offered, id: \.self) { v in Text(Self.label(v)).tag(v) }
                }
                .pickerStyle(.segmented)
                .fixedSize()
                .id("picker")
            }
            // Without this, a selection past the first couple segments (e.g. the
            // default Pace on a "total" goal) is scrolled out of view — the
            // control shows Week/Month with no visible selection at all.
            .onAppear { proxy.scrollTo("picker", anchor: .center) }
        }
    }

    private static func label(_ v: GoalViewKey) -> String {
        switch v {
        case .week: return "Week"
        case .month: return "Month"
        case .pace: return "Pace"
        case .year: return "Year"
        case .byPerson: return "By person"
        case .yearRing: return "Year ring"
        case .collection: return "Collection"
        case .consistency: return "Consistency"
        }
    }

    private func load() async {
        loading = true
        activity = try? await api.goalActivity(id: goal.id)
        if let timeframe {
            let saved = GoalViewPreference.get(goal.id)
            view = (saved.map { offered.contains($0) } == true) ? saved : GoalStats.defaultView(goalType: goal.goalType, timeframe: timeframe)
        }
        loading = false
    }
}

// MARK: - Day / month drill-down

/// Tapping a day cell opens this — the day's log entries, reusing the recent-
/// activity row look. `recent` only keeps the last 12 grouped entries, so an
/// older tapped day falls back to the per-member total breakdown.
struct GoalDayDetailSheet: View {
    @Environment(\.dismiss) private var dismiss
    let goal: WaffledAPI.GoalDetail
    let dateKey: String
    let dayEntry: DayEntry
    let personMap: [String: WaffledAPI.Goal.Participant]

    private var label: String { DateFmt.string(GoalDateKey.parse(dateKey), "EEEE, MMMM d", .current) }
    private var matches: [WaffledAPI.GoalDetail.LogEntry] {
        goal.recent.filter { entry in
            guard let d = HealthKitBridge.parseTimestamp(entry.loggedAt) else { return false }
            return GoalDateKey.toKey(d) == dateKey
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("\(GoalViewFmt.num(dayEntry.total))\(goal.unit.map { " \($0)" } ?? "") logged")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)

                    if dayEntry.total == 0, matches.isEmpty {
                        Text("No activity logged this day.").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                    }

                    ForEach(matches) { entry in
                        HStack(spacing: 12) {
                            if entry.participants.isEmpty {
                                Avatar(colorHex: nil, emoji: "🙂", size: 30)
                            } else {
                                HStack(spacing: -8) {
                                    ForEach(entry.participants) { p in Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 30) }
                                }
                            }
                            Text(entry.note?.isEmpty == false ? entry.note! : "Logged progress").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
                            Spacer()
                            Text("+\(GoalViewFmt.num(entry.amount))\(goal.unit.map { " \($0)" } ?? "")").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink2)
                        }
                    }

                    if matches.isEmpty, !dayEntry.perMember.isEmpty {
                        ForEach(Array(dayEntry.perMember.keys), id: \.self) { pid in
                            let p = personMap[pid]
                            HStack(spacing: 10) {
                                Avatar(colorHex: p?.colorHex, emoji: p?.avatarEmoji ?? "🙂", size: 26)
                                Text(p.map { goalFirstName($0.name) } ?? "Someone").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink)
                                Spacer()
                                Text("\(GoalViewFmt.num(dayEntry.perMember[pid] ?? 0))\(goal.unit.map { " \($0)" } ?? "")").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink2)
                            }
                        }
                        Text("Individual entries aren't kept in the recent log this far back — showing the day's totals only.")
                            .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                }
                .padding(16)
            }
            .navigationTitle(label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}

/// Tapping a By-person column or Year-ring wedge opens this — those views are
/// MONTH-scoped (a segment is a whole month), so this pulls that month's total +
/// per-member breakdown, not a single synthesized day.
struct GoalMonthDetailSheet: View {
    @Environment(\.dismiss) private var dismiss
    let goal: WaffledAPI.GoalDetail
    let year: Int
    let month: Int // 0-indexed
    let stats: GoalStatsResult
    let personMap: [String: WaffledAPI.Goal.Participant]

    private var total: Double { stats.byMonth[month] }
    private var perMember: [String: Double] { stats.byMonthPerMember[month] }
    private var matches: [WaffledAPI.GoalDetail.LogEntry] {
        goal.recent.filter { entry in
            guard let d = HealthKitBridge.parseTimestamp(entry.loggedAt) else { return false }
            let c = GoalDateKey.calendar.dateComponents([.year, .month], from: d)
            return c.year == year && (c.month ?? 0) - 1 == month
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("\(GoalViewFmt.num(total))\(goal.unit.map { " \($0)" } ?? "") logged")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)

                    if total == 0, matches.isEmpty {
                        Text("No activity logged this month.").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                    }

                    ForEach(matches) { entry in
                        HStack(spacing: 12) {
                            if entry.participants.isEmpty {
                                Avatar(colorHex: nil, emoji: "🙂", size: 30)
                            } else {
                                HStack(spacing: -8) {
                                    ForEach(entry.participants) { p in Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 30) }
                                }
                            }
                            Text(entry.note?.isEmpty == false ? entry.note! : "Logged progress").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
                            Spacer()
                            Text("+\(GoalViewFmt.num(entry.amount))\(goal.unit.map { " \($0)" } ?? "")").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink2)
                        }
                    }

                    if !perMember.isEmpty {
                        ForEach(Array(perMember.keys.filter { (perMember[$0] ?? 0) > 0 }), id: \.self) { pid in
                            let p = personMap[pid]
                            HStack(spacing: 10) {
                                Avatar(colorHex: p?.colorHex, emoji: p?.avatarEmoji ?? "🙂", size: 26)
                                Text(p.map { goalFirstName($0.name) } ?? "Someone").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink)
                                Spacer()
                                Text("\(GoalViewFmt.num(perMember[pid] ?? 0))\(goal.unit.map { " \($0)" } ?? "")").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink2)
                            }
                        }
                        if matches.isEmpty {
                            Text("Individual entries aren't kept in the recent log this far back — showing the month's totals only.")
                                .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(WF.ink3)
                        }
                    }
                }
                .padding(16)
            }
            .navigationTitle("\(GoalViewFmt.monthName(month)) \(year)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}
