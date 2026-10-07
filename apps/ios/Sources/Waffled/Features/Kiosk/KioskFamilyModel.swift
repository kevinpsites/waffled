import Foundation
import Observation

/// REST-backed data used by the iPad Family page. Keeping each feed in a
/// `RestDomain` preserves the last confirmed values when a refresh fails and
/// distinguishes a successful empty response from an initial load failure.
@MainActor
@Observable
final class KioskFamilyModel {
    typealias FetchChores = @Sendable () async throws -> [WaffledAPI.PersonChoresDTO]
    typealias FetchStars = @Sendable () async throws -> [WaffledAPI.FamilyStarsDTO]

    private let choresD = RestDomain<[WaffledAPI.PersonChoresDTO]>([], isEmpty: \.isEmpty)
    private let starsD = RestDomain<[WaffledAPI.FamilyStarsDTO]>([], isEmpty: \.isEmpty)
    private let fetchChores: FetchChores
    private let fetchStars: FetchStars
    private(set) var choresEnabled = true
    private var loadGeneration = 0

    init(fetchChores: FetchChores? = nil, fetchStars: FetchStars? = nil) {
        let api = WaffledAPI()
        self.fetchChores = fetchChores ?? { try await api.choresToday() }
        self.fetchStars = fetchStars ?? { try await api.familyStars() }
    }

    /// Hide retained chore progress immediately when the module is disabled. The
    /// confirmed value stays cached so turning the module back on can remain truthful
    /// if that subsequent refresh fails.
    var chores: [WaffledAPI.PersonChoresDTO] { choresEnabled ? choresD.value : [] }
    var stars: [WaffledAPI.FamilyStarsDTO] { starsD.value }
    var state: RestState {
        .combined(choresEnabled ? [choresD.state, starsD.state] : [starsD.state])
    }

    func load(choresEnabled: Bool) async {
        loadGeneration &+= 1
        let generation = loadGeneration
        self.choresEnabled = choresEnabled
        if choresEnabled { choresD.beginLoading() }
        starsD.beginLoading()
        async let chores = RestFetch.result(when: choresEnabled, fetchChores)
        async let stars = RestFetch.result(fetchStars)
        let results = await (chores, stars)

        guard !Task.isCancelled, generation == loadGeneration else { return }
        if let chores = results.0 { choresD.apply(chores) }
        starsD.apply(results.1)
    }
}
