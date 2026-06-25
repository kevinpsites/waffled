import SwiftUI

/// The full-screen family-display screensaver — the iPad twin of the web kiosk's
/// `Screensaver`. With `content == "photos"` and photos present it cross-fades through
/// them (a slow Ken-Burns drift on top) as the background; otherwise a calm dark
/// gradient ("clock & weather"). Always overlays a big clock + date · weather, the next
/// event, the current photo's album, and a "tap anywhere to wake" hint. Tapping wakes it.
struct ScreensaverView: View {
    let content: String                 // "photos" | "clock"
    let photos: [NookAPI.Photo]
    let weather: NookAPI.Weather?
    let nextEvent: SyncedEvent?
    let timezone: TimeZone
    let dimmed: Bool                    // night-dim window → darken everything
    let onWake: () -> Void

    @State private var idx = 0
    @State private var prevIdx = 0
    @State private var zoom = 1.0
    @State private var now = Date()

    // ~9s per photo; the clock re-renders every 30s. Fixed cadence — the iOS display
    // config doesn't carry a per-photo interval (the web's does).
    private let perPhoto: TimeInterval = 9
    private let clockTick = Timer.publish(every: 30, on: .main, in: .common).autoconnect()
    private let slideTick = Timer.publish(every: 9, on: .main, in: .common).autoconnect()

    private var photoMode: Bool { content == "photos" && !photos.isEmpty }

    var body: some View {
        ZStack {
            background
            // Scrim for legibility — darker at the corners where the text sits.
            LinearGradient(colors: [.black.opacity(0.45), .clear, .clear, .black.opacity(0.5)],
                           startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            chrome
            if dimmed { Color.black.opacity(0.62).ignoresSafeArea() }
        }
        .ignoresSafeArea()
        .contentShape(Rectangle())
        .onTapGesture { onWake() }
        .onReceive(clockTick) { now = $0 }
        .onReceive(slideTick) { _ in advance() }
        .onAppear { startKenBurns() }
    }

    // MARK: background (cross-fading photos, or a calm gradient)

    @ViewBuilder private var background: some View {
        if photoMode {
            ZStack {
                photoFill(photos[prevIdx % photos.count])               // the photo we're leaving
                photoFill(photos[idx % photos.count])                   // fades in over it
                    .scaleEffect(zoom)
                    .id(idx)
                    .transition(.opacity)
            }
            .ignoresSafeArea()
        } else {
            LinearGradient(colors: [Color(hex: 0x2B2B2B), Color(hex: 0x161616)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
                .ignoresSafeArea()
        }
    }

    /// A photo filling the screen. The image lives in an overlay over a flexible spacer
    /// and is clipped, so scaledToFill can't inflate the layout (the tile-bleed fix).
    private func photoFill(_ p: NookAPI.Photo) -> some View {
        Color.clear
            .overlay {
                if let url = MediaURL.resolve(p.imageUrl) {
                    AsyncImage(url: url) { phase in
                        if let img = phase.image { img.resizable().scaledToFill() }
                        else { tile(p) }
                    }
                } else { tile(p) }
            }
            .clipped()
    }

    private func tile(_ p: NookAPI.Photo) -> some View {
        let c = Color(hexString: p.colorHex) ?? Color(hex: 0x7FC1E8)
        return ZStack {
            LinearGradient(colors: [c, c.opacity(0.7)], startPoint: .topLeading, endPoint: .bottomTrailing)
            Text(p.emoji ?? "🖼️").font(.system(size: 160))
        }
    }

    // MARK: chrome (clock · weather · next event · album · wake)

    private var chrome: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Clock + date · weather, top-left.
            VStack(alignment: .leading, spacing: 4) {
                Text(timeString).font(NK.serif(112)).foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.4), radius: 16, y: 2)
                Text(dateLine).font(.system(size: 24, weight: .semibold)).foregroundStyle(.white.opacity(0.95))
                    .shadow(color: .black.opacity(0.4), radius: 12, y: 1)
            }
            Spacer(minLength: 0)
            // Album (left) + next event / wake hint (right) along the bottom.
            HStack(alignment: .bottom) {
                if let label = albumLabel {
                    Text(label).font(NK.serif(30)).foregroundStyle(.white)
                        .shadow(color: .black.opacity(0.45), radius: 14, y: 1).lineLimit(1)
                }
                Spacer(minLength: 16)
                VStack(alignment: .trailing, spacing: 12) {
                    if let ev = nextEventLine {
                        Text(ev).font(.system(size: 19, weight: .heavy)).foregroundStyle(.white)
                            .shadow(color: .black.opacity(0.45), radius: 12, y: 1).lineLimit(1)
                    }
                    Text("Tap anywhere to wake")
                        .font(.system(size: 14, weight: .bold)).foregroundStyle(.white.opacity(0.85))
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(.ultraThinMaterial, in: Capsule())
                        .environment(\.colorScheme, .dark)
                }
            }
        }
        .padding(.horizontal, 54).padding(.top, 46).padding(.bottom, 40)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: slideshow timing

    private func advance() {
        guard photoMode, photos.count > 1 else { return }
        prevIdx = idx
        withAnimation(.easeInOut(duration: 1.1)) { idx = (idx + 1) % photos.count }
        startKenBurns()
    }

    /// Reset the top photo to 1.0 then slowly drift to 1.08 across its time on screen,
    /// for the gentle "alive" motion the web slideshow has.
    private func startKenBurns() {
        guard photoMode else { return }
        zoom = 1.0
        withAnimation(.easeInOut(duration: perPhoto + 1.2)) { zoom = 1.08 }
    }

    // MARK: formatting

    private var timeString: String {
        let f = DateFormatter(); f.timeZone = timezone; f.dateFormat = "h:mm"
        return f.string(from: now)
    }
    private var dateLine: String {
        let f = DateFormatter(); f.timeZone = timezone; f.dateFormat = "EEEE, MMMM d"
        let date = f.string(from: now)
        if let w = weather, w.configured, let t = w.tempF {
            let parts = ["\(w.emoji ?? "")\(w.emoji == nil ? "" : " ")\(Int(t.rounded()))°", w.label].compactMap { $0 }.filter { !$0.isEmpty }
            return "\(date) · \(parts.joined(separator: " · "))"
        }
        return date
    }
    private var albumLabel: String? {
        guard photoMode else { return nil }
        let p = photos[idx % photos.count]
        let label = p.memory ?? (p.caption.isEmpty ? nil : p.caption)
        return label?.isEmpty == false ? label : nil
    }
    private var nextEventLine: String? {
        guard let ev = nextEvent else { return nil }
        if ev.allDay { return "Next: \(ev.title)" }
        guard let when = ev.startsAt else { return "Next: \(ev.title)" }
        let f = DateFormatter(); f.timeZone = timezone; f.dateFormat = "h:mm"
        return "Next: \(ev.title) · \(f.string(from: when))"
    }
}
