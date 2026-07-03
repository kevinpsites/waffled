import SwiftUI
import Observation

/// The Today → "Review events" screen. Two queues from the goal-calendar bridge:
///   • CONFIRMED (purple, NK.ai): events the household agreed tie to a goal, now
///     ended — confirm to log progress (editable amount + who), or skip.
///   • SUGGESTED (orange, NK.gold): untagged events the matcher thinks might count
///     — link to the goal, or dismiss.
/// Colour encodes confidence: purple = a sure link, orange = a maybe. Action
/// buttons stay coral (NK.primary). Mirrors the web ReviewDrawer.
@MainActor
@Observable
final class ReviewEventsModel {
    private(set) var recap: [WaffledAPI.GoalRecapItem] = []
    private(set) var suggestions: [WaffledAPI.GoalSuggestionItem] = []
    private(set) var loading = true
    private(set) var error = false
    /// Per-recap editable draft (amount + who gets credit), keyed by recap id.
    var drafts: [String: Draft] = [:]
    /// Rows with an action in flight (disables their buttons).
    private(set) var busy: Set<String> = []

    struct Draft { var amount: Double; var people: [String] }

    private let api = WaffledAPI()

    func load() async {
        loading = true
        async let r = api.goalRecap()
        async let s = api.goalSuggestions()
        do {
            let (rr, ss) = try await (r, s)
            recap = rr; suggestions = ss
            for it in rr where drafts[it.id] == nil {
                drafts[it.id] = Draft(amount: it.suggestedAmount, people: it.defaultPersonIds)
            }
            error = false
        } catch { self.error = true }
        loading = false
    }

    func draft(for it: WaffledAPI.GoalRecapItem) -> Draft {
        drafts[it.id] ?? Draft(amount: it.suggestedAmount, people: it.defaultPersonIds)
    }

    func setAmount(_ it: WaffledAPI.GoalRecapItem, _ amount: Double) {
        var d = draft(for: it); d.amount = max(0, amount); drafts[it.id] = d
    }
    func setPeople(_ it: WaffledAPI.GoalRecapItem, _ people: [String]) {
        var d = draft(for: it); d.people = people; drafts[it.id] = d
    }

    func confirm(_ it: WaffledAPI.GoalRecapItem, _ sync: SyncManager) async {
        guard !busy.contains(it.id) else { return }
        let d = draft(for: it)
        busy.insert(it.id); defer { busy.remove(it.id) }
        do {
            try await api.confirmRecap(eventId: it.eventId, occurrenceDate: it.occurrenceDate,
                                       amount: it.isAmountBased ? d.amount : 1, personIds: d.people)
            withAnimation { recap.removeAll { $0.id == it.id } }
            sync.touchGoals()
        } catch { self.error = true }
    }

    func skip(_ it: WaffledAPI.GoalRecapItem, _ sync: SyncManager) async {
        guard !busy.contains(it.id) else { return }
        busy.insert(it.id); defer { busy.remove(it.id) }
        do {
            try await api.skipRecap(eventId: it.eventId, occurrenceDate: it.occurrenceDate)
            withAnimation { recap.removeAll { $0.id == it.id } }
            sync.touchGoals()
        } catch { self.error = true }
    }

    func link(_ s: WaffledAPI.GoalSuggestionItem, _ sync: SyncManager) async {
        guard !busy.contains(s.id) else { return }
        busy.insert(s.id); defer { busy.remove(s.id) }
        do {
            try await api.linkSuggestion(eventId: s.eventId, goalId: s.goalId)
            withAnimation { suggestions.removeAll { $0.id == s.id } }
            sync.touchGoals()
        } catch { self.error = true }
    }

    func dismiss(_ s: WaffledAPI.GoalSuggestionItem, _ sync: SyncManager) async {
        guard !busy.contains(s.id) else { return }
        busy.insert(s.id); defer { busy.remove(s.id) }
        do {
            try await api.dismissSuggestion(eventId: s.eventId)
            withAnimation { suggestions.removeAll { $0.id == s.id } }
        } catch { self.error = true }
    }

