import SwiftUI
import AVFoundation

/// Barcode scan flow — point the camera at a barcode, look it up on Open Food Facts
/// (server-cached), confirm where/amount/best-by, and "Add & scan next" loops straight
/// back to scanning (each add commits immediately, mirroring the web ScanModal). On the
/// simulator (no camera) or when access is denied, the "Type a barcode" path does the
/// same lookup.
struct PantryScanView: View {
    @Environment(\.dismiss) private var dismiss
    let locations: [String]
    let onAdded: () async -> Void

    enum CamState { case checking, ready, denied, unavailable }
    @State private var cam: CamState = .checking
    @State private var result: ScanResult?
    @State private var looking = false
    @State private var lookupError: String?
    @State private var manualEntry = false
    @State private var addedCount = 0
    @State private var addedEmojis: [String] = []
    /// Last accepted code + time — drops the rapid repeat reads AVFoundation emits.
    @State private var lastCode = ""
    @State private var lastAt = Date.distantPast

    private let api = WaffledAPI()

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if cam == .ready {
                BarcodeScanner { code in handle(code) }.ignoresSafeArea()
                scanFrame
            } else {
                fallbackBody
            }
            overlay
            if looking { ProgressView().tint(.white).scaleEffect(1.3) }
        }
        .task { await checkCamera() }
        .sheet(item: $result) { r in
            PantryFoundSheet(result: r, locations: locations) { body, emoji in
                await add(body, emoji: emoji)
            }
        }
        .sheet(isPresented: $manualEntry) {
            ManualBarcodeSheet { code in handle(code) }
        }
        .alert("Couldn’t reach Open Food Facts", isPresented: Binding(get: { lookupError != nil }, set: { if !$0 { lookupError = nil } })) {
            Button("OK", role: .cancel) { lookupError = nil }
        } message: { Text(lookupError ?? "") }
    }

    // MARK: chrome

    private var overlay: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top) {
                Button { Task { await close() } } label: {
                    Image(systemName: "xmark").font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 36, height: 36).background(.white.opacity(0.18)).clipShape(Circle())
                }.buttonStyle(.plain)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Scan into pantry").font(.system(size: 18, weight: .bold)).foregroundStyle(.white)
                    Text(cam == .ready ? "Point at the barcode" : "Type the barcode below")
                        .font(.system(size: 13)).foregroundStyle(.white.opacity(0.7))
                }
                Spacer()
            }
            .padding(.horizontal, 18).padding(.top, 8)
            Spacer()
            tray
        }
    }

    private var tray: some View {
        HStack(spacing: 12) {
            if addedCount > 0 {
                HStack(spacing: -8) {
                    ForEach(Array(addedEmojis.suffix(3).enumerated()), id: \.offset) { _, e in
                        Text(e).font(.system(size: 16)).frame(width: 34, height: 34)
                            .background(.white).clipShape(Circle()).overlay(Circle().stroke(.black.opacity(0.15), lineWidth: 1))
                    }
                }
                Text("\(addedCount) added").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
            } else {
                Text(cam == .ready ? "Hold steady — it catches each barcode" : "")
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(.white.opacity(0.7))
            }
            Spacer()
            Button { manualEntry = true } label: {
                Text("Type instead").font(.system(size: 14, weight: .bold)).foregroundStyle(.black)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.white).clipShape(Capsule())
            }.buttonStyle(.plain)
        }
        .padding(16).padding(.bottom, 24)
        .background(LinearGradient(colors: [.clear, .black.opacity(0.55)], startPoint: .top, endPoint: .bottom).ignoresSafeArea())
    }

    private var scanFrame: some View {
        RoundedRectangle(cornerRadius: 18, style: .continuous)
            .strokeBorder(.white.opacity(0.85), lineWidth: 3)
            .frame(width: 250, height: 160)
            .overlay(Rectangle().fill(WF.primary).frame(height: 2).opacity(0.9))
    }

    private var fallbackBody: some View {
        VStack(spacing: 16) {
            Image(systemName: cam == .denied ? "video.slash" : "barcode.viewfinder")
                .font(.system(size: 48)).foregroundStyle(.white.opacity(0.85))
            Text(cam == .checking ? "Starting camera…"
                 : cam == .denied ? "Camera access is off"
                 : "No camera on this device")
                .font(.system(size: 16, weight: .semibold)).foregroundStyle(.white)
            if cam == .denied {
                Text("Enable camera for Waffled in Settings, or type the barcode.")
                    .font(.system(size: 13)).foregroundStyle(.white.opacity(0.7)).multilineTextAlignment(.center)
            }
            if cam != .checking {
                Button { manualEntry = true } label: {
                    Text("Type a barcode").font(.system(size: 15, weight: .bold)).foregroundStyle(.black)
                        .padding(.horizontal, 20).padding(.vertical, 12).background(.white).clipShape(Capsule())
                }.buttonStyle(.plain)
            }
        }
        .padding(40)
    }

    // MARK: logic

    private func checkCamera() async {
        guard AVCaptureDevice.default(for: .video) != nil else { cam = .unavailable; return }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: cam = .ready
        case .notDetermined: cam = (await AVCaptureDevice.requestAccess(for: .video)) ? .ready : .denied
        default: cam = .denied
        }
    }

    /// Accept a scanned/typed code (digits only), de-duped, only while idle.
    private func handle(_ raw: String) {
        guard result == nil, !looking else { return }
        let code = raw.filter(\.isNumber)
        guard !code.isEmpty else { return }
        if code == lastCode, Date().timeIntervalSince(lastAt) < 3 { return }
        lastCode = code; lastAt = Date()
        looking = true
        Task {
            do {
                if let product = try await api.pantryLookup(barcode: code) {
                    result = .found(product: product, barcode: code)
                } else {
                    result = .notFound(barcode: code)
                }
            } catch {
                lookupError = "Couldn’t look that up — add it by hand, or try again."
            }
            looking = false
        }
    }

    private func add(_ body: [String: JSONValue], emoji: String) async {
        do {
            // Scan upsert: a re-scan increments the matching on-hand item instead of
            // duplicating it.
            _ = try await api.pantryScan(body)
            addedCount += 1
            addedEmojis.append(emoji)
        } catch {
            lookupError = "Couldn’t save that item."
        }
        // The sheet dismisses itself; clearing `result` re-arms the scanner.
        result = nil
    }

    private func close() async {
        if addedCount > 0 { await onAdded() }
        dismiss()
    }
}

