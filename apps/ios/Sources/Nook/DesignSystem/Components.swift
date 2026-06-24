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

/// A centered loading spinner with the standard Nook tint + breathing room. Use this
/// for the first-load state of any list screen so the spinner sits consistently across
/// the app instead of each screen picking its own padding.
struct NookLoading: View {
    var top: CGFloat = 48
    var body: some View {
        ProgressView()
            .tint(NK.ink3)
            .frame(maxWidth: .infinity)
            .padding(.top, top)
    }
}

/// A friendly centered empty state — big emoji, a bold title, and an optional line of
/// supporting copy. The shared shape behind every "all caught up" / "nothing here yet"
/// screen so they read the same everywhere.
struct NookEmptyState: View {
    let emoji: String
    let title: String
    var message: String? = nil
    var top: CGFloat = 56

    var body: some View {
        VStack(spacing: 12) {
            Text(emoji).font(.system(size: 48))
            Text(title).font(.system(size: 17, weight: .bold)).foregroundStyle(NK.ink)
            if let message {
                Text(message)
                    .font(.system(size: 13)).foregroundStyle(NK.ink3)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, top)
        .padding(.horizontal, 24)
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

/// A small `chevron.right` that rotates 90° when its section is open — the shared
/// disclosure indicator for collapsible headers. Stateless: pass the open flag.
struct DisclosureChevron: View {
    var isOpen: Bool
    var size: CGFloat = 11
    var weight: Font.Weight = .heavy
    var color: Color = NK.ink3

    var body: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: size, weight: weight))
            .foregroundStyle(color)
            .rotationEffect(.degrees(isOpen ? 90 : 0))
    }
}

/// The little capsule used as a `Menu` label — bold text plus a down chevron. Shared by
/// the Plan sheets so every "tap to change" menu trigger looks identical.
struct NookMenuPill: View {
    var text: String

    var body: some View {
        HStack(spacing: 6) {
            Text(text).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
            Image(systemName: "chevron.down").font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink3)
        }
        .padding(.horizontal, 14).padding(.vertical, 9).background(NK.panel).clipShape(Capsule())
    }
}

/// A weekday toggle chip — a full-width pill that fills coral when on. Shared by the
/// Plan-my-week and Plan-my-month sheets so both day selectors look identical.
struct WeekdayToggleChip: View {
    let label: String
    let isOn: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label).font(.system(size: 14, weight: .heavy)).foregroundStyle(isOn ? .white : NK.ink2)
                .lineLimit(1).minimumScaleFactor(0.75)
                .frame(maxWidth: .infinity).frame(height: 44)
                .background(isOn ? NK.primary : NK.card)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(isOn ? .clear : NK.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}
