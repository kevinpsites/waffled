import UIKit

/// Image encoding for the blob store, matching the web's upload pipeline: downscale
/// the long edge to a cap, JPEG-encode (so HEIC is transcoded away), and base64 the
/// bytes — staying under the server's 10 MB decoded cap.
enum MediaImage {
    /// Long-edge cap, matching the web kiosk (2048px).
    static let maxEdge: CGFloat = 2048
    /// The server's hard cap on the DECODED image bytes.
    static let maxDecodedBytes = 10 * 1024 * 1024

    enum EncodeError: LocalizedError {
        case tooLarge
        var errorDescription: String? {
            switch self {
            case .tooLarge: return "That image is too large to upload. Try a smaller photo."
            }
        }
    }

    /// Downscale + JPEG-encode a UIImage to base64 under the 10MB decoded cap.
    /// Returns (base64, "image/jpeg"). Throws if it can't be encoded under the cap.
    ///
    /// Strategy: first fit the long edge to `maxEdge`, then encode at `quality`. If the
    /// JPEG still exceeds the cap, step quality down (0.85 → 0.6 → 0.4), then shrink the
    /// long edge in halving steps, retrying at each size. Gives up with a friendly error.
    static func encodeJPEG(_ image: UIImage, quality: CGFloat = 0.85) throws -> (data: String, contentType: String) {
        var working = downscale(image, longEdge: maxEdge)
        // Quality ladder tried at each size; later sizes reuse the same ladder.
        let qualities: [CGFloat] = [quality, 0.6, 0.4]

        // Up to a handful of shrink passes, halving the long edge each time.
        for shrinkPass in 0..<6 {
            if shrinkPass > 0 {
                let edge = max(working.size.width, working.size.height)
                let next = max(320, edge / 2)
                if next >= edge { break }   // can't shrink further
                working = downscale(working, longEdge: next)
            }
            for q in qualities {
                if let jpeg = working.jpegData(compressionQuality: q),
                   jpeg.count <= maxDecodedBytes {
                    return (jpeg.base64EncodedString(), "image/jpeg")
                }
            }
        }
        throw EncodeError.tooLarge
    }

    /// Return a copy of `image` whose long edge is at most `longEdge` (no upscaling).
    /// Renders in the natural orientation so EXIF rotation is baked in.
    private static func downscale(_ image: UIImage, longEdge: CGFloat) -> UIImage {
        let w = image.size.width, h = image.size.height
        guard w > 0, h > 0 else { return image }
        let edge = max(w, h)
        let scale = edge > longEdge ? longEdge / edge : 1
        let target = CGSize(width: (w * scale).rounded(), height: (h * scale).rounded())
        if scale == 1 && image.imageOrientation == .up { return image }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1            // target is in pixels, not points
        format.opaque = true        // JPEG has no alpha
        let renderer = UIGraphicsImageRenderer(size: target, format: format)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }
}

/// Resolves the relative media (and recipe image) URLs the API returns into absolute
/// URLs so SwiftUI `AsyncImage` can load them off the configured server origin.
enum MediaURL {
    /// Resolve a possibly-relative media URL (e.g. "/media/ab/cd.jpg") to an absolute
    /// URL against the configured server origin. Absolute http(s) URLs pass through.
    /// nil/empty → nil.
    static func resolve(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty else { return nil }
        if raw.hasPrefix("http://") || raw.hasPrefix("https://") { return URL(string: raw) }
        // apiBaseURL has no trailing slash; relative urls begin with "/".
        let base = AppConfig.apiBaseURL
        let joined = raw.hasPrefix("/") ? base + raw : base + "/" + raw
        return URL(string: joined)
    }

    /// A signed media URL is a short-lived bearer credential, but its decoded bytes are
    /// still the same image. Keep signature rotation out of the in-memory cache key so
    /// refreshing credentials does not force another download and decode.
    static func cacheKey(for url: URL) -> NSURL {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let items = parts.queryItems,
              items.contains(where: { $0.name == "expires" }),
              items.contains(where: { $0.name == "sig" }) else {
            return url as NSURL
        }
        let retained = items.filter { $0.name != "expires" && $0.name != "sig" }
        parts.queryItems = retained.isEmpty ? nil : retained
        return (parts.url ?? url) as NSURL
    }

    /// Refresh signed media credentials halfway through the shortest remaining lifetime.
    /// External/unsigned images use the ordinary kiosk poll cadence. The five-second
    /// floor avoids a tight loop when a URL is already expired or nearly expired.
    static func refreshDelaySeconds(
        for urls: [String],
        now: Date = Date(),
        fallback: Int = 900
    ) -> Int {
        let safeFallback = max(5, fallback)
        let nowSeconds = Int64(now.timeIntervalSince1970.rounded(.down))
        let remaining = urls.compactMap { raw -> Int64? in
            guard let parts = URLComponents(string: raw),
                  let items = parts.queryItems,
                  items.contains(where: { $0.name == "sig" && !($0.value ?? "").isEmpty }),
                  let rawExpiry = items.first(where: { $0.name == "expires" })?.value,
                  let expiry = Int64(rawExpiry) else { return nil }
            return expiry - nowSeconds
        }
        guard let shortest = remaining.min() else { return safeFallback }
        return max(5, min(safeFallback, Int(shortest / 2)))
    }
}

extension WaffledAPI {
    /// Encode + upload a picked/captured image in one step.
    func uploadImage(_ image: UIImage) async throws -> UploadedMedia {
        let enc = try MediaImage.encodeJPEG(image)
        return try await uploadMedia(base64Data: enc.data, contentType: enc.contentType)
    }
}
