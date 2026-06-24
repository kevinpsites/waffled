import SwiftUI
import PhotosUI
import UIKit

/// Photo-proof for chores: capturing a completion snapshot (camera or library), and a
/// parent's review modal that shows the proof big before Approve / Not-yet. Mirrors the
/// web kiosk's `startProof`/`onProofPicked` and `ChoreProofModal`.

// MARK: - Camera picker (UIImagePickerController wrapper)

/// A thin SwiftUI bridge to `UIImagePickerController` in `.camera` mode — SwiftUI's
/// `PhotosPicker` covers the library, but the live camera still needs UIKit. Only
/// presented when a camera is actually available (simulators/camera-less iPads fall
/// back to the library).
struct CameraPicker: UIViewControllerRepresentable {
    var onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onImage(image) }
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

/// Whether this device can actually take a photo (false on the simulator and on
/// camera-less hardware) — used to hide/disable the "Take Photo" choice.
enum ProofCapture {
    static var cameraAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }
}

// MARK: - Parent proof review modal

/// A centered card with the large proof photo, who-finished-what context, and the
/// Approve / Not-yet actions in one place — so a parent can look at the proof before
/// deciding. Mirrors the web `ChoreProofModal`. Reuses `Avatar`/`ApprovalActionPair`.
struct ChoreProofReview: View {
    let chore: NookAPI.ChoreInstanceDTO
    let memberColorHex: String?
    let coin: String?
    let onApprove: () -> Void
    let onReject: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 12) {
                        Avatar(colorHex: memberColorHex, emoji: chore.emoji ?? "🙂", size: 40)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(chore.personName ?? "Someone") finished")
                                .font(.system(size: 13)).foregroundStyle(NK.ink3)
                            HStack(spacing: 6) {
                                Text("\(chore.emoji ?? "🧹") \(chore.choreTitle)")
                                    .font(.system(size: 16, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(2)
                                if let coin {
                                    Text(coin).font(.system(size: 12.5, weight: .heavy)).foregroundStyle(NK.gold)
                                        .padding(.horizontal, 7).padding(.vertical, 2)
                                        .background(NK.gold.opacity(0.14)).clipShape(Capsule())
                                }
                            }
                        }
                        Spacer(minLength: 0)
                    }

                    proofStage

                    ApprovalActionPair(
                        denyLabel: "Not yet", isKiosk: false,
                        onDeny: { onReject(); dismiss() },
                        onApprove: { onApprove(); dismiss() })
                }
                .padding(20)
            }
            .background(NK.canvas)
            .navigationTitle("Review photo").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
        }
        .presentationDetents([.large])
    }

    @ViewBuilder private var proofStage: some View {
        if let url = MediaURL.resolve(chore.proofUrl) {
            AsyncImage(url: url) { phase in
                switch phase {
                case let .success(image):
                    image.resizable().scaledToFit()
                case .failure:
                    proofPlaceholder("📷 Couldn’t load the photo.")
                default:
                    ZStack { Color.clear; ProgressView() }.frame(height: 240)
                }
            }
            .frame(maxWidth: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        } else {
            proofPlaceholder(chore.hadProof
                ? "📷 A photo was attached but is no longer saved."
                : "No photo was attached.")
        }
    }

    private func proofPlaceholder(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(NK.ink3)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, minHeight: 160)
            .background(NK.panel)
            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
    }
}

// MARK: - A small tappable proof thumbnail used in approval rows

/// The little proof thumbnail shown beside an awaiting chore — tap to open the review.
/// When the proof expired (`hadProof` but no URL) it shows a "no longer available" note
/// instead. Returns nothing for a chore that never had a photo (the caller keeps the
/// plain inline Approve/Reject in that case).
struct ChoreProofThumb: View {
    let chore: NookAPI.ChoreInstanceDTO
    let onTap: () -> Void

    var body: some View {
        if let url = MediaURL.resolve(chore.proofUrl) {
            Button(action: onTap) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image { image.resizable().scaledToFill() }
                    else { NK.panel }
                }
                .frame(width: 44, height: 44)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
                .overlay(alignment: .bottomTrailing) {
                    Text("🔍").font(.system(size: 10))
                        .padding(2).background(.ultraThinMaterial).clipShape(Circle())
                        .padding(2)
                }
            }
            .buttonStyle(.plain)
        } else if chore.hadProof {
            Text("📷 gone")
                .font(.system(size: 10.5, weight: .semibold)).foregroundStyle(NK.ink3)
                .padding(.horizontal, 7).padding(.vertical, 4)
                .background(NK.panel).clipShape(Capsule())
        }
    }
}
