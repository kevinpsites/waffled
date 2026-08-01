import Foundation
import Testing
@testable import Waffled

private enum RestFixtureFailure: Error {
    case rejected
}

private let fixtureDate = Date(timeIntervalSince1970: 1_785_500_000)

@MainActor
@Suite struct RestStateContractTests {
    @Test func successfulEmptyIsAuthoritative() {
        let domain = RestDomain<[Int]>([], isEmpty: \.isEmpty)

        domain.apply([], at: fixtureDate)

        #expect(domain.state == .empty(updatedAt: fixtureDate))
        #expect(domain.state.isAuthoritative)
    }

    @Test func initialServerFailureIsAnErrorNotEmpty() {
        let domain = RestDomain<[Int]>([], isEmpty: \.isEmpty)

        domain.apply(.failure(RestFixtureFailure.rejected), at: fixtureDate)

        if case .error = domain.state { /* expected */ }
        else { Issue.record("Expected an error state") }
        #expect(!domain.state.isAuthoritative)
    }

    @Test func failedRefreshKeepsValueAndBecomesStale() {
        let domain = RestDomain<[Int]>([], isEmpty: \.isEmpty)
        domain.apply([1, 2], at: fixtureDate)

        domain.apply(.failure(RestFixtureFailure.rejected))

        #expect(domain.value == [1, 2])
        if case let .stale(updatedAt, _) = domain.state { #expect(updatedAt == fixtureDate) }
        else { Issue.record("Expected a stale state") }
    }

    @Test func networkFailureIsOfflineNotGenericError() {
        let domain = RestDomain<[Int]>([], isEmpty: \.isEmpty)

        domain.apply(.failure(URLError(.notConnectedToInternet)))

        #expect(domain.state == .offline(updatedAt: nil))
    }

    @Test func queuedAndConflictAreExplicitStates() {
        let domain = RestDomain<[Int]>([], isEmpty: \.isEmpty)
        domain.apply([1], at: fixtureDate)

        domain.markQueued(2)
        #expect(domain.state == .queued(pending: 2, updatedAt: fixtureDate))

        domain.markConflict("Changed on another device")
        #expect(domain.state == .conflict(message: "Changed on another device", updatedAt: fixtureDate))
    }

    @Test func partialScreenFailureCombinesAsStaleNotEmpty() {
        let state = RestState.combined([
            .empty(updatedAt: fixtureDate),
            .error(message: "Couldn’t load"),
        ])

        if case .stale = state { /* expected */ }
        else { Issue.record("Expected a partial response to be stale") }
        #expect(!state.isAuthoritative)
    }

    @Test func offlineDomainDoesNotBorrowAFreshSiblingsTimestamp() {
        let state = RestState.combined([
            .offline(updatedAt: nil),
            .ready(updatedAt: fixtureDate),
        ])

        #expect(state == .offline(updatedAt: nil))
    }
}

@MainActor
@Suite struct RestBackedSurfaceStateTests {
    @Test func familyHubDoesNotCallPartialFailureEmpty() async {
        let model = FamilyHubModel(
            fetchChores: { throw RestFixtureFailure.rejected },
            fetchGoals: { [] },
            fetchStars: { [] },
            fetchLists: { [] },
            fetchPhotos: { [] }
        )

        await model.load()

        #expect(model.choresSubtitle == "Couldn’t load")
        #expect(!model.state.isAuthoritative)
        if case .stale = model.state { /* expected */ }
        else { Issue.record("Expected a partial Family hub response to be stale") }
    }

    @Test func approvalFailureCannotRenderAllCaughtUp() async {
        let model = ApprovalsModel(
            fetchRedemptions: { throw RestFixtureFailure.rejected },
            fetchChores: { [] }
        )

        await model.load()

        #expect(model.isEmpty)
        #expect(!model.state.isAuthoritative)
    }

    @Test func authoritativeEmptyApprovalsCanRenderAllCaughtUp() async {
        let model = ApprovalsModel(fetchRedemptions: { [] }, fetchChores: { [] })

        await model.load()

        #expect(model.isEmpty)
        #expect(model.state.isAuthoritative)
    }

    @Test func failedPhotoRefreshKeepsThePreviouslyLoadedWall() async {
        final class Feed: @unchecked Sendable {
            var response: Result<[WaffledAPI.Photo], Error> = .success([])
        }
        let feed = Feed()
        let photo = WaffledAPI.Photo(
            id: "photo-1",
            imageUrl: "/media/photo-1.jpg",
            caption: "Camping",
            emoji: nil,
            colorHex: nil,
            memory: "Summer",
            takenAt: nil,
            isFavorite: false,
            reactions: [:],
            uploadedBy: nil,
            createdAt: "2026-07-31T12:00:00Z"
        )
        feed.response = .success([photo])
        let model = PhotosModel(fetchPhotos: { try feed.response.get() })
        await model.load()
        feed.response = .failure(RestFixtureFailure.rejected)

        await model.load()

        #expect(model.photos.map(\.id) == ["photo-1"])
        if case .stale = model.state { /* expected */ }
        else { Issue.record("Expected the photo wall to be stale") }
    }
}
