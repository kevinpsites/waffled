import SwiftUI

/// The Today card for Rhythms — the things that should keep happening — shared by iPhone
/// (`kiosk == false`, `WaffledCard`) and the iPad family display (`kiosk == true`,
/// `KioskCard` + larger type), exactly like the Pantry and Family Night cards.
///
/// It shows only what needs attention today and renders **nothing** otherwise (same rule as
/// the web card and the Lists card): most days a quarterly register is quiet, and an empty
/// card on the board every morning is how a board stops being read.
///
/// The two shapes get different verbs on purpose:
///   `.due`         — you did the thing, so "Mark done" is the honest action.
///   `.unscheduled` — a calendar event exists for the period, or it doesn't. The action is
///                    to book it; there is no "done", no streak and no "on track", because
///                    whether you actually went is deliberately not a question a rhythm asks.
///
/// Gated by `sync.module(.rhythms)` at the call site (`TodayView` / `KioskDashboard`) — the
/// module is off by default.
struct RhythmsTodayCard: View {
    var kiosk = false
    @State private var model = RhythmsModel()
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
        .task { await model.loadAttention() }
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
                HStack(spacing: 8) {
                    Text("🔁 Rhythms")
                        .font(kiosk ? .system(size: 16, weight: .heavy) : .system(size: 12.5, weight: .bold))
                        .foregroundStyle(kiosk ? WF.ink : WF.ink2)
                    Spacer(minLength: 6)
                    Text(model.attention.count == 1 ? "1 needs attention" : "\(model.attention.count) need attention")
                        .font(.system(size: kiosk ? 13 : 12)).foregroundStyle(WF.ink3)
                    Image(systemName: "chevron.right")
                        .font(.system(size: kiosk ? 13 : 12, weight: kiosk ? .bold : .semibold))
                        .foregroundStyle(WF.ink3)
                }
            }
            .buttonStyle(.plain)

            ForEach(model.attention.prefix(cap)) { row($0) }
            if model.attention.count > cap {
                Text("+\(model.attention.count - cap) more")
                    .font(.system(size: kiosk ? 13 : 11, weight: .semibold)).foregroundStyle(WF.ink3)
            }
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
            Spacer(minLength: kiosk ? 8 : 6)
            actions(item)
        }
    }

    private func overdue(_ item: WaffledAPI.RhythmAttentionItem) -> Bool {
        item.kind == .due && (item.overdue ?? false)
    }

    private func subtitle(_ item: WaffledAPI.RhythmAttentionItem) -> String {
        let status = model.statusLines[item.rhythm.id] ?? ""
        switch item.kind {
        case .due:
            return "\(RhythmFormat.cadenceLabel(item.rhythm.every)) · \(status)"
        case .unscheduled:
            // An autoSchedule rhythm is normally absent from this list — its recurring event
            // IS the satisfied state. Turning up here means the calendar and the intention
            // have disagreed, so the offer is to put the series back.
            let lead = item.rhythm.autoSchedule ? "The series needs putting back" : "Not on the calendar yet"
            return status.isEmpty ? lead : "\(lead) · \(status)"
        }
    }

    @ViewBuilder private func actions(_ item: WaffledAPI.RhythmAttentionItem) -> some View {
        switch item.kind {
        case .due:
            RhythmActionButton(label: "Mark done", kiosk: kiosk, busy: busyId == item.rhythm.id) {
                run(item.rhythm.id) { try await model.markDone(item.rhythm.id) }
            }
        case .unscheduled:
            HStack(spacing: kiosk ? 8 : 6) {
                RhythmActionButton(label: item.rhythm.autoSchedule ? "Put it back" : "Book a time",
                                   kiosk: kiosk, busy: false) { booking = item }
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
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if busy { ProgressView().controlSize(.small).tint(labelColor) }
                Text(label).font(.system(size: kiosk ? 14 : 12, weight: .bold))
                    // A colored fill stays saturated in both themes, so .white is right
                    // for the default; a wash passes its own ink in.
                    .foregroundStyle(labelColor)
            }
            .padding(.horizontal, kiosk ? 12 : 10).padding(.vertical, kiosk ? 7 : 5)
            .background(tint).clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(busy || disabled)
    }
}
