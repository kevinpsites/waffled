import SwiftUI
import UIKit

/// Drives the iPad family-display screensaver: watches for inactivity, and once the
/// household's "Screensaver after N min" elapses with no touches, layers `ScreensaverView`
/// over the whole kiosk. Any touch wakes it. Honors the Display & Kiosk config — the
/// idle delay, content mode (photos / clock / off), and the night-dim window — the same
/// settings a web kiosk reads. Attach with `.kioskScreensaver()` on the kiosk root.
@MainActor
@Observable
final class ScreensaverModel {
    var cfg: NookAPI.DisplayConfig?
    var photos: [NookAPI.Photo] = []
    var weather: NookAPI.Weather?
    var showing = false
    var dimmed = false

    private var lastActivity = Date()
    private let api = NookAPI()

    /// A touch happened somewhere — reset the idle clock (ignored while the saver is up;
    /// the saver handles its own wake so a stray ping can't pre-empt the wake tap).
    func ping() { if !showing { lastActivity = Date() } }

    /// Tapped the saver: dismiss and restart the idle countdown.
    func wake() { lastActivity = Date(); showing = false }

    func load() async {
        cfg = try? await api.displayConfig()
        weather = try? await api.weather()
        // Only fetch the wall when the saver would actually show photos, then scope it to
        // the configured source/album + shuffle.
        if let cfg, cfg.content == "photos" {
            let raw = (try? await api.photos()) ?? []
            photos = NookAPI.screensaverPhotos(raw, cfg)
        } else {
            photos = []
        }
    }

    /// Called every second: decide whether to show the saver and whether to night-dim.
    func tick(_ now: Date, tz: TimeZone) {
        guard let cfg, cfg.content != "off" else {
            if showing { showing = false }
            dimmed = false
            return
        }
        dimmed = Self.inNightWindow(cfg.nightDim, now: now, tz: tz)
        if !showing {
            let idle = now.timeIntervalSince(lastActivity)
            if idle >= Double(max(1, cfg.screensaverMinutes) * 60) {
                // Don't start the saver over an open sheet/cover — it presents above the
                // app view tree, so the saver would render *under* it (a broken sandwich).
                // Wait it out: hold the idle clock until the modal is dismissed.
                if Self.modalPresented() { lastActivity = now } else { showing = true }
            }
        }
    }

    /// Whether a sheet / full-screen cover is currently presented anywhere on screen.
    static func modalPresented() -> Bool {
        for scene in UIApplication.shared.connectedScenes {
            guard let ws = scene as? UIWindowScene else { continue }
            for w in ws.windows where w.rootViewController?.presentedViewController != nil { return true }
        }
        return false
    }

    /// Is `now` inside the dim window? Compares "HH:mm" strings in the household tz and
    /// handles an overnight window (start later than end, e.g. 21:00 → 07:00).
    static func inNightWindow(_ nd: NookAPI.DisplayConfig.NightDim, now: Date, tz: TimeZone) -> Bool {
        guard nd.enabled else { return false }
        let f = DateFormatter(); f.timeZone = tz; f.dateFormat = "HH:mm"
        let cur = f.string(from: now)
        return nd.start <= nd.end ? (cur >= nd.start && cur < nd.end)
                                  : (cur >= nd.start || cur < nd.end)
    }
}

struct KioskScreensaverHost: ViewModifier {
    @Environment(SyncManager.self) private var sync
    @Environment(KioskMode.self) private var kiosk
    @State private var model = ScreensaverModel()
    @AppStorage("nook.screensaverMotion") private var motion = true
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    func body(content: Content) -> some View {
        content
            // A window-wide, pass-through touch observer feeds the idle clock.
            .background(IdleReset { model.ping() })
            .overlay {
                if model.showing, let cfg = model.cfg {
                    ScreensaverView(
                        content: cfg.content == "photos" ? "photos" : "clock",
                        photos: model.photos, weather: model.weather,
                        nextEvent: nextEvent, timezone: sync.householdTz,
                        dimmed: model.dimmed, interval: cfg.photoInterval,
                        motion: motion, onWake: { wake() })
                        .transition(.opacity)
                        .zIndex(100)
                }
            }
            .animation(.easeInOut(duration: 0.45), value: model.showing)
            .task { await model.load() }
            // Refresh photos / weather / config periodically while parked.
            .task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(150))
                    await model.load()
                }
            }
            .onReceive(tick) { model.tick($0, tz: sync.householdTz) }
            // Keep the screen awake while the saver is up (it IS the screensaver).
            .onChange(of: model.showing) { _, on in UIApplication.shared.isIdleTimerDisabled = on }
    }

    /// Tapped the screensaver to wake. On a shared kiosk with "Return to profile picker"
    /// enabled, waking drops the current person and shows the picker (so the next person
    /// to walk up isn't acting as whoever last used it); otherwise it just resumes.
    private func wake() {
        let toPicker = (model.cfg?.returnToPicker ?? false) && kiosk.isShared
        model.wake()
        if toPicker { Task { await kiosk.returnToPicker(sync: sync) } }
    }

    /// The soonest upcoming event (timed or all-day) for the "Next:" line.
    private var nextEvent: SyncedEvent? {
        let now = Date()
        return sync.events
            .filter { ($0.startsAt ?? .distantPast) >= now }
            .min { ($0.startsAt ?? .distantFuture) < ($1.startsAt ?? .distantFuture) }
    }
}

extension View {
    /// Layer the idle-triggered family-display screensaver over this view (iPad kiosk).
    func kioskScreensaver() -> some View { modifier(KioskScreensaverHost()) }
}

// MARK: - Window-wide touch observer

/// A zero-cost, pass-through activity watcher. It adds a gesture recognizer to the host
/// window that fires on every touch-down and then fails — so it never delays, cancels,
/// or consumes touches — purely to reset the idle clock. Standard "reset idle timer".
struct IdleReset: UIViewRepresentable {
    let onActivity: () -> Void

    func makeUIView(context: Context) -> UIView {
        let v = ActivityAnchor()
        v.isUserInteractionEnabled = false   // the recognizer lives on the window, not here
        v.onActivity = onActivity
        return v
    }
    func updateUIView(_ uiView: UIView, context: Context) {
        (uiView as? ActivityAnchor)?.onActivity = onActivity
    }
}

private final class ActivityAnchor: UIView {
    var onActivity: (() -> Void)?
    private var installed = false

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard !installed, let window else { return }
        installed = true
        let g = AnyTouchRecognizer { [weak self] in self?.onActivity?() }
        g.cancelsTouchesInView = false
        g.delaysTouchesBegan = false
        g.delaysTouchesEnded = false
        window.addGestureRecognizer(g)
    }
}

private final class AnyTouchRecognizer: UIGestureRecognizer {
    private let cb: () -> Void
    init(_ cb: @escaping () -> Void) { self.cb = cb; super.init(target: nil, action: nil) }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        cb()
        state = .failed   // never recognize → never interfere with the real UI
    }
}
