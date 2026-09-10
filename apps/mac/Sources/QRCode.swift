import AppKit
import CoreImage

/// The ready step's QR code: the address, so a phone can be pointed at the server by
/// camera instead of by typing a `.local` name into a keyboard on a screen that size.
///
/// CoreImage rather than a library — the generator is in the OS, and this app ships a
/// 670 MB runtime bundle without adding a dependency to draw twenty-five squares.
enum QRCode {
    /// Medium correction: the code is read off a screen at arm's length, not printed on a
    /// box, so a quarter of the modules spent on damage recovery buys nothing.
    static let correctionLevel = "M"

    static func image(for text: String, side: CGFloat) -> NSImage? {
        guard let cgImage = cgImage(for: text, side: side) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: side, height: side))
    }

    /// The bitmap, kept separate so a test can decode what was really drawn.
    static func cgImage(for text: String, side: CGFloat) -> CGImage? {
        // ISO-8859-1 because that is QR byte mode's own default charset: a reader decodes
        // these bytes as Latin-1 unless an ECI header says otherwise, so encoding them as
        // anything else is how a code scans to the wrong string. A host outside Latin-1
        // therefore gets no code rather than a wrong one — and cannot arise anyway, since
        // every address here is an IP, an ASCII-checked name, or this Mac's own hostname.
        guard !text.isEmpty, let data = text.data(using: .isoLatin1),
              let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(data, forKey: "inputMessage")
        filter.setValue(correctionLevel, forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage, output.extent.width > 0 else { return nil }

        // Scaled by an integer factor and nearest-neighbour by construction: a fractional
        // scale blurs module edges, which is exactly what a camera fails to read.
        let scale = max(1, (side / output.extent.width).rounded(.down))
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        return CIContext().createCGImage(scaled, from: scaled.extent)
    }
}
