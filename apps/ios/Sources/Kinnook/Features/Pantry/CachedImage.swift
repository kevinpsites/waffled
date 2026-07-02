import SwiftUI
import UIKit

/// A small in-memory **decoded**-image cache. SwiftUI's `AsyncImage` re-issues the
/// request and re-decodes every time its view is recreated (which happens constantly in
/// a `LazyVGrid` that re-renders on each search keystroke / scroll), which is the source
/// of the Pantry lag. This caches the decoded `UIImage`, so a re-render is instant.
final class ImageMemoryCache: @unchecked Sendable {
    static let shared = ImageMemoryCache()
    private let cache = NSCache<NSURL, UIImage>()
    private init() { cache.countLimit = 300 }

    func image(for url: URL) -> UIImage? { cache.object(forKey: url as NSURL) }

    func load(_ url: URL) async -> UIImage? {
        if let img = image(for: url) { return img }
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let img = UIImage(data: data) else { return nil }
        cache.setObject(img, forKey: url as NSURL)
        return img
    }
}

/// Cached drop-in for `AsyncImage` — resolves OFF (absolute) or uploaded (relative)
/// URLs via `MediaURL`, serves a cached decode synchronously on init (no flash, no
/// reload), and only hits the network on a true miss.
struct CachedImage<Placeholder: View>: View {
    private let url: URL?
    private let contentMode: ContentMode
    private let placeholder: Placeholder
    @State private var image: UIImage?

    init(_ raw: String?, contentMode: ContentMode = .fill, @ViewBuilder placeholder: () -> Placeholder) {
        let resolved = MediaURL.resolve(raw)
        self.url = resolved
        self.contentMode = contentMode
        self.placeholder = placeholder()
        _image = State(initialValue: resolved.flatMap { ImageMemoryCache.shared.image(for: $0) })
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else {
                placeholder
            }
        }
        .task(id: url) {
            guard image == nil, let url else { return }
            image = await ImageMemoryCache.shared.load(url)
        }
    }
}
