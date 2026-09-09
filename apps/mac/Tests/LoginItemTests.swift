import ServiceManagement
import XCTest
@testable import Waffled

/// "Start at login" without launchd: the three calls this type makes are injected, so
/// every rule about what the menu draws can be asserted without registering anything.
@MainActor
final class LoginItemTests: XCTestCase {

    /// A stand-in for `SMAppService.mainApp`: the status it reports, and whether the two
    /// verbs throw.
    private final class FakeService {
        var status: SMAppService.Status = .notRegistered
        var failure: Error?

        func turnOn() throws {
            if let failure { throw failure }
            status = .enabled
        }

        func turnOff() throws {
            if let failure { throw failure }
            status = .notRegistered
        }
    }

    private func makeItem(_ fake: FakeService) -> LoginItem {
        LoginItem(status: { fake.status },
                  register: { try fake.turnOn() },
                  unregister: { try fake.turnOff() })
    }

    private let transient = NSError(
        domain: "SMAppServiceErrorDomain", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Operation not permitted"])

    /// The finding: one throw used to disable the control for the life of the process.
    /// A failed attempt is now a note on a toggle that still works.
    func testATransientFailureLeavesTheToggleInteractive() {
        let fake = FakeService()
        fake.failure = transient
        let item = makeItem(fake)
        item.refresh()

        item.setEnabled(true)

        guard case let .toggle(isOn, note) = item.control else {
            return XCTFail("a failed attempt must not take the toggle away: \(item.control)")
        }
        XCTAssertFalse(isOn)
        XCTAssertEqual(note, "Operation not permitted")

        // And the very next attempt reaches launchd, rather than being unclickable.
        fake.failure = nil
        item.setEnabled(true)
        XCTAssertEqual(item.control, .toggle(isOn: true, note: nil),
                       "a later success clears the note")
    }

    /// The note is the user's own last attempt: it stays until they try again, rather
    /// than blinking out on the next two-second poll.
    func testTheNoteSurvivesAPollButNotALaterSuccess() {
        let fake = FakeService()
        fake.failure = transient
        let item = makeItem(fake)

        item.setEnabled(true)
        item.refresh()
        XCTAssertEqual(item.control, .toggle(isOn: false, note: "Operation not permitted"))

        fake.failure = nil
        item.setEnabled(true)
        item.refresh()
        XCTAssertEqual(item.control, .toggle(isOn: true, note: nil))
    }

    /// Switched off in System Settings: registering from here cannot override that, so
    /// the item stops pretending to be a toggle and offers the one thing that helps.
    func testApprovalRequiredOffersSystemSettings() {
        let fake = FakeService()
        fake.status = .requiresApproval
        let item = makeItem(fake)
        item.refresh()

        XCTAssertEqual(item.control,
                       .openSettings(reason: "approve Waffled in System Settings → Login Items"))
    }

    /// The only status with nothing to click: this build cannot register at all.
    func testNotFoundIsTheOnlyDisabledCase() {
        let fake = FakeService()
        fake.status = .notFound
        let item = makeItem(fake)
        item.refresh()

        guard case .unavailable = item.control else {
            return XCTFail("notFound has nothing to offer: \(item.control)")
        }
    }

    /// The other half of the finding: a change made in System Settings has to come back.
    /// The app re-reads the status on every poll, so this is what the menu then shows.
    func testAStatusChangedElsewhereIsPickedUpByTheNextRead() {
        let fake = FakeService()
        fake.status = .requiresApproval
        let item = makeItem(fake)
        item.refresh()
        XCTAssertEqual(item.control,
                       .openSettings(reason: "approve Waffled in System Settings → Login Items"))

        fake.status = .enabled          // someone switched it back on
        item.refresh()

        XCTAssertEqual(item.control, .toggle(isOn: true, note: nil))
        XCTAssertTrue(item.isEnabled)
    }
}
