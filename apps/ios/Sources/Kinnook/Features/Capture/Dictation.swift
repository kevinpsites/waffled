import Foundation
import Speech
import AVFoundation

/// Live, on-device voice dictation via Apple's Speech framework. Toggling the mic
/// streams a running transcript into `transcript`; callers mirror that into their
/// text field. Used by the AI capture sheet's mic button.
@MainActor
@Observable
final class Dictation {
    private(set) var isListening = false
    private(set) var transcript = ""
    /// True once we know the recognizer is unavailable (no permission / offline-only locale).
    private(set) var unavailable = false

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    func toggle() { isListening ? stop() : authorizeAndStart() }

    private func authorizeAndStart() {
        SFSpeechRecognizer.requestAuthorization { status in
            Task { @MainActor in
                guard status == .authorized else { self.unavailable = true; return }
                AVAudioApplication.requestRecordPermission { granted in
                    Task { @MainActor in granted ? self.start() : (self.unavailable = true) }
                }
            }
        }
    }

    private func start() {
        guard let recognizer, recognizer.isAvailable else { unavailable = true; return }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch { return }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        request = req
        transcript = ""

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            req.append(buffer)
        }
        engine.prepare()
        do { try engine.start() } catch { stop(); return }
        isListening = true

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if let result { self.transcript = result.bestTranscription.formattedString }
                if error != nil || (result?.isFinal ?? false) { self.stop() }
            }
        }
    }

    func stop() {
        guard isListening || task != nil else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        isListening = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
