import Foundation
import Observation

/// REST feeds represented by optional Family launcher tiles. Photos is core and
/// therefore deliberately absent: it is always loaded and aggregated.
struct FamilyRestModules: Hashable, Sendable {
    let chores: Bool
    let goals: Bool
    let rewards: Bool
    let lists: Bool

    static let all = Self(chores: true, goals: true, rewards: true, lists: true)
    static let none = Self(chores: false, goals: false, rewards: false, lists: false)
}

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
    private var modules: FamilyRestModules = .all
    private var dataScope: RestDataScopeKey?
    private var loadGeneration = 0

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
    var loaded: Bool { activeStates.allSatisfy(\.loaded) }
    var state: RestState { .combined(activeStates) }

    private var activeStates: [RestState] {
        var states = [photosD.state]
        if modules.chores { states.append(choresD.state) }
        if modules.goals { states.append(goalsD.state) }
        if modules.rewards { states.append(rewardsD.state) }
        if modules.lists { states.append(listsD.state) }
        return states
    }

    func load(scope: RestDataScopeKey, modules: FamilyRestModules) async {
        loadGeneration &+= 1
        let generation = loadGeneration
        if dataScope != scope {
            dataScope = scope
            choresD.reset()
            goalsD.reset()
            rewardsD.reset()
            listsD.reset()
            photosD.reset()
        }
        self.modules = modules
        if modules.chores { choresD.beginLoading() }
        if modules.goals { goalsD.beginLoading() }
        if modules.rewards { rewardsD.beginLoading() }
        if modules.lists { listsD.beginLoading() }
        photosD.beginLoading()
        async let chores = RestFetch.result(when: modules.chores, fetchChores)
        async let goals = RestFetch.result(when: modules.goals, fetchGoals)
        async let rewards = RestFetch.result(when: modules.rewards, fetchStars)
        async let lists = RestFetch.result(when: modules.lists, fetchLists)
        async let photos = RestFetch.result(fetchPhotos)
        let results = await (chores, goals, rewards, lists, photos)

        guard !Task.isCancelled, generation == loadGeneration else { return }
        if let chores = results.0 { choresD.apply(chores) }
        if let goals = results.1 { goalsD.apply(goals) }
        if let rewards = results.2 { rewardsD.apply(rewards) }
        if let lists = results.3 { listsD.apply(lists) }
        photosD.apply(results.4)
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
