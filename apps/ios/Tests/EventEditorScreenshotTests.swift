import XCTest
import SwiftUI
@testable import Waffled

// Opt-in visual evidence for the event editor's When card: renders the real sheet for a timed
// event, a one-day all-day event and a multi-day trip. Run with
// -only-testing:WaffledTests/EventEditorScreenshotTests and TEST_RUNNER_WAFFLED_CAPTURE_EDITOR=1;
// TEST_RUNNER_WAFFLED_CAPTURE_DIR picks where the PNGs go (default: Documents).
private final class OfflineURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)) }
    override func stopLoading() {}
}

@MainActor
final class EventEditorScreenshotTests: XCTestCase {
    func testCaptureEventEditor() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["WAFFLED_CAPTURE_EDITOR"] == "1" else { throw XCTSkip("Opt-in simulator screenshot capture") }
        URLProtocol.registerClass(OfflineURLProtocol.self)
        defer { URLProtocol.unregisterClass(OfflineURLProtocol.self) }

        let cal = Cal.current
        let day = cal.date(from: DateComponents(year: 2026, month: 9, day: 14, hour: 12))!
        func at(_ d: Int, _ h: Int) -> Date { cal.date(from: DateComponents(year: 2026, month: 9, day: d, hour: h))! }
        let cases: [(String, SyncedEvent)] = [
            ("timed", SyncedEvent(id: "t", title: "Soccer practice", startsAtRaw: nil, startsAt: at(14, 17), allDay: false,
                                  personId: nil, colorHex: nil, emoji: nil, endsAt: at(14, 18))),
            ("all-day", SyncedEvent(id: "a", title: "Grandma visits", startsAtRaw: nil, startsAt: at(14, 12), allDay: true,
                                    personId: nil, colorHex: nil, emoji: nil, endsAt: at(15, 12))),
            ("trip", SyncedEvent(id: "h", title: "Trip to the Hamptons", startsAtRaw: nil, startsAt: at(14, 12), allDay: true,
                                 personId: nil, colorHex: nil, emoji: nil, endsAt: at(18, 12))),
        ]
        let sync = SyncManager(initialMembers: [])
        let dir = env["WAFFLED_CAPTURE_DIR"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("EventEditorScreenshots")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        for (name, event) in cases {
            let sheet = EventEditSheet(event: event, initialDate: day)
            let controller = UIHostingController(rootView: sheet.environment(sync).preferredColorScheme(.light))
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
            window.rootViewController = controller
            window.makeKeyAndVisible()
            try await Task.sleep(for: .milliseconds(800))
            try snap(window, controller, "editor-\(name)", dir)
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    private func snap(_ window: UIWindow, _ controller: UIViewController, _ name: String, _ dir: URL) throws {
        controller.view.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        try image.pngData()!.write(to: dir.appendingPathComponent(name + ".png"))
    }
}
