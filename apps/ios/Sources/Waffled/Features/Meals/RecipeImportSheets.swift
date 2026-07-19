import SwiftUI
import PhotosUI

/// The two AI recipe-import sheets reached from the recipe editor's paste-bar — the
/// native twins of the web `PhotoImportModal` / `DescribeImportModal`. Each turns some
/// input (photos of a physical recipe / a spoken-or-typed description) into the same
/// `ParsedRecipe` draft the editor prefills from, then hands it back via `onDraft`.
/// Nothing is saved here — the user reviews the filled form and saves as normal.
///
/// Reuse, not reinvention: photos go through `MediaImage.encodeJPEG` (the shared upload
/// encoder) and the `CameraPicker` UIKit bridge; dictation reuses the `Dictation` class
/// (SFSpeechRecognizer) exactly as `CaptureSheet` does.

/// Up to this many photos of a single recipe (matches web `MAX_PHOTOS`).
private let maxRecipePhotos = 6

/// A friendly one-liner for an import failure. The server returns
/// `{ error, message }`; surface its message when we can, else a generic line.
func recipeImportErrorMessage(_ error: Error, fallback: String) -> String {
    if case let WaffledAPI.APIError.http(_, body) = error,
       let data = body.data(using: .utf8),
       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let msg = obj["message"] as? String, !msg.isEmpty {
        return msg
    }
    return fallback
}

// MARK: - Photo(s) → recipe

/// Snap or choose up to six photos of a recipe card / cookbook page / handwritten note;
/// the server's vision LLM reads them and fills the form.
struct PhotoImportSheet: View {
    var onDraft: (WaffledAPI.ParsedRecipe) -> Void
    @Environment(\.dismiss) private var dismiss
    private let api = WaffledAPI()

    /// A picked image plus a stable id (so the remove-by-id and ForEach stay correct).
    private struct Pick: Identifiable { let id = UUID(); let image: UIImage }

    @State private var picks: [Pick] = []
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var showCamera = false
    @State private var busy = false
    @State private var error: String?

    private let grid = [GridItem(.adaptive(minimum: 84), spacing: 10)]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Snap or choose a photo of a recipe card, cookbook page, or handwritten note — even a few pages of one recipe. We’ll read it and fill the form. Photos are held briefly, then deleted.")
                        .font(.system(size: 13.5)).foregroundStyle(WF.ink2)

                    if !picks.isEmpty {
                        LazyVGrid(columns: grid, spacing: 10) {
                            ForEach(picks) { pick in thumb(pick) }
                        }
                    }

                    if picks.count < maxRecipePhotos {
                        HStack(spacing: 10) {
                            if ProofCapture.cameraAvailable {
                                Button { showCamera = true } label: {
                                    Label("Take photo", systemImage: "camera")
                                        .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
                                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                                        .background(WF.panel).clipShape(Capsule())
                                }.buttonStyle(.plain)
                            }
                            PhotosPicker(selection: $pickerItems,
                                         maxSelectionCount: maxRecipePhotos - picks.count,
                                         matching: .images) {
                                Label(picks.isEmpty ? "Choose photos" : "Add more", systemImage: "photo.on.rectangle")
                                    .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
                                    .frame(maxWidth: .infinity).padding(.vertical, 12)
                                    .background(WF.panel).clipShape(Capsule())
                            }
                        }
                    }

