import XCTest
import SwiftUI
@testable import Waffled

// Explicit opt-in visual evidence. Every API request is intercepted; screenshots
// use synthetic data and actual shipping views, never a live household.
private final class ScreenshotURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)) }
    override func stopLoading() {}
}

private final class ScreenshotFeed: @unchecked Sendable {
    enum Mode: String, CaseIterable { case loading, empty, initialFailure, loaded, stale }
    var mode: Mode = .empty
    func rows<T: Sendable>(_ values: [T]) async throws -> [T] {
        switch mode {
        case .loading: try await Task.sleep(for: .seconds(120)); return []
        case .empty: return []
        case .initialFailure, .stale: throw WaffledAPI.APIError.http(503, "Screenshot fixture")
        case .loaded: return values
        }
    }
}

@MainActor
final class RestScreenshotTests: XCTestCase {
    func testCaptureMigratedSurfaces() async throws {
        // Run only with -only-testing:WaffledTests/RestScreenshotTests and a runner
        // environment WAFFLED_CAPTURE_REST=1; ordinary CI skips screenshot export.
        guard ProcessInfo.processInfo.environment["WAFFLED_CAPTURE_REST"] == "1" else {
            throw XCTSkip("Opt-in simulator screenshot capture")
        }
        URLProtocol.registerClass(ScreenshotURLProtocol.self)
        defer { URLProtocol.unregisterClass(ScreenshotURLProtocol.self) }
        let members: [SyncedMember] = [
            .init(id: "parent", name: "Alex", colorHex: "#A88FD6", emoji: "🙂", memberType: "adult"),
            .init(id: "child", name: "Riley", colorHex: "#7BB9A3", emoji: "🦊", memberType: "kid"),
        ]
        let sync = SyncManager(initialMembers: members)
        await sync.loadIdentity(fetchCurrentPerson: {
            .init(id: "parent", memberType: "adult", isAdmin: true, capabilities: [])
        }, fetchModules: { .init(modules: ["pantry": false, "rhythms": false, "familyNight": false], rewards: true) })
        let today = Agenda.todayKey(sync.householdTz)
        let photo = WaffledAPI.Photo(id: "photo", imageUrl: nil, caption: "Lake afternoon", emoji: "🏞️", colorHex: "#82B5C3", memory: "Summer days", takenAt: nil, isFavorite: true, reactions: [:], uploadedBy: nil, createdAt: "2026-09-01T12:00:00Z")
        let chore = try JSONDecoder().decode(WaffledAPI.ChoreInstanceDTO.self, from: Data("""
            {"id":"chore","choreId":"template","choreTitle":"Feed the cat","emoji":"🐈","personId":"child","personName":"Riley","status":"awaiting","rewardAmount":3,"rewardCurrency":"stars","dueOn":"\(today)","requiresApproval":true,"streak":2}
            """.utf8))
        let chores = [WaffledAPI.PersonChoresDTO(id: "child", name: "Riley", avatarEmoji: "🦊", colorHex: "#7BB9A3", total: 3, done: 1, stars: 3)]
        let stars = [WaffledAPI.FamilyStarsDTO(name: "Riley", stars: 12)]
        let dinner = WaffledAPI.WeekEntryDTO(id: "dinner", date: today, mealType: "dinner", title: "Veggie tacos", recipeId: nil, recipe: nil, cook: nil)
        let isPad = UIDevice.current.userInterfaceIdiom == .pad
        let device = isPad ? "ipad" : "iphone"

        for mode in [ScreenshotFeed.Mode.loading, .empty, .initialFailure, .stale] {
            let feed = ScreenshotFeed()
            feed.mode = mode == .stale ? .loaded : mode
            let approvals = ApprovalsModel(fetchRedemptions: { try await feed.rows([]) }, fetchChores: { try await feed.rows([chore]) })
            let photos = PhotosModel(fetchPhotos: { try await feed.rows([photo]) })
            let family = FamilyHubModel(fetchChores: { try await feed.rows(chores) }, fetchGoals: { try await feed.rows([]) }, fetchStars: { try await feed.rows(stars) }, fetchLists: { try await feed.rows([]) }, fetchPhotos: { try await feed.rows([photo]) })
            let kioskFamily = KioskFamilyModel(fetchChores: { try await feed.rows(chores) }, fetchStars: { try await feed.rows(stars) })
            let dash = DashboardModel(fetchMeals: { _ in try await feed.rows([dinner]) }, fetchChores: { try await feed.rows(chores) }, fetchGrocery: { try await feed.rows([.init(id: "milk", checked: false)]) }, fetchGoals: { try await feed.rows([]) }, fetchRecap: { try await feed.rows([]) }, fetchSuggestions: { try await feed.rows([]) })
            let kiosk = KioskTodayModel(fetchChores: { try await feed.rows(chores) }, fetchMeals: { _ in try await feed.rows([dinner]) }, fetchGrocery: { try await feed.rows([.init(id: "milk", name: "Milk", quantity: nil, checked: false, section: nil, assignee: nil, aisle: nil, sourceRecipeIds: nil)]) }, fetchGoals: { try await feed.rows([]) }, fetchWeather: { nil })
            if mode != .loading {
                await approvals.load(scope: sync.restDataScopeKey)
                await photos.load()
                await family.load(scope: sync.restDataScopeKey, modules: .all)
                await kioskFamily.load(choresEnabled: true)
                await dash.load(todayKey: today); await dash.loadGoals()
                await kiosk.load(todayKey: today)
            }
            if mode == .stale {
                feed.mode = .stale
                await approvals.load(scope: sync.restDataScopeKey)
                await photos.load()
                await family.load(scope: sync.restDataScopeKey, modules: .all)
                await kioskFamily.load(choresEnabled: true)
                await dash.load(todayKey: today); await dash.loadGoals()
                await kiosk.load(todayKey: today)
            }
            let familyView = isPad
                ? AnyView(KioskFamilyView(path: .constant([]), model: kioskFamily))
                : AnyView(FamilyView(path: .constant([]), approvals: approvals, hub: family))
            let todayView = isPad
                ? AnyView(KioskDashboard(model: kiosk, approvals: approvals))
                : AnyView(TodayView(approvals: approvals, path: .constant([]), dash: dash))
            let surfaces: [(String, AnyView)] = [
                ("today", todayView),
                ("family", familyView),
                ("approvals", AnyView(NavigationStack { ApprovalsView(model: approvals) })),
                ("photos", AnyView(NavigationStack { PhotosView(model: photos) })),
            ]
            for (surface, view) in surfaces {
                let controller = UIHostingController(rootView: view.environment(sync).environment(CookSessionStore()).preferredColorScheme(.light))
                let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
                let window = UIWindow(windowScene: scene)
                window.frame = scene.coordinateSpace.bounds
                window.rootViewController = controller
                window.makeKeyAndVisible()
                try await Task.sleep(for: .milliseconds(450))
                controller.view.layoutIfNeeded()
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let name = "\(device)-\(surface)-\(mode.rawValue)"
                let attachment = XCTAttachment(image: image)
                attachment.name = name
                attachment.lifetime = .keepAlways
                add(attachment)
                let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("RestScreenshots")
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                try image.pngData()!.write(to: dir.appendingPathComponent(name + ".png"))
                window.isHidden = true
                window.rootViewController = nil
            }
        }
    }
}
