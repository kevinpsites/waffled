import SwiftUI

// Reusable Nook building blocks — the SwiftUI equivalents of nook.css's
// `.card`, `.pill`, `.av`, section labels and the AI capture bar.

/// A white rounded surface (`.card`). Pass the content; padding/insets are the
/// caller's choice so it works for both list cards and split media cards.
struct NookCard<Content: View>: View {
    var padding: CGFloat = 16
    var radius: CGFloat = NK.rLG
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(NK.card)
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .nkShadow1()
    }
}

/// An uppercase section label (e.g. "EVERYTHING ELSE", "WALLY'S DAY").
struct SectionLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 12.5, weight: .heavy))
            .tracking(0.6)
            .foregroundStyle(NK.ink3)
    }
}

/// A rounded chip (`.pill`).
struct Pill: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.system(size: 12, weight: .semibold))
            .padding(.horizontal, 12).padding(.vertical, 5)
            .background(NK.panel)
            .foregroundStyle(NK.ink2)
            .clipShape(Capsule())
    }
}

/// A person avatar (`.av`) — emoji on a soft tint. Works from either a design
/// `FamilyColor` (static screens) or a real `color_hex` string (synced data).
struct Avatar: View {
    let tint: Color
    let emoji: String
    var size: CGFloat = 34

    init(person: FamilyColor, emoji: String, size: CGFloat = 34) {
        self.tint = person.tint
        self.emoji = emoji
        self.size = size
    }

    init(tint: Color, emoji: String, size: CGFloat = 34) {
        self.tint = tint
        self.emoji = emoji
        self.size = size
    }

    /// Synced member: derive a soft tint from the stored hex (falls back to panel).
    init(colorHex: String?, emoji: String, size: CGFloat = 34) {
        self.tint = Color(hexString: colorHex)?.opacity(0.16) ?? NK.panel
        self.emoji = emoji
        self.size = size
    }

    var body: some View {
        Text(emoji)
            .font(.system(size: size * 0.52))
            .frame(width: size, height: size)
            .background(tint)
            .clipShape(Circle())
    }
}

/// The "Add anything…" capture bar shown on Today. Tapping it is wired by the
/// caller (Phase 2 opens the AI capture sheet).
struct AICaptureBar: View {
    var placeholder: String = "Add anything…"
    var onTap: () -> Void = {}
    var onMic: () -> Void = {}

    var body: some View {
        HStack(spacing: 11) {
            ZStack {
                Circle().fill(NK.ai)
                Image(systemName: "sparkles")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
            }
            .frame(width: 30, height: 30)

            Text(placeholder)
                .font(.system(size: 16))
                .foregroundStyle(NK.ink3)
            Spacer(minLength: 0)

            Button(action: onMic) {
                Image(systemName: "mic.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(NK.ink3)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12).padding(.vertical, 11)
        .background(NK.card)
        .clipShape(Capsule())
        .overlay(Capsule().stroke(NK.hair, lineWidth: 1))
        .nkShadow1()
        .contentShape(Capsule())
        .onTapGesture(perform: onTap)
    }
}
