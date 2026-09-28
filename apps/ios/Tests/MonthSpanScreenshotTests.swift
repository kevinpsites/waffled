import XCTest
import SwiftUI
@testable import Waffled

// Opt-in visual evidence for multi-day bars in the month grid: the real iPad Calendar page on an
// iPad simulator, the real iPhone Calendar tab on an iPhone one, over this month's synthetic
// events. Run with -only-testing:WaffledTests/MonthSpanScreenshotTests and
// TEST_RUNNER_WAFFLED_CAPTURE_MONTH=1; TEST_RUNNER_WAFFLED_CAPTURE_DIR picks where the PNGs go.
private final class OfflineMonthURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)) }
    override func stopLoading() {}
}

@MainActor
final class MonthSpanScreenshotTests: XCTestCase {
    func testCaptureMonthBars() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["WAFFLED_CAPTURE_MONTH"] == "1" else { throw XCTSkip("Opt-in simulator screenshot capture") }
        URLProtocol.registerClass(OfflineMonthURLProtocol.self)
        defer { URLProtocol.unregisterClass(OfflineMonthURLProtocol.self) }

        let cal = Cal.current
        let today = cal.startOfDay(for: Date())
        func day(_ offset: Int, _ hour: Int = 12) -> Date { cal.date(byAdding: .hour, value: hour, to: cal.date(byAdding: .day, value: offset, to: today)!)! }
        func allDay(_ id: String, _ title: String, _ first: Int, through last: Int) -> SyncedEvent {
            SyncedEvent(id: id, title: title, startsAtRaw: nil, startsAt: day(first), allDay: true,
                        personId: nil, colorHex: nil, emoji: nil, endsAt: day(last + 1))
        }
        let events = [
            allDay("hamptons", "Trip to the Hamptons", 1, through: 6),
            allDay("conference", "Conference", 0, through: 2),
            allDay("birthday", "Birthday", 2, through: 2),
            SyncedEvent(id: "dinner", title: "Dinner at Monk's", startsAtRaw: nil, startsAt: day(2, 18), allDay: false,
                        personId: nil, colorHex: nil, emoji: nil, endsAt: day(2, 19)),
        ]
        let sync = SyncManager(initialMembers: [], initialEvents: events)
        let dir = env["WAFFLED_CAPTURE_DIR"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("MonthSpanScreenshots")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let isPad = UIDevice.current.userInterfaceIdiom == .pad
        let root = isPad ? AnyView(KioskCalendarView()) : AnyView(CalendarView(openEventId: .constant(nil)))
        let controller = UIHostingController(rootView: root.environment(sync).preferredColorScheme(.light))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.rootViewController = controller
        window.makeKeyAndVisible()
        try await Task.sleep(for: .milliseconds(1200))
        controller.view.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let name = isPad ? "ipad-month" : "iphone-month"
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        try image.pngData()!.write(to: dir.appendingPathComponent(name + ".png"))
        window.isHidden = true
        window.rootViewController = nil
    }
}
