import AppKit

/// The Waffled mark, drawn for the menu bar: the closed waffle iron from the logo —
/// knob, lid, base — as a monochrome template image.
///
/// It is drawn rather than shipped as an asset because a menu-bar image has to be a
/// template (macOS recolours it for light bars, dark bars and the menu's own highlight)
/// and because the state is carried by the *shape*: outlined while nothing is running,
/// cooking hole by hole while it starts, solid when it is up, slashed when it needs
/// looking at. A single asset cannot do that, and colour is not available to say it.
///
/// The geometry is fractions of the square with the origin bottom-left, which is how it
/// was drawn and approved at 18 pt; everything scales from `pointSize`.
///
/// Main-actor by declaration, not by convention: the cache below is a plain dictionary,
/// and every caller today is the main-actor model — this makes the compiler hold that
/// line for whoever adds the next caller.
@MainActor
enum WaffleIronIcon {
    /// The lid carries a 3 × 2 grid — six holes, which is also the length of the cooking
    /// animation.
    nonisolated static let columns = 3
    nonisolated static let rows = 2
    nonisolated static var holeCount: Int { columns * rows }

    // Fractions of the square. Bottom-left origin, matching CoreGraphics.
    private static let knobFraction = CGRect(x: 0.38, y: 0.86, width: 0.24, height: 0.10)
    private static let lidFraction = CGRect(x: 0.04, y: 0.34, width: 0.92, height: 0.50)
    private static let baseFraction = CGRect(x: 0.10, y: 0.04, width: 0.80, height: 0.24)
    /// 1.6 pt at 18 pt, scaled from there.
    private static let strokeAt18: CGFloat = 1.6

    private struct Frame: Hashable {
        var state: RuntimeState
        var fillCount: Int
        var pointSize: CGFloat
    }

    /// Drawn once per state and frame. The icon is asked for on every poll and on every
    /// animation tick — twice a second between them — and nothing about it changes in
    /// between. Only ever touched from the main thread, like everything else the menu
    /// bar reads.
    private static var cache: [Frame: NSImage] = [:]

    /// The image for a state. `fillCount` is how many holes have cooked, and means
    /// something only while `starting`; the other states ignore it.
    static func image(state: RuntimeState, fillCount: Int = 0, pointSize: CGFloat = 18) -> NSImage {
        let frame = Frame(state: state, fillCount: fillCount, pointSize: pointSize)
        if let cached = cache[frame] { return cached }

        // The block initialiser renders at the display's own scale — no hand-rolled 2x
        // bitmap — and hands back a bottom-left origin, which is what the fractions above
        // are written in.
        let image = NSImage(size: NSSize(width: pointSize, height: pointSize),
                            flipped: false) { _ in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            draw(in: context, size: pointSize, state: state, fillCount: fillCount)
            return true
        }
        image.isTemplate = true
        cache[frame] = image
        return image
    }

    // MARK: - the drawing

    private static func draw(in context: CGContext, size: CGFloat,
                             state: RuntimeState, fillCount: Int) {
        let stroke = max(1, size / 18 * strokeAt18)
        context.setShouldAntialias(true)
        context.setLineWidth(stroke)
        context.setStrokeColor(NSColor.black.cgColor)
        context.setFillColor(NSColor.black.cgColor)

        let knob = scale(knobFraction, size)
        let lid = scale(lidFraction, size)
        let base = scale(baseFraction, size)
        let holes = holeRects(in: lid)

        if state == .running {
            // Solid iron with the holes knocked out of it: even-odd, so the grid stays
            // visible as holes rather than being painted over by the lid.
            context.saveGState()
            for pill in [knob, lid, base] { context.addPath(pillPath(pill)) }
            for hole in holes { context.addRect(hole) }
            context.drawPath(using: .eoFill)
            context.restoreGState()
            return
        }

        // Outlined. The stroke straddles the path, so the rectangles come in by half a
        // line width to keep the mark inside its square.
        for pill in [knob, lid, base] {
            context.addPath(pillPath(pill.insetBy(dx: stroke / 2, dy: stroke / 2)))
        }
        context.strokePath()

        // Cooking: the holes fill one at a time, top row first, which is the only motion
        // in the icon and reads as a waffle browning rather than a blinking light.
        let cooked = state == .starting ? min(max(fillCount, 0), holes.count) : 0
        for (index, hole) in holes.enumerated() {
            if index < cooked {
                context.fill(hole)
            } else {
                context.setLineWidth(stroke * 0.6)
                context.stroke(hole)
                context.setLineWidth(stroke)
            }
        }

        if state == .unhealthy {
            // A slash across the whole mark, a touch heavier than the outline so it reads
            // at 18 pt as "this one is not right" and not as part of the iron.
            context.setLineWidth(stroke * 1.2)
            context.move(to: CGPoint(x: size * 0.15, y: size * 0.08))
            context.addLine(to: CGPoint(x: size * 0.85, y: size * 0.92))
            context.strokePath()
        }
    }

    /// The grid of square holes on the lid, in cooking order: top row left to right,
    /// then the row below it.
    private static func holeRects(in lid: CGRect) -> [CGRect] {
        let grid = lid.insetBy(dx: lid.height * 0.30, dy: lid.height * 0.20)
        let cellWidth = grid.width / CGFloat(columns)
        let cellHeight = grid.height / CGFloat(rows)
        let side = min(cellWidth, cellHeight) * 0.66

        return (0..<rows).flatMap { row in
            (0..<columns).map { column -> CGRect in
                // Row 0 is the top one: the fractions are bottom-left, the cooking is not.
                let fromBottom = rows - 1 - row
                return CGRect(
                    x: grid.minX + CGFloat(column) * cellWidth + (cellWidth - side) / 2,
                    y: grid.minY + CGFloat(fromBottom) * cellHeight + (cellHeight - side) / 2,
                    width: side, height: side)
            }
        }
    }

    private static func scale(_ fraction: CGRect, _ size: CGFloat) -> CGRect {
        CGRect(x: size * fraction.minX, y: size * fraction.minY,
               width: size * fraction.width, height: size * fraction.height)
    }

    private static func pillPath(_ rect: CGRect) -> CGPath {
        let radius = rect.height / 2
        return CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius,
                      transform: nil)
    }
}
