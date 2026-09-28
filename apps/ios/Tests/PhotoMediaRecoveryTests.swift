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

    func testPlanningMealRefetchesRecipeAfterExpiredImage() async throws {
        try await assertRecovery(detail: false, planning: true)
    }

    private func assertRecovery(detail: Bool, planning: Bool = false) async throws {
        let id = UUID().uuidString
        let old = "http://photo-review.invalid/media/house/\(id).png?expires=1&sig=old"
        let fresh = "http://photo-review.invalid/media/house/\(id).png?expires=2&sig=fresh"
        let photo = WaffledAPI.Photo(id: id, imageUrl: old, caption: "Synthetic photo", emoji: "🏞️", colorHex: nil, memory: nil, takenAt: nil, isFavorite: false, reactions: [:], uploadedBy: nil, createdAt: "2026-09-08T12:00:00Z")
        let png = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { ctx in
            UIColor.red.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        }.pngData()!
        let parentBody: [String: Any] = planning
            ? ["recipe": ["id": id, "imageUrl": fresh, "title": "Synthetic recipe", "isFavorite": false, "cookedCount": 0], "ingredients": [], "steps": []]
            : ["photo": ["id": id, "imageUrl": fresh, "caption": "Synthetic photo", "isFavorite": false, "reactions": [:], "createdAt": "2026-09-08T12:00:00Z"]]
        let payload = try JSONSerialization.data(withJSONObject: parentBody)
        let parentPath = planning ? "/api/recipes/\(id)" : "/api/photos/\(id)"
        let parentRead = expectation(description: "Read owning resource")
        let retry = expectation(description: "Load refreshed image")
        PhotoMediaProtocol.handler = { request in
            if request.url?.path == parentPath {
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
        let view: AnyView
        if planning {
            let week = "2026-09-06"
            let feed = try JSONDecoder().decode(WaffledAPI.PlanningMealsView.self, from:
                JSONSerialization.data(withJSONObject: ["weekStart": week, "nights": [["date": week,
                    "events": [], "dinner": ["entryId": id, "recipeId": id, "title": "Synthetic recipe", "imageUrl": old]]]]))
            _ = PlanningMealsStepStore.shared.model(sessionId: id, weekStart: week) {
                PlanningMealsModel(fetchView: { _, _ in feed })
            }
            let step = WaffledAPI.PlanningStep(key: "meals", number: 7, title: "Meals", ask: "Meals?",
                primary: "Done", act: "review", requiresModule: "meals", available: true,
                status: "pending", data: [:], decidedAt: nil, parked: nil)
            let props = PlanningStepProps(step: step, sessionId: id, weekStart: week,
                setDecisionData: { _ in }, refresh: {}, busy: false, routes: [],
                goToStep: { _ in }, lendVerb: { _ in }, reportBusy: { _ in })
            view = AnyView(MealsStepView(props: props).environment(SyncManager()))
        } else {
            view = detail ? AnyView(PhotoDetailView(photo: photo)) : AnyView(PhotoTile(photo: photo))
        }
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            URLProtocol.unregisterClass(PhotoMediaProtocol.self)
            PhotoMediaProtocol.handler = nil
            if planning { PlanningMealsStepStore.shared.reset() }
            if let previous { UserDefaults.standard.set(previous, forKey: "waffled.apiBaseURL") }
            else { UserDefaults.standard.removeObject(forKey: "waffled.apiBaseURL") }
        }
        await fulfillment(of: [parentRead, retry], timeout: 3, enforceOrder: true)
    }
}
