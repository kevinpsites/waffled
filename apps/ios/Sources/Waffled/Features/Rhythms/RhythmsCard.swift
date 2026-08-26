import SwiftUI

/// The Today card for Rhythms — the things that should keep happening — shared by iPhone
/// (`kiosk == false`, `WaffledCard`) and the iPad family display (`kiosk == true`,
/// `KioskCard` + larger type), exactly like the Pantry and Family Night cards.
///
/// It shows only what needs attention today and renders **nothing** otherwise (same rule as
/// the web card and the Lists card): most days a quarterly register is quiet, and an empty
/// card on the board every morning is how a board stops being read.
///
/// Each row leads with its countdown and follows with the cadence — "2 days late · every
/// 3 months" — because on a board read from the other side of a kitchen the cadence is the
/// half you already know and the countdown is the half you don't.
///
/// The two shapes get different verbs on purpose:
///   `.due`         — you did the thing, so "I did it" is the honest action.
///   `.unscheduled` — a calendar event exists for the period, or it doesn't. The action is
///                    to book it; there is no "done", no streak and no "on track", because
///                    whether you actually went is deliberately not a question a rhythm asks.
///
/// Gated by `sync.module(.rhythms)` at the call site (`TodayView` / `KioskDashboard`) — the
/// module is off by default.
struct RhythmsTodayCard: View {
    var kiosk = false
    /// Owned and loaded by the parent (`TodayView` / `KioskDashboard`), deliberately.
    ///
    /// This card renders nothing when the register is quiet — and quiet is its *initial*
    /// state. SwiftUI does not install lifecycle modifiers on a view that resolves to
    /// `EmptyView`, so while the card loaded itself, the `.task` that would have fetched
    /// the attention list never ran: empty → `EmptyView` → no fetch → still empty, on
    /// every launch, forever. Measured against a live server, the app made *zero*
    /// `/api/rhythms/attention` requests from Today while the loader lived here, and one
    /// the moment the empty branch became a real view.
    var model: RhythmsModel
    @State private var booking: WaffledAPI.RhythmAttentionItem?
    @State private var busyId: String?
    @State private var errorMessage: String?
    var onOpen: () -> Void = {}
    private let cap = 4

