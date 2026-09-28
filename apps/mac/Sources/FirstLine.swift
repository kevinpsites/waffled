import Foundation

extension String {
    /// The first line with anything on it, trimmed — or `nil` when there is nothing to
    /// show, so each call site supplies its own fallback wording.
    ///
    /// The menu has one line, and the runtime is happy to hand over several: a refusal is
    /// routinely a sentence followed by the detail underneath it. This is the rule for
    /// picking the sentence, in one place, because the two that existed had already
    /// drifted apart on trimming.
    ///
    /// The split is on `isNewline`, not on `"\n"`. Swift strings are graphemes, and CRLF
    /// is *one* grapheme that does not equal `"\n"` — so splitting on the literal walks
    /// straight past a Windows line ending and hands the menu the whole message. Nothing
    /// in the runtime writes CRLF today; a log line quoted out of a Postgres tool might.
    var firstLine: String? {
        for line in split(whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }
}
