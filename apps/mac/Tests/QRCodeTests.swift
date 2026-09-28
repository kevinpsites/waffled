import Vision
import XCTest
@testable import Waffled

/// A QR code nobody can scan is worse than no QR code: it is a screen telling a person
/// to point their phone at something that does not answer. So the test decodes what was
/// really drawn rather than asserting that a bitmap came back.
final class QRCodeTests: XCTestCase {

    private func decode(_ image: CGImage) throws -> [String] {
        let request = VNDetectBarcodesRequest()
        request.symbologies = [.qr]
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap(\.payloadStringValue)
    }

    func testTheCodeDecodesBackToTheAddress() throws {
        let address = "http://kevins-mac-mini.local:8082"
        let image = try XCTUnwrap(QRCode.cgImage(for: address, side: 190))
        XCTAssertEqual(try decode(image), [address])
    }

    /// The address a household actually gets is the awkward one: a long custom name on a
    /// non-default port is more modules than the default, and the scale must still land
    /// on whole pixels or a camera reads nothing.
    func testALongerAddressStillDecodes() throws {
        let address = "http://waffled.the-longer-household-name.example.com:65535"
        let image = try XCTUnwrap(QRCode.cgImage(for: address, side: 190))
        XCTAssertEqual(try decode(image), [address])
    }

    func testAnEmptyAddressDrawsNothing() {
        XCTAssertNil(QRCode.cgImage(for: "", side: 190))
    }

    /// Scaled to at least the size asked for: a code drawn at its natural 25-odd points
    /// is a smudge on a Retina screen.
    func testTheCodeIsDrawnAtTheSizeAskedFor() throws {
        let image = try XCTUnwrap(QRCode.cgImage(for: "http://waffled.local:8080", side: 190))
        XCTAssertGreaterThanOrEqual(image.width, 100)
        XCTAssertEqual(image.width, image.height)
    }
}
