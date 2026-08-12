import Foundation
import Testing
@testable import Waffled

// "Private" on a feed means "only the person it belongs to sees it". Belonging to
// nobody makes that nobody at all: imported events carry no owner, and the read
// filter (`visibility = 'family' or owner_person_id = $viewer`) never matches a null
// owner — so not even the admin who added the feed sees a thing, with no error to
// go on and a green "synced" badge saying it worked.
//
// The API refuses the combination. The form's job is to make it unaskable.
struct IcsFeedFormTests {
    @Test func offersPrivateOnlyOnceTheFeedBelongsToSomeone() {
        #expect(!IcsFeedForm.offersPrivate(personId: nil))
        #expect(IcsFeedForm.offersPrivate(personId: "p1"))
    }

    // Taking the person away is the other route in — the toggle disappears, so
    // whatever it was last set to must not travel with the save.
    @Test func dropsPrivateWhenThePersonIsCleared() {
        #expect(!IcsFeedForm.isPrivate(wanted: true, personId: nil))
    }

    @Test func keepsPrivateWhileAPersonIsChosen() {
        #expect(IcsFeedForm.isPrivate(wanted: true, personId: "p1"))
        #expect(!IcsFeedForm.isPrivate(wanted: false, personId: "p1"))
    }

    // Editing a feed already in the stranded state (created before the rule, or by
    // curl): open it and it reads as family, so simply saving repairs it.
    @Test func readsAStrandedExistingFeedAsFamily() {
        #expect(!IcsFeedForm.isPrivate(wanted: true, personId: nil))
    }
}
