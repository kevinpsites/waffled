import Foundation

/// Run an async operation, retrying on throw up to `attempts` times. Returns nil on
/// success, or the last error if every attempt failed.
///
/// Used to make the first PowerSync database open resilient: PowerSync sets WAL
/// journal mode on first access (a brief exclusive lock), and a prior instance
/// still releasing its lock can yield a transient "database is locked"
/// (SQLITE_BUSY). A couple of retries rides over that.
enum Retry {
    @discardableResult
    static func run(
        attempts: Int,
        delay: UInt64 = 0,
        _ operation: () async throws -> Void
    ) async -> Error? {
        var last: Error?
        for attempt in 1...max(1, attempts) {
            do {
                try await operation()
                return nil
            } catch {
                last = error
                if attempt < attempts, delay > 0 {
                    try? await Task.sleep(nanoseconds: delay)
                }
            }
        }
        return last
    }
}
