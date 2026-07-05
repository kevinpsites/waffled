import SwiftUI
import UIKit

/// The full-screen family-display screensaver — the iPad twin of the web kiosk's
/// `Screensaver`. With `content == "photos"` and photos present it cross-fades through
/// them (a slow Ken-Burns drift on top) as the background; otherwise a calm dark
/// gradient ("clock & weather"). Always overlays a big clock + date · weather, the next
/// event, the current photo's album, and a "tap anywhere to wake" hint. Tapping wakes it.
struct ScreensaverView: View {
    let content: String                 // "photos" | "clock"
    let photos: [WaffledAPI.Photo]
    let weather: WaffledAPI.Weather?
    let nextEvent: SyncedEvent?
    let timezone: TimeZone
    let dimmed: Bool                    // night-dim window → darken everything
    /// Seconds each photo stays on screen (from the display config; clamped to ≥3).
    var interval: Int = 8
    /// A pure photo slideshow with no clock / weather / next-event / album overlays —
    /// the manual "Play" from the Photos tab. The idle kiosk saver leaves this false.
    var bare: Bool = false
    /// Slow Ken-Burns drift on each photo (device-local preference). Off = photos sit still.
    var motion: Bool = true
    let onWake: () -> Void

    @State private var idx = 0
    @State private var prevIdx = 0
    @State private var now = Date()
    @State private var elapsed = 0

    // One 1-second heartbeat drives both the clock and the slideshow cadence, so the
    // per-photo interval is just a number (no need to re-arm a publisher).
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()
    private var perPhoto: TimeInterval { Double(max(3, interval)) }

    private var photoMode: Bool { content == "photos" && !photos.isEmpty }

    var body: some View {
        ZStack {
            background
            if !bare {
                // Scrim for legibility — darker at the corners where the text sits.
                LinearGradient(colors: [.black.opacity(0.45), .clear, .clear, .black.opacity(0.5)],
                               startPoint: .top, endPoint: .bottom)
                    .ignoresSafeArea()
                chrome
            } else {
                // Even a bare slideshow needs a way out — keep just the wake hint.
                VStack { Spacer(); HStack { Spacer(); wakeHint } }
                    .padding(.horizontal, 54).padding(.bottom, 40)
            }
            if dimmed { Color.black.opacity(0.62).ignoresSafeArea() }
        }
        .ignoresSafeArea()
        .contentShape(Rectangle())
        .onTapGesture { onWake() }
        .onReceive(tick) { t in
            now = t
            elapsed += 1
            if elapsed >= Int(perPhoto) { elapsed = 0; advance() }
        }
        .onAppear { ScreensaverImageCache.shared.prefetch(photos) }
    }

    // MARK: background (cross-fading photos, or a calm gradient)

    @ViewBuilder private var background: some View {
        if photoMode {
            ZStack {
                // The photo we're leaving sits underneath, static, so the incoming one
                // fades in over a real image — never over a blank/placeholder frame.
                SlidePhoto(photo: photos[prevIdx % photos.count], motion: false, duration: perPhoto)
                SlidePhoto(photo: photos[idx % photos.count], motion: motion, duration: perPhoto + 1.2)
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

    // MARK: chrome (clock · weather · next event · album · wake)

    private var chrome: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Clock + date · weather, top-left.
            VStack(alignment: .leading, spacing: 4) {
                Text(timeString).font(WF.serif(112)).foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.4), radius: 16, y: 2)
                Text(dateLine).font(.system(size: 24, weight: .semibold)).foregroundStyle(.white.opacity(0.95))
                    .shadow(color: .black.opacity(0.4), radius: 12, y: 1)
            }
            Spacer(minLength: 0)
            // Album (left) + next event / wake hint (right) along the bottom.
            HStack(alignment: .bottom) {
                if let label = albumLabel {
                    Text(label).font(WF.serif(30)).foregroundStyle(.white)
                        .shadow(color: .black.opacity(0.45), radius: 14, y: 1).lineLimit(1)
                }
                Spacer(minLength: 16)
                VStack(alignment: .trailing, spacing: 12) {
                    if let ev = nextEventLine {
                        Text(ev).font(.system(size: 19, weight: .heavy)).foregroundStyle(.white)
                            .shadow(color: .black.opacity(0.45), radius: 12, y: 1).lineLimit(1)
                    }
                    wakeHint
                }
            }
        }
        .padding(.horizontal, 54).padding(.top, 46).padding(.bottom, 40)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var wakeHint: some View {
        Text("Tap anywhere to wake")
            .font(.system(size: 14, weight: .bold)).foregroundStyle(.white.opacity(0.85))
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(.ultraThinMaterial, in: Capsule())
            .environment(\.colorScheme, .dark)
    }