/// A found / not-found scan result, driving the confirm sheet.
enum ScanResult: Identifiable {
    case found(product: WaffledAPI.OffProduct, barcode: String)
    case notFound(barcode: String)
    var id: String {
        switch self {
        case let .found(_, b): return "f-\(b)"
        case let .notFound(b): return "n-\(b)"
        }
    }
    var barcode: String {
        switch self { case let .found(_, b): return b; case let .notFound(b): return b }
    }
    var product: WaffledAPI.OffProduct? { if case let .found(p, _) = self { return p }; return nil }
}

// MARK: - Manual barcode entry

struct ManualBarcodeSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @FocusState private var focused: Bool
    let onSubmit: (String) -> Void

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Barcode number")
                TextField("e.g. 0049000028200", text: $text)
                    .keyboardType(.numberPad).focused($focused)
                    .font(.system(size: 18, weight: .semibold)).foregroundStyle(WF.ink)
                    .padding(14).background(WF.card2)
                    .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                Text("We’ll look it up on Open Food Facts.").font(.system(size: 12)).foregroundStyle(WF.ink3)
                Spacer()
            }
            .onAppear { focused = true }
            .padding(20).background(WF.canvas)
            .navigationTitle("Type a barcode").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Look up") { onSubmit(text); dismiss() }.fontWeight(.semibold)
                        .disabled(text.filter(\.isNumber).isEmpty)
                }
            }
        }
        .presentationDetents([.height(240)])
    }
}
