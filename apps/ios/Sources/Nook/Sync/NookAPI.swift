import Foundation

/// One queued row op forwarded to the server's CRUD sink, matching the shape the
/// web connector sends (`{ op, table, id, data }`) and `powersync-crud.ts` reads.
struct CrudOpDTO: Encodable {
    let op: String
    let table: String
    let id: String
    let data: [String: String?]?
}

/// Tiny HTTP client for the two endpoints the sync layer needs. Stateless — reads
/// `AppConfig` at call time so a token edit takes effect on the next request.
struct NookAPI: Sendable {
    struct TokenResponse: Decodable {
        let token: String
        let powerSyncUrl: String?
    }

    enum APIError: Error { case http(Int, String) }

    /// Exchange the session token for a short-lived PowerSync token + endpoint.
    func fetchPowerSyncToken() async throws -> TokenResponse {
        var req = URLRequest(url: url("/api/powersync/token"))
        authorize(&req)
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
        return try JSONDecoder().decode(TokenResponse.self, from: data)
    }

    struct CaptureResponse: Decodable {
        let intent: CaptureIntent?
        let via: String
        let fallback: Bool
    }

    /// Parse free text into an intent via the server's pluggable-LLM endpoint.
    func capture(text: String) async throws -> CaptureResponse {
        var req = URLRequest(url: url("/api/capture"))
        req.httpMethod = "POST"
        authorize(&req)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["text": text])
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
        return try JSONDecoder().decode(CaptureResponse.self, from: data)
    }

    /// Preload the model (fire-and-forget) so the first parse isn't a cold start.
    func warmCapture() async {
        var req = URLRequest(url: url("/api/capture/warm"))
        req.httpMethod = "POST"
        authorize(&req)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = "{}".data(using: .utf8)
        _ = try? await URLSession.shared.data(for: req)
    }

    /// Forward a batch of queued local writes to the server's CRUD sink.
    func uploadCrud(_ ops: [CrudOpDTO]) async throws {
        var req = URLRequest(url: url("/api/powersync/crud"))
        req.httpMethod = "POST"
        authorize(&req)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["ops": ops])
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
    }

    // MARK: helpers

    private func url(_ path: String) -> URL {
        URL(string: AppConfig.apiBaseURL + path)!
    }

    private func authorize(_ req: inout URLRequest) {
        req.setValue("Bearer \(AppConfig.devToken)", forHTTPHeaderField: "Authorization")
    }

    private func check(_ resp: URLResponse, _ data: Data) throws {
        guard let http = resp as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.http(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }
    }
}
