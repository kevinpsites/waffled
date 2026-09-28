import Foundation
import Testing
@testable import Waffled

/// WHICH WORDS AN ANSWERED NOTE CARRIES. The gold box corrects a note in place, so the
/// answer button must hand the composer the CORRECTED words, not the stored `note.note`.
@Suite struct PlanningHandoffWordsTests {

    private func note(id: String, _ text: String) -> WaffledAPI.PlanningStepHandoff {
        WaffledAPI.PlanningStepHandoff(id: id, note: text, byline: nil)
    }

    @Test func anUneditedNoteCarriesItsStoredWords() {
        let n = note(id: "n1", "book the campsite")
        #expect(PlanningHandoffWords.of(n, edited: [:]) == "book the campsite")
    }

    @Test func anEditedNoteCarriesTheEdit() {
        let n = note(id: "n1", "book the capmsite")
        #expect(PlanningHandoffWords.of(n, edited: ["n1": "book the campsite"]) == "book the campsite")
    }

    /// The map is keyed by id: two notes can be open in the same box.
    @Test func oneNotesEditDoesNotLeakOntoAnother() {
        let n = note(id: "n2", "ask about the school trip")
        #expect(PlanningHandoffWords.of(n, edited: ["n1": "something else"]) == "ask about the school trip")
    }
}
