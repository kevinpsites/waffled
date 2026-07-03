import SwiftUI
import UIKit
import AVFoundation

/// A live camera barcode reader (AVFoundation). Mirrors the chore-proof `CameraPicker`
/// representable pattern, but runs an `AVCaptureSession` with a metadata output so it
/// reads retail barcodes (EAN-13/8, UPC-A/E, Code 128/39/93, ITF-14). Fires `onCode`
/// with the raw string on each read; the caller de-dupes. The session is configured and
/// started off the main thread; the preview layer fills the view.
struct BarcodeScanner: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> BarcodeScannerController {
        let c = BarcodeScannerController()
        c.onCode = onCode
        return c
    }
    func updateUIViewController(_ controller: BarcodeScannerController, context: Context) {
        controller.onCode = onCode
    }
}

final class BarcodeScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "app.waffled.pantry.scanner")
    private var preview: AVCaptureVideoPreviewLayer?

    private static let codeTypes: [AVMetadataObject.ObjectType] = [
        .ean8, .ean13, .upce, .code39, .code93, .code128, .itf14, .interleaved2of5,
    ]

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        sessionQueue.async { [weak self] in self?.configure() }
    }

    private func configure() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input)
        else { return }

        session.beginConfiguration()
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        if session.canAddOutput(output) {
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            // Only request types the device actually supports (set after adding to session).
            output.metadataObjectTypes = Self.codeTypes.filter { output.availableMetadataObjectTypes.contains($0) }
        }
        session.commitConfiguration()

        DispatchQueue.main.async { [weak self] in self?.attachPreview() }
        session.startRunning()
    }

    private func attachPreview() {
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.insertSublayer(layer, at: 0)
        preview = layer
        applyRotation()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
        applyRotation()   // keep the feed upright as the iPad rotates
    }

    /// Match the preview's video rotation to the current interface orientation —
    /// otherwise the feed is sideways on an iPad held in landscape.
    private func applyRotation() {
        guard let connection = preview?.connection else { return }
        let angle: CGFloat
        switch view.window?.windowScene?.interfaceOrientation {
        case .landscapeLeft: angle = 180
        case .landscapeRight: angle = 0
        case .portraitUpsideDown: angle = 270
        default: angle = 90   // portrait
        }
        if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sessionQueue.async { [weak self] in
            guard let self, self.session.isRunning else { return }
            self.session.stopRunning()
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = obj.stringValue else { return }
        onCode?(value)
    }
}
