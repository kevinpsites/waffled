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

        // Decoded lossily on purpose: the window can cut a UTF-8 sequence in half.
        var lines = String(decoding: data, as: UTF8.self)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        // A window that started mid-line drops that partial first line — unless it is the
        // only line in there, which is what a single line longer than the window looks
        // like. Its tail is still the most recent thing the runtime wrote, and a stack
        // trace is exactly when a blank progress line helps least. A log shorter than the
        // window starts at byte zero, where nothing was cut.
        if from > 0, lines.count(where: { !$0.isEmpty }) > 1 {
            lines.removeFirst()
        }
        return lines.last { !$0.isEmpty }
    }
}
