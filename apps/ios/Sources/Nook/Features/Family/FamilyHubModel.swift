import Foundation
import Observation

/// REST-backed counts for the Family hub launcher tiles (chores, goals, rewards,
/// lists, photos). None of these are PowerSync tables, so they load over the API —
/// concurrently, on appear and on pull-to-refresh. Each tile's subtitle is derived
/// here so the view stays declarative.
@MainActor
@Observable
final class FamilyHubModel {
    private(set) var choresRemaining = 0
    private(set) var goalsActive = 0
    private(set) var goalsFeatured = 0
    private(set) var rewards: [NookAPI.FamilyStarsDTO] = []
    private(set) var listsCount = 0
    private(set) var photosCount = 0
    private(set) var latestMemory: String?
    private(set) var loaded = false

    private let api = NookAPI()

    func load() async {
        async let chores = fetchChores()
        async let goals = fetchGoals()
        async let people = fetchStars()
        async let lists = fetchLists()
        async let photos = fetchPhotos()
        let (c, g, p, l, ph) = await (chores, goals, people, lists, photos)

        choresRemaining = c.reduce(0) { $0 + max(0, $1.total - $1.done) }
        goalsActive = g.count
        goalsFeatured = g.filter(\.isFeatured).count
        rewards = p.filter { $0.stars > 0 }.sorted { $0.stars > $1.stars }
        listsCount = l.count
        photosCount = ph.count
        latestMemory = ph.compactMap(\.memory).first { !$0.isEmpty }
        loaded = true
    }

    // MARK: derived tile subtitles

    var choresSubtitle: String {
        guard loaded else { return "Loading…" }
        return choresRemaining > 0 ? "\(choresRemaining) to do today" : "All done today 🎉"
    }

    var goalsSubtitle: String {
        guard loaded else { return "Loading…" }
        if goalsActive == 0 { return "No goals yet" }
        let base = "\(goalsActive) active"
        return goalsFeatured > 0 ? "\(base) · \(goalsFeatured) featured" : base
    }

    var rewardsSubtitle: String {
        guard loaded else { return "Loading…" }
        guard !rewards.isEmpty else { return "No stars yet" }
        return rewards.prefix(2)
            .map { "\($0.name ?? "—") \($0.stars)" }
            .joined(separator: " · ")
    }

    var listsSubtitle: String {
        guard loaded else { return "Loading…" }
        return "\(listsCount) list\(listsCount == 1 ? "" : "s")"
    }

    var photosSubtitle: String {
        guard loaded else { return "Loading…" }
        if let memory = latestMemory { return "“\(memory)” · \(photosCount) new" }
        return photosCount > 0 ? "\(photosCount) photo\(photosCount == 1 ? "" : "s")" : "No photos yet"
    }

    // MARK: fetches (failures leave counts at zero rather than erroring the screen)

    private func fetchChores() async -> [NookAPI.PersonChoresDTO] { (try? await api.choresToday()) ?? [] }
    private func fetchGoals() async -> [NookAPI.GoalDTO] { (try? await api.goals()) ?? [] }
    private func fetchStars() async -> [NookAPI.FamilyStarsDTO] { (try? await api.familyStars()) ?? [] }
    private func fetchLists() async -> [NookAPI.ListRefDTO] { (try? await api.lists()) ?? [] }
    private func fetchPhotos() async -> [NookAPI.PhotoDTO] { (try? await api.photos()) ?? [] }
}
