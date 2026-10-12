import Foundation
import Testing
@testable import Waffled

// The "albums" screensaver source mixes several albums (e.g. Google Photos imports)
// in a random order. Mirrors web `screensaverPhotos`.
struct ScreensaverAlbumsTests {
    private static func photo(_ id: String, _ memory: String?) -> WaffledAPI.Photo {
        let json = """
        {"id":"\(id)","imageUrl":null,"caption":"","emoji":null,"colorHex":null,
         "memory":\(memory.map { "\"\($0)\"" } ?? "null"),"takenAt":null,"isFavorite":false,
         "reactions":{},"uploadedBy":null,"createdAt":"2026-01-01T00:00:00Z"}
        """
        return try! JSONDecoder().decode(WaffledAPI.Photo.self, from: Data(json.utf8))
    }

    private static func config(_ extra: String) throws -> WaffledAPI.DisplayConfig {
        let json = """
        {"screensaverMinutes":15,"content":"photos","returnToPicker":true,"resetHomeMinutes":3,
         "nightDim":{"enabled":false,"start":"22:00","end":"07:00"},
         "photoInterval":10,"photoShuffle":false\(extra)}
        """
        return try JSONDecoder().decode(WaffledAPI.DisplayConfig.self, from: Data(json.utf8))
    }

    private let photos = [photo("a", "Beach"), photo("b", "Beach"), photo("c", "Kids"), photo("d", nil)]

    @Test func decodesPhotoAlbumsAndDefaultsToEmpty() throws {
        #expect(try Self.config(#","photoSource":"albums","photoAlbums":["Beach","Kids"]"#).photoAlbums == ["Beach", "Kids"])
        #expect(try Self.config("").photoAlbums == [])
    }

    @Test func playsOnlyTheChosenAlbumsInRandomOrder() throws {
        let cfg = try Self.config(#","photoSource":"albums","photoAlbums":["Beach","Kids"]"#)
        #expect(WaffledAPI.screensaverPhotos(photos, cfg).map(\.id).sorted() == ["a", "b", "c"])
        let orders = Set((0..<40).map { _ in WaffledAPI.screensaverPhotos(photos, cfg).map(\.id).joined() })
        #expect(orders.count > 1)
    }

    @Test func noAlbumsChosenPlaysEverything() throws {
        let cfg = try Self.config(#","photoSource":"albums","photoAlbums":[]"#)
        #expect(WaffledAPI.screensaverPhotos(photos, cfg).count == 4)
    }
}
