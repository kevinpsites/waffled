import AppKit
import Vision
import XCTest
@testable import Waffled

/// The QR code as `NSAlert` receives it.
///
/// The first build of `Show QR code…` handed the alert a bare `NSImageView(image:)`. An
/// accessory view with no frame is laid out at zero size and draws nothing — the alert
/// sizes itself around the frame it is given, not around the view's content — so the
/// dialog showed its own app icon, the address, and no code at all. Which looks exactly
/// like a code that failed to generate.
final class QRAccessoryTests: XCTestCase {

    private let address = "http://192.168.4.150:8082"

    func testTheAccessoryViewHasASizeToBeDrawnAt() throws {
        let view = try XCTUnwrap(QRCode.accessoryView(for: address, side: 220))

        XCTAssertEqual(view.frame.width, 220)
        XCTAssertEqual(view.frame.height, 220)
        XCTAssertFalse(view.frame.isEmpty, "a zero frame is drawn as nothing at all")
    }

    /// And it is the code, not some other image: decoded back rather than assumed.
    func testTheAccessoryViewCarriesTheScannableCode() throws {
        let view = try XCTUnwrap(QRCode.accessoryView(for: address, side: 220))
        let image = try XCTUnwrap(view.image)
        let cg = try XCTUnwrap(image.cgImage(forProposedRect: nil, context: nil, hints: nil))

        let request = VNDetectBarcodesRequest()
        request.symbologies = [.qr]
        try VNImageRequestHandler(cgImage: cg).perform([request])
        XCTAssertEqual((request.results ?? []).compactMap(\.payloadStringValue), [address])
    }

    func testNothingToShowMeansNoAccessoryView() {
        XCTAssertNil(QRCode.accessoryView(for: "", side: 220))
    }
}
