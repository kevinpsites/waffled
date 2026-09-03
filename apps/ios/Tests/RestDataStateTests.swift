import Foundation
import Testing
@testable import Waffled

private enum RestFixtureFailure: Error {
    case rejected
}

private actor RestFetchCalls {
    private var names: [String] = []

    func record(_ name: String) {
        names.append(name)
    }

    func snapshot() -> [String] {
        names
    }

    func count(_ name: String) -> Int {
        names.count { $0 == name }
    }
}

private actor DeferredRestValue<Value: Sendable> {
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var result: CheckedContinuation<Value, Error>?

    func fetch() async throws -> Value {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters = []
        return try await withCheckedThrowingContinuation { result = $0 }
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func succeed(_ value: Value) {
        result?.resume(returning: value)
        result = nil
    }
}

private final class RestResponse<Value: Sendable>: @unchecked Sendable {
    var result: Result<Value, Error>

    init(_ result: Result<Value, Error>) {
        self.result = result
    }
}

private let fixtureDate = Date(timeIntervalSince1970: 1_785_500_000)
private let fixtureRestScope = RestDataScopeKey(
    scope: RestDataScope(), apiBaseURL: "https://tests.example"
)

@MainActor
@Suite struct RestStateContractTests {
    @Test func restDataScopeChangesForNewSessionsAndServers() {
        let epoch = RestDataScope()
        let first = RestDataScopeKey(scope: epoch, apiBaseURL: "https://one.example")

        #expect(first != RestDataScopeKey(scope: RestDataScope(), apiBaseURL: "https://one.example"))
        #expect(first != RestDataScopeKey(scope: epoch, apiBaseURL: "https://two.example"))
        #expect(first == RestDataScopeKey(scope: epoch, apiBaseURL: "https://one.example"))
    }

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

    @Test func staleDomainDoesNotBorrowANewerSiblingTimestamp() {
        let staleAt = fixtureDate
        let freshAt = fixtureDate.addingTimeInterval(3_600)

        let state = RestState.combined([
            .ready(updatedAt: freshAt),
            .stale(updatedAt: staleAt, message: "Chores couldn’t refresh."),
        ])

        #expect(state == .stale(updatedAt: staleAt, message: "Chores couldn’t refresh."))
    }

    @Test func multipleStaleDomainsUseTheOldestTimestamp() {
        let oldest = fixtureDate
        let newer = fixtureDate.addingTimeInterval(1_800)
        let fresh = fixtureDate.addingTimeInterval(3_600)

        let state = RestState.combined([
            .stale(updatedAt: newer, message: "Feed couldn’t refresh."),
            .ready(updatedAt: fresh),
            .stale(updatedAt: oldest, message: "Feed couldn’t refresh."),
        ])

        #expect(state == .stale(updatedAt: oldest, message: "Feed couldn’t refresh."))
    }

    @Test func multipleStaleDomainsAreOrderIndependentAndUseAggregateCopyWhenMessagesDiffer() {
        let oldest = RestState.stale(updatedAt: fixtureDate, message: "Chores couldn’t refresh.")
        let newer = RestState.stale(
            updatedAt: fixtureDate.addingTimeInterval(1_800),
            message: "Goals couldn’t refresh."
        )
        let expected = RestState.stale(
            updatedAt: fixtureDate,
            message: "Some data couldn’t be refreshed."
        )

        #expect(RestState.combined([oldest, newer]) == expected)
        #expect(RestState.combined([newer, oldest]) == expected)
    }

    @Test func loadingDefersBareErrorsUntilSiblingRequestsSettle() {
        let error = RestState.error(message: "Couldn’t load")
        let loading = RestState.loading

        #expect(RestState.combined([error, loading]) == .loading)
        #expect(RestState.combined([loading, error]) == .loading)
        #expect(RestState.combined([.ready(updatedAt: fixtureDate), error, loading]) == .loading)
        #expect(RestState.combined([.ready(updatedAt: fixtureDate), error]) == .stale(
            updatedAt: fixtureDate,
            message: "Some data couldn’t be refreshed."
        ))
    }

    @Test func offlineDomainDoesNotBorrowAFreshSiblingsTimestamp() {
        let state = RestState.combined([
            .offline(updatedAt: nil),
            .ready(updatedAt: fixtureDate),
        ])

        #expect(state == .offline(updatedAt: nil))
    }

    @Test func unknownOfflineTimestampDominatesDatedOfflineSiblings() {
        let state = RestState.combined([
            .offline(updatedAt: fixtureDate),
            .offline(updatedAt: nil),
        ])

        #expect(state == .offline(updatedAt: nil))
    }

    @Test func multipleDatedOfflineDomainsUseTheOldestTimestamp() {
        let oldest = fixtureDate
        let newer = fixtureDate.addingTimeInterval(1_800)

        let state = RestState.combined([
            .offline(updatedAt: newer),
            .offline(updatedAt: oldest),
        ])

        #expect(state == .offline(updatedAt: oldest))
    }

    @Test func mixedOfflineAndStaleDomainsUseTheOldestFailureTimestampInEitherOrder() {
        let oldest = fixtureDate
        let newer = fixtureDate.addingTimeInterval(1_800)
        let offline = RestState.offline(updatedAt: newer)
        let stale = RestState.stale(updatedAt: oldest, message: "Couldn’t refresh.")

        #expect(RestState.combined([offline, stale]) == .offline(updatedAt: oldest))
        #expect(RestState.combined([stale, offline]) == .offline(updatedAt: oldest))
    }

    @Test func unknownFailureTimestampDominatesMixedOfflineAggregation() {
        let offline = RestState.offline(updatedAt: fixtureDate)
        let error = RestState.error(message: "Couldn’t load")

        #expect(RestState.combined([offline, error]) == .offline(updatedAt: nil))
        #expect(RestState.combined([error, offline]) == .offline(updatedAt: nil))
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

        await model.load(scope: fixtureRestScope, modules: .all)

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

        await model.load(scope: fixtureRestScope)

        #expect(model.isEmpty)
        #expect(!model.state.isAuthoritative)
    }

    @Test func authoritativeEmptyApprovalsCanRenderAllCaughtUp() async {
        let model = ApprovalsModel(fetchRedemptions: { [] }, fetchChores: { [] })

        await model.load(scope: fixtureRestScope)

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

    @Test func disabledFamilyModulesAreNeitherFetchedNorAggregated() async {
        let calls = RestFetchCalls()
        let model = FamilyHubModel(
            fetchChores: { await calls.record("chores"); return [] },
            fetchGoals: { await calls.record("goals"); return [] },
            fetchStars: { await calls.record("rewards"); return [] },
            fetchLists: { await calls.record("lists"); return [] },
            fetchPhotos: { await calls.record("photos"); return [] }
        )

        await model.load(scope: fixtureRestScope, modules: .none)

        let called = await calls.snapshot()
        #expect(called == ["photos"])
        if case .empty = model.state { /* expected */ }
        else { Issue.record("Expected the enabled Photos feed to be authoritatively empty") }
        #expect(model.state.isAuthoritative)
    }

    @Test func disabledRewardsDoesNotFetchTheHiddenRewardsFeed() async {
        let calls = RestFetchCalls()
        let model = FamilyHubModel(
            fetchChores: { await calls.record("chores"); return [] },
            fetchGoals: { await calls.record("goals"); return [] },
            fetchStars: { await calls.record("rewards"); return [] },
            fetchLists: { await calls.record("lists"); return [] },
            fetchPhotos: { await calls.record("photos"); return [] }
        )

        await model.load(scope: fixtureRestScope, modules: .init(
            chores: true,
            goals: false,
            rewards: false,
            lists: false
        ))

        let chores = await calls.count("chores")
        let rewards = await calls.count("rewards")
        let photos = await calls.count("photos")
        #expect(chores == 1)
        #expect(rewards == 0)
        #expect(photos == 1)
        #expect(model.state.isAuthoritative)
    }

    @Test func disablingAFailedFamilyModuleRemovesItsErrorFromTheScreenState() async {
        let calls = RestFetchCalls()
        let model = FamilyHubModel(
            fetchChores: {
                await calls.record("chores")
                throw RestFixtureFailure.rejected
            },
            fetchGoals: { [] },
            fetchStars: { [] },
            fetchLists: { [] },
            fetchPhotos: { [] }
        )
        await model.load(scope: fixtureRestScope, modules: .all)
        #expect(!model.state.isAuthoritative)

        await model.load(scope: fixtureRestScope, modules: .none)

        if case .empty = model.state { /* expected */ }
        else { Issue.record("Expected disabled-module failures to be excluded") }
        #expect(model.state.isAuthoritative)
        let choreCalls = await calls.count("chores")
        #expect(choreCalls == 1)
    }

    @Test func familyScopeChangeClearsConfirmedValuesBeforeANewScopeFails() async {
        let photo = WaffledAPI.Photo(
            id: "tenant-a-photo", imageUrl: "/media/a.jpg", caption: "Tenant A",
            emoji: nil, colorHex: nil, memory: nil, takenAt: nil,
            isFavorite: false, reactions: [:], uploadedBy: nil,
            createdAt: "2026-09-03T12:00:00Z"
        )
        let photos = RestResponse<[WaffledAPI.Photo]>(.success([photo]))
        let model = FamilyHubModel(
            fetchChores: { [] }, fetchGoals: { [] }, fetchStars: { [] }, fetchLists: { [] },
            fetchPhotos: { try photos.result.get() }
        )
        let scopeA = RestDataScopeKey(scope: RestDataScope(), apiBaseURL: "https://a.example")
        let scopeB = RestDataScopeKey(scope: RestDataScope(), apiBaseURL: "https://a.example")

        await model.load(scope: scopeA, modules: .none)
        #expect(model.photosCount == 1)
        photos.result = .failure(RestFixtureFailure.rejected)

        await model.load(scope: scopeB, modules: .none)

        #expect(model.photosCount == 0)
        #expect(!model.state.isAuthoritative)
        if case .error = model.state { /* expected */ }
        else { Issue.record("Expected a new-scope initial error, never tenant A stale data") }
    }

    @Test func lateFamilyResultFromThePreviousScopeIsDiscarded() async {
        let deferred = DeferredRestValue<[WaffledAPI.Photo]>()
        let calls = RestFetchCalls()
        let oldPhoto = WaffledAPI.Photo(
            id: "tenant-a-photo", imageUrl: "/media/a.jpg", caption: "Tenant A",
            emoji: nil, colorHex: nil, memory: nil, takenAt: nil,
            isFavorite: false, reactions: [:], uploadedBy: nil,
            createdAt: "2026-09-03T12:00:00Z"
        )
        let model = FamilyHubModel(
            fetchChores: { [] }, fetchGoals: { [] }, fetchStars: { [] }, fetchLists: { [] },
            fetchPhotos: {
                await calls.record("photos")
                if await calls.count("photos") == 1 { return try await deferred.fetch() }
                throw RestFixtureFailure.rejected
            }
        )
        let scopeA = RestDataScopeKey(scope: RestDataScope(), apiBaseURL: "https://a.example")
        let scopeB = RestDataScopeKey(scope: RestDataScope(), apiBaseURL: "https://a.example")

        let oldLoad = Task { await model.load(scope: scopeA, modules: .none) }
        await deferred.waitUntilStarted()
        await model.load(scope: scopeB, modules: .none)
        await deferred.succeed([oldPhoto])
        await oldLoad.value

        #expect(model.photosCount == 0)
        if case .error = model.state { /* expected */ }
        else { Issue.record("Expected the current scope’s failure to win") }
    }

    @Test func approvalScopeChangeClearsConfirmedValuesBeforeANewScopeFails() async {
        let redemption = WaffledAPI.RewardRedemption(
            id: "tenant-a-redemption", rewardId: "reward-1", personId: "person-a",
            personName: "Alex", personAvatar: nil, personColor: nil,
            title: "Movie night", emoji: "🎬", cost: 5, currency: "stars",
            status: "pending", decidedAt: nil, createdAt: "2026-09-03T12:00:00Z"
        )
        let redemptions = RestResponse<[WaffledAPI.RewardRedemption]>(.success([redemption]))
        let chores = RestResponse<[WaffledAPI.ChoreInstanceDTO]>(.success([]))
        let model = ApprovalsModel(
            fetchRedemptions: { try redemptions.result.get() },
            fetchChores: { try chores.result.get() }
        )
        let scopeA = RestDataScopeKey(scope: RestDataScope(), apiBaseURL: "https://a.example")
        let scopeB = RestDataScopeKey(scope: RestDataScope(), apiBaseURL: "https://a.example")

        await model.load(scope: scopeA)
        #expect(model.redemptions.map(\.id) == ["tenant-a-redemption"])
        redemptions.result = .failure(RestFixtureFailure.rejected)
        chores.result = .failure(RestFixtureFailure.rejected)

        await model.load(scope: scopeB)

        #expect(model.redemptions.isEmpty)
        #expect(!model.state.isAuthoritative)
        if case .stale = model.state { Issue.record("Must not expose tenant A as stale") }
    }

    @Test func lateApprovalResultFromThePreviousScopeIsDiscarded() async {
        let deferred = DeferredRestValue<[WaffledAPI.RewardRedemption]>()
        let calls = RestFetchCalls()
        let choreCalls = RestFetchCalls()
        let redemption = WaffledAPI.RewardRedemption(
            id: "tenant-a-redemption", rewardId: "reward-1", personId: "person-a",
            personName: "Alex", personAvatar: nil, personColor: nil,
            title: "Movie night", emoji: "🎬", cost: 5, currency: "stars",
            status: "pending", decidedAt: nil, createdAt: "2026-09-03T12:00:00Z"
        )
        let model = ApprovalsModel(
            fetchRedemptions: {
                await calls.record("redemptions")
                if await calls.count("redemptions") == 1 { return try await deferred.fetch() }
                throw RestFixtureFailure.rejected
            },
            fetchChores: {
                await choreCalls.record("chores")
                if await choreCalls.count("chores") == 1 { return [] }
                throw RestFixtureFailure.rejected
            }
        )
        let scopeA = RestDataScopeKey(scope: RestDataScope(), apiBaseURL: "https://a.example")
        let scopeB = RestDataScopeKey(scope: RestDataScope(), apiBaseURL: "https://a.example")

        let oldLoad = Task { await model.load(scope: scopeA) }
        await deferred.waitUntilStarted()
        await model.load(scope: scopeB)
        await deferred.succeed([redemption])
        await oldLoad.value

        #expect(model.redemptions.isEmpty)
        if case .stale = model.state { Issue.record("Must not expose late tenant A data") }
    }

    @Test func lateIdentityFromThePreviousScopeCannotReplaceTheCurrentPrincipal() async {
        let oldIdentity = DeferredRestValue<WaffledAPI.CurrentPerson?>()
        let oldModuleCalls = RestFetchCalls()
        let sync = SyncManager()
        let personA = WaffledAPI.CurrentPerson(
            id: "person-a", memberType: "adult", isAdmin: true, capabilities: []
        )
        let personB = WaffledAPI.CurrentPerson(
            id: "person-b", memberType: "adult", isAdmin: false, capabilities: []
        )
        let oldScope = sync.restDataScopeKey
        let oldLoad = Task {
            await sync.loadIdentity(
                fetchCurrentPerson: { try await oldIdentity.fetch() },
                fetchModules: {
                    await oldModuleCalls.record("modules")
                    return .init(modules: ["chores": false], rewards: false)
                }
            )
        }
        await oldIdentity.waitUntilStarted()

        sync.invalidateRestDataScope()
        await sync.loadIdentity(
            fetchCurrentPerson: { personB },
            fetchModules: { .init(modules: ["chores": true], rewards: true) }
        )
        await oldIdentity.succeed(personA)
        await oldLoad.value

        let staleModuleCalls = await oldModuleCalls.count("modules")
        #expect(sync.restDataScopeKey != oldScope)
        #expect(sync.currentPersonId == "person-b")
        #expect(sync.module(.chores))
        #expect(staleModuleCalls == 0)
    }

    @Test func lateModuleFlagsFromThePreviousScopeCannotReplaceCurrentSettings() async {
        let oldModules = DeferredRestValue<WaffledAPI.HouseholdModules>()
        let sync = SyncManager()
        let personA = WaffledAPI.CurrentPerson(
            id: "person-a", memberType: "adult", isAdmin: true, capabilities: []
        )
        let personB = WaffledAPI.CurrentPerson(
            id: "person-b", memberType: "adult", isAdmin: false, capabilities: []
        )
        let oldLoad = Task {
            await sync.loadIdentity(
                fetchCurrentPerson: { personA },
                fetchModules: { try await oldModules.fetch() }
            )
        }
        await oldModules.waitUntilStarted()

        sync.invalidateRestDataScope()
        await sync.loadIdentity(
            fetchCurrentPerson: { personB },
            fetchModules: { .init(modules: ["chores": true], rewards: true) }
        )
        await oldModules.succeed(.init(modules: ["chores": false], rewards: false))
        await oldLoad.value

        #expect(sync.currentPersonId == "person-b")
        #expect(sync.module(.chores))
        #expect(sync.rewardsOn)
    }

    @Test func canceledIdentityLoadCannotApplyModulesAndItsReplacementFinishesThem() async {
        let oldModules = DeferredRestValue<WaffledAPI.HouseholdModules>()
        let replacementCalls = RestFetchCalls()
        let sync = SyncManager()
        let person = WaffledAPI.CurrentPerson(
            id: "person-a", memberType: "adult", isAdmin: true, capabilities: []
        )
        let oldLoad = Task {
            await sync.loadIdentity(
                fetchCurrentPerson: { person },
                fetchModules: { try await oldModules.fetch() }
            )
        }
        await oldModules.waitUntilStarted()

        oldLoad.cancel()
        await oldModules.succeed(.init(modules: ["chores": false], rewards: false))
        await oldLoad.value

        // The canceled response must not install its disabled flags. Even though the
        // person half completed, a replacement call still finishes the module half.
        #expect(sync.module(.chores))
        await sync.loadIdentity(
            fetchCurrentPerson: {
                await replacementCalls.record("identity")
                return person
            },
            fetchModules: {
                await replacementCalls.record("modules")
                return .init(modules: ["chores": false], rewards: false)
            }
        )

        let identityCalls = await replacementCalls.count("identity")
        let moduleCalls = await replacementCalls.count("modules")
        #expect(identityCalls == 0)
        #expect(moduleCalls == 1)
        #expect(!sync.module(.chores))
        #expect(!sync.rewardsOn)
    }
}

