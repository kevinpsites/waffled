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

    nonisolated static func isPermanentUploadRejection(_ error: Error) -> Bool {
        (error as? WaffledAPI.APIError)?.isGuestReadOnly == true
    }

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
            // Transient failures keep the queue for retry. A guest rejection is
            // permanent for this optimistic mutation, so acknowledge it; PowerSync's
            // next download restores the server-authoritative value locally.
            do {
                try await api.uploadCrud(ops)
            } catch where Self.isPermanentUploadRejection(error) {
                try await tx.complete()
                continue
            }
            try await tx.complete()
        }
    }
}
