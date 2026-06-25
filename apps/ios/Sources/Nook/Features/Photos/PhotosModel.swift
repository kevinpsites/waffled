import Foundation
import Observation

/// REST-backed state for the Photos wall. Photos aren't a PowerSync table, so the
/// grid loads over the API on appear, on pull-to-refresh, and after add/edit/delete.
@MainActor
@Observable
final class PhotosModel {
    private(set) var photos: [NookAPI.Photo] = []
    private(set) var loading = false
    private(set) var error = false

    private let api = NookAPI()

    /// The distinct album labels in the current wall (for the add/edit album pickers).
    var albums: [String] {
        var seen = Set<String>()
        var out: [String] = []
        for p in photos {
            if let m = p.memory, !m.isEmpty, !seen.contains(m) { seen.insert(m); out.append(m) }
        }
        return out.sorted()
    }

    func load() async {
        loading = true
        defer { loading = false }
        do {
            photos = try await api.photos()
            error = false
        } catch {
            self.error = true
        }
    }

    /// How many photos share a given album (for the detail "view all" line).
    func count(inMemory memory: String) -> Int {
        photos.filter { $0.memory == memory }.count
    }

    // MARK: Bulk actions (multi-select)

    /// Move the given photos into `album` (nil/empty removes them from any album).
    /// Patches each over the existing per-photo endpoint, then reloads. Returns false
    /// if any one failed (the wall still reloads to reflect whatever did land).
    func move(_ ids: Set<String>, toAlbum album: String?) async -> Bool {
        let value: JSONValue = (album?.trimmingCharacters(in: .whitespaces).isEmpty == false)
            ? .string(album!) : .null
        var ok = true
        for id in ids {
            do { _ = try await api.updatePhoto(id: id, ["memory": value]) }
            catch { ok = false }
        }
        await load()
        return ok
    }

    /// Soft-delete the given photos, then reload. Returns false if any one failed.
    func delete(_ ids: Set<String>) async -> Bool {
        var ok = true
        for id in ids {
            do { try await api.deletePhoto(id: id) } catch { ok = false }
        }
        await load()
        return ok
    }
}