@MainActor
@Suite struct KioskFamilyRestStateTests {
    @Test func startsLoadingRatherThanPretendingRestDataIsEmpty() {
        let model = KioskFamilyModel(fetchChores: { [] }, fetchStars: { [] })

        #expect(model.state == .loading)
        #expect(!model.state.isAuthoritative)
    }

    @Test func successfulEmptyResponseIsAuthoritative() async {
        let model = KioskFamilyModel(fetchChores: { [] }, fetchStars: { [] })

        await model.load(choresEnabled: true)

        if case .empty = model.state { /* expected */ }
        else { Issue.record("Expected an authoritative empty state") }
        #expect(model.state.isAuthoritative)
    }

    @Test func initialFailureCannotMasqueradeAsEmpty() async {
        let model = KioskFamilyModel(
            fetchChores: { throw RestFixtureFailure.rejected },
            fetchStars: { throw RestFixtureFailure.rejected }
        )

        await model.load(choresEnabled: true)

        if case .error = model.state { /* expected */ }
        else { Issue.record("Expected an initial error state") }
        #expect(!model.state.isAuthoritative)
    }

    @Test func failedRefreshKeepsConfirmedChoresAndStars() async {
        final class Feed: @unchecked Sendable {
            var shouldFail = false
        }
        let feed = Feed()
        let chores = WaffledAPI.PersonChoresDTO(
            id: "person-1", name: "Maya", avatarEmoji: "🧒", colorHex: "#7C6FCD",
            total: 3, done: 1, stars: 12
        )
        let stars = WaffledAPI.FamilyStarsDTO(name: "Maya", stars: 12)
        let model = KioskFamilyModel(
            fetchChores: {
                if feed.shouldFail { throw RestFixtureFailure.rejected }
                return [chores]
            },
            fetchStars: {
                if feed.shouldFail { throw RestFixtureFailure.rejected }
                return [stars]
            }
        )
        await model.load(choresEnabled: true)
        feed.shouldFail = true

        await model.load(choresEnabled: true)

        #expect(model.chores.map(\.id) == ["person-1"])
        #expect(model.stars.map(\.name) == ["Maya"])
        if case .stale = model.state { /* expected */ }
        else { Issue.record("Expected stale data after refresh failure") }
    }

