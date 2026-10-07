package app.waffled.feature.capture

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Live voice dictation via the platform [SpeechRecognizer] — the Android twin of the iOS
 * `Dictation` (SFSpeechRecognizer). Streams a running transcript into [transcript]; the
 * caller mirrors it into its text field.
 *
 * The RECORD_AUDIO runtime grant is the caller's job (the sheet requests it before
 * [start]). Must be created and driven on the main thread, as SpeechRecognizer requires.
 */
class Dictation(private val context: Context) {

    private val _isListening = MutableStateFlow(false)
    val isListening: StateFlow<Boolean> = _isListening.asStateFlow()

    private val _transcript = MutableStateFlow("")
    val transcript: StateFlow<String> = _transcript.asStateFlow()

    /** True once we know recognition can't run (no permission, no recognizer service). */
    private val _unavailable = MutableStateFlow(false)
    val unavailable: StateFlow<Boolean> = _unavailable.asStateFlow()

    private var recognizer: SpeechRecognizer? = null

    fun markUnavailable() {
        _unavailable.value = true
    }

    fun start() {
        if (_isListening.value) return
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            markUnavailable()
            return
        }
        val r = recognizer ?: SpeechRecognizer.createSpeechRecognizer(context).also {
            it.setRecognitionListener(listener)
            recognizer = it
        }
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        }
        _transcript.value = ""
        _isListening.value = true
        r.startListening(intent)
    }

    fun stop() {
        if (!_isListening.value) return
        _isListening.value = false
        recognizer?.stopListening()
    }

    /** Release the recognizer — call when the sheet leaves composition. */
    fun destroy() {
        _isListening.value = false
        recognizer?.destroy()
        recognizer = null
    }

    private fun best(results: Bundle?): String? =
        results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf { it.isNotBlank() }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) = Unit
        override fun onBeginningOfSpeech() = Unit
        override fun onRmsChanged(rmsdB: Float) = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() = Unit
        override fun onEvent(eventType: Int, params: Bundle?) = Unit

        override fun onPartialResults(partialResults: Bundle?) {
            best(partialResults)?.let { _transcript.value = it }
        }

        override fun onResults(results: Bundle?) {
            best(results)?.let { _transcript.value = it }
            _isListening.value = false
        }

        override fun onError(error: Int) {
            if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) markUnavailable()
            _isListening.value = false
        }
    }
}
