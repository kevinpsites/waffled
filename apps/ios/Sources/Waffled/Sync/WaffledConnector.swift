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
        while let tx = try await database.getNextCrudTransaction() {
            let ops = tx.crud.map { entry in
                CrudOpDTO(op: entry.op.rawValue, table: entry.table, id: entry.id, data: entry.opData)
            }
            // Throw on failure so PowerSync keeps the queue and retries (offline-safe).
            try await api.uploadCrud(ops)
            try await tx.complete()
        }
    }
}