    var body: some View {
        Group {
            // Quiet is the normal state — render nothing rather than an empty card. A failed
            // fetch is quiet too: "nothing needs attention" is a claim, and a dropped
            // connection is not evidence for it either way.
            if model.attention.isEmpty {
                EmptyView()
            } else if kiosk {
                KioskCard { cardBody }
            } else {
                WaffledCard(padding: 15) { cardBody }
            }
        }
        .sheet(item: $booking) { item in
            BookRhythmSheet(item: item, model: model)
        }
        .alert("Rhythm unchanged", isPresented: errorPresented) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "That didn’t stick — check your connection and try again.")
        }
    }

    private var errorPresented: Binding<Bool> {
        Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
    }

    @ViewBuilder private var cardBody: some View {
        VStack(alignment: .leading, spacing: kiosk ? 12 : 10) {
            Button(action: onOpen) {
                // Both halves of where you stand when there's room for both; the title and
                // the way in when there isn't. ViewThatFits rather than a width guess:
                // this card sits in a phone list AND in a kiosk column, and the count's
                // own length changes with the number.
                ViewThatFits(in: .horizontal) {
                    header(showingCount: true)
                    header(showingCount: false)
                }
            }
            .buttonStyle(.plain)

            ForEach(model.attention.prefix(cap)) { row($0) }

            if model.attention.count > cap {
                Text("+\(model.attention.count - cap) more")
                    .font(.system(size: kiosk ? 13 : 11, weight: .semibold)).foregroundStyle(WF.ink3)
            }
        }
        // The header's total needs the whole register, which is a second request. It is
        // asked for HERE rather than by the parent so it only happens on days this card
        // actually renders: SwiftUI installs no lifecycle modifier on an EmptyView, and a
        // quarterly register is quiet most mornings. A request per board refresh to render
        // something nobody sees is not a trade worth making.
        .task {
            if !model.listLoaded { await model.loadAll() }
        }
    }

    /// The card's header. `showingCount` is dropped by `ViewThatFits` when the column is
    /// too narrow for it — the title and the way into the register both stay.
    @ViewBuilder private func header(showingCount: Bool) -> some View {
        HStack(spacing: 8) {
            Text("🔁 Rhythms")
                .font(kiosk ? .system(size: 16, weight: .heavy) : .system(size: 12.5, weight: .bold))
                .foregroundStyle(kiosk ? WF.ink : WF.ink2)
                .lineLimit(1).fixedSize()
            if showingCount {
                Text(model.attention.count == 1 ? "1 wants attention" : "\(model.attention.count) want attention")
                    .font(.system(size: kiosk ? 13 : 12)).foregroundStyle(WF.ink3)
                    .lineLimit(1).fixedSize()
            }
            Spacer(minLength: 6)
            // The reassuring half: the others are handled, and the register is one tap
            // away. Held back until the count has arrived rather than flashing "All 0".
            Text(model.rhythms.isEmpty ? "All" : "All \(model.rhythms.count)")
                .font(.system(size: kiosk ? 13 : 12)).foregroundStyle(WF.ink3)
                .lineLimit(1).fixedSize()
            Image(systemName: "arrow.right")
                .font(.system(size: kiosk ? 13 : 12, weight: kiosk ? .bold : .semibold))
                .foregroundStyle(WF.ink3)
        }
    }

    @ViewBuilder private func row(_ item: WaffledAPI.RhythmAttentionItem) -> some View {
        HStack(spacing: kiosk ? 12 : 10) {
            RhythmGlyph(item.rhythm, kiosk: kiosk)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.rhythm.title)
                    .font(.system(size: kiosk ? 18 : 14, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                // Precomputed on load (`statusLines`) — never date math in a view body.
                Text(subtitle(item))
                    .font(.system(size: kiosk ? 13 : 11)).foregroundStyle(overdue(item) ? WF.danger : WF.ink3)
                    .lineLimit(1)
            }
            // The verb refuses to wrap, so without this the row satisfies it by starving
            // the text column instead and the rhythm's own name collapses to an ellipsis.
            // Priority says which side gives: the title truncates, the verb never does.
            // No Spacer after this: an expanding frame and an expanding Spacer split the
            // free width between them, so the title got half of what was going spare and
            // collapsed to "T…" on the kiosk board. The frame does the pushing on its own.
            .frame(maxWidth: .infinity, alignment: .leading)
            .layoutPriority(1)
            actions(item)
        }
    }

    private func overdue(_ item: WaffledAPI.RhythmAttentionItem) -> Bool {
        item.kind == .due && (item.overdue ?? false)
    }

    /// Everything on this card wants attention, so a loud button on every row makes none
    /// of them mean anything. The emphasis is kept for what is actually late, or a booking
    /// window with a day left in it.
    private func urgent(_ item: WaffledAPI.RhythmAttentionItem) -> Bool {
        if overdue(item) { return true }
        guard item.kind == .unscheduled, let end = item.periodEnd,
              let date = RhythmFormat.moment(end, Cal.current) else { return false }
        return RhythmFormat.dayDiff(date, Date(), Cal.current) <= 1
    }

    private func subtitle(_ item: WaffledAPI.RhythmAttentionItem) -> String {
        let status = model.statusLines[item.rhythm.id] ?? ""
        switch item.kind {
        case .due:
            // Countdown first, cadence second — see the note at the top of this file.
            return "\(status) · \(RhythmFormat.cadenceLabel(item.rhythm.every))"
        case .unscheduled:
            // An autoSchedule rhythm is normally absent from this list — its recurring event
            // IS the satisfied state. Turning up here means the calendar and the intention
            // have disagreed, and only a MISSING SERIES is worth explaining: said of a
            // series that is alive it sent people to a button that built a second one
            // beside it, doubling every future occurrence.
            // "Not on the calendar yet" was true of every row on this card and so
            // distinguished nothing; the deadline is what differs.
            guard item.rhythm.autoSchedule, item.hasSeries != true else { return status }
            return status.isEmpty ? "The series needs putting back"
                                  : "\(status) · the series needs putting back"
        }
    }

    @ViewBuilder private func actions(_ item: WaffledAPI.RhythmAttentionItem) -> some View {
        switch item.kind {
        case .due:
            RhythmActionButton(label: "I did it", kiosk: kiosk,
                               tint: urgent(item) ? WF.primary : WF.panel,
                               labelColor: urgent(item) ? .white : WF.ink,
                               busy: busyId == item.rhythm.id) {
                run(item.rhythm.id) { try await model.markDone(item.rhythm.id) }
            }
        case .unscheduled:
            HStack(spacing: kiosk ? 8 : 6) {
                RhythmActionButton(label: item.rhythm.autoSchedule && item.hasSeries != true
                                          ? "Put it back" : "Book a time",
                                   kiosk: kiosk,
                                   tint: urgent(item) ? WF.primary : WF.panel,
                                   labelColor: urgent(item) ? .white : WF.ink,
                                   busy: false) { booking = item }
                // Skipping is the quiet way out of a period; tucked in a menu so the booking
                // action stays the obvious one.
                Menu {
                    Button("Skip this period") {
                        run(item.rhythm.id) { try await model.skipPeriod(item) }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.system(size: kiosk ? 20 : 17, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                .disabled(busyId == item.rhythm.id)
            }
        }
    }

    private func run(_ id: String, _ work: @escaping () async throws -> Void) {
        guard busyId == nil else { return }
        busyId = id
        Task {
            defer { busyId = nil }
            do { try await work() } catch {
                errorMessage = APIErrorText.message(
                    for: error, fallback: "That didn’t stick — check your connection and try again.")
            }
        }
    }
}

/// A rhythm's glyph — its emoji, defaulting per shape (🔁 for "you do it", 🗓️ for "it gets
/// scheduled"). Uses the shared emoji-tile look on the phone and a bare glyph on the wall
/// display, matching the Pantry / Family Night rows.
struct RhythmGlyph: View {
    let rhythm: WaffledAPI.Rhythm
    var kiosk = false

    init(_ rhythm: WaffledAPI.Rhythm, kiosk: Bool = false) {
        self.rhythm = rhythm
        self.kiosk = kiosk
    }

    private var glyph: String {
        rhythm.emoji ?? (rhythm.satisfiedBy == .scheduling ? "🗓️" : "🔁")
    }

    var body: some View {
        if kiosk {
            Text(glyph).font(.system(size: 22))
        } else {
            WaffledEmojiTile(emoji: glyph, size: 17, frame: 32, cornerRadius: 9)
        }
    }
}

/// The countdown that anchors a register row — the one thing on it worth reading from the
/// other side of a kitchen, which is why the number is set large and the unit small
/// underneath rather than the two running together as a sentence.
///
/// It replaces the "Needs attention" badge the row used to carry. A badge said only THAT
/// something wanted you; this says how much, which is the difference between a row you
/// scan past and a row you act on.
struct RhythmCountdownLabel: View {
    let countdown: RhythmFormat.Countdown
    /// A paused rhythm keeps its number — it is still true — but stops shouting it.
    var muted = false

    private var booked: Bool { countdown.tone == .done }

    private var tint: Color {
        if muted { return WF.ink3 }
        switch countdown.tone {
        case .done: return WF.success
        case .late: return WF.danger
        // Coming up is neither shouting nor greyed out; steady recedes a step.
        case .near: return WF.ink
        case .soft: return WF.ink2
        }
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 1) {
            Text(countdown.number)
                // "Booked" is a word, not a number, so it doesn't get the display size —
                // set large it reads as a shout about something already handled.
                .font(.system(size: booked ? 14 : 21, weight: booked ? .bold : .semibold,
                              design: booked ? .default : .serif))
                .foregroundStyle(tint)
            Text(countdown.unit)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(muted || countdown.tone != .late ? WF.ink3 : WF.danger)
        }
        .fixedSize()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(countdown.number) \(countdown.unit)")
    }
}

/// How much of the current cycle is already spent. A hairline rather than a chart: the
/// exact fraction doesn't matter, only whether the row is near the end of its window.
struct RhythmProgressBar: View {
    let percent: Int
    var late = false

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(WF.hair)
                Capsule()
                    .fill(late ? WF.danger : WF.ink3.opacity(0.55))
                    // `percent` is already clamped to 0–100 by periodProgress; this keeps
                    // the width non-negative if that ever stops being true.
                    .frame(width: max(0, geo.size.width * Double(min(100, max(0, percent))) / 100))
            }
        }
        .frame(height: 3)
        .frame(maxWidth: 260)
        .accessibilityHidden(true)
    }
}

