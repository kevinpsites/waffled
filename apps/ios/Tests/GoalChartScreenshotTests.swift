import XCTest
import SwiftUI
@testable import Waffled

// Opt-in visual evidence for the goal-detail data views: renders the real chart card for
// every view a "total" goal offers, inside a copy of the goal detail's iPad two-column
// layout and a phone-width column, using GoalChartFixture. Run with
// -only-testing:WaffledTests/GoalChartScreenshotTests and TEST_RUNNER_WAFFLED_CAPTURE_GOALS=1.
@MainActor
final class GoalChartScreenshotTests: XCTestCase {
    private func placeholder(_ height: CGFloat) -> some View {
        WF.panel.frame(height: height).frame(maxWidth: .infinity).clipShape(RoundedRectangle(cornerRadius: 12))
    }

    func testCaptureGoalCharts() async throws {
        guard ProcessInfo.processInfo.environment["WAFFLED_CAPTURE_GOALS"] == "1" else {
            throw XCTSkip("Opt-in simulator screenshot capture")
        }
        // Every "total" view, plus the count and habit signature views, and the Week → Month switch.
        let total = try GoalChartFixture.context()
        let count = try GoalChartFixture.context(type: "count", target: 40)
        let habit = try GoalChartFixture.context(type: "habit", target: 5)
        let offered = GoalStats.availableViews(goalType: "total", timeframe: .long)
        let cases: [(GoalDataContext, GoalViewKey?)] = offered.map { (total, $0) } + [(count, .collection), (habit, .consistency), (total, nil)]
        let sync = SyncManager(initialMembers: [])
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("GoalChartScreenshots")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        // (name, window width, iPad layout): iPad 13" landscape beside the side rail, and iPhone 17 Pro.
        let layouts: [(String, CGFloat, Bool)] = [("ipad-landscape", 1236, true), ("iphone", 402, false)]
        let switcher = SwitchBox()
        for (layout, width, kiosk) in layouts {
            // `nil` = open on Week, then switch to Month in place — the user's path.
            for (ctx, key) in cases {
                switcher.key = .week
                let menu = GoalStats.availableViews(goalType: ctx.goal.goalType, timeframe: .long)
                let card = SwitchHost(box: switcher, fixed: key) { GoalDataViewCard(ctx: ctx, view: $0, offered: menu) { _ in } }
                let root = ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        placeholder(160)
                        if kiosk {
                            HStack(alignment: .top, spacing: 16) {
                                VStack(spacing: 16) { card }.frame(maxWidth: .infinity, alignment: .top)
                                VStack(spacing: 16) { placeholder(240); placeholder(500) }.frame(maxWidth: .infinity, alignment: .top)
                            }
                        } else {
                            card
                            placeholder(240)
                        }
                    }
                    .padding(.horizontal, 16).padding(.top, 8)
                }
                .background(WF.canvas)
                let controller = UIHostingController(rootView: root.environment(sync).preferredColorScheme(.light))
                let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: width, height: 1100)
                window.rootViewController = controller
                window.makeKeyAndVisible()
                try await Task.sleep(for: .milliseconds(600))
                if key == nil {
                    switcher.key = .month
                    try await Task.sleep(for: .milliseconds(600))
                }
                controller.view.layoutIfNeeded()
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let name = "\(layout)-\(key.map { "\($0)" } ?? "switch-week-to-month")"
                let attachment = XCTAttachment(image: image)
                attachment.name = name
                attachment.lifetime = .keepAlways
                add(attachment)
                try image.pngData()!.write(to: dir.appendingPathComponent(name + ".png"))
                window.isHidden = true
                window.rootViewController = nil
            }
        }
    }
}

@Observable private final class SwitchBox { var key: GoalViewKey = .week }

/// Shows `fixed` when given, else whatever `box.key` currently holds — swapping the chart
/// in place the way picking from the view menu does.
private struct SwitchHost<Content: View>: View {
    let box: SwitchBox
    let fixed: GoalViewKey?
    @ViewBuilder let content: (GoalViewKey) -> Content
    var body: some View { content(fixed ?? box.key) }
}