                    if let error {
                        Text(error).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.primaryD)
                    }

                    Text("Under 10 MB each · up to \(maxRecipePhotos) photos.")
                        .font(.system(size: 12)).foregroundStyle(WF.ink3)

                    if !picks.isEmpty {
                        WaffledPrimaryCTA(
                            label: busy ? "Reading…" : "Read \(picks.count) → fill the form",
                            isBusy: busy, isDisabled: busy, action: { Task { await extract() } })
                    }
                }
                .padding(16)
            }
            .background(WF.canvas)
            .navigationTitle("Import from a photo").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .sheet(isPresented: $showCamera) {
                CameraPicker { image in addImages([image]) }
                    .ignoresSafeArea()
            }
            .onChange(of: pickerItems) { _, items in Task { await loadLibraryPicks(items) } }
        }
    }

    private func thumb(_ pick: Pick) -> some View {
        Image(uiImage: pick.image).resizable().scaledToFill()
            .frame(width: 84, height: 84)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
            .overlay(alignment: .topTrailing) {
                Button { picks.removeAll { $0.id == pick.id } } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 20)).foregroundStyle(.white, .black.opacity(0.55))
                }
                .buttonStyle(.plain).padding(3)
            }
    }

    private func loadLibraryPicks(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }
        var loaded: [UIImage] = []
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: data) {
                loaded.append(img)
            }
        }
        pickerItems = []
        addImages(loaded)
    }

    private func addImages(_ images: [UIImage]) {
        guard !images.isEmpty else { return }
        let room = maxRecipePhotos - picks.count
        picks.append(contentsOf: images.prefix(room).map { Pick(image: $0) })
        error = nil
    }

    private func extract() async {
        guard !picks.isEmpty, !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            // Encode off the main actor — JPEG re-encoding a handful of 2048px images is
            // real CPU work and shouldn't stall the sheet.
            let images = picks.map(\.image)
            let encoded = try await Task.detached(priority: .userInitiated) {
                try images.map { try MediaImage.encodeJPEG($0) }
            }.value
            let draft = try await api.ingestRecipePhotos(images: encoded)
            onDraft(draft)
            dismiss()
        } catch let e as MediaImage.EncodeError {
            error = e.errorDescription
        } catch {
            self.error = recipeImportErrorMessage(error, fallback: "Couldn’t read that photo — try a clearer shot or a different one.")
        }
    }
}

// MARK: - Speech / free-form text → recipe

/// Say or type what you know — ingredients and steps, in any order — and the server's LLM
/// organizes it into a recipe draft. Dictation reuses the shared `Dictation` class.
struct DescribeRecipeSheet: View {
    var onDraft: (WaffledAPI.ParsedRecipe) -> Void
    @Environment(\.dismiss) private var dismiss
    private let api = WaffledAPI()

    @State private var text = ""
    @State private var dictation = Dictation()
    /// Text captured before the current dictation started, so speech appends rather than
    /// replaces what was already typed (mirrors the web `baseRef`).
    @State private var dictationBase = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Just say or type what you know — ingredients and steps, in any order. We’ll organize it into a recipe you can tidy up.")
                        .font(.system(size: 13.5)).foregroundStyle(WF.ink2)

                    HStack {
                        Text("WHAT’S IN IT & HOW TO MAKE IT")
                            .font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(WF.ink3)
                        Spacer()
                        micButton
                    }

                    TextField("Grandma’s chili — brown a pound of ground beef with an onion, add two cans of kidney beans, a can of diced tomatoes, chili powder and cumin, simmer about 30 minutes…",
                              text: $text, axis: .vertical)
                        .font(.system(size: 15)).lineLimit(6...16).focused($focused)
                        .padding(12).wfField(fill: WF.panel)

                    if dictation.unavailable {
                        Text("Voice input isn’t available — type the recipe instead.")
                            .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                    if let error {
                        Text(error).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.primaryD)
                    }

                    WaffledPrimaryCTA(
                        label: busy ? "Thinking…" : "Turn into a recipe",
                        isBusy: busy,
                        isDisabled: busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                        action: { Task { await submit() } })
                }
                .padding(16)
            }
            .background(WF.canvas)
            .navigationTitle("Describe the recipe").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .onChange(of: dictation.transcript) { _, t in if !t.isEmpty { text = dictationBase + t } }
            .onDisappear { dictation.stop() }
        }
    }

    private var micButton: some View {
        Button { toggleMic() } label: {
            HStack(spacing: 6) {
                Image(systemName: dictation.isListening ? "mic.fill" : "mic")
                    .font(.system(size: 13, weight: .bold))
                Text(dictation.isListening ? "Listening… tap to stop" : "Dictate")
                    .font(.system(size: 12.5, weight: .bold))
            }
            .foregroundStyle(dictation.isListening ? .white : WF.ink2)
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(dictation.isListening ? WF.primary : WF.card)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(dictation.isListening ? Color.clear : WF.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func toggleMic() {
        if dictation.isListening {
            dictation.stop()
        } else {
            focused = false
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            dictationBase = trimmed.isEmpty ? "" : trimmed + " "
            dictation.toggle()
        }
    }

    private func submit() async {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !busy else { return }
        dictation.stop()
        busy = true; error = nil
        defer { busy = false }
        do {
            let draft = try await api.ingestRecipeVoice(text: t)
            onDraft(draft)
            dismiss()
        } catch {
            self.error = recipeImportErrorMessage(error, fallback: "Couldn’t turn that into a recipe — try adding a little more detail.")
        }
    }
}
