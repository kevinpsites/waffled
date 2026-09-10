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

    /// The folder Waffled makes for itself inside whatever a person picks. It matches the
    /// runtime's own `datadir.AppName`, so the default path and a chosen one read alike.
    static let folderName = "Waffled"

    /// The files that mark a folder as already holding a household. Either is enough: a
    /// data directory that has never been started has `config.env` and no `runtime.json`.
    static let householdMarkers = ["runtime.json", "config.env"]

    /// Where Waffled's data really goes, given the folder a person picked.
    ///
    /// The open panel hands back the folder they clicked, and the runtime writes
    /// `config.env`, `postgres/` and `media/` straight into whatever it is given — so
    /// picking `~/Documents` would scatter a database through Documents. Waffled gets a
    /// folder of its own inside their choice instead.
    ///
    /// Unless their choice already IS one: picking the folder Waffled lives in, from
    /// `Settings…` or a second setup, must not bury it one level deeper each time. The
    /// evidence is what is inside, never the name — an empty folder called Waffled is
    /// still just a folder.
    static func dataDirectory(forChosen url: URL) -> URL {
        let alreadyOurs = householdMarkers.contains {
            FileManager.default.fileExists(atPath: url.appendingPathComponent($0).path)
        }
        return alreadyOurs ? url : url.appendingPathComponent(folderName)
    }

    /// Why this folder cannot be Waffled's, asking everything there is to ask about it —
    /// the volume it sits on, and whether we could write there at all.
    ///
    /// One door rather than two, so the panel cannot accept a folder one rule would have
    /// refused. A folder Waffled cannot write to fails at the first `config set` with a
    /// message about a path, long after the person who could have picked another has
    /// stopped looking.
    /// Writability is asked of the nearest folder that is really there, because the
    /// answer is wanted about folders that do not exist yet — `<picked>/Waffled` is the
    /// ordinary case — and `isWritableFile` says no to every path that is missing.
    static func refusal(for url: URL) -> String? {
        if let volume = refusal(for: facts(for: url)) { return volume }
        guard FileManager.default.isWritableFile(atPath: nearestExisting(url).path) else {
            return "Waffled cannot write to that folder — pick one you own, like a folder "
                + "in your home folder."
        }
        return nil
    }

    static func nearestExisting(_ url: URL) -> URL {
        var here = url.standardizedFileURL
        while !FileManager.default.fileExists(atPath: here.path) {
            let parent = here.deletingLastPathComponent()
            if parent.path == here.path { return here }
            here = parent
        }
        return here
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