    var isBusy: (String) -> Bool { { self.busy.contains($0) } }
}

struct ReviewEventsView: View {
    @Environment(SyncManager.self) private var sync
    @Binding var path: [HubRoute]
    @State private var model = ReviewEventsModel()
    @State private var editingPeople: WaffledAPI.GoalRecapItem?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Confirm linked events that have happened, and link any that look like they count.")
                    .font(.system(size: 14, weight: .medium)).foregroundStyle(NK.ink2)
                    .fixedSize(horizontal: false, vertical: true)

                if model.recap.isEmpty && model.suggestions.isEmpty {
                    if model.loading {
                        WaffledLoading(top: 60)
                    } else {
                        WaffledEmptyState(emoji: "🎉",
                                       title: "You're all caught up",
                                       message: "Nothing to review or link right now.")
                    }
                }
                if !model.recap.isEmpty { recapSection }
                if !model.suggestions.isEmpty { suggestionSection }
            }
            .padding(16).padding(.bottom, 110)
        }
        // Bounce even when there's nothing to review, so pull-to-refresh still triggers.
        .scrollBounceBehavior(.always)
        .background(NK.canvas)
        .navigationTitle("Review events")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: sync.goalsRev) { await model.load() }
        .refreshable { await model.load() }
        .sheet(item: $editingPeople) { it in
            ReviewPeopleSheet(item: it, members: sync.members,
                              selected: model.draft(for: it).people) { picked in
                model.setPeople(it, picked)
            }
        }
    }

    // MARK: Confirmed (purple) ------------------------------------------------

    private var recapSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(icon: NK.ai, tint: NK.ai, title: "Did these happen?",
                          sub: "Confirm each to log its progress — or mark it skipped.",
                          count: model.recap.count)
            ForEach(model.recap) { it in recapCard(it) }
        }
    }

    private func recapCard(_ it: WaffledAPI.GoalRecapItem) -> some View {
        let d = model.draft(for: it)
        let busy = model.isBusy(it.id)
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                emojiBox(it.goalEmoji ?? "🎯")
                VStack(alignment: .leading, spacing: 3) {
                    Text(it.title).font(.system(size: 15.5, weight: .bold)).foregroundStyle(NK.ink)
                    Text(eventWhen(it.startsAt, allDay: it.allDay))
                        .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(NK.ink3)
                    goalChip(it)
                }
                Spacer(minLength: 0)
            }

            HStack(spacing: 10) {
                if it.isAmountBased {
                    stepper(it, amount: d.amount)
                    Text(unitLabel(it.unit, d.amount))
                        .font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink2)
                }
                Spacer(minLength: 0)
                Button { editingPeople = it } label: { peopleLabel(it, d.people) }
                    .buttonStyle(.plain)
            }

            HStack(spacing: 10) {
                Button { Task { await model.skip(it, sync) } } label: {
                    Text("Skip").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink2)
                        .frame(maxWidth: .infinity).padding(.vertical, 11)
                        .overlay(Capsule().strokeBorder(NK.hair, lineWidth: 1))
                }
                .buttonStyle(.plain).disabled(busy)
                Button { Task { await model.confirm(it, sync) } } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark").font(.system(size: 13, weight: .heavy))
                        Text("Confirm").font(.system(size: 14, weight: .bold))
                    }
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 11)
                    .background(canConfirm(it, d) ? NK.primary : NK.ink3)
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain).disabled(busy || !canConfirm(it, d))
            }
        }
        .padding(14)
        .background(NK.card)
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
            .strokeBorder(NK.ai.opacity(0.22), lineWidth: 1))
    }

    private func canConfirm(_ it: WaffledAPI.GoalRecapItem, _ d: ReviewEventsModel.Draft) -> Bool {
        it.isAmountBased ? d.amount > 0 : true
    }

    // MARK: Suggested (orange) ------------------------------------------------

    private var suggestionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(icon: NK.gold, tint: NK.gold, title: "Might count toward a goal",
                          sub: "Link the ones that fit — or dismiss them.",
                          count: model.suggestions.count)
            ForEach(model.suggestions) { s in suggestionCard(s) }
        }
    }

    private func suggestionCard(_ s: WaffledAPI.GoalSuggestionItem) -> some View {
        let busy = model.isBusy(s.id)
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                emojiBox(s.goalEmoji ?? "🎯")
                VStack(alignment: .leading, spacing: 3) {
                    Text(s.title).font(.system(size: 15.5, weight: .bold)).foregroundStyle(NK.ink)
                    Text(eventWhen(s.startsAt, allDay: s.allDay))
                        .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(NK.ink3)
                    chip(emoji: s.goalEmoji, text: s.goalTitle, dot: NK.gold)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 10) {
                Button { Task { await model.dismiss(s, sync) } } label: {
                    Text("Dismiss").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink2)
                        .frame(maxWidth: .infinity).padding(.vertical, 11)
                        .overlay(Capsule().strokeBorder(NK.hair, lineWidth: 1))
                }
                .buttonStyle(.plain).disabled(busy)
                Button { Task { await model.link(s, sync) } } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "link").font(.system(size: 13, weight: .heavy))
                        Text("Link").font(.system(size: 14, weight: .bold))
                    }
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 11)
                    .background(NK.primary).clipShape(Capsule())
                }
                .buttonStyle(.plain).disabled(busy)
            }
        }
        .padding(14)
        .background(NK.card)
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
            .strokeBorder(NK.gold.opacity(0.40), lineWidth: 1))
    }

    // MARK: shared pieces -----------------------------------------------------

    private func sectionHeader(icon: Color, tint: Color, title: String, sub: String, count: Int) -> some View {
        HStack(spacing: 11) {
            Image(systemName: "sparkles").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(LinearGradient(colors: [tint.opacity(0.8), tint], startPoint: .topLeading, endPoint: .bottomTrailing))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.system(size: 16, weight: .heavy)).foregroundStyle(NK.ink)
                Text(sub).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(NK.ink3)
            }
            Spacer(minLength: 6)
            Text("\(count)").font(.system(size: 13, weight: .heavy)).foregroundStyle(tint)
                .frame(minWidth: 22, minHeight: 22)
                .background(tint.opacity(0.14)).clipShape(Circle())
        }
    }

    private func emojiBox(_ emoji: String) -> some View {
        Text(emoji).font(.system(size: 21))
            .frame(width: 42, height: 42)
            .background(NK.card2)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    @ViewBuilder private func goalChip(_ it: WaffledAPI.GoalRecapItem) -> some View {
        if let step = it.stepLabel, it.goalType == "checklist" {
            chip(emoji: "✓", text: step, dot: NK.ai)
        } else {
            chip(emoji: it.goalEmoji, text: it.goalTitle, dot: NK.ai)
        }
    }

    private func chip(emoji: String?, text: String, dot: Color) -> some View {
        HStack(spacing: 5) {
            Circle().fill(dot).frame(width: 6, height: 6)
            Text("\(emoji.map { "\($0) " } ?? "")\(text)")
                .font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink2).lineLimit(1)
        }
        .padding(.horizontal, 9).padding(.vertical, 5)
        .background(NK.panel).clipShape(Capsule())
    }

    private func stepper(_ it: WaffledAPI.GoalRecapItem, amount: Double) -> some View {
        let s = stepSize(it.unit)
        return HStack(spacing: 4) {
            stepButton("minus", enabled: amount > 0) { model.setAmount(it, amount - s) }
            Text(fmtAmount(amount)).font(.system(size: 15, weight: .heavy)).foregroundStyle(NK.ink)
                .frame(minWidth: 34)
            stepButton("plus", enabled: true) { model.setAmount(it, amount + s) }
        }
        .padding(.horizontal, 5).padding(.vertical, 4)
        .background(NK.card2)
        .clipShape(Capsule())
        .overlay(Capsule().strokeBorder(NK.hair, lineWidth: 1))
    }

    private func stepButton(_ icon: String, enabled: Bool, _ tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            Image(systemName: icon).font(.system(size: 12, weight: .heavy)).foregroundStyle(enabled ? NK.ink : NK.ink3)
                .frame(width: 28, height: 28).background(NK.card).clipShape(Circle())
        }
        .buttonStyle(.plain).disabled(!enabled)
    }

    private func peopleLabel(_ it: WaffledAPI.GoalRecapItem, _ people: [String]) -> some View {
        let members = people.compactMap { id in sync.members.first { $0.id == id } }
        let suffix = people.count > 1 ? (it.trackingMode == "shared_total" ? " · split" : " · each") : ""
        return HStack(spacing: 6) {
            Text("to").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
            HStack(spacing: -6) {
                ForEach(members.prefix(3)) { m in
                    Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 22)
                        .overlay(Circle().strokeBorder(NK.card, lineWidth: 1.5))
                }
            }
            Text(peopleNames(members) + suffix)
                .font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink2).lineLimit(1)
            Image(systemName: "chevron.down").font(.system(size: 9, weight: .heavy)).foregroundStyle(NK.ink3)
        }
    }

    private func peopleNames(_ members: [SyncedMember]) -> String {
        if members.isEmpty { return "anyone" }
        if members.count == 1 { return goalFirstName(members[0].name) }
        if members.count == 2 { return "\(goalFirstName(members[0].name)) & \(goalFirstName(members[1].name))" }
        return "\(members.count) people"
    }

    // MARK: formatting --------------------------------------------------------

    private func stepSize(_ unit: String?) -> Double {
        let u = (unit ?? "").lowercased()
        return ["hour", "hours", "hr", "hrs", "minute", "minutes", "min"].contains(u) ? 0.5 : 1
    }

    private func fmtAmount(_ a: Double) -> String {
        a == a.rounded() ? String(Int(a)) : String(format: "%g", a)
    }

    private func unitLabel(_ unit: String?, _ amount: Double) -> String {
        guard let u = unit, !u.isEmpty else { return "" }
        let one = abs(amount - 1) < 0.001
        return (one && u.hasSuffix("s")) ? String(u.dropLast()) : u
    }

    private func eventWhen(_ iso: String, allDay: Bool) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return String(iso.prefix(10)) }
        return DateFmt.string(date, allDay ? "EEE, MMM d" : "EEE, MMM d · h:mm a", sync.householdTz)
    }
}

