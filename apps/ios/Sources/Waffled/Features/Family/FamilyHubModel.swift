import Foundation
import Observation

/// REST-backed counts for the Family hub launcher tiles (chores, goals, rewards,
/// lists, photos). None of these are PowerSync tables, so they load over the API —
/// concurrently, on appear and on pull-to-refresh. Each tile's subtitle is derived
/// here so the view stays declarative.
@MainActor
@Observable
final class FamilyHubModel {
    typealias FetchChores = @Sendable () async throws -> [WaffledAPI.PersonChoresDTO]
    typealias FetchGoals = @Sendable () async throws -> [WaffledAPI.GoalDTO]
    typealias FetchStars = @Sendable () async throws -> [WaffledAPI.FamilyStarsDTO]
    typealias FetchLists = @Sendable () async throws -> [WaffledAPI.ListRefDTO]
    typealias FetchPhotos = @Sendable () async throws -> [WaffledAPI.Photo]

    private let choresD = RestDomain<[WaffledAPI.PersonChoresDTO]>([], isEmpty: \.isEmpty)
    private let goalsD = RestDomain<[WaffledAPI.GoalDTO]>([], isEmpty: \.isEmpty)
    private let rewardsD = RestDomain<[WaffledAPI.FamilyStarsDTO]>([], isEmpty: \.isEmpty)
    private let listsD = RestDomain<[WaffledAPI.ListRefDTO]>([], isEmpty: \.isEmpty)
    private let photosD = RestDomain<[WaffledAPI.Photo]>([], isEmpty: \.isEmpty)

    private let fetchChores: FetchChores
    private let fetchGoals: FetchGoals
    private let fetchStars: FetchStars
    private let fetchLists: FetchLists
    private let fetchPhotos: FetchPhotos

    init(
        fetchChores: FetchChores? = nil,
        fetchGoals: FetchGoals? = nil,
        fetchStars: FetchStars? = nil,
        fetchLists: FetchLists? = nil,
        fetchPhotos: FetchPhotos? = nil
    ) {
        let api = WaffledAPI()
        self.fetchChores = fetchChores ?? { try await api.choresToday() }
        self.fetchGoals = fetchGoals ?? { try await api.goals() }
        self.fetchStars = fetchStars ?? { try await api.familyStars() }
        self.fetchLists = fetchLists ?? { try await api.lists() }
        self.fetchPhotos = fetchPhotos ?? { try await api.photos() }
    }

    var choresRemaining: Int {
        choresD.value.reduce(0) { $0 + max(0, $1.total - $1.done) }
    }
    var goalsActive: Int { goalsD.value.count }
    var goalsFeatured: Int { goalsD.value.filter(\.isFeatured).count }
    var rewards: [WaffledAPI.FamilyStarsDTO] {
        rewardsD.value.filter { $0.stars > 0 }.sorted { $0.stars > $1.stars }
    }
    var listsCount: Int { listsD.value.count }
    var photosCount: Int { photosD.value.count }
    var latestMemory: String? { photosD.value.compactMap(\.memory).first { !$0.isEmpty } }
    var loaded: Bool {
        choresD.loaded && goalsD.loaded && rewardsD.loaded && listsD.loaded && photosD.loaded
    }
    var state: RestState {
        .combined([choresD.state, goalsD.state, rewardsD.state, listsD.state, photosD.state])
    }

    func load() async {
        choresD.beginLoading()
        goalsD.beginLoading()
        rewardsD.beginLoading()
        listsD.beginLoading()
        photosD.beginLoading()
        async let chores = fetchChores()
        async let goals = fetchGoals()
        async let rewards = fetchStars()
        async let lists = fetchLists()
        async let photos = fetchPhotos()

        do { choresD.apply(.success(try await chores)) } catch { choresD.apply(.failure(error)) }
        do { goalsD.apply(.success(try await goals)) } catch { goalsD.apply(.failure(error)) }
        do { rewardsD.apply(.success(try await rewards)) } catch { rewardsD.apply(.failure(error)) }
        do { listsD.apply(.success(try await lists)) } catch { listsD.apply(.failure(error)) }
        do { photosD.apply(.success(try await photos)) } catch { photosD.apply(.failure(error)) }
    }

    // MARK: derived tile subtitles

    var choresSubtitle: String {
        subtitle(choresD.state, value: choresRemaining > 0 ? "\(choresRemaining) to do today" : "All done today 🎉")
    }

    var goalsSubtitle: String {
        let value: String
        if goalsActive == 0 { value = "No goals yet" }
        else {
            let base = "\(goalsActive) active"
            value = goalsFeatured > 0 ? "\(base) · \(goalsFeatured) featured" : base
        }
        return subtitle(goalsD.state, value: value)
    }

    var rewardsSubtitle: String {
        let value = rewards.isEmpty ? "No stars yet" : rewards.prefix(2)
            .map { "\($0.name ?? "—") \($0.stars)" }
            .joined(separator: " · ")
        return subtitle(rewardsD.state, value: value)
    }

    var listsSubtitle: String {
        subtitle(listsD.state, value: "\(listsCount) list\(listsCount == 1 ? "" : "s")")
    }

    var photosSubtitle: String {
        let value: String
        if let memory = latestMemory { value = "“\(memory)” · \(photosCount) new" }
        else { value = photosCount > 0 ? "\(photosCount) photo\(photosCount == 1 ? "" : "s")" : "No photos yet" }
        return subtitle(photosD.state, value: value)
    }

    private func subtitle(_ state: RestState, value: String) -> String {
        switch state {
        case .loading: return "Loading…"
        case .empty, .ready: return value
        case .stale: return value.isEmpty ? "May be out of date" : "May be out of date · \(value)"
        case .offline: return state.updatedAt == nil ? "Offline" : "Offline · \(value)"
        case let .queued(pending, _): return "\(pending) change\(pending == 1 ? "" : "s") queued"
        case .conflict: return "Needs review"
        case .error: return "Couldn’t load"
        }
    }
}