    @Test func disabledKioskChoresAreNeitherFetchedNorAggregated() async {
        let calls = RestFetchCalls()
        let model = KioskFamilyModel(
            fetchChores: {
                await calls.record("chores")
                throw RestFixtureFailure.rejected
            },
            fetchStars: {
                await calls.record("stars")
                return []
            }
        )

        await model.load(choresEnabled: true)
        #expect(!model.state.isAuthoritative)

        await model.load(choresEnabled: false)

        let choreCalls = await calls.count("chores")
        let starCalls = await calls.count("stars")
        #expect(choreCalls == 1)
        #expect(starCalls == 2)
        if case .empty = model.state { /* expected */ }
        else { Issue.record("Expected disabled chores failures to be excluded") }
        #expect(model.state.isAuthoritative)
    }

    @Test func disablingKioskChoresHidesPreviouslyConfirmedRowsWithoutRefetchingThem() async {
        let calls = RestFetchCalls()
        let chores = WaffledAPI.PersonChoresDTO(
            id: "person-1", name: "Maya", avatarEmoji: "🧒", colorHex: "#7C6FCD",
            total: 3, done: 1, stars: 12
        )
        let model = KioskFamilyModel(
            fetchChores: { await calls.record("chores"); return [chores] },
            fetchStars: { await calls.record("stars"); return [] }
        )
        await model.load(choresEnabled: true)
        #expect(model.chores.map(\.id) == ["person-1"])

        await model.load(choresEnabled: false)

        let choreCalls = await calls.count("chores")
        #expect(choreCalls == 1)
        #expect(model.chores.isEmpty)
        #expect(model.state.isAuthoritative)
    }

