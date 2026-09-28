import XCTest
@testable import Waffled

/// `Show QR code…`. The ready step shows one exactly once, on the single launch a
/// household ever sees it — and every phone that arrives afterwards is a person reading
/// an address off the menu and typing it into a browser. The menu is where they already
/// go for the address, so it is where the code belongs too.
final class ShareAddressTests: XCTestCase {

    private func status(_ json: String) throws -> RuntimeStatus {
        try RuntimeStatus.decode(Fixtures.data(json))
    }

    func testTheCodeIsOfferedWhileTheServerIsUp() throws {
        let menu = MenuPresentation.make(status: try status(Fixtures.fullRunning))
        XCTAssertTrue(menu.shareEnabled)
    }

    /// There is nothing to point a phone at until something is answering, so the item is
    /// off for the same reason `Open Waffled` and the address line are.
    func testTheCodeIsOffWhenNothingIsAnswering() throws {
        XCTAssertFalse(MenuPresentation.make(status: try status(Fixtures.minimalStopped)).shareEnabled)
        XCTAssertFalse(MenuPresentation.make(status: nil).shareEnabled)
    }

    /// An install reachable only on loopback has no address to hand anyone.
    func testTheCodeIsOffWithNoNetworkAddress() throws {
        XCTAssertFalse(MenuPresentation.make(status: try status(Fixtures.noAddress)).shareEnabled)
    }

    /// The same value the ready step's card is built from, so the code in the menu and the
    /// code at the end of setup are the same code — and it encodes the whole URL, which is
    /// what a phone's camera can actually open.
    func testTheCodeEncodesTheAddressTheReadyStepShowed() throws {
        let running = try status(Fixtures.fullRunning)
        let card = try XCTUnwrap(FirstRunPresentation.addressCard(running, preferredPort: 8080))

        XCTAssertEqual(MenuPresentation.shareURL(running), card.url)
        XCTAssertTrue(card.url.hasPrefix("http://"),
                      "a bare host:port is a search, not an address")
    }

    func testThereIsNothingToShareWithoutAStatus() {
        XCTAssertNil(MenuPresentation.shareURL(nil))
    }
}