/// The compact inline action on a rhythm row ("Mark done", "Book a time"). A tinted capsule
/// rather than a `WaffledPrimaryCTA`, which is the full-width bottom-of-sheet shape; the
/// tint + capsule match `WaffledStatusBadge`'s treatment so the card reads as one family.
struct RhythmActionButton: View {
    let label: String
    var kiosk = false
    var tint: Color = WF.primary
    /// Overridden only for the settled "Done today ✓" capsule, which is a tinted wash
    /// rather than a saturated fill and so needs ink, not white.
    var labelColor: Color = .white
    var busy = false
    /// A settled state, not a blocked one — the row still shows the capsule, it just has
    /// nothing left to do. Kept apart from `busy` so a disabled button doesn't spin.
    var disabled = false
    /// The register's row verb, which sits on its own line rather than inline: at phone
    /// widths a title, a countdown and a verb do not fit across one, and the verb is the
    /// one that cannot be truncated. Capped rather than genuinely full-width — the same
    /// register runs on the iPad wall display, where "spans the row" is a 1400pt coral
    /// slab. Below the cap (every phone) it still fills the row exactly as the design has
    /// it, so one number covers both surfaces without a discriminator.
    var fullWidth = false
    private static let verbCap: CGFloat = 420
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if busy { ProgressView().controlSize(.small).tint(labelColor) }
                Text(label).font(.system(size: kiosk || fullWidth ? 14 : 12, weight: .bold))
                    // A colored fill stays saturated in both themes, so .white is right
                    // for the default; a wash passes its own ink in.
                    .foregroundStyle(labelColor)
                    // Never wrap. In a narrow kiosk column "Book a time" came out as three
                    // stacked characters — the row has to give up width from the title,
                    // which can truncate, rather than from the verb, which cannot.
                    .lineLimit(1).fixedSize(horizontal: true, vertical: false)
            }
            .padding(.horizontal, kiosk ? 12 : 10)
            .padding(.vertical, fullWidth ? 10 : (kiosk ? 7 : 5))
            .frame(maxWidth: fullWidth ? Self.verbCap : nil)
            .background(tint).clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(busy || disabled)
    }
}