/// A compact people picker for a recap row — toggle who gets credit among the
/// goal's participants. Defaults to the recap's `defaultPersonIds`.
private struct ReviewPeopleSheet: View {
    @Environment(\.dismiss) private var dismiss
    let item: WaffledAPI.GoalRecapItem
    let members: [SyncedMember]
    @State private var picked: Set<String>
    let onSave: ([String]) -> Void

    init(item: WaffledAPI.GoalRecapItem, members: [SyncedMember], selected: [String], onSave: @escaping ([String]) -> Void) {
        self.item = item; self.members = members; self.onSave = onSave
        _picked = State(initialValue: Set(selected))
    }

    /// Only the goal's participants are eligible (fallback to all members).
    private var eligible: [SyncedMember] {
        let ids = Set(item.goalParticipantIds)
        let pool = members.filter { ids.contains($0.id) }
        return pool.isEmpty ? members : pool
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(eligible) { m in
                        let on = picked.contains(m.id)
                        Button {
                            if on { picked.remove(m.id) } else { picked.insert(m.id) }
                        } label: {
                            HStack(spacing: 11) {
                                Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 30)
                                Text(m.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                                Spacer()
                                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                                    .font(.system(size: 20)).foregroundStyle(on ? NK.primary : NK.ink3)
                            }
                            .padding(13)
                            .background(NK.card)
                            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
                                .strokeBorder(on ? NK.primary.opacity(0.5) : NK.hair, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(16)
            }
            .background(NK.canvas)
            .navigationTitle("Who gets credit?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        onSave(eligible.map(\.id).filter { picked.contains($0) })
                        dismiss()
                    }.fontWeight(.semibold).disabled(picked.isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }
}
