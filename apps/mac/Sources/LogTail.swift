import Foundation

/// The last line the runtime wrote, for the setting-up step.
///
/// It reads the tail rather than the file: `runtime.log` grows for the life of an install
/// and this is asked once a second while a window is open. Reading it whole would make a
/// progress line the most expensive thing in the app.
enum LogTail {
    /// How much of the end of the file to read. Comfortably more than the longest line the
    /// runtime writes, and small enough that a second of them costs nothing.
    static let window = 8 * 1024

    /// The last non-empty line, or nil when there is no file, no line, or nothing but
    /// blanks. Never throws: a missing log during a start is the ordinary case.
    static func lastLine(of url: URL, window: Int = LogTail.window) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let end = try? handle.seekToEnd() else { return nil }
        let from = end > UInt64(window) ? end - UInt64(window) : 0
        guard (try? handle.seek(toOffset: from)) != nil,
              let data = try? handle.readToEnd() else { return nil }

        // A window that started mid-line drops that partial first line, unless it is the
        // only one — a log shorter than the window starts at byte zero, where nothing was
        // cut. Decoded lossily for the same reason: a UTF-8 sequence can straddle the cut.
        var lines = String(decoding: data, as: UTF8.self)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        if from > 0, !lines.isEmpty { lines.removeFirst() }
        return lines.last { !$0.isEmpty }
    }
}
