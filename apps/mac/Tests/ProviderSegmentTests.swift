import XCTest
@testable import Waffled

/// AI settings: Not now · Claude · OpenAI-compatible · Ollama.
///
/// config.env only makes a provider AVAILABLE — which one a household actually uses, and
/// which model, is chosen per household in the web app's Settings (`households.settings.ai`).
/// So each segment writes that provider's credential and nothing else.
final class ProviderSegmentTests: XCTestCase {

    func testTheRowIsCalledAISettings() {
        XCTAssertEqual(FirstRunPresentation.OptionsCopy.provider.title, "AI settings")
    }

    func testNothingIsChosenUntilSomeoneChoosesIt() {
        XCTAssertEqual(SetupOptions().provider, .none)
        XCTAssertEqual(SetupOptions.Provider.allCases.map(\.label),
                       ["Not now", "Claude", "OpenAI-compatible", "Ollama"])
    }

    func testClaudeWritesItsKey() {
        var options = SetupOptions()
        options.provider = .anthropic
        options.providerKey = "sk-ant"
        XCTAssertTrue(options.commandsBeforeFirstStart().contains(.configSet("ANTHROPIC_API_KEY", "sk-ant")))
    }

    /// OpenAI-compatible is also a local server's door: LM Studio, vLLM and the rest speak
    /// the same API at a different address.
    func testOpenAICompatibleWritesItsKeyAndAnyAddress() {
        var options = SetupOptions()
        options.provider = .openai
        options.providerKey = "sk-oa"
        options.openAIBaseURL = "http://127.0.0.1:1234/v1"
        let commands = options.commandsBeforeFirstStart()
        XCTAssertTrue(commands.contains(.configSet("OPENAI_API_KEY", "sk-oa")))
        XCTAssertTrue(commands.contains(.configSet("OPENAI_BASE_URL", "http://127.0.0.1:1234/v1")))
    }

    func testABlankAddressIsLeftToTheApisDefault() {
        var options = SetupOptions()
        options.provider = .openai
        options.providerKey = "sk-oa"
        XCTAssertFalse(options.commandsBeforeFirstStart().contains { $0.trailing.first?.hasPrefix("OPENAI_BASE_URL") == true })
    }

    /// Ollama needs no key — its address is what makes it available to the api.
    func testOllamaWritesItsAddress() {
        var options = SetupOptions()
        options.provider = .ollama
        XCTAssertTrue(options.commandsBeforeFirstStart()
            .contains(.configSet("OLLAMA_HOST", SetupOptions.defaultOllamaHost)))
    }

    func testNotNowWritesNoCredentialOnAFirstRun() {
        let commands = SetupOptions().commandsBeforeFirstStart()
        for key in ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OLLAMA_HOST"] {
            XCTAssertFalse(commands.contains { $0.trailing.first?.hasPrefix(key + "=") == true })
        }
    }

    /// A provider that needs a key and was just chosen without one would turn nothing on.
    func testChoosingAKeyedProviderWithNoKeyIsAProblem() {
        var options = SetupOptions()
        options.provider = .anthropic
        XCTAssertFalse(options.problems.isEmpty)
        options.providerKey = "sk-ant"
        XCTAssertTrue(options.problems.isEmpty)
    }

    /// In Settings the key field opens blank — a blank there means "unchanged", so staying
    /// on the provider that was already chosen is not a problem.
    func testKeepingTheProviderAlreadyChosenNeedsNoKey() {
        var saved = SetupOptions()
        saved.provider = .anthropic
        var options = saved
        options.providerKey = ""
        XCTAssertTrue(options.problems(comparedTo: saved).isEmpty)
        XCTAssertEqual(options.commandsForChange(from: saved), [])
    }

    /// Turning suggestions off is a choice, not an empty field: it takes the saved
    /// credentials off this Mac so the api stops offering them.
    func testNotNowInSettingsRemovesTheCredentials() {
        var saved = SetupOptions()
        saved.provider = .ollama
        var options = saved
        options.provider = .none
        XCTAssertEqual(options.commandsForChange(from: saved), [
            .configSet("ANTHROPIC_API_KEY", ""),
            .configSet("OPENAI_API_KEY", ""),
            .configSet("OLLAMA_HOST", ""),
        ])
    }

    func testMovingOllamaWritesTheNewAddress() {
        var saved = SetupOptions()
        saved.provider = .ollama
        var options = saved
        options.ollamaHost = "http://studio.local:11434"
        XCTAssertEqual(options.commandsForChange(from: saved),
                       [.configSet("OLLAMA_HOST", "http://studio.local:11434")])
    }

    func testAnAddressThatIsNotAURLIsAProblem() {
        var options = SetupOptions()
        options.provider = .ollama
        options.ollamaHost = "studio.local"
        XCTAssertFalse(options.problems.isEmpty)
    }

    // MARK: Ollama on this Mac

    func testOllamaIsAskedForItsModelsAtItsOwnAddress() {
        XCTAssertEqual(OllamaProbe.tagsURL(host: "http://localhost:11434/")?.absoluteString,
                       "http://localhost:11434/api/tags")
        XCTAssertNil(OllamaProbe.tagsURL(host: "not a url"))
    }

    func testTheModelsOllamaReportsAreRead() {
        let body = Data(#"{"models":[{"name":"llama3.1:latest"},{"name":"qwen2.5:7b"}]}"#.utf8)
        XCTAssertEqual(OllamaProbe.models(in: body), ["llama3.1:latest", "qwen2.5:7b"])
        XCTAssertNil(OllamaProbe.models(in: Data("<html>".utf8)))
    }

    func testWhatTheRowSaysAboutOllama() {
        XCTAssertEqual(OllamaProbe.Result.running(models: ["llama3.1:latest", "qwen2.5:7b"]).sentence,
                       "Ollama is running here, with 2 models: llama3.1:latest, qwen2.5:7b.")
        XCTAssertEqual(OllamaProbe.Result.running(models: []).sentence,
                       "Ollama is running here, but has no models yet — `ollama pull llama3.1` adds one.")
        XCTAssertEqual(OllamaProbe.Result.notAnswering.sentence,
                       "Nothing answered at that address. Is Ollama open?")
    }
}