    @Test func lateEnabledChoreLoadCannotRepublishRowsAfterModuleIsDisabled() async {
        let deferred = DeferredRestValue<[WaffledAPI.PersonChoresDTO]>()
        let calls = RestFetchCalls()
        let chore = WaffledAPI.PersonChoresDTO(
            id: "person-1", name: "Maya", avatarEmoji: "🧒", colorHex: "#7C6FCD",
            total: 3, done: 1, stars: 12
        )
        let model = KioskFamilyModel(
            fetchChores: {
                await calls.record("chores")
                return try await deferred.fetch()
            },
            fetchStars: { [] }
        )

        let oldLoad = Task { await model.load(choresEnabled: true) }
        await deferred.waitUntilStarted()
        await model.load(choresEnabled: false)
        await deferred.succeed([chore])
        await oldLoad.value

        let choreCalls = await calls.count("chores")
        #expect(choreCalls == 1)
        #expect(model.chores.isEmpty)
        #expect(model.state.isAuthoritative)
    }

    @Test func coreStarsFailureStillCountsWhenKioskChoresAreDisabled() async {
        let model = KioskFamilyModel(
            fetchChores: { [] },
            fetchStars: { throw RestFixtureFailure.rejected }
        )

        await model.load(choresEnabled: false)

        if case .error = model.state { /* expected */ }
        else { Issue.record("Expected the always-active family overview feed to remain authoritative") }
        #expect(!model.state.isAuthoritative)
    }
}
