import Foundation
import PowerSync

/// Bridges PowerSync to our backend — the Swift twin of the web `WaffledConnector`.
///
/// - `fetchCredentials`: exchanges the session token for a PowerSync token + URL.
/// - `uploadData`: drains queued local writes and forwards each transaction's row
///   ops to `/api/powersync/crud`, keyed on the client-generated id so the
///   optimistic local row and the replicated server row are the same row.
final class WaffledConnector: PowerSyncBackendConnectorProtocol, @unchecked Sendable {
    private let api = WaffledAPI()

    func fetchCredentials() async throws -> PowerSyncCredentials? {
        let resp = try await api.fetchPowerSyncToken()
        guard let endpoint = resp.powerSyncUrl, !endpoint.isEmpty, !resp.token.isEmpty else {
            // No token/URL yet (not signed in) — PowerSync retries when one appears.
            return nil
        }
        return PowerSyncCredentials(endpoint: endpoint, token: resp.token)
    }

    func uploadData(database: PowerSyncDatabaseProtocol) async throws {
        let api = api
        try await UploadQueue.drain(
            next: {
                guard let tx = try await database.getNextCrudTransaction() else { return nil }
                let ops = tx.crud.map { entry in
                    CrudOpDTO(op: entry.op.rawValue, table: entry.table, id: entry.id, data: entry.opData)
                }
                return CrudUploadBatch(ops: ops) { try await tx.complete() }
            },
            upload: { try await api.uploadCrud($0) }
        )
    }
}

/// One queued CRUD transaction — a seam so the drain loop is testable without PowerSync.
struct CrudUploadBatch {
    let ops: [CrudOpDTO]
    let complete: () async throws -> Void
}

/// The upload loop behind `WaffledConnector.uploadData`. Twin of the web connector and
/// Android's `WaffledConnector.drain`.
enum UploadQueue {
    static func drain(
        next: () async throws -> CrudUploadBatch?,
        upload: ([CrudOpDTO]) async throws -> Void
    ) async throws {
        while let tx = try await next() {
            // Throw on failure so PowerSync keeps the queue and retries (offline-safe) —
            // except a refusal that can never succeed, which would wedge every write
            // queued behind it.
            do {
                try await upload(tx.ops)
            } catch {
                guard isPermanentRejection(error) else { throw error }
                print("PowerSync upload rejected by the server; dropping it:", error, tx.ops.map(\.id))
            }
            try await tx.complete()
        }
    }

    /// A 4xx is the server's final word, except an expired session, a timeout or throttling —
    /// and only when the api itself answered: every api error carries a JSON `error` code, a
    /// proxy's HTML 404 does not.
    static func isPermanentRejection(_ error: Error) -> Bool {
        guard case let WaffledAPI.APIError.http(status, body) = error,
              (400..<500).contains(status), ![401, 408, 429].contains(status),
              let json = try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any]
        else { return false }
        return json["error"] is String
    }
}
