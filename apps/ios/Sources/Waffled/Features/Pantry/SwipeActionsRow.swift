import SwiftUI

/// Swipe-to-reveal trailing actions for a row that lives inside a *vertical* ScrollView
/// / LazyVGrid — where SwiftUI's native `List.swipeActions` isn't available. Left-swipe
/// reveals Edit + Delete; keep pulling past the threshold to delete outright, like the
/// system list. The gesture is horizontal-only, so it coexists with the enclosing
/// vertical scroll. Pass a shared `openId` binding so opening one row closes the others.
struct SwipeActionsRow<Content: View>: View {
    let id: String
    @Binding var openId: String?
    var onEdit: () -> Void
    var onDelete: () -> Void
    @ViewBuilder var content: Content

    @State private var offset: CGFloat = 0
    @State private var dragging = false
    @State private var base: CGFloat = 0

    private let button: CGFloat = 78
    private var fullyOpen: CGFloat { -button * 2 }
    /// Pulled this far past fully-open → treat the release as a delete.
    private var deleteAt: CGFloat { fullyOpen - 80 }
    private var revealed: Bool { offset < -1 }

    var body: some View {
        ZStack(alignment: .trailing) {
            actions
            content
                .background(WF.card)   // opaque so the buttons stay hidden at rest
                .overlay {
                    // While open, a tap on the row closes it instead of activating the card.
                    if revealed {
                        Color.black.opacity(0.0001).contentShape(Rectangle())
                            .onTapGesture { close() }
                    }
                }
                .offset(x: offset)
                .gesture(drag)
        }
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .onChange(of: openId) { _, new in
            if new != id, revealed, !dragging { close() }
        }
    }

    // MARK: reveal buttons

    private var actions: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            actionButton("Edit", "pencil", WF.ink) { close(); onEdit() }
            actionButton("Delete", "trash", Color(hex: 0xD8443A)) { close(); onDelete() }
        }
    }

    private func actionButton(_ title: String, _ icon: String, _ bg: Color, _ tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            VStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 17, weight: .semibold))
                Text(title).font(.system(size: 12, weight: .bold))
            }
            .foregroundStyle(.white)
            .frame(width: button).frame(maxHeight: .infinity)
            .background(bg)
        }.buttonStyle(.plain)
    }

    // MARK: gesture

    private var drag: some Gesture {
        DragGesture(minimumDistance: 14)
            .onChanged { v in
                if !dragging {
                    dragging = true
                    base = offset
                    if openId != id { openId = id }
                }
                // Only track predominantly-horizontal movement (let vertical scroll win).
                guard abs(v.translation.width) > abs(v.translation.height) || revealed else { return }
                offset = min(0, max(base + v.translation.width, deleteAt - 24))
            }
            .onEnded { v in
                dragging = false
                let x = min(0, base + v.translation.width)
                withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) {
                    if x < deleteAt {
                        offset = 0
                        if openId == id { openId = nil }
                        onDelete()
                    } else if x < fullyOpen / 2 {
                        offset = fullyOpen
                        openId = id
                    } else {
                        offset = 0
                        if openId == id { openId = nil }
                    }
                }
            }
    }

    private func close() {
        withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { offset = 0 }
        if openId == id { openId = nil }
    }
}
