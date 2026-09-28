import SwiftUI

/// The setup window's palette and type, from the design.
///
/// It commits to one light appearance rather than following the system: this window is a
/// household's first sight of Waffled, it is shown once, and the design is a warm paper
/// ground the menu bar's monochrome mark deliberately is not. The window forces
/// `.aqua` (`FirstRunWindow`), so these colours are never drawn on a dark ground.
enum SetupTheme {
    static let background = Color(red: 0.980, green: 0.969, blue: 0.949) // #FAF7F2
    static let panel = Color(red: 0.957, green: 0.937, blue: 0.906)      // #F4EFE7
    static let ink = Color(red: 0.114, green: 0.114, blue: 0.122)        // #1D1D1F
    static let inkSecondary = Color(red: 0.420, green: 0.420, blue: 0.439) // #6B6B70
    static let inkTertiary = Color(red: 0.651, green: 0.635, blue: 0.608)  // #A6A29B
    static let primary = Color(red: 0.925, green: 0.376, blue: 0.286)    // #EC6049
    static let green = Color(red: 0.145, green: 0.639, blue: 0.408)      // #25A368
    static let noteBackground = Color(red: 0.992, green: 0.965, blue: 0.902) // #FDF6E6
    static let hairline = Color(red: 0.114, green: 0.114, blue: 0.122).opacity(0.10)

    /// The window is a fixed size in the design, and every step is laid out inside it.
    static let windowSize = CGSize(width: 940, height: 648)
    static let footerHeight: CGFloat = 72
    static let pad: CGFloat = 40

    static func title(_ size: CGFloat) -> Font { .system(size: size, weight: .semibold, design: .serif) }
    static let body = Font.system(size: 14)
    static let small = Font.system(size: 12.5)
    static let mono = Font.system(size: 13, design: .monospaced)
    static let eyebrow = Font.system(size: 11, weight: .semibold).monospaced()
}

/// The footer's three slots, in the design's order: the quiet action on the left, then
/// the secondary and the primary on the right.
struct SetupFooter: View {
    var tertiary: (label: String, action: () -> Void)?
    var secondary: (label: String, action: () -> Void)?
    var primary: (label: String, action: () -> Void)?
    var primaryEnabled = true

    var body: some View {
        HStack(spacing: 10) {
            if let tertiary {
                Button(tertiary.label, action: tertiary.action)
                    .buttonStyle(SetupButton(kind: .quiet))
            }
            Spacer(minLength: 0)
            if let secondary {
                Button(secondary.label, action: secondary.action)
                    .buttonStyle(SetupButton(kind: .ghost))
            }
            if let primary {
                Button(primary.label, action: primary.action)
                    .buttonStyle(SetupButton(kind: .primary))
                    .keyboardShortcut(.defaultAction)
                    .disabled(!primaryEnabled)
            }
        }
        .padding(.horizontal, SetupTheme.pad)
        .frame(height: SetupTheme.footerHeight)
        .background(SetupTheme.panel)
        .overlay(alignment: .top) { Rectangle().fill(SetupTheme.hairline).frame(height: 1) }
    }
}

struct SetupButton: ButtonStyle {
    enum Kind { case primary, ghost, quiet }
    var kind: Kind
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: kind == .primary ? .semibold : .regular))
            .foregroundStyle(foreground)
            .padding(.horizontal, kind == .quiet ? 4 : 18)
            .padding(.vertical, 10)
            .background(background(pressed: configuration.isPressed))
            .clipShape(RoundedRectangle(cornerRadius: 9))
            .opacity(isEnabled ? 1 : 0.45)
            .contentShape(Rectangle())
    }

    private var foreground: Color {
        switch kind {
        case .primary: return .white
        case .ghost: return SetupTheme.ink
        case .quiet: return SetupTheme.inkSecondary
        }
    }

    @ViewBuilder
    private func background(pressed: Bool) -> some View {
        switch kind {
        case .primary:
            // #D84A33, the design's pressed shade.
            RoundedRectangle(cornerRadius: 9)
                .fill(pressed ? Color(red: 0.847, green: 0.290, blue: 0.200) : SetupTheme.primary)
        case .ghost:
            RoundedRectangle(cornerRadius: 9)
                .fill(Color.white.opacity(pressed ? 0.5 : 1))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(SetupTheme.hairline))
        case .quiet:
            Color.clear
        }
    }
}

/// The tick the design uses for a promise, a finished service and the ready step.
struct SetupTick: View {
    var side: CGFloat = 18
    var filled = true

    var body: some View {
        ZStack {
            Circle().fill(filled ? SetupTheme.green : SetupTheme.green.opacity(0.14))
            Image(systemName: "checkmark")
                .font(.system(size: side * 0.5, weight: .bold))
                .foregroundStyle(filled ? Color.white : SetupTheme.green)
        }
        .frame(width: side, height: side)
    }
}
