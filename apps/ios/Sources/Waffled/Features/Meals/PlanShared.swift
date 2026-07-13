import SwiftUI

/// Pure text helpers shared by the plan sheets. `friendly`/`viaLabel` are timezone-
/// free; `weekday` needs the household timezone, so call sites pass `sync.householdTz`.
enum MealPlanText {
    static func friendly(_ err: String) -> String {
        err == "AIUnavailable" || err == "No AI provider configured"
            ? "No AI provider is set up. Choose one in Settings → AI & capture."
            : err
    }

    static func viaLabel(_ v: String) -> String {
        switch v { case "anthropic": return "Claude"; case "openai": return "OpenAI"
        case "ollama", "local": return "local AI"; default: return v }
    }

    static func weekday(_ ymd: String, _ tz: TimeZone) -> String {
        guard let d = DateFmt.date(ymd, "yyyy-MM-dd", tz) else { return ymd }
        return DateFmt.string(d, "EEE MMM d", tz).uppercased()
    }
}

// Stateless leaf views shared by PlanWeekSheet and PlanMonthSheet. These are pure
// view-layer reuse — no parent state lives here. Keep rendered output pixel-identical
// to the originals (WF.* tokens, font sizes, spacing must match exactly).

/// A small pill button (icon + label) used in a review card's action row.
struct PlanActionChip: View {
    let icon: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 12, weight: .bold))
                Text(label).font(.system(size: 12, weight: .bold)).lineLimit(1).fixedSize()
            }
            .foregroundStyle(WF.ink2)
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(WF.panel).clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// A tiny metadata tag chip (e.g. "🕐 30m", "📖 Library").
struct PlanTag: View {
    let text: String

    var body: some View {
        Text(text).font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink2)
            .padding(.horizontal, 7).padding(.vertical, 2).background(WF.panel).clipShape(Capsule()).lineLimit(1)
    }
}

/// The "Use up first" card — a chip flow of ingredients to prioritize, plus an
/// inline add field. The parent owns `items` and `input`; this view is otherwise
/// self-contained (same 12-item cap and chip styling as both plan sheets).
struct UseUpCard: View {
    @Binding var items: [String]
    @Binding var input: String
    var title: String = "Use up first"
    var placeholder: String = "+ Add"

    var body: some View {
        WaffledCard(padding: 14) {
            VStack(alignment: .leading, spacing: 10) {
                Text(title).font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
                ChipFlow(spacing: 8, lineSpacing: 8) {
                    ForEach(items, id: \.self) { u in chip(u) }
                    TextField(placeholder, text: $input)
                        .font(.system(size: 14)).textInputAutocapitalization(.never)
                        .submitLabel(.done).onSubmit { add() }
                        .frame(minWidth: 80)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(WF.panel).clipShape(Capsule())
                }
            }
        }
    }

    private func chip(_ u: String) -> some View {
        HStack(spacing: 5) {
            Text(u).font(.system(size: 14, weight: .medium)).foregroundStyle(WF.ink)
            Button { items.removeAll { $0 == u } } label: {
                Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(WF.ink3)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(WF.panel).clipShape(Capsule())
    }

    private func add() {
        let v = input.trimmingCharacters(in: .whitespaces)
        guard !v.isEmpty, !items.contains(v), items.count < 12 else { input = ""; return }
        items.append(v); input = ""
    }
}

/// The full-screen loading state shown while the AI drafts a plan.
struct PlanLoadingView: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(spacing: 16) {
            ProgressView().controlSize(.large).tint(WF.ai)
            Text(title).font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink)
            Text(subtitle)
                .font(.system(size: 13)).foregroundStyle(WF.ink3).multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The full-screen empty/error message. Pass `onRetry` to show a "Try again" button.
struct PlanMessageView: View {
    let emoji: String
    let title: String
    let subtitle: String
    var onRetry: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 12) {
            Text(emoji).font(.system(size: 44))
            Text(title).font(.system(size: 18, weight: .bold)).foregroundStyle(WF.ink)
            Text(subtitle).font(.system(size: 14)).foregroundStyle(WF.ink3)
                .multilineTextAlignment(.center).padding(.horizontal, 40)
            if let onRetry {
                Button(action: onRetry) {
                    Text("Try again").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ai)
                }
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The compact drag preview shown while dragging a review card onto another night.
struct PlanCardDragPreview: View {
    let card: WaffledAPI.PlanCardDTO

    var body: some View {
        HStack(spacing: 5) {
            Text(card.emoji ?? "🍽️").font(.system(size: 14))
            Text(card.title).font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(WF.card).clipShape(Capsule()).overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1))
    }
}

/// The ✨ Reshuffle / Reshuffling… capsule in a review header. `isBusy` drives the
/// inline ProgressView + "Reshuffling…" label; the parent owns the disabled rule.
struct PlanReshuffleButton: View {
    var isBusy: Bool
    var isDisabled: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if isBusy {
                    ProgressView().controlSize(.small).tint(WF.ai)
                } else { Text("✨").font(.system(size: 13)) }
                Text(isBusy ? "Reshuffling…" : "Reshuffle")
                    .font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ai)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(WF.ai.opacity(0.10)).clipShape(Capsule())
        }
        .buttonStyle(.plain).disabled(isDisabled)
    }
}

