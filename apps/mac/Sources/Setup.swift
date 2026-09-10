import Foundation

/// Where a household's Waffled lives, and which folders may hold it.
enum Setup {
    /// The chosen data directory, remembered across launches. Written through the model's
    /// injected memory, so no test reads UserDefaults.
    static let dataDirectoryKey = "waffled.setup.dataDirectory"

    /// What the setup screen last applied, so `Settings…` can show it and work out what
    /// changed. config.env cannot answer this — `config set` is write-only by design, and
    /// the provider key must never be read back out of it anyway.
    static let appliedOptionsKey = "waffled.setup.appliedOptions"

    static func remember(_ options: SetupOptions, in memory: UpdateMemory) {
        guard let data = try? JSONEncoder().encode(options),
              let json = String(data: data, encoding: .utf8) else { return }
        memory.set(json, forKey: appliedOptionsKey)
    }

    /// Anything unreadable reads as the defaults: a preferences file someone edited, or one
    /// written by a version that spelled these differently, must not stop Settings opening.
    static func appliedOptions(in memory: UpdateMemory) -> SetupOptions {
        guard let json = memory.string(forKey: appliedOptionsKey),
              let decoded = try? JSONDecoder().decode(SetupOptions.self, from: Data(json.utf8))
        else { return SetupOptions() }
        return decoded
    }

    static var defaultDataDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Waffled")
    }

    /// What macOS says about the volume a folder sits on. Split out from the folder so
    /// the rule below is a value-to-value function: no test needs a network share or an
    /// unplugged drive to assert what happens on one.
    struct VolumeFacts: Equatable {
        var isRemovable = false
        var isInternal = true
        var isLocal = true
        /// `volumeLocalizedFormatDescription` — "APFS", "Mac OS Extended (Journaled)",
        /// "ExFAT". Nil when the volume would not answer.
        var format: String?
    }

    /// The filesystems that can hold a live Postgres cluster. Everything else — ExFAT,
    /// FAT32, SMB, NTFS-3G — is missing the semantics the cluster is built on.
    static let supportedFormats = ["APFS", "Mac OS Extended", "HFS"]

    /// Why this folder cannot be Waffled's, in the words the row shows — nil when it can.
    ///
    /// The refusals are ordered by what a person would do about them, most actionable
    /// first: an unplugged drive is a different problem to a filesystem that cannot hold
    /// a database.
    static func refusal(for facts: VolumeFacts) -> String? {
        if facts.isRemovable || !facts.isInternal {
            return """
                Waffled needs a folder on this Mac's own disk — an unplugged drive would \
                mean no server.
                """
        }
        if !facts.isLocal {
            return """
                Waffled needs a folder on this Mac's own disk — a network folder cannot \
                hold a running database.
                """
        }
        guard let format = facts.format else { return nil }
        guard supportedFormats.contains(where: format.hasPrefix) else {
            return "Waffled needs an APFS or Mac OS Extended folder — this one is \(format)."
        }
        return nil
    }

    /// Asks macOS about the volume a folder is on. A volume that will not answer reads as
    /// the ordinary case rather than as a refusal: being unable to look is not evidence.
    static func facts(for url: URL) -> VolumeFacts {
        let values = try? url.resourceValues(forKeys: [
            .volumeIsRemovableKey, .volumeIsInternalKey, .volumeIsLocalKey,
            .volumeLocalizedFormatDescriptionKey,
        ])
        return VolumeFacts(
            isRemovable: values?.volumeIsRemovable ?? false,
            isInternal: values?.volumeIsInternal ?? true,
            isLocal: values?.volumeIsLocal ?? true,
            format: values?.volumeLocalizedFormatDescription)
    }
}
