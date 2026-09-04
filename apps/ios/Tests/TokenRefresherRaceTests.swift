import Foundation
import Testing
@testable import Waffled

private actor RefreshDeferred<Value: Sendable> {
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var result: CheckedContinuation<Value, Never>?

    func wait() async -> Value {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        return await withCheckedContinuation { result = $0 }
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func resume(_ value: Value) {
        result?.resume(returning: value)
        result = nil
    }
}

private actor RefreshCredentialVault {
    private var lease: AuthTokens.RefreshLease?
    private var access: String?
    private var refresh: String?

    init(access: String, refresh: String, scope: String, generation: UInt64) {
        self.access = access
        self.refresh = refresh
        lease = .init(refreshToken: refresh, identityScope: scope, generation: generation)
    }

    func currentLease() -> AuthTokens.RefreshLease? { lease }
    func isCurrent(_ candidate: AuthTokens.RefreshLease) -> Bool { lease == candidate }

    func saveIfCurrent(
        _ candidate: AuthTokens.RefreshLease,
        access newAccess: String,
        refresh newRefresh: String
    ) -> Bool {
        guard lease == candidate else { return false }
        access = newAccess
        refresh = newRefresh
        lease = .init(
            refreshToken: newRefresh,
            identityScope: candidate.identityScope,
            generation: candidate.generation &+ 1
        )
        return true
    }

    func replace(access newAccess: String, refresh newRefresh: String, scope: String, generation: UInt64) {
        access = newAccess
        refresh = newRefresh
        lease = .init(refreshToken: newRefresh, identityScope: scope, generation: generation)
    }

    func snapshot() -> (String?, String?) { (access, refresh) }
}

private actor RefreshExpirationRecorder {
    private var leases: [AuthTokens.RefreshLease] = []
    func record(_ lease: AuthTokens.RefreshLease) { leases.append(lease) }
    func count() -> Int { leases.count }
}

@Suite
struct TokenRefresherRaceTests {
    private func credentials(_ vault: RefreshCredentialVault) -> TokenRefreshCredentials {
        TokenRefreshCredentials(
            currentLease: { await vault.currentLease() },
            saveIfCurrent: { lease, access, refresh in
                await vault.saveIfCurrent(lease, access: access, refresh: refresh)
            },
            isCurrent: { await vault.isCurrent($0) }
        )
    }

    @Test("a stale successful refresh cannot overwrite a replacement session")
    func staleSuccessCannotOverwriteReplacement() async {
        let vault = RefreshCredentialVault(
            access: "old-access",
            refresh: "old-refresh",
            scope: "session:old",
            generation: 1
        )
        let delayed = RefreshDeferred<TokenRefreshResponse>()
        let refresher = TokenRefresher(
            credentials: credentials(vault),
            request: { token in
                if token == "old-refresh" { return await delayed.wait() }
                return .refreshed(access: "new-access-rotated", refresh: "new-refresh-rotated")
            },
            expire: { _ in }
        )

        let oldAttempt = Task { await refresher.refresh() }
        await delayed.waitUntilStarted()
        await vault.replace(
            access: "new-access",
            refresh: "new-refresh",
            scope: "session:new",
            generation: 2
        )

        #expect(await refresher.refresh())
        await delayed.resume(.refreshed(access: "stale-access", refresh: "stale-refresh"))
        #expect(!(await oldAttempt.value))
        let snapshot = await vault.snapshot()
        #expect(snapshot.0 == "new-access-rotated")
        #expect(snapshot.1 == "new-refresh-rotated")
    }

    @Test("a stale rejected refresh cannot expire a replacement session")
    func staleRejectionCannotExpireReplacement() async {
        let vault = RefreshCredentialVault(
            access: "old-access",
            refresh: "old-refresh",
            scope: "session:old",
            generation: 1
        )
        let delayed = RefreshDeferred<TokenRefreshResponse>()
        let expirations = RefreshExpirationRecorder()
        let refresher = TokenRefresher(
            credentials: credentials(vault),
            request: { _ in await delayed.wait() },
            expire: { await expirations.record($0) }
        )

        let oldAttempt = Task { await refresher.refresh() }
        await delayed.waitUntilStarted()
        await vault.replace(
            access: "replacement-access",
            refresh: "replacement-refresh",
            scope: "session:replacement",
            generation: 2
        )
        await delayed.resume(.rejected)

        #expect(!(await oldAttempt.value))
        #expect(await expirations.count() == 0)
        let snapshot = await vault.snapshot()
        #expect(snapshot.0 == "replacement-access")
        #expect(snapshot.1 == "replacement-refresh")
    }
}