/// A single review-night card shared by PlanWeekSheet and PlanMonthSheet. Stateless:
/// every bit of mutable state (locked/dirty/dragOverDate/redrafting/suggestions) stays
/// in the parent and is threaded in as plain values + closures. The few wording/layout
/// differences between week and month are parameterized:
///   - `metaTags`: the small tags row, built by the parent (week vs month wording).
///   - `belowTitleNote`: week shows its note as a line below the title; month passes nil
///     (month folds the note into `metaTags` instead).
///   - `onSkip`: month passes a closure → shows the trailing ✕; week passes nil.
///   - `titleMultilineLeading`: week applies `.multilineTextAlignment(.leading)` after
///     `.lineLimit(2)`; month applies only `.lineLimit(2)`.
/// The view modifier order (padding → background → clipShape → lock overlay → busy
/// overlay → animation → drag-target overlay → draggable → dropDestination) matches the
/// originals 1:1 — order is semantically load-bearing for drag/drop + the lock border.
struct MealPlanReviewCard: View {
    let card: WaffledAPI.PlanCardDTO
    let dayLabel: String
    let isLocked: Bool
    let isBusy: Bool
    let isDragTarget: Bool
    let metaTags: [String]
    let belowTitleNote: String?
    let titleMultilineLeading: Bool
    var onSkip: (() -> Void)? = nil
    /// Tap the emoji+title block to preview the candidate recipe. Optional so
    /// PlanMonthSheet (which doesn't wire it) keeps compiling and stays inert.
    var onOpen: (() -> Void)? = nil
    let onSwap: () -> Void
    let onPick: () -> Void
    let onToggleLock: () -> Void
    let onDrop: (String) -> Bool
    let onDragTargetChange: (Bool) -> Void
    let actionsDisabled: Bool

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 12) {
                Text(card.emoji ?? "🍽️").font(.system(size: 26))
                    .frame(width: 46, height: 46).background(RecipeGradient.forCategory(card.mealType))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(dayLabel).font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(WF.ink3)
                    titleText
                    HStack(spacing: 8) {
                        ForEach(metaTags, id: \.self) { PlanTag(text: $0) }
                    }
                    if let note = belowTitleNote, !note.isEmpty {
                        Text(note).font(.system(size: 12)).foregroundStyle(WF.ink3).lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                if let onSkip {
                    Button(action: onSkip) {
                        Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                            .frame(width: 28, height: 28).background(WF.panel).clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                }
            }
            // Tap the emoji+title block to preview the recipe. The inner ✕ Button keeps
            // its own tap; this coexists with the card's `.draggable` (same pattern as
            // WeekPlannerView.entryRow). No-op when onOpen is nil (PlanMonthSheet).
            .contentShape(Rectangle())
            .onTapGesture { onOpen?() }
            Divider().background(WF.hair)
            HStack(spacing: 8) {
                PlanActionChip(icon: "arrow.triangle.2.circlepath", label: "Swap", action: onSwap)
                    .disabled(actionsDisabled)
                PlanActionChip(icon: "book", label: "Pick", action: onPick)
                    .disabled(actionsDisabled)
                Spacer()
                Button(action: onToggleLock) {
                    HStack(spacing: 5) {
                        Image(systemName: isLocked ? "lock.fill" : "lock.open")
                            .font(.system(size: 12, weight: .bold))
                        Text(isLocked ? "Locked" : "Lock").font(.system(size: 12, weight: .bold)).lineLimit(1).fixedSize()
                    }
                    .foregroundStyle(isLocked ? .white : WF.ink2)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(isLocked ? WF.primary : WF.panel).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(13)
        .background(WF.card)
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
            .strokeBorder(isLocked ? WF.primary.opacity(0.45) : WF.hair, lineWidth: 1))
        .overlay {
            if isBusy {
                RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).fill(WF.card.opacity(0.7))
                    .overlay(ProgressView().controlSize(.small).tint(WF.ai))
            }
        }
        .animation(.easeInOut(duration: 0.15), value: isLocked)
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
            .strokeBorder(isDragTarget ? WF.ai : .clear, lineWidth: 2))
        .draggable(card.date) { PlanCardDragPreview(card: card) }
        .dropDestination(for: String.self) { items, _ in
            guard let s = items.first else { return false }
            return onDrop(s)
        } isTargeted: { onDragTargetChange($0) }
    }

    /// The title line. Week appends `.multilineTextAlignment(.leading)` after
    /// `.lineLimit(2)`; month stops at `.lineLimit(2)`. Kept as distinct branches so
    /// the modifier chain is byte-identical to each original.
    @ViewBuilder private var titleText: some View {
        if titleMultilineLeading {
            Text(card.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                .lineLimit(2).multilineTextAlignment(.leading)
        } else {
            Text(card.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                .lineLimit(2)
        }
    }
}

/// The bottom Divider + full-width primary action button shared by both plan sheets.
/// The parent passes the already-resolved `label` (e.g. "Add 5 & build list" /
/// "Save month & build list"); when `isBusy` the bar shows a ProgressView.
///
/// `isInactive` drives the gray vs. WF.ai tint (originally `suggestions.isEmpty`),
/// while `isDisabled` is the broader gate (originally
/// `suggestions.isEmpty || applying || redrafting`). These differ on purpose: a
/// busy bar with suggestions still shows the blue tint while disabled.
struct PlanApplyBar: View {
    var isBusy: Bool
    var isInactive: Bool
    var isDisabled: Bool
    var label: String
    var action: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Divider().background(WF.hair)
            Button(action: action) {
                HStack(spacing: 8) {
                    if isBusy { ProgressView().controlSize(.small).tint(.white) }
                    Text(label)
                        .font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 14)
                .background(isInactive ? WF.ink3 : WF.ai)
                .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            }
            .buttonStyle(.plain).disabled(isDisabled)
            .padding(.horizontal, 16).padding(.vertical, 12)
        }
        .background(WF.canvas)
    }
}
