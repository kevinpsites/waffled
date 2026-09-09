import XCTest
import SwiftUI
@testable import Waffled

private final class PhotoMediaProtocol: URLProtocol {
    static var handler: ((URLRequest) -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "photo-review.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.cancelled)); return
        }
        let (status, data) = handler(request)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

// These real view-hosting checks run serially in XCTest. Only a reserved fixture
// host is intercepted; the app's server preference is restored after each check.
@MainActor
final class PhotoMediaRecoveryTests: XCTestCase {
    func testPhotoGridRefetchesAfterExpiredImage() async throws { try await assertRecovery(detail: false) }
    func testPhotoDetailRefetchesAfterExpiredImage() async throws { try await assertRecovery(detail: true) }

    private func assertRecovery(detail: Bool) async throws {
        let id = UUID().uuidString
        let old = "http://photo-review.invalid/media/house/\(id).png?expires=1&sig=old"
        let fresh = "http://photo-review.invalid/media/house/\(id).png?expires=2&sig=fresh"
        let photo = WaffledAPI.Photo(id: id, imageUrl: old, caption: "Synthetic photo", emoji: "🏞️", colorHex: nil, memory: nil, takenAt: nil, isFavorite: false, reactions: [:], uploadedBy: nil, createdAt: "2026-09-08T12:00:00Z")
        let png = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { ctx in
            UIColor.red.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        }.pngData()!
        let payload = try JSONSerialization.data(withJSONObject: ["photo": ["id": id, "imageUrl": fresh, "caption": "Synthetic photo", "isFavorite": false, "reactions": [:], "createdAt": "2026-09-08T12:00:00Z"]])
        let parentRead = expectation(description: "Read owning photo")
        let retry = expectation(description: "Load refreshed image")
        PhotoMediaProtocol.handler = { request in
            if request.url?.path == "/api/photos/\(id)" {
                XCTAssertNotNil(request.value(forHTTPHeaderField: "Authorization"))
                parentRead.fulfill()
                return (200, payload)
            }
            if request.url?.absoluteString == fresh { retry.fulfill(); return (200, png) }
            return (403, Data())
        }
        let previous = UserDefaults.standard.object(forKey: "waffled.apiBaseURL")
        UserDefaults.standard.set("http://photo-review.invalid", forKey: "waffled.apiBaseURL")
        URLProtocol.registerClass(PhotoMediaProtocol.self)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        let view = detail ? AnyView(PhotoDetailView(photo: photo)) : AnyView(PhotoTile(photo: photo))
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            URLProtocol.unregisterClass(PhotoMediaProtocol.self)
            PhotoMediaProtocol.handler = nil
            if let previous { UserDefaults.standard.set(previous, forKey: "waffled.apiBaseURL") }
            else { UserDefaults.standard.removeObject(forKey: "waffled.apiBaseURL") }
        }
        await fulfillment(of: [parentRead, retry], timeout: 3, enforceOrder: true)
    }
}