    // MARK: slideshow timing

    private func advance() {
        guard photoMode, photos.count > 1 else { return }
        let next = (idx + 1) % photos.count
        // Warm the cache for the photo after next, so its turn is flash-free too.
        ScreensaverImageCache.shared.prefetch([photos[(next + 1) % photos.count]])
        prevIdx = idx
        withAnimation(.easeInOut(duration: 1.1)) { idx = next }
        // Each SlidePhoto runs its own Ken-Burns on appear, so there's nothing to reset.
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

// MARK: - Cached, self-animating slideshow photo

/// One full-screen slideshow photo, backed by an in-memory cache so a re-shown image
/// appears instantly (no AsyncImage placeholder flash mid-crossfade). Runs its own slow
/// Ken-Burns drift on appear when `motion` is on, so the outgoing photo is never affected.
private struct SlidePhoto: View {
    let photo: WaffledAPI.Photo
    let motion: Bool
    let duration: Double

    @State private var image: UIImage?
    @State private var scale = 1.0

    var body: some View {
        Color.clear
            .overlay {
                if let image {
                    Image(uiImage: image).resizable().scaledToFill().scaleEffect(scale)
                } else {
                    tile
                }
            }
            .clipped()
            .task(id: photo.id) { await loadAndAnimate() }
    }

    private func loadAndAnimate() async {
        scale = 1.0
        if let url = MediaURL.resolve(photo.imageUrl) {
            // Synchronous when already cached → the crossfade reveals a real image, not a
            // placeholder. Falls back to an async fetch the first time only.
            if let hit = ScreensaverImageCache.shared.cached(url) {
                image = hit
            } else {
                image = await ScreensaverImageCache.shared.load(url)
            }
        } else {
            image = nil
        }
        guard motion, image != nil else { return }
        withAnimation(.easeInOut(duration: duration)) { scale = 1.08 }
    }

    private var tile: some View {
        let c = Color(hexString: photo.colorHex) ?? Color(hex: 0x7FC1E8)
        return ZStack {
            LinearGradient(colors: [c, c.opacity(0.7)], startPoint: .topLeading, endPoint: .bottomTrailing)
            Text(photo.emoji ?? "🖼️").font(.system(size: 160))
        }
    }
}

/// Tiny decoded-image cache for the screensaver. NSCache is thread-safe; loads dedupe to
/// the cache, and a capped sequential prefetch warms upcoming photos in the background.
final class ScreensaverImageCache: @unchecked Sendable {
    static let shared = ScreensaverImageCache()
    private let cache = NSCache<NSURL, UIImage>()
    private init() { cache.countLimit = 240 }

    func cached(_ url: URL) -> UIImage? { cache.object(forKey: url as NSURL) }

    @discardableResult
    func load(_ url: URL) async -> UIImage? {
        if let img = cached(url) { return img }
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let img = UIImage(data: data) else { return nil }
        cache.setObject(img, forKey: url as NSURL)
        return img
    }

    /// Warm the cache for a batch of photos (sequential, capped) without blocking.
    func prefetch(_ photos: [WaffledAPI.Photo]) {
        let urls = photos.prefix(60).compactMap { MediaURL.resolve($0.imageUrl) }.filter { cached($0) == nil }
        guard !urls.isEmpty else { return }
        Task.detached(priority: .utility) {
            for url in urls { _ = await self.load(url) }
        }
    }
}
